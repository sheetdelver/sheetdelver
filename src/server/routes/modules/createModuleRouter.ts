import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createModuleProxyService } from '@server/services/modules/ModuleProxyService';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';
import { logger } from '@shared/utils/logger';
import { getModulesDataDir, getLocalModulesDataDir } from '@core/paths';

interface ModuleRouterDeps {
    tryAuthenticateSession: express.RequestHandler;
}

/**
 * Resolve a module's base directory, checking installed modules first
 * (`<DATA_DIR>/modules/<id>`) then local-dev modules (`<DATA_DIR>/local/modules/<id>`).
 * Per ADR-0027 decision 27, the asset URL must resolve identically in dev and packaged.
 */
function resolveModuleBaseDir(moduleId: string): string | null {
    for (const root of [getModulesDataDir(), getLocalModulesDataDir()]) {
        const candidate = path.join(root, moduleId);
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

// ─── Module JS rewriter ────────────────────────────────────────────────────────
//
// Runtime-installed (managed) modules can't be in the Next.js webpack bundle.
// They are served via GET /api/modules/:id/ui as native ESM so the browser
// can import them with /* webpackIgnore: true */.
//
// The compiled artifact uses bare ESM specifiers ('react', '@sheet-delver/sdk')
// that the browser's native loader can't resolve without an importmap. We rewrite
// those imports server-side to reference window.__SD, which the SDKGlobalProvider
// sets synchronously during page load. This shares the host's React instance so
// module context (useSDK, useSDKComponents) works correctly.

const GLOBAL_MAP: Record<string, string> = {
    'react':                  'window.__SD.React',
    'react/jsx-runtime':      'window.__SD.ReactJSX',
    'react-dom':              'window.__SD.React',
    '@sheet-delver/sdk':      'window.__SD.sdk',
    // Client subpath (ADR-0027 decision 2). `@sheet-delver/sdk/server` is intentionally
    // absent — a UI bundle importing it stays unresolved (server-only rejected from UI).
    '@sheet-delver/sdk/react': 'window.__SD.sdkReact',
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

export function createModuleRouter(deps: ModuleRouterDeps) {
    // --- Module Router (Permissive Auth) ---
    // Mounted before the global auth middleware to allow module-specific permissive routes
    const moduleRouter = express.Router();
    moduleRouter.use(deps.tryAuthenticateSession);

    /**
     * GET /api/modules/:id/ui
     *
     * Serves a managed module's compiled UI artifact as browser-compatible ESM.
     * Bare import specifiers ('react', '@sheet-delver/sdk') are rewritten to
     * window.__SD.* references so the browser's native ESM loader can resolve
     * them without an importmap.
     *
     * Local dev and built-in modules are loaded through webpack via the generated
     * @data-registry/module-ui-registry; this endpoint exists specifically for
     * managed modules installed after the Next.js build.
     *
     * Path searched: <DATA_DIR>/modules/:id/<manifest.ui from info.json>,
     * falling back to dist/ui.js / module/ui.js conventions.
     */
    moduleRouter.get('/:id/ui', async (req, res) => {
        const moduleId = String(req.params.id).toLowerCase();
        const baseDir = path.join(getModulesDataDir(), moduleId);

        if (!fs.existsSync(baseDir)) {
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

    /**
     * GET /api/modules/:id/assets/*
     *
     * Serves static assets for a module from its `assets/` directory, resolving both
     * installed (<DATA_DIR>/modules/:id) and local-dev (<DATA_DIR>/local/modules/:id)
     * modules so `assetUrl()` resolves identically in dev and packaged (ADR-0027
     * decision 27). Includes path traversal protection.
     */
    moduleRouter.get('/:id/assets/{*assetPath}', async (req, res) => {
        const moduleId = String(req.params.id).toLowerCase();

        // Extract the trailing path accurately without relying on Express 0-index wildcard parameters
        const prefix = `/${moduleId}/assets/`;
        const assetPath = req.path.slice(prefix.length);

        const baseDir = resolveModuleBaseDir(moduleId);

        if (!baseDir) {
            return res.status(404).json({ error: `Module "${moduleId}" not found` });
        }

        const assetsDir = path.join(baseDir, 'assets');
        if (!fs.existsSync(assetsDir)) {
            return res.status(404).json({ error: `No assets directory found for module "${moduleId}"` });
        }

        const fullPath = path.resolve(assetsDir, assetPath);

        // Path traversal protection
        if (!fullPath.startsWith(path.resolve(assetsDir))) {
            return res.status(403).json({ error: 'Access denied' });
        }

        if (!fs.existsSync(fullPath)) {
            return res.status(404).json({ error: 'Asset not found' });
        }

        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.sendFile(fullPath);
    });

    // Module proxy service: displaced matching and dispatch orchestration for module api routes.
    const moduleProxyService = createModuleProxyService();

    // Express 5: String wildcards (*) must be named or used via RegExp.
    // Named capturing groups (?<name>) populate req.params.name
    moduleRouter.all(/^(.*)$/, async (req, res) => {
        try {
            const result = await moduleProxyService.dispatchModuleRoute({
                path: req.path,
                method: req.method,
                url: req.url,
                headers: req.headers,
                body: req.body,
                foundryClient: req.foundryClient,
                userSession: req.userSession
            });

            return res.status(result.status).json(result.payload);
        } catch (error: unknown) {
            const message = getErrorMessage(error);
            logger.error(`Module Routing Error (${req.path}): ${message}`);
            return res.status(500).json({ error: message });
        }
    });

    return moduleRouter;
}
