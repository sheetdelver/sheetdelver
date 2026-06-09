import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createModuleProxyService } from '@server/services/modules/ModuleProxyService';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';
import { logger } from '@shared/utils/logger';
import { getModulesDataDir, getLocalModulesDataDir } from '@core/paths';
import { isSdkError } from '@shared/sdk/errors';
import { rewriteImportsForBrowser } from './rewriteModuleImports';
import { recordModuleRuntimeFailure } from '@modules/registry/server';

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

function toShortString(value: unknown, fallback: string): string {
    if (typeof value !== 'string') return fallback;
    const trimmed = value.trim();
    if (!trimmed) return fallback;
    return trimmed.length > 500 ? `${trimmed.slice(0, 500)}...` : trimmed;
}

function recordModuleUiFailure(moduleId: string, message: string, source?: string): void {
    const sourceLabel = source ? ` (${source})` : '';
    const lifecycleMessage = `UI load failure${sourceLabel}: ${message}`;
    const recorded = recordModuleRuntimeFailure(moduleId, lifecycleMessage);
    logger.warn(`Registry | ${lifecycleMessage} for module "${moduleId}"${recorded ? '' : ' (no lifecycle record found)'}`);
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
     * Local dev modules are loaded through webpack via the generated
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
        // Also capture compiledStyles — it lives on the packager-patched artifact info.json
        // (decision 37), NOT on the source info.json that got bundled into ui.js, so the
        // client can't read it from `manifest.info`. We re-export it from the served module.
        let uiFile: string | null = null;
        let compiledStyles: string | undefined;
        const infoPath = path.join(baseDir, 'info.json');
        if (fs.existsSync(infoPath)) {
            try {
                const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
                const manifestUi = info?.manifest?.ui;
                if (manifestUi) {
                    const candidate = path.join(baseDir, manifestUi);
                    if (fs.existsSync(candidate)) uiFile = candidate;
                }
                if (typeof info?.compiledStyles === 'string') compiledStyles = info.compiledStyles;
            } catch { /* ignore malformed info.json */ }
        }

        if (!uiFile) {
            for (const candidate of ['dist/ui.js', 'module/ui.js']) {
                const p = path.join(baseDir, candidate);
                if (fs.existsSync(p)) { uiFile = p; break; }
            }
        }

        if (!uiFile) {
            recordModuleUiFailure(moduleId, 'No UI artifact found');
            return res.status(404).json({ error: `No UI artifact found for module "${moduleId}"` });
        }

        try {
            const raw = fs.readFileSync(uiFile, 'utf8');
            let rewritten = rewriteImportsForBrowser(raw);
            // Surface the packager-patched compiledStyles to the client injector (decision 37).
            if (compiledStyles) {
                rewritten += `\nexport const __sdCompiledStyles = ${JSON.stringify(compiledStyles)};\n`;
            }

            res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store'); // always serve fresh after install/upgrade
            res.send(rewritten);
        } catch (err) {
            recordModuleUiFailure(moduleId, getErrorMessage(err));
            logger.error(`[Registry] Failed to serve UI for module "${moduleId}":`, err);
            res.status(500).json({ error: getErrorMessage(err) });
        }
    });

    /**
     * POST /api/modules/:id/ui-error
     *
     * Browser import/evaluation failures happen after the server has successfully
     * served the UI artifact, so the server cannot detect them from the GET alone.
     * The client reports a short message here and the registry records it into
     * lifecycle health for admin visibility. This is an operational health signal,
     * not a generic telemetry endpoint.
     */
    moduleRouter.post('/:id/ui-error', async (req, res) => {
        const moduleId = String(req.params.id).toLowerCase();
        const body = req.body as { message?: unknown; source?: unknown } | undefined;
        const message = toShortString(body?.message, 'Client failed to import module UI');
        const source = typeof body?.source === 'string' ? toShortString(body.source, 'unknown') : undefined;

        recordModuleUiFailure(moduleId, message, source);
        res.json({ success: true });
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
                transportClient: req.foundryClient,
                userSession: req.userSession
            });

            return res.status(result.status).json(result.payload);
        } catch (error: unknown) {
            if (isSdkError(error)) {
                logger.error(`Module Routing Error (${req.path}): ${error.message}`);
                return res.status(error.status).json({ error: error.message, code: error.code, status: error.status });
            }
            const message = getErrorMessage(error);
            logger.error(`Module Routing Error (${req.path}): ${message}`);
            return res.status(500).json({ error: message });
        }
    });

    return moduleRouter;
}
