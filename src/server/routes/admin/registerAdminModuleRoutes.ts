/**
 * Admin module-lifecycle + source-profile endpoints. Carved out of the
 * monolithic createAdminRouter.ts per ADR-0022 Phase 4.
 *
 * Owns:
 *   - GET    /lifecycle
 *   - POST   /modules/:id/enable, /modules/:id/disable, /modules/:id/switch-source
 *   - POST   /modules/install, /modules/upgrade, /modules/uninstall, /modules/validate
 *   - POST   /modules/dry-run-install, /modules/dry-run-upgrade
 *   - POST   /admin/restart-server
 *   - GET    /sources, /sources/:id/modules
 *   - POST   /sources, /sources/:id/test
 *   - PUT    /sources/:id
 *   - DELETE /sources/:id
 */
import express from 'express';
import { logger } from '@shared/utils/logger';
import { requireAdminAuth, auditAdminAction } from '@server/middleware/requireAdminAuth';
import { requireAdminCsrf } from '@server/middleware/requireAdminCsrf';
import { ModuleSourceCategory } from '@shared/types/modules';
import { getConfig } from '@server/core/config';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';

export interface RegisterAdminModuleRoutesOptions {
    adminRouter: express.Router;
    requireAdminAccountExists: express.RequestHandler;
    broadcastToClients: (event: string, data: unknown) => void;
}

export function registerAdminModuleRoutes(opts: RegisterAdminModuleRoutesOptions): void {
    const { adminRouter, requireAdminAccountExists } = opts;
    // Inline alias keeps the extracted handlers unchanged from their original
    // shape — they reference `deps.broadcastToClients` literally.
    const deps = { broadcastToClients: opts.broadcastToClients };

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
                            // Validation diagnostics from lifecycle record
                            validation: m.lifecycle.validation ? {
                                manifestValid: m.lifecycle.validation.manifestValid,
                                diagnostics: [
                                    // Map core constraint diagnostics
                                    ...(m.lifecycle.validation.coreDiagnostics || []).map(d => ({
                                        code: `core:${d.constraint}`,
                                        message: d.reason || (d.compatible ? 'Constraint satisfied' : `Constraint ${d.constraint} not satisfied`),
                                        severity: d.compatible ? 'info' : 'error',
                                    })),
                                    // Map contract diagnostics
                                    ...(m.lifecycle.validation.contractDiagnostics || []).map(d => ({
                                        code: `contract:${d.contract}`,
                                        message: d.reason || (d.compatible ? `${d.contract} ${d.providedVersion || ''} satisfies ${d.requiredRange}` : `${d.contract} incompatible`),
                                        severity: d.compatible ? 'info' : 'error',
                                    })),
                                    // Map validation errors as simple diagnostics
                                    ...(m.lifecycle.validation.validationErrors || []).map(e => ({
                                        code: 'manifest-error',
                                        message: e,
                                        severity: 'error' as const,
                                    })),
                                ],
                            } : undefined,
                            artifact: m.artifact,
                            activeSource: m.lifecycle.activeSource,
                            localDirectory: m.lifecycle.localDirectory,
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
                const moduleId = Array.isArray(req.params.moduleId)
                    ? req.params.moduleId[0]
                    : req.params.moduleId;
                const { enableModule, checkCanEnableModule } = await import('@modules/registry/server');

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
                    return res.status(400).json({
                        success: false,
                        error: `Failed to enable module ${moduleId}. Module may be incompatible or invalid.`,
                    });
                }

                logger.info(`[Admin] Module enabled: ${moduleId}`);
                // Notify clients so open actor pages can re-resolve their module UI.
                deps.broadcastToClients('moduleStateChanged', { moduleId, enabled: true });
                res.json({
                    success: true,
                    message: `Module ${moduleId} enabled`,
                    moduleId,
                });
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
                const moduleId = Array.isArray(req.params.moduleId)
                    ? req.params.moduleId[0]
                    : req.params.moduleId;
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
                // Notify clients so open actor pages fall back to generic immediately.
                deps.broadcastToClients('moduleStateChanged', { moduleId, enabled: false });
                res.json({
                    success: true,
                    message: `Module ${moduleId} disabled`,
                    moduleId,
                    reason,
                });
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
     * After the registry is updated server-side, a 'moduleSourceChanged' socket
     * event is broadcast to all connected clients. Any client currently viewing
     * an actor whose system matches this moduleId will automatically re-resolve
     * and reload its module UI from the new source without a page refresh.
     */
    adminRouter.post(
        '/lifecycle/:moduleId/switch-source',
        requireAdminAccountExists, requireAdminAuth,
        async (req, res) => {
            try {
                const moduleId = String(req.params.moduleId);
                const { source } = req.body as { source?: string };
                if (source !== ModuleSourceCategory.Local && source !== ModuleSourceCategory.Managed) {
                    return res.status(400).json({ success: false, error: `source must be "${ModuleSourceCategory.Local}" or "${ModuleSourceCategory.Managed}"` });
                }
                const { switchModuleSource } = await import('@modules/registry/server');
                const result = switchModuleSource(moduleId, source);
                if (!result.success) {
                    return res.status(400).json({ success: false, error: result.error });
                }
                // Push the change to all connected clients. Clients use this to
                // invalidate their cached source-map and reload the module UI if
                // they are currently rendering an actor for this system.
                deps.broadcastToClients('moduleSourceChanged', { moduleId, source });
                res.json({ success: true, moduleId, activeSource: source });
            } catch (error: unknown) {
                res.status(500).json({ error: getErrorMessage(error) });
            }
        }
    );

    function managerErrorStatusCode(errorCode?: string): number {
        if (!errorCode) return 400;
        if (errorCode === 'module-not-found') return 404;
        if (errorCode === 'source-resolution-failed') return 422;
        if (errorCode === 'trust-policy-blocked') return 403;
        if (errorCode === 'artifact-verification-failed') return 422;
        if (errorCode === 'permission-escalation-requires-approval') return 409;
        if (errorCode === 'precondition-failed' || errorCode === 'transition-rejected') return 409;
        if (errorCode === 'validation-failed') return 422;
        return 400;
    }

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
                const moduleId = Array.isArray(req.params.moduleId)
                    ? req.params.moduleId[0]
                    : req.params.moduleId;
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
                const moduleId = Array.isArray(req.params.moduleId)
                    ? req.params.moduleId[0]
                    : req.params.moduleId;
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
                const moduleId = Array.isArray(req.params.moduleId)
                    ? req.params.moduleId[0]
                    : req.params.moduleId;
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

                // Bust client source-map cache so getUIModule picks up the new install.
                deps.broadcastToClients('moduleRegistryChanged', { moduleId, operation: 'install' });
                res.json({
                    success: true,
                    moduleId,
                    operation: 'install',
                    previousStatus: result.previousStatus,
                    newStatus: result.newStatus,
                });
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
                const moduleId = Array.isArray(req.params.moduleId)
                    ? req.params.moduleId[0]
                    : req.params.moduleId;

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

                deps.broadcastToClients('moduleRegistryChanged', { moduleId, operation: 'uninstall' });
                res.json({
                    success: true,
                    moduleId,
                    operation: 'uninstall',
                    previousStatus: result.previousStatus,
                    newStatus: result.newStatus,
                });
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
                const moduleId = Array.isArray(req.params.moduleId)
                    ? req.params.moduleId[0]
                    : req.params.moduleId;
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

                deps.broadcastToClients('moduleRegistryChanged', { moduleId, operation: 'upgrade' });
                res.json({
                    success: true,
                    moduleId,
                    operation: 'upgrade',
                    previousStatus: result.previousStatus,
                    newStatus: result.newStatus,
                });
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
                const moduleId = Array.isArray(req.params.moduleId)
                    ? req.params.moduleId[0]
                    : req.params.moduleId;

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
    // Source Profiles
    // ============

    adminRouter.get('/sources', requireAdminAccountExists, requireAdminAuth, async (req, res) => {
        try {
            const { loadSourceProfiles } = await import('@modules/registry/distribution/sourceProfiles');
            res.json({ success: true, profiles: loadSourceProfiles() });
        } catch (error: unknown) {
            res.status(500).json({ error: getErrorMessage(error) });
        }
    });

    adminRouter.post('/sources', requireAdminAccountExists, requireAdminAuth, requireAdminCsrf, auditAdminAction, async (req, res) => {
        try {
            const { createSourceProfile } = await import('@modules/registry/distribution/sourceProfiles');
            const { isHostAllowed } = await import('@modules/registry/security/sourceGovernance');
            
            const profile = req.body;
            if (!profile || !profile.baseUrl) {
                return res.status(400).json({ error: 'baseUrl is required' });
            }

            const allowlist = getConfig().security.sourceGovernance?.hostAllowlist;
            const mode = process.env.NODE_ENV === 'production' ? 'production' : 'development';
            if (!isHostAllowed(String(profile.baseUrl), allowlist, mode)) {
                return res.status(403).json({ error: 'Host is not in the configured allowlist' });
            }

            const created = createSourceProfile(profile);
            res.json({ success: true, profile: created });
        } catch (error: unknown) {
            res.status(500).json({ error: getErrorMessage(error) });
        }
    });

    adminRouter.put('/sources/:id', requireAdminAccountExists, requireAdminAuth, requireAdminCsrf, auditAdminAction, async (req, res) => {
        try {
            const { updateSourceProfile } = await import('@modules/registry/distribution/sourceProfiles');
            const { isHostAllowed } = await import('@modules/registry/security/sourceGovernance');

            const id = req.params.id as string;
            const updates = req.body;

            if (updates.baseUrl) {
                const allowlist = getConfig().security.sourceGovernance?.hostAllowlist;
                const mode = process.env.NODE_ENV === 'production' ? 'production' : 'development';
                if (!isHostAllowed(String(updates.baseUrl), allowlist, mode)) {
                    return res.status(403).json({ error: 'Host is not in the configured allowlist' });
                }
            }

            const updated = updateSourceProfile(id, updates);
            if (!updated) {
                return res.status(404).json({ error: 'Source profile not found' });
            }

            res.json({ success: true, profile: updated });
        } catch (error: unknown) {
            res.status(500).json({ error: getErrorMessage(error) });
        }
    });

    adminRouter.delete('/sources/:id', requireAdminAccountExists, requireAdminAuth, requireAdminCsrf, auditAdminAction, async (req, res) => {
        try {
            const { deleteSourceProfile } = await import('@modules/registry/distribution/sourceProfiles');
            const id = req.params.id as string;
            const deleted = deleteSourceProfile(id);
            if (!deleted) {
                return res.status(400).json({ error: 'Source profile not found or cannot be deleted' });
            }
            res.json({ success: true });
        } catch (error: unknown) {
            res.status(500).json({ error: getErrorMessage(error) });
        }
    });

    adminRouter.post('/sources/:id/test', requireAdminAccountExists, requireAdminAuth, requireAdminCsrf, auditAdminAction, async (req, res) => {
        try {
            const { getSourceProfile } = await import('@modules/registry/distribution/sourceProfiles');
            const { fetchRemoteIndex } = await import('@modules/registry/distribution/remoteIndexFetcher');
            const { isHostAllowed } = await import('@modules/registry/security/sourceGovernance');

            const id = req.params.id as string;
            const profile = getSourceProfile(id);
            if (!profile) {
                return res.status(404).json({ error: 'Source profile not found' });
            }

            if (profile.kind !== 'indexed') {
                return res.status(400).json({ error: 'Can only test connection for "indexed" source profiles' });
            }

            const allowlist = getConfig().security.sourceGovernance?.hostAllowlist;
            const mode = process.env.NODE_ENV === 'production' ? 'production' : 'development';
            if (!isHostAllowed(String(profile.baseUrl), allowlist, mode)) {
                return res.status(403).json({ error: 'Host is not in the configured allowlist' });
            }

            const result = await fetchRemoteIndex(profile.baseUrl, { auth: profile.auth });
            
            if (!result.ok) {
                return res.status(400).json({ 
                    success: false, 
                    error: result.error, 
                    errorCode: result.errorCode 
                });
            }

            const moduleCount = result.index?.modules ? Object.keys(result.index.modules).length : 0;
            res.json({ 
                success: true, 
                message: 'Connection successful',
                schemaVersion: result.index?.schemaVersion,
                publisher: result.index?.publisher,
                moduleCount
            });
        } catch (error: unknown) {
            res.status(500).json({ error: getErrorMessage(error) });
        }
    });

    adminRouter.get('/sources/:id/modules', requireAdminAccountExists, requireAdminAuth, async (req, res) => {
        try {
            const { getSourceProfile } = await import('@modules/registry/distribution/sourceProfiles');
            const { fetchRemoteIndex } = await import('@modules/registry/distribution/remoteIndexFetcher');
            const { isHostAllowed } = await import('@modules/registry/security/sourceGovernance');

            const id = req.params.id as string;
            const profile = getSourceProfile(id);
            if (!profile) {
                return res.status(404).json({ error: 'Source profile not found' });
            }

            if (profile.kind !== 'indexed') {
                return res.status(400).json({ error: 'Can only browse modules for "indexed" source profiles' });
            }

            const allowlist = getConfig().security.sourceGovernance?.hostAllowlist;
            const mode = process.env.NODE_ENV === 'production' ? 'production' : 'development';
            if (!isHostAllowed(String(profile.baseUrl), allowlist, mode)) {
                return res.status(403).json({ error: 'Host is not in the configured allowlist' });
            }

            const result = await fetchRemoteIndex(profile.baseUrl, { auth: profile.auth });
            
            if (!result.ok) {
                return res.status(400).json({ 
                    success: false, 
                    error: result.error, 
                    errorCode: result.errorCode 
                });
            }

            res.json({ 
                success: true, 
                modules: result.index?.modules || {}
            });
        } catch (error: unknown) {
            res.status(500).json({ error: getErrorMessage(error) });
        }
    });

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
     * Note: this restarts the Core Service (API + adapters) only. In production,
     * the Next.js build process is separate; newly installed module UIs require
     * a Next.js rebuild for their webpack chunks to be included. In development
     * mode Turbopack handles this lazily without a restart.
     */
    adminRouter.post(
        '/server/restart',
        requireAdminAccountExists,
        requireAdminAuth,
        requireAdminCsrf,
        auditAdminAction,
        (_req, res) => {
            // Notify all connected clients that a restart is imminent so they
            // can show a reconnecting state immediately rather than waiting for
            // the socket to time out.
            deps.broadcastToClients('serverRestarting', {});

            // Flush the response before exiting so the browser receives 200.
            res.json({ success: true, message: 'Server is restarting' });
            res.end();

            // Short delay gives express time to flush the response buffer.
            // Exit code 75 is the restart signal — start-server.ts watches for
            // this specific code and restarts both the Core Service and Next.js
            // rather than propagating a full shutdown.
            setTimeout(() => {
                logger.info('Admin | Server restart requested by admin — signalling manager for restart (exit 75)');
                process.exit(75);
            }, 500);
        }
    );

}
