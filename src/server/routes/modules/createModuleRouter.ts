import express from 'express';
import fs from 'node:fs';
import { createModuleProxyService } from '@server/services/modules/ModuleProxyService';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';
import { logger } from '@shared/utils/logger';
import { getModulesDataDir, getLocalModulesDataDir } from '@core/paths';
import { isSdkError } from '@shared/sdk/errors';
import { rewriteImportsForBrowser } from './rewriteModuleImports';
import { getModuleLifecycleState, recordModuleRuntimeFailure } from '@modules/registry/server';
import { parseModuleId } from '@shared/security/moduleId';
import {
    ModuleUiHealthRateLimiter,
    parseModuleUiHealthSource,
    sanitizeModuleUiHealthText,
} from '@server/security/moduleUiHealthPolicy';
import { ModuleSourceCategory } from '@shared/types/modules';
import {
    readWildcardPath,
    resolveConfinedDirectory,
    resolveConfinedFile,
    resolveModuleDirectory,
} from '@server/security/modulePath';

interface ModuleRouterDeps {
    tryAuthenticateSession: express.RequestHandler;
    /** Test seam for proving source-aware asset routing without mutating registry state. */
    getModuleAssetSource?: (moduleId: string) => ModuleSourceCategory | undefined;
}

/**
 * Resolve only the registry-selected source. Falling through to the other source
 * can combine one module's code with another version's assets.
 */
function resolveModuleBaseDir(moduleId: string, source: ModuleSourceCategory | undefined): string | null {
    const root = source === ModuleSourceCategory.Local
        ? getLocalModulesDataDir()
        : source === ModuleSourceCategory.Managed
            ? getModulesDataDir()
            : null;
    return root ? resolveModuleDirectory(root, moduleId) : null;
}

function getEnabledModuleAssetSource(moduleId: string): ModuleSourceCategory | undefined {
    const lifecycle = getModuleLifecycleState().find((record) => record.moduleId === moduleId);
    // Disabled or undiscovered modules must not expose an inactive source as a fallback.
    return lifecycle?.enabled ? lifecycle.activeSource : undefined;
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
    const uiHealthLimiter = new ModuleUiHealthRateLimiter();
    const getModuleAssetSource = deps.getModuleAssetSource ?? getEnabledModuleAssetSource;
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
        const moduleId = parseModuleId(req.params.id);
        if (!moduleId) {
            return res.status(400).json({ error: 'Invalid module ID', code: 'invalid-module-id' });
        }
        const baseDir = resolveModuleDirectory(getModulesDataDir(), moduleId);

        if (!baseDir) {
            return res.status(404).json({ error: `Module "${moduleId}" not found` });
        }

        // Find the UI file: prefer manifest.ui from info.json, then conventions.
        // Also capture compiledStyles — it lives on the packager-patched artifact info.json
        // (decision 37), NOT on the source info.json that got bundled into ui.js, so the
        // client can't read it from `manifest.info`. We re-export it from the served module.
        let uiFile: string | null = null;
        let compiledStyles: string | undefined;
        const infoPath = resolveConfinedFile(baseDir, 'info.json');
        if (infoPath) {
            try {
                const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
                const manifestUi = info?.manifest?.ui;
                if (typeof manifestUi === 'string') {
                    uiFile = resolveConfinedFile(baseDir, manifestUi);
                }
                if (typeof info?.compiledStyles === 'string') compiledStyles = info.compiledStyles;
            } catch { /* ignore malformed info.json */ }
        }

        if (!uiFile) {
            for (const candidate of ['dist/ui.js', 'module/ui.js']) {
                const confined = resolveConfinedFile(baseDir, candidate);
                if (confined) { uiFile = confined; break; }
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
        // Only a restored Foundry user session may mutate operator-visible health.
        const sessionId = req.userSession?.id;
        if (!sessionId || !req.userSession?.userId || req.isSystem === true) {
            return res.status(401).json({ error: 'Authentication required', code: 'authentication-required' });
        }

        const moduleId = parseModuleId(req.params.id);
        if (!moduleId) {
            return res.status(400).json({ error: 'Invalid module ID', code: 'invalid-module-id' });
        }

        const body = req.body as { message?: unknown; source?: unknown } | undefined;
        const source = parseModuleUiHealthSource(body?.source);
        if (!source) {
            return res.status(400).json({ error: 'Invalid module source', code: 'invalid-module-source' });
        }

        const lifecycle = getModuleLifecycleState().find((record) => record.moduleId === moduleId);
        if (!lifecycle) {
            return res.status(404).json({ error: 'Module not found', code: 'module-not-found' });
        }
        if (!lifecycle.enabled || lifecycle.activeSource !== source) {
            return res.status(409).json({ error: 'Module source is not active', code: 'module-source-inactive' });
        }
        if (!uiHealthLimiter.consume(sessionId, moduleId)) {
            return res.status(429).json({ error: 'Too many module UI health reports', code: 'rate-limit-exceeded' });
        }

        const message = sanitizeModuleUiHealthText(
            body?.message,
            'Client failed to import module UI',
            500,
        );

        recordModuleUiFailure(moduleId, message, source);
        res.json({ success: true });
    });

    /**
     * GET /api/modules/:id/assets/*
     *
     * Serves static assets from the registry-selected source. The URL remains identical
     * for local development and managed packages (ADR-0027 decision 27), while source
     * selection prevents code from one version being paired with another version's assets.
     * Includes path traversal protection.
     */
    moduleRouter.get('/:id/assets/{*assetPath}', async (req, res) => {
        const moduleId = parseModuleId(req.params.id);
        if (!moduleId) {
            return res.status(400).json({ error: 'Invalid module ID', code: 'invalid-module-id' });
        }
        const assetPath = readWildcardPath(req.params.assetPath);
        if (!assetPath) {
            return res.status(400).json({ error: 'Invalid asset path', code: 'invalid-asset-path' });
        }

        const baseDir = resolveModuleBaseDir(moduleId, getModuleAssetSource(moduleId));

        if (!baseDir) {
            return res.status(404).json({ error: `Module "${moduleId}" not found` });
        }

        const assetsDir = resolveConfinedDirectory(baseDir, 'assets');
        if (!assetsDir) {
            return res.status(404).json({ error: `No assets directory found for module "${moduleId}"` });
        }

        const fullPath = resolveConfinedFile(assetsDir, assetPath);
        if (!fullPath) {
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
