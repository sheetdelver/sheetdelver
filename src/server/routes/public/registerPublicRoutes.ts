import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '@shared/utils/logger';
import { getRegisteredModules, getModuleActiveSources } from '@modules/registry/server';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';
import { getModulesDataDir, getLocalModulesDir } from '@core/paths';

// ─── Module JS rewriter ────────────────────────────────────────────────────────
//
// Runtime-installed modules (installed after the Next.js build) can't be in the
// webpack bundle. They are served via GET /api/modules/:id/ui as native ESM so
// the browser can import them with /* webpackIgnore: true */.
//
// The compiled artifact uses bare ESM specifiers ('react', '@sheet-delver/sdk')
// that the browser's native loader can't resolve without an importmap. We rewrite
// those imports server-side to reference window.__SD, which the SDKGlobalProvider
// sets synchronously during page load. This shares the host's React instance so
// module context (useSDK, useSDKComponents) works correctly.

const GLOBAL_MAP: Record<string, string> = {
    'react':                'window.__SD.React',
    'react/jsx-runtime':    'window.__SD.ReactJSX',
    'react-dom':            'window.__SD.React',
    '@sheet-delver/sdk':    'window.__SD.sdk',
};

/**
 * Rewrites bare ESM import statements in a compiled module artifact to use
 * the window.__SD globals instead, making the file loadable by the browser's
 * native ESM loader without an importmap.
 *
 * Handles the three forms esbuild produces:
 *   import { a, b } from "module"
 *   import X from "module"
 *   import * as X from "module"
 */
function rewriteImportsForBrowser(code: string): string {
    return code.replace(
        /^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/gm,
        (match, imports: string, source: string) => {
            const global = GLOBAL_MAP[source];
            if (!global) return match;

            const parts: string[] = [];
            const trimmed = imports.trim();

            // namespace: * as X
            const nsMatch = trimmed.match(/^\*\s+as\s+(\w+)$/);
            if (nsMatch) {
                parts.push(`const ${nsMatch[1]} = ${global};`);
                return parts.join('\n');
            }

            // default + possibly named: X, { a, b }  or  X
            const defaultMatch = trimmed.match(/^(\w+)(?:\s*,\s*\{([^}]*)\})?$/);
            if (defaultMatch) {
                parts.push(`const ${defaultMatch[1]} = ${global};`);
                if (defaultMatch[2]) {
                    const names = defaultMatch[2].split(',').map(s => s.trim()).filter(Boolean).join(', ');
                    parts.push(`const { ${names} } = ${global};`);
                }
                return parts.join('\n');
            }

            // named only: { a, b }
            const namedMatch = trimmed.match(/^\{([^}]*)\}$/);
            if (namedMatch) {
                const names = namedMatch[1].split(',').map(s => s.trim()).filter(Boolean).join(', ');
                parts.push(`const { ${names} } = ${global};`);
                return parts.join('\n');
            }

            return match;
        }
    );
}

interface PublicRouteDeps {
    statusHandler: express.RequestHandler;
    getSanitizedConfig: () => unknown;
    getSetupStatus: () => Promise<{ isConfigured: boolean }>;
    loginLimiter: express.RequestHandler;
    createSession: (username: string, password?: string) => Promise<{ sessionId: string; userId: string }>;
    destroySession: (token: string) => Promise<void>;
}

export function registerPublicRoutes(appRouter: express.Router, deps: PublicRouteDeps) {
    appRouter.get('/status', deps.statusHandler);
    appRouter.get('/session/connect', deps.statusHandler);

    appRouter.get('/config', (req, res) => {
        res.json(deps.getSanitizedConfig());
    });

    /**
     * Public endpoint to check if the application has been configured.
     * Used by the frontend 'Configuration Required' overlay.
     */
    appRouter.get('/config/setup-status', async (req, res) => {
        try {
            res.json(await deps.getSetupStatus());
        } catch (err: unknown) {
            logger.error(`Failed to check setup status: ${getErrorMessage(err)}`);
            res.status(500).json({ isConfigured: false, error: 'Failed to verify configuration status' });
        }
    });

    appRouter.get('/registry/modules', (req, res) => {
        res.json(getRegisteredModules());
    });

    // moduleId → activeSource map consumed by the browser's getUIModule().
    // No auth required: it contains no sensitive data and must be reachable
    // before a session exists (e.g. on initial actor page load).
    // When an admin switches a module source, clients receive a 'moduleSourceChanged'
    // socket event and re-fetch this endpoint to pick the correct webpack alias.
    appRouter.get('/registry/sources', (req, res) => {
        res.json(getModuleActiveSources());
    });

    /**
     * GET /api/modules/:id/ui
     *
     * Serves a module's compiled UI artifact as browser-compatible ESM.
     * Bare import specifiers ('react', '@sheet-delver/sdk') are rewritten to
     * window.__SD.* references so the browser's native ESM loader can resolve
     * them without an importmap.
     *
     * Used by getUIModule() for modules installed at runtime (after the Next.js
     * build), loaded via import(webpackIgnore: true) so webpack doesn't attempt
     * static analysis of the path.
     *
     * Path searched: activeSource directory → manifest.ui from info.json.
     * Falls back to dist/ui.js and module/ui.js conventions.
     */
    appRouter.get('/modules/:id/ui', async (req, res) => {
        const moduleId = String(req.params.id).toLowerCase();

        const sources = getModuleActiveSources();
        const source = sources[moduleId];

        // Determine the base directory for this module's active source.
        let baseDir: string | null = null;
        if (source === 'local') {
            const localDir = getLocalModulesDir();
            if (localDir) baseDir = path.join(localDir, moduleId);
        }
        if (!baseDir) {
            baseDir = path.join(getModulesDataDir(), moduleId);
        }

        if (!baseDir || !fs.existsSync(baseDir)) {
            return res.status(404).json({ error: `Module "${moduleId}" not found` });
        }

        // Find the UI file: prefer manifest.ui from info.json, then conventions.
        let uiFile: string | null = null;
        const infoPath = path.join(baseDir, 'info.json');
        if (fs.existsSync(infoPath)) {
            try {
                const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
                const manifestUi = info?.manifest?.ui;
                if (manifestUi) {
                    const candidate = path.join(baseDir, manifestUi);
                    if (fs.existsSync(candidate)) uiFile = candidate;
                }
            } catch { /* ignore malformed info.json */ }
        }

        if (!uiFile) {
            for (const candidate of ['dist/ui.js', 'module/ui.js']) {
                const p = path.join(baseDir, candidate);
                if (fs.existsSync(p)) { uiFile = p; break; }
            }
        }

        if (!uiFile) {
            return res.status(404).json({ error: `No UI artifact found for module "${moduleId}"` });
        }

        try {
            const raw = fs.readFileSync(uiFile, 'utf8');
            const rewritten = rewriteImportsForBrowser(raw);

            res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store'); // always serve fresh after install/upgrade
            res.send(rewritten);
        } catch (err) {
            logger.error(`[Registry] Failed to serve UI for module "${moduleId}":`, err);
            res.status(500).json({ error: getErrorMessage(err) });
        }
    });

    appRouter.post('/login', deps.loginLimiter, async (req, res) => {
        const { username, password } = req.body;
        try {
            const session = await deps.createSession(username, password);
            res.json({ success: true, token: session.sessionId, userId: session.userId });
        } catch (error: unknown) {
            res.status(401).json({ success: false, error: getErrorMessage(error) });
        }
    });

    appRouter.post('/logout', async (req, res) => {
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.split(' ')[1];
            await deps.destroySession(token);
        }
        res.json({ success: true });
    });
}
