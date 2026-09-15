/**
 * Admin module-lifecycle + dormant source-profile endpoints. Carved out of the
 * monolithic createAdminRouter.ts per ADR-0022 Phase 4.
 *
 * Owns:
 *   - GET    /lifecycle
 *   - POST   /modules/:id/enable, /modules/:id/disable, /modules/:id/switch-source
 *   - POST   /modules/install, /modules/upgrade, /modules/uninstall, /modules/validate
 *   - POST   /modules/dry-run-install, /modules/dry-run-upgrade
 *   - POST   /server/restart
 *   - GET    /sources, /sources/:id/modules
 *   - POST   /sources, /sources/:id/test
 *   - PUT    /sources/:id
 *   - DELETE /sources/:id
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { logger } from '@shared/utils/logger';
import { requireAdminAuth, auditAdminAction } from '@server/middleware/requireAdminAuth';
import { requireAdminCsrf } from '@server/middleware/requireAdminCsrf';
import { ModuleSourceCategory, ModuleTrustTier, type ModuleTrustTier as ModuleTrustTierValue } from '@shared/types/modules';
import { getDistArchivesDir, getModulesDataDir } from '@core/paths';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';
import type { RegisteredModuleRuntimeInfo } from '@modules/registry/server';
import type { ModuleLifecycleValidation, ModuleSourceState } from '@modules/registry/lifecycle/lifecycle';
import { parseModuleId } from '@shared/security/moduleId';
import { DEFAULT_MODULE_ARCHIVE_LIMITS } from '@modules/registry/distribution/archiveTransaction';
import { isDistributionHostAllowed } from '@modules/registry/distribution/publicDistributionClient';
import { getConfig } from '@server/core/config';

export interface RegisterAdminModuleRoutesOptions {
    adminRouter: express.Router;
    requireAdminAccountExists: express.RequestHandler;
    requestServerRestart: (reason: string, detail?: Record<string, unknown>) => void;
}

export function registerAdminModuleRoutes(opts: RegisterAdminModuleRoutesOptions): void {
    const { adminRouter, requireAdminAccountExists } = opts;
    function respondWithRuntimeRestart(
        res: express.Response,
        payload: object,
        moduleId: string,
        operation: string,
    ): void {
        res.json({ ...payload, restartScheduled: true });
        opts.requestServerRestart(`module-${operation}:${moduleId}`, { moduleId, operation });
    }

    /** Reject decoded separators and other non-slug IDs before registry mutation. */
    function readRequestModuleId(req: express.Request, res: express.Response): string | null {
        const raw = Array.isArray(req.params.moduleId) ? req.params.moduleId[0] : req.params.moduleId;
        const moduleId = parseModuleId(raw);
        if (!moduleId) {
            res.status(400).json({ success: false, error: 'Invalid module ID', errorCode: 'invalid-module-id' });
            return null;
        }
        return moduleId;
    }

    /**
     * Convert internal lifecycle validation into the flat diagnostic rows rendered
     * by the admin panel. Artifact warnings/errors are intentionally included here
     * so the operator can audit old managed packages without opening a browser console.
     */
    function toValidationPayload(validation?: ModuleLifecycleValidation) {
        if (!validation) return undefined;

        return {
            manifestValid: validation.manifestValid,
            diagnostics: [
                ...(validation.coreDiagnostics || []).map(d => ({
                    code: `core:${d.constraint}`,
                    message: d.reason || (d.compatible ? 'Constraint satisfied' : `Constraint ${d.constraint} not satisfied`),
                    severity: d.compatible ? 'info' : 'error',
                })),
                ...(validation.contractDiagnostics || []).map(d => ({
                    code: `contract:${d.contract}`,
                    message: d.reason || (d.compatible ? `${d.contract} ${d.providedVersion || ''} satisfies ${d.requiredRange}` : `${d.contract} incompatible`),
                    severity: d.compatible ? 'info' : 'error',
                })),
                ...(validation.validationErrors || []).map(e => ({
                    code: 'manifest-error',
                    message: e,
                    severity: 'error' as const,
                })),
                ...(validation.artifactDiagnostics || []).map(d => ({
                    code: d.code,
                    message: d.message,
                    severity: d.severity,
                })),
            ],
        };
    }

    /**
     * Source states are sent with the same validation shape as the active module.
     * This lets the split local/managed cards show source-specific drift or blockers.
     */
    function toSourceStatesPayload(sourceStates?: Partial<Record<ModuleSourceCategory, ModuleSourceState>>) {
        if (!sourceStates) return undefined;
        return Object.fromEntries(
            Object.entries(sourceStates)
                .filter((entry): entry is [string, ModuleSourceState] => Boolean(entry[1]))
                .map(([source, state]) => [
                    source,
                    {
                        ...state,
                        validation: toValidationPayload(state.validation),
                    },
                ])
        );
    }

    /**
     * When enable fails, re-read lifecycle state after the registry operation so the
     * HTTP response can name the blocking source reason instead of returning a generic
     * "invalid/incompatible" message.
     */
    function getLifecycleFailureReason(
        modules: RegisteredModuleRuntimeInfo[],
        moduleId: string,
        source?: ModuleSourceCategory,
    ): string | undefined {
        const canonicalId = parseModuleId(moduleId);
        const entry = canonicalId ? modules.find(m => parseModuleId(m.info.id) === canonicalId) : undefined;
        if (!entry) return undefined;
        return (source ? entry.lifecycle.sourceStates?.[source]?.reason : undefined)
            || entry.lifecycle.reason;
    }

    /**
     * GET /admin/api/lifecycle
     * List all modules with their lifecycle state (enabled/disabled, status, compatibility)
     * Requires admin auth
     */
    adminRouter.get(
        '/lifecycle',
        requireAdminAccountExists,
        requireAdminAuth,
        async (req, res) => {
            try {
                const { listModules } = await import('@modules/registry/server');
                const modules = listModules({ includeExperimental: true, includeDisabled: true });

                res.json({
                    success: true,
                    modules: modules.map((m) => {
                        return {
                            moduleId: m.info.id,
                            title: m.info.title,
                            directory: m.directory,
                            enabled: m.enabled,
                            status: m.status,
                            experimental: m.info.experimental,
                            managed: m.managed,
                            reason: m.reason,
                            health: m.lifecycle.health,
                            validation: toValidationPayload(m.lifecycle.validation),
                            sourceStates: toSourceStatesPayload(m.lifecycle.sourceStates),
                            artifact: m.artifact,
                            activeSource: m.lifecycle.activeSource,
                            localDirectory: m.lifecycle.localDirectory,
                            // Explicit per-source managed path so each card shows its own fixed
                            // location regardless of which source is active (ADR-0030 UX-6).
                            // `directory` alone is mutated to the active source on switch.
                            managedDirectory: path.join(getModulesDataDir(), parseModuleId(m.info.id)!),
                            localEnabled: m.lifecycle.localEnabled,
                            managedEnabled: m.lifecycle.managedEnabled,
                        };
                    }),
                });
            } catch (error: unknown) {
                logger.error('Failed to list module lifecycle', error);
                res.status(500).json({ error: getErrorMessage(error) });
            }
        }
    );

    /**
     * POST /admin/api/lifecycle/:moduleId/enable
     * Enable a module. Requires admin auth.
     * Returns 409 Conflict if dependencies are not met or conflicts exist.
     */
    adminRouter.post(
        '/lifecycle/:moduleId/enable',
        requireAdminAccountExists,
        requireAdminAuth,
        requireAdminCsrf,
        auditAdminAction,
        async (req, res) => {
            try {
                const moduleId = readRequestModuleId(req, res);
                if (!moduleId) return;
                const { enableModule, checkCanEnableModule, listModules } = await import('@modules/registry/server');

                // Check dependencies and conflicts
                const depCheck = checkCanEnableModule(moduleId);
                if (!depCheck.canEnable) {
                    logger.warn(`Admin attempted to enable ${moduleId} with unmet constraints`, depCheck.violations);
                    return res.status(409).json({
                        success: false,
                        error: 'Cannot enable module due to dependency or conflict constraints',
                        violations: depCheck.violations || [],
                    });
                }

                const source = req.body?.source as ModuleSourceCategory | undefined;
                const success = enableModule(moduleId, source);
                if (!success) {
                    const modules = listModules({ includeExperimental: true, includeDisabled: true });
                    const reason = getLifecycleFailureReason(modules, moduleId, source);
                    return res.status(400).json({
                        success: false,
                        error: reason || `Failed to enable module ${moduleId}. Module may be incompatible or invalid.`,
                    });
                }

                logger.info(`[Admin] Module enabled: ${moduleId}`);
                respondWithRuntimeRestart(res, {
                    success: true,
                    message: `Module ${moduleId} enabled`,
                    moduleId,
                }, moduleId, 'enable');
            } catch (error: unknown) {
                logger.error(`Failed to enable module ${req.params.moduleId}`, error);
                res.status(500).json({ error: getErrorMessage(error) });
            }
        }
    );

    /**
     * POST /admin/api/lifecycle/:moduleId/disable
     * Disable a module. Requires admin auth.
     * Returns 409 Conflict if other modules depend on this one.
     */
    adminRouter.post(
        '/lifecycle/:moduleId/disable',
        requireAdminAccountExists,
        requireAdminAuth,
        requireAdminCsrf,
        auditAdminAction,
        async (req, res) => {
            try {
                const moduleId = readRequestModuleId(req, res);
                if (!moduleId) return;
                const { disableModule, checkCanDisableModule } = await import('@modules/registry/server');
                const reason = req.body?.reason || 'Module disabled by admin';

                // Check if other modules depend on this one
                const depCheck = checkCanDisableModule(moduleId);
                if (!depCheck.canDisable) {
                    logger.warn(`Admin attempted to disable ${moduleId} with active dependents`, depCheck.violations);
                    return res.status(409).json({
                        success: false,
                        error: 'Cannot disable module because other modules depend on it',
                        violations: depCheck.violations || [],
                    });
                }

                const source = req.body?.source as ModuleSourceCategory | undefined;
                const success = disableModule(moduleId, reason, source);
                if (!success) {
                    return res.status(400).json({
                        success: false,
                        error: `Failed to disable module ${moduleId}. Module may be protected (e.g., generic).`,
                    });
                }

                logger.info(`[Admin] Module disabled: ${moduleId} (reason: ${reason})`);
                respondWithRuntimeRestart(res, {
                    success: true,
                    message: `Module ${moduleId} disabled`,
                    moduleId,
                    reason,
                }, moduleId, 'disable');
            } catch (error: unknown) {
                logger.error(`Failed to disable module ${req.params.moduleId}`, error);
                res.status(500).json({ error: getErrorMessage(error) });
            }
        }
    );

    /**
     * POST /admin/api/lifecycle/:moduleId/switch-source
     * Switch a module between its local dev version and managed install.
     *
     * Source switching changes executable runtime ownership and therefore uses
     * the same supervised restart boundary as install, upgrade, and uninstall.
     */
    adminRouter.post(
        '/lifecycle/:moduleId/switch-source',
        requireAdminAccountExists,
        requireAdminAuth,
        requireAdminCsrf,
        auditAdminAction,
        async (req, res) => {
            try {
                const moduleId = readRequestModuleId(req, res);
                if (!moduleId) return;
                const { source } = req.body as { source?: string };
                if (source !== ModuleSourceCategory.Local && source !== ModuleSourceCategory.Managed) {
                    return res.status(400).json({ success: false, error: `source must be "${ModuleSourceCategory.Local}" or "${ModuleSourceCategory.Managed}"` });
                }
                const { switchModuleSource } = await import('@modules/registry/server');
                const result = switchModuleSource(moduleId, source);
                if (!result.success) {
                    return res.status(400).json({ success: false, error: result.error });
                }
                respondWithRuntimeRestart(
                    res,
                    { success: true, moduleId, activeSource: source },
                    moduleId,
                    'switch-source',
                );
            } catch (error: unknown) {
                res.status(500).json({ error: getErrorMessage(error) });
            }
        }
    );

    function managerErrorStatusCode(errorCode?: string): number {
        if (!errorCode) return 400;
        if (errorCode === 'module-not-found') return 404;
        if (errorCode === 'remote-module-distribution-disabled') return 501;
        if (errorCode === 'source-resolution-failed') return 422;
        if (errorCode === 'trust-policy-blocked') return 403;
        if (errorCode === 'artifact-verification-failed') return 422;
        if (errorCode === 'permission-escalation-requires-approval') return 409;
        if (errorCode === 'update-policy-blocked') return 409;
        if (errorCode === 'precondition-failed' || errorCode === 'transition-rejected') return 409;
        if (errorCode === 'validation-failed') return 422;
        return 400;
    }

    const archiveBodyParser = express.raw({
        type: ['application/gzip', 'application/x-gzip', 'application/octet-stream'],
        limit: DEFAULT_MODULE_ARCHIVE_LIMITS.maxArchiveBytes,
    });

    function readSingleQueryValue(req: express.Request, name: string): string | undefined {
        const value = req.query[name];
        return typeof value === 'string' ? value.trim() || undefined : undefined;
    }

    function readBooleanQuery(req: express.Request, name: string): boolean {
        const value = readSingleQueryValue(req, name);
        if (value === undefined || value === 'false') return false;
        if (value === 'true') return true;
        throw new Error(`Query parameter ${name} must be true or false`);
    }

    function readArchiveTrustTier(req: express.Request): ModuleTrustTierValue | undefined {
        const value = readSingleQueryValue(req, 'trustTier');
        if (value === undefined) return undefined;
        if (
            value === ModuleTrustTier.FirstParty
            || value === ModuleTrustTier.VerifiedThirdParty
            || value === ModuleTrustTier.Unverified
        ) {
            return value;
        }
        throw new Error('Query parameter trustTier must be first-party, verified-third-party, or unverified');
    }

    function writeUploadedArchive(body: unknown): string {
        if (!Buffer.isBuffer(body)) {
            throw new TypeError('Archive body must use application/gzip or application/octet-stream');
        }
        if (body.length === 0) throw new RangeError('Archive body must not be empty');

        const directory = getDistArchivesDir();
        fs.mkdirSync(directory, { recursive: true });
        const directoryStat = fs.lstatSync(directory);
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
            throw new Error('Archive upload directory must be a physical directory');
        }
        const uploadPath = path.join(directory, `.admin-upload-${randomUUID()}.tgz`);
        const descriptor = fs.openSync(uploadPath, 'wx', 0o600);
        try {
            fs.writeFileSync(descriptor, body);
            fs.fsyncSync(descriptor);
            fs.closeSync(descriptor);
        } catch (error) {
            try { fs.closeSync(descriptor); } catch { /* descriptor may already be closed */ }
            try { fs.unlinkSync(uploadPath); } catch { /* original write error remains authoritative */ }
            throw error;
        }
        return uploadPath;
    }

    function registerArchiveRoute(
        routePath: string,
        operation: 'install' | 'upgrade',
        dryRun: boolean,
    ): void {
        adminRouter.post(
            routePath,
            requireAdminAccountExists,
            requireAdminAuth,
            requireAdminCsrf,
            auditAdminAction,
            archiveBodyParser,
            async (req, res) => {
                const moduleId = readRequestModuleId(req, res);
                if (!moduleId) return;

                let uploadPath: string | undefined;
                try {
                    uploadPath = writeUploadedArchive(req.body);
                    const input = {
                        archivePath: uploadPath,
                        expectedModuleId: moduleId,
                        sourceTrustTier: readArchiveTrustTier(req),
                        approveTrustOverride: readBooleanQuery(req, 'approveTrustOverride'),
                        approvePermissionEscalation: readBooleanQuery(req, 'approvePermissionEscalation'),
                    };
                    const { applyLocalModuleArchive, dryRunLocalModuleArchive } = await import('@modules/registry/server');

                    if (dryRun) {
                        const preview = await dryRunLocalModuleArchive(operation, input);
                        return res.json(preview);
                    }

                    const result = await applyLocalModuleArchive(operation, input);
                    if (!result.success) {
                        return res.status(managerErrorStatusCode(result.errorCode)).json(result);
                    }

                    respondWithRuntimeRestart(res, result, moduleId, operation);
                    return;
                } catch (error: unknown) {
                    const message = getErrorMessage(error);
                    if (error instanceof TypeError) {
                        return res.status(415).json({
                            success: false,
                            error: message,
                            errorCode: 'unsupported-media-type',
                        });
                    }
                    if (error instanceof RangeError || message.startsWith('Query parameter ')) {
                        return res.status(400).json({
                            success: false,
                            error: message,
                            errorCode: 'invalid-request',
                        });
                    }
                    logger.error(`Failed to process archive ${operation} for module ${moduleId}`, error);
                    return res.status(500).json({ error: message });
                } finally {
                    if (uploadPath) {
                        try {
                            fs.unlinkSync(uploadPath);
                        } catch (error) {
                            logger.warn(`Failed to remove staged admin archive ${path.basename(uploadPath)}: ${getErrorMessage(error)}`);
                        }
                    }
                }
            },
        );
    }

    registerArchiveRoute('/manager/:moduleId/archive/dry-run/install', 'install', true);
    registerArchiveRoute('/manager/:moduleId/archive/dry-run/upgrade', 'upgrade', true);
    registerArchiveRoute('/manager/:moduleId/archive/install', 'install', false);
    registerArchiveRoute('/manager/:moduleId/archive/upgrade', 'upgrade', false);

    function readBooleanBody(req: express.Request, name: string): boolean {
        const value = req.body?.[name];
        if (value === undefined || value === false) return false;
        if (value === true) return true;
        throw new TypeError(`Body property ${name} must be true or false`);
    }

    function registerPublicReleaseRoute(
        routePath: string,
        operation: 'install' | 'upgrade',
        dryRun: boolean,
    ): void {
        adminRouter.post(
            routePath,
            requireAdminAccountExists,
            requireAdminAuth,
            requireAdminCsrf,
            auditAdminAction,
            async (req, res) => {
                const moduleId = readRequestModuleId(req, res);
                if (!moduleId) return;

                try {
                    const manifestUrl = typeof req.body?.manifestUrl === 'string'
                        ? req.body.manifestUrl.trim()
                        : '';
                    const repository = typeof req.body?.repository === 'string'
                        ? req.body.repository.trim()
                        : '';
                    if (Boolean(manifestUrl) === Boolean(repository)) {
                        throw new TypeError('Provide exactly one of manifestUrl or repository');
                    }

                    const releaseOperations = await import('@modules/registry/server');
                    const resolvedManifestUrl = repository
                        ? releaseOperations.resolvePublicGithubRepositoryManifestUrl(repository)
                        : manifestUrl;
                    const input = {
                        manifestUrl: resolvedManifestUrl,
                        expectedModuleId: moduleId,
                        policy: {
                            allowedHosts: getConfig().security.sourceGovernance?.hostAllowlist || [],
                        },
                        approveTrustOverride: readBooleanBody(req, 'approveTrustOverride'),
                        approvePermissionEscalation: readBooleanBody(req, 'approvePermissionEscalation'),
                        approveDowngrade: readBooleanBody(req, 'approveDowngrade'),
                    };

                    if (dryRun) {
                        const preview = await releaseOperations.dryRunPublicModuleRelease(operation, input);
                        return res.json(preview);
                    }

                    const result = await releaseOperations.applyPublicModuleRelease(operation, input);
                    if (!result.success) {
                        return res.status(managerErrorStatusCode(result.errorCode)).json(result);
                    }
                    respondWithRuntimeRestart(res, result, moduleId, operation);
                    return;
                } catch (error: unknown) {
                    const message = getErrorMessage(error);
                    if (error instanceof TypeError) {
                        return res.status(400).json({
                            success: false,
                            error: message,
                            errorCode: 'invalid-request',
                        });
                    }
                    logger.error(`Failed to process public release ${operation} for module ${moduleId}`, error);
                    return res.status(500).json({ error: message });
                }
            },
        );
    }

    registerPublicReleaseRoute('/manager/:moduleId/release/dry-run/install', 'install', true);
    registerPublicReleaseRoute('/manager/:moduleId/release/dry-run/upgrade', 'upgrade', true);
    registerPublicReleaseRoute('/manager/:moduleId/release/install', 'install', false);
    registerPublicReleaseRoute('/manager/:moduleId/release/upgrade', 'upgrade', false);

    function summarizeUpdatePolicy(artifact: {
        moduleId: string;
        version: string;
        sourceProfileId?: string;
        updatePolicy?: { locked: boolean; pinnedVersion?: string };
    }) {
        return {
            moduleId: artifact.moduleId,
            installedVersion: artifact.version,
            sourceProfileId: artifact.sourceProfileId,
            updatePolicy: artifact.updatePolicy || { locked: false },
        };
    }

    adminRouter.get(
        '/manager/:moduleId/update-policy',
        requireAdminAccountExists,
        requireAdminAuth,
        async (req, res) => {
            const moduleId = readRequestModuleId(req, res);
            if (!moduleId) return;
            const { getManagedModuleArtifact } = await import('@modules/registry/server');
            const artifact = getManagedModuleArtifact(moduleId);
            if (!artifact) return res.status(404).json({ error: 'Managed module artifact not found' });
            return res.json({ success: true, ...summarizeUpdatePolicy(artifact) });
        },
    );

    adminRouter.put(
        '/manager/:moduleId/update-policy',
        requireAdminAccountExists,
        requireAdminAuth,
        requireAdminCsrf,
        auditAdminAction,
        async (req, res) => {
            const moduleId = readRequestModuleId(req, res);
            if (!moduleId) return;
            try {
                if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
                    throw new TypeError('Update policy body must be an object');
                }
                const body = req.body as Record<string, unknown>;
                const keys = Object.keys(body);
                if (keys.length === 0 || keys.some((key) => key !== 'locked' && key !== 'pinnedVersion')) {
                    throw new TypeError('Provide locked and/or pinnedVersion only');
                }
                const updates = {
                    ...(body.locked !== undefined ? { locked: body.locked as boolean } : {}),
                    ...(body.pinnedVersion !== undefined
                        ? { pinnedVersion: body.pinnedVersion as string | null }
                        : {}),
                };
                const { updateManagedModulePolicy } = await import('@modules/registry/server');
                const artifact = updateManagedModulePolicy(moduleId, updates);
                if (!artifact) return res.status(404).json({ error: 'Managed module artifact not found' });
                return res.json({ success: true, ...summarizeUpdatePolicy(artifact) });
            } catch (error: unknown) {
                return res.status(400).json({ error: getErrorMessage(error) });
            }
        },
    );

    /**
     * POST /admin/api/manager/:moduleId/dry-run/install
     * Preview install impact (no mutation).
     */
    adminRouter.post(
        '/manager/:moduleId/dry-run/install',
        requireAdminAccountExists,
        requireAdminAuth,
        requireAdminCsrf,
        auditAdminAction,
        async (req, res) => {
            try {
                const moduleId = readRequestModuleId(req, res);
                if (!moduleId) return;
                const source = typeof req.body?.source === 'string' ? req.body.source : `local://${moduleId}`;
                const version = typeof req.body?.version === 'string' ? req.body.version : undefined;
                const integrity = typeof req.body?.integrity === 'string' ? req.body.integrity : undefined;
                const signature = typeof req.body?.signature === 'string' ? req.body.signature : undefined;
                const permissions = typeof req.body?.permissions === 'object' ? req.body.permissions : undefined;

                const { dryRunInstallManagedModule } = await import('@modules/registry/server');
                const preview = await dryRunInstallManagedModule({
                    moduleId,
                    source,
                    version,
                    integrity,
                    signature,
                    permissions,
                });

                res.json(preview);
            } catch (error: unknown) {
                logger.error(`Failed to dry-run install for module ${req.params.moduleId}`, error);
                res.status(500).json({ error: getErrorMessage(error) });
            }
        }
    );

    /**
     * POST /admin/api/manager/:moduleId/dry-run/upgrade
     * Preview upgrade impact (no mutation).
     */
    adminRouter.post(
        '/manager/:moduleId/dry-run/upgrade',
        requireAdminAccountExists,
        requireAdminAuth,
        requireAdminCsrf,
        auditAdminAction,
        async (req, res) => {
            try {
                const moduleId = readRequestModuleId(req, res);
                if (!moduleId) return;
                const source = typeof req.body?.source === 'string' ? req.body.source : `local://${moduleId}`;
                const targetVersion = typeof req.body?.targetVersion === 'string'
                    ? req.body.targetVersion
                    : undefined;
                const integrity = typeof req.body?.integrity === 'string' ? req.body.integrity : undefined;
                const signature = typeof req.body?.signature === 'string' ? req.body.signature : undefined;
                const permissions = typeof req.body?.permissions === 'object' ? req.body.permissions : undefined;
                const approvePermissionEscalation = req.body?.approvePermissionEscalation === true;

                const { dryRunUpgradeManagedModule } = await import('@modules/registry/server');
                const preview = await dryRunUpgradeManagedModule({
                    moduleId,
                    source,
                    targetVersion,
                    integrity,
                    signature,
                    permissions,
                    approvePermissionEscalation,
                });

                res.json(preview);
            } catch (error: unknown) {
                logger.error(`Failed to dry-run upgrade for module ${req.params.moduleId}`, error);
                res.status(500).json({ error: getErrorMessage(error) });
            }
        }
    );

    /**
     * POST /admin/api/manager/:moduleId/install
     * Install a discovered module and transition it through installed->validated.
     */
    adminRouter.post(
        '/manager/:moduleId/install',
        requireAdminAccountExists,
        requireAdminAuth,
        requireAdminCsrf,
        auditAdminAction,
        async (req, res) => {
            try {
                const moduleId = readRequestModuleId(req, res);
                if (!moduleId) return;
                const source = typeof req.body?.source === 'string' ? req.body.source : `local://${moduleId}`;
                const version = typeof req.body?.version === 'string' ? req.body.version : undefined;
                const integrity = typeof req.body?.integrity === 'string' ? req.body.integrity : undefined;
                const signature = typeof req.body?.signature === 'string' ? req.body.signature : undefined;
                const permissions = typeof req.body?.permissions === 'object' ? req.body.permissions : undefined;

                const { installManagedModule } = await import('@modules/registry/server');
                const result = await installManagedModule({ moduleId, source, version, integrity, signature, permissions });
                if (!result.success) {
                    return res.status(managerErrorStatusCode(result.errorCode)).json({
                        success: false,
                        moduleId,
                        operation: 'install',
                        errorCode: result.errorCode,
                        error: result.error,
                        previousStatus: result.previousStatus,
                    });
                }

                respondWithRuntimeRestart(res, {
                    success: true,
                    moduleId,
                    operation: 'install',
                    previousStatus: result.previousStatus,
                    newStatus: result.newStatus,
                }, moduleId, 'install');
            } catch (error: unknown) {
                logger.error(`Failed to install module ${req.params.moduleId}`, error);
                res.status(500).json({ error: getErrorMessage(error) });
            }
        }
    );

    /**
     * POST /admin/api/manager/:moduleId/uninstall
     * Uninstall a module and remove its artifact metadata.
     */
    adminRouter.post(
        '/manager/:moduleId/uninstall',
        requireAdminAccountExists,
        requireAdminAuth,
        requireAdminCsrf,
        auditAdminAction,
        async (req, res) => {
            try {
                const moduleId = readRequestModuleId(req, res);
                if (!moduleId) return;

                const { uninstallManagedModule } = await import('@modules/registry/server');
                const result = uninstallManagedModule(moduleId);
                if (!result.success) {
                    return res.status(managerErrorStatusCode(result.errorCode)).json({
                        success: false,
                        moduleId,
                        operation: 'uninstall',
                        errorCode: result.errorCode,
                        error: result.error,
                        previousStatus: result.previousStatus,
                    });
                }

                respondWithRuntimeRestart(res, {
                    success: true,
                    moduleId,
                    operation: 'uninstall',
                    previousStatus: result.previousStatus,
                    newStatus: result.newStatus,
                }, moduleId, 'uninstall');
            } catch (error: unknown) {
                logger.error(`Failed to uninstall module ${req.params.moduleId}`, error);
                res.status(500).json({ error: getErrorMessage(error) });
            }
        }
    );

    /**
     * POST /admin/api/manager/:moduleId/upgrade
     * Upgrade a module and re-validate it under transition policy.
     */
    adminRouter.post(
        '/manager/:moduleId/upgrade',
        requireAdminAccountExists,
        requireAdminAuth,
        requireAdminCsrf,
        auditAdminAction,
        async (req, res) => {
            try {
                const moduleId = readRequestModuleId(req, res);
                if (!moduleId) return;
                const source = typeof req.body?.source === 'string' ? req.body.source : `local://${moduleId}`;
                const targetVersion = typeof req.body?.targetVersion === 'string'
                    ? req.body.targetVersion
                    : undefined;
                const integrity = typeof req.body?.integrity === 'string' ? req.body.integrity : undefined;
                const signature = typeof req.body?.signature === 'string' ? req.body.signature : undefined;
                const permissions = typeof req.body?.permissions === 'object' ? req.body.permissions : undefined;
                const approvePermissionEscalation = req.body?.approvePermissionEscalation === true;

                const { upgradeManagedModule } = await import('@modules/registry/server');
                const result = await upgradeManagedModule({
                    moduleId,
                    source,
                    targetVersion,
                    integrity,
                    signature,
                    permissions,
                    approvePermissionEscalation,
                });
                if (!result.success) {
                    return res.status(managerErrorStatusCode(result.errorCode)).json({
                        success: false,
                        moduleId,
                        operation: 'upgrade',
                        errorCode: result.errorCode,
                        error: result.error,
                        previousStatus: result.previousStatus,
                    });
                }

                respondWithRuntimeRestart(res, {
                    success: true,
                    moduleId,
                    operation: 'upgrade',
                    previousStatus: result.previousStatus,
                    newStatus: result.newStatus,
                }, moduleId, 'upgrade');
            } catch (error: unknown) {
                logger.error(`Failed to upgrade module ${req.params.moduleId}`, error);
                res.status(500).json({ error: getErrorMessage(error) });
            }
        }
    );

    /**
     * POST /admin/api/manager/:moduleId/validate
     * Re-run strict manifest+compatibility validation for a module.
     */
    adminRouter.post(
        '/manager/:moduleId/validate',
        requireAdminAccountExists,
        requireAdminAuth,
        requireAdminCsrf,
        auditAdminAction,
        async (req, res) => {
            try {
                const moduleId = readRequestModuleId(req, res);
                if (!moduleId) return;

                const source = req.body?.source as ModuleSourceCategory | undefined;

                const { validateManagedModule } = await import('@modules/registry/server');
                const result = validateManagedModule(moduleId, source);
                if (!result.success) {
                    return res.status(managerErrorStatusCode(result.errorCode)).json({
                        success: false,
                        moduleId,
                        operation: 'validate',
                        errorCode: result.errorCode,
                        error: result.error,
                        previousStatus: result.previousStatus,
                    });
                }

                res.json({
                    success: true,
                    moduleId,
                    operation: 'validate',
                    previousStatus: result.previousStatus,
                    newStatus: result.newStatus,
                });
            } catch (error: unknown) {
                logger.error(`Failed to validate module ${req.params.moduleId}`, error);
                res.status(500).json({ error: getErrorMessage(error) });
            }
        }
    );

    // ============
    // Public Catalog Sources
    // ============

    function configuredCatalogPolicy() {
        return {
            allowedHosts: getConfig().security.sourceGovernance?.hostAllowlist || [],
        };
    }

    function assertConfiguredCatalogUrl(value: unknown): string {
        if (typeof value !== 'string' || !value.trim()) throw new TypeError('baseUrl is required');
        let url: URL;
        try {
            url = new URL(value.trim());
        } catch {
            throw new TypeError('Catalog URL is invalid');
        }
        if (url.protocol !== 'https:' || url.username || url.password) {
            throw new TypeError('Catalog URL must use HTTPS without credentials');
        }
        if (!isDistributionHostAllowed(url.hostname, configuredCatalogPolicy().allowedHosts)) {
            throw new RangeError(`Catalog host "${url.hostname}" is not in the configured allowlist`);
        }
        return url.href;
    }

    function catalogWriteInput(body: unknown, partial = false) {
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            throw new TypeError('Catalog request body must be an object');
        }
        const value = body as Record<string, unknown>;
        for (const forbidden of ['auth', 'kind', 'trustTier']) {
            if (forbidden in value) throw new TypeError(`Catalog property ${forbidden} is not accepted`);
        }
        return {
            ...(!partial || value.name !== undefined ? { name: String(value.name || '') } : {}),
            ...(!partial || value.baseUrl !== undefined
                ? { baseUrl: assertConfiguredCatalogUrl(value.baseUrl) }
                : {}),
            ...(value.enabled !== undefined ? { enabled: value.enabled as boolean } : {}),
            ...(value.priority !== undefined ? { priority: value.priority as number } : {}),
        };
    }

    adminRouter.get('/sources', requireAdminAccountExists, requireAdminAuth, async (_req, res) => {
        try {
            const { loadSourceProfiles, redactSourceProfile } = await import('@modules/registry/distribution/sourceProfiles');
            return res.json({
                success: true,
                profiles: loadSourceProfiles().map(redactSourceProfile),
            });
        } catch (error: unknown) {
            return res.status(500).json({ error: getErrorMessage(error) });
        }
    });

    adminRouter.post('/sources', requireAdminAccountExists, requireAdminAuth, requireAdminCsrf, auditAdminAction, async (req, res) => {
        try {
            const { createSourceProfile, redactSourceProfile } = await import('@modules/registry/distribution/sourceProfiles');
            const input = catalogWriteInput(req.body);
            if (!input.name || !input.baseUrl) throw new TypeError('name and baseUrl are required');
            const created = createSourceProfile({ ...input, name: input.name, baseUrl: input.baseUrl });
            return res.json({ success: true, profile: redactSourceProfile(created) });
        } catch (error: unknown) {
            const status = error instanceof RangeError ? 403 : 400;
            return res.status(status).json({ error: getErrorMessage(error) });
        }
    });

    adminRouter.put('/sources/:id', requireAdminAccountExists, requireAdminAuth, requireAdminCsrf, auditAdminAction, async (req, res) => {
        try {
            const sourceId = String(req.params.id || '');
            const { updateSourceProfile, redactSourceProfile } = await import('@modules/registry/distribution/sourceProfiles');
            const updated = updateSourceProfile(sourceId, catalogWriteInput(req.body, true));
            if (!updated) return res.status(404).json({ error: 'Source profile not found' });
            return res.json({ success: true, profile: redactSourceProfile(updated) });
        } catch (error: unknown) {
            const status = error instanceof RangeError ? 403 : 400;
            return res.status(status).json({ error: getErrorMessage(error) });
        }
    });

    adminRouter.delete('/sources/:id', requireAdminAccountExists, requireAdminAuth, requireAdminCsrf, auditAdminAction, async (req, res) => {
        try {
            const { deleteSourceProfile } = await import('@modules/registry/distribution/sourceProfiles');
            const deleted = deleteSourceProfile(String(req.params.id || ''));
            if (!deleted) return res.status(404).json({ error: 'Source profile not found' });
            return res.json({ success: true });
        } catch (error: unknown) {
            return res.status(400).json({ error: getErrorMessage(error) });
        }
    });

    adminRouter.post('/sources/:id/test', requireAdminAccountExists, requireAdminAuth, requireAdminCsrf, auditAdminAction, async (req, res) => {
        try {
            const { getSourceProfile } = await import('@modules/registry/distribution/sourceProfiles');
            const { fetchPublicCatalog } = await import('@modules/registry/distribution/publicCatalogService');
            const profile = getSourceProfile(String(req.params.id || ''));
            if (!profile) return res.status(404).json({ error: 'Source profile not found' });
            const result = await fetchPublicCatalog(profile, configuredCatalogPolicy(), { forceRefresh: true });
            if (result.state === 'error') return res.status(422).json({ success: false, ...result });
            return res.json({ success: true, ...result, moduleCount: Object.keys(result.index?.modules || {}).length });
        } catch (error: unknown) {
            return res.status(400).json({ error: getErrorMessage(error) });
        }
    });

    adminRouter.get('/sources/:id/modules', requireAdminAccountExists, requireAdminAuth, async (req, res) => {
        try {
            const { getSourceProfile } = await import('@modules/registry/distribution/sourceProfiles');
            const { fetchPublicCatalog } = await import('@modules/registry/distribution/publicCatalogService');
            const profile = getSourceProfile(String(req.params.id || ''));
            if (!profile) return res.status(404).json({ error: 'Source profile not found' });
            const result = await fetchPublicCatalog(profile, configuredCatalogPolicy());
            return res.json({
                success: result.state !== 'error',
                source: result,
                modules: result.index?.modules || {},
            });
        } catch (error: unknown) {
            return res.status(400).json({ error: getErrorMessage(error) });
        }
    });

    adminRouter.get('/catalog', requireAdminAccountExists, requireAdminAuth, async (req, res) => {
        try {
            const { loadSourceProfiles } = await import('@modules/registry/distribution/sourceProfiles');
            const { aggregatePublicCatalogs } = await import('@modules/registry/distribution/publicCatalogService');
            const forceRefresh = req.query.refresh === 'true';
            const result = await aggregatePublicCatalogs(
                loadSourceProfiles(),
                configuredCatalogPolicy(),
                { forceRefresh },
            );
            return res.json({ success: true, ...result });
        } catch (error: unknown) {
            return res.status(500).json({ error: getErrorMessage(error) });
        }
    });

    async function resolveCatalogRelease(
        sourceId: string,
        moduleId: string,
        selectedVersion?: string,
    ) {
        const { getSourceProfile } = await import('@modules/registry/distribution/sourceProfiles');
        const { fetchPublicCatalog } = await import('@modules/registry/distribution/publicCatalogService');
        const releaseOperations = await import('@modules/registry/server');
        const profile = getSourceProfile(sourceId);
        if (!profile) throw new RangeError('Source profile not found');

        const catalog = await fetchPublicCatalog(profile, configuredCatalogPolicy());
        if (!catalog.index) {
            throw new Error(catalog.error || 'Catalog is unavailable');
        }
        const entry = catalog.index.modules[moduleId];
        if (!entry) throw new RangeError('Module not found in source catalog');

        const baseInput = {
            manifestUrl: entry.manifest,
            expectedModuleId: moduleId,
            policy: configuredCatalogPolicy(),
            sourceTrustTier: profile.trustTier || ModuleTrustTier.Unverified,
            sourceProfileId: profile.id,
        };
        const history = await releaseOperations.inspectPublicModuleReleaseHistory(baseInput);
        const target = releaseOperations.resolvePublicModuleReleaseTarget(history, selectedVersion);
        const input = {
            ...baseInput,
            manifestUrl: target.manifest,
            expectedVersion: target.version,
        };
        const inspected = target.version === history.latest.version
            ? { summary: history.latest }
            : await releaseOperations.inspectPublicModuleRelease(input);

        return { history, input, profile, release: inspected.summary };
    }

    adminRouter.get(
        '/sources/:sourceId/modules/:moduleId/release',
        requireAdminAccountExists,
        requireAdminAuth,
        async (req, res) => {
            const moduleId = readRequestModuleId(req, res);
            if (!moduleId) return;
            try {
                const sourceId = String(req.params.sourceId || '');
                const selectedVersion = typeof req.query?.version === 'string'
                    ? req.query.version
                    : undefined;
                const resolved = await resolveCatalogRelease(sourceId, moduleId, selectedVersion);
                return res.json({
                    success: true,
                    sourceId,
                    release: resolved.release,
                    historyAvailable: resolved.history.historyAvailable,
                    historyUrl: resolved.history.historyUrl,
                    historyError: resolved.history.historyError,
                    releases: resolved.history.compatibleReleases.map((entry) => ({ version: entry.version })),
                });
            } catch (error: unknown) {
                const status = error instanceof RangeError ? 404 : 422;
                return res.status(status).json({ success: false, error: getErrorMessage(error) });
            }
        },
    );

    function registerCatalogReleaseRoute(
        routePath: string,
        operation: 'install' | 'upgrade',
        dryRun: boolean,
    ): void {
        adminRouter.post(
            routePath,
            requireAdminAccountExists,
            requireAdminAuth,
            requireAdminCsrf,
            auditAdminAction,
            async (req, res) => {
                const moduleId = readRequestModuleId(req, res);
                if (!moduleId) return;
                try {
                    const sourceId = String(req.params.sourceId || '');
                    const selectedVersion = typeof req.body?.version === 'string'
                        ? req.body.version
                        : undefined;
                    const resolved = await resolveCatalogRelease(sourceId, moduleId, selectedVersion);
                    const input = {
                        ...resolved.input,
                        approveTrustOverride: readBooleanBody(req, 'approveTrustOverride'),
                        approvePermissionEscalation: readBooleanBody(req, 'approvePermissionEscalation'),
                        approveDowngrade: readBooleanBody(req, 'approveDowngrade'),
                    };
                    const releaseOperations = await import('@modules/registry/server');
                    if (dryRun) {
                        const preview = await releaseOperations.dryRunPublicModuleRelease(operation, input);
                        return res.json({ ...preview, sourceId });
                    }

                    const result = await releaseOperations.applyPublicModuleRelease(operation, input);
                    if (!result.success) {
                        return res.status(managerErrorStatusCode(result.errorCode)).json({ ...result, sourceId });
                    }
                    respondWithRuntimeRestart(res, { ...result, sourceId }, moduleId, operation);
                    return;
                } catch (error: unknown) {
                    const message = getErrorMessage(error);
                    if (error instanceof TypeError || error instanceof RangeError) {
                        const status = error instanceof RangeError ? 404 : 400;
                        return res.status(status).json({ success: false, error: message, errorCode: 'invalid-request' });
                    }
                    return res.status(422).json({ success: false, error: message });
                }
            },
        );
    }

    registerCatalogReleaseRoute('/sources/:sourceId/modules/:moduleId/dry-run/install', 'install', true);
    registerCatalogReleaseRoute('/sources/:sourceId/modules/:moduleId/dry-run/upgrade', 'upgrade', true);
    registerCatalogReleaseRoute('/sources/:sourceId/modules/:moduleId/install', 'install', false);
    registerCatalogReleaseRoute('/sources/:sourceId/modules/:moduleId/upgrade', 'upgrade', false);

    /**
     * POST /admin/api/server/restart
     *
     * Gracefully restarts the Core Service process. The response is flushed
     * before the process exits so the client receives confirmation. PM2,
     * systemd, or any other process supervisor will restart the process
     * automatically.
     *
     * Clients should watch for socket reconnection and reload the page once
     * the server is back up — the admin panel handles this automatically.
     *
     * Exit code 75 is handled by start-server.ts as a full managed-stack restart,
     * covering both Core adapter code and the application shell.
     */
    adminRouter.post(
        '/server/restart',
        requireAdminAccountExists,
        requireAdminAuth,
        requireAdminCsrf,
        auditAdminAction,
        (_req, res) => {
            res.json({ success: true, message: 'Server is restarting', restartScheduled: true });
            opts.requestServerRestart('admin-requested-restart');
        }
    );

}
