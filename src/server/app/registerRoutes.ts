import express from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import type { AppConfig } from '@shared/interfaces';
import type { SessionManager } from '@core/session/SessionManager';
import { systemService } from '@core/system/SystemService';
import { SetupManager } from '@core/world/SetupManager';
import { createAuthenticateSession } from '@server/middleware/authenticateSession';
import { createTryAuthenticateSession } from '@server/middleware/tryAuthenticateSession';
import { createEnsureInitialized } from '@server/middleware/ensureInitialized';
import { createLoginLimiter } from '@server/middleware/rateLimiters';
import { registerPublicRoutes } from '@server/routes/public/registerPublicRoutes';
import { registerSystemRoutes } from '@server/routes/protected/registerSystemRoutes';
import { registerActorRoutes } from '@server/routes/protected/registerActorRoutes';
import { registerDebugRoutes } from '@server/routes/debug/registerDebugRoutes';
import { registerChatRoutes } from '@server/routes/protected/registerChatRoutes';
import { registerCombatRoutes } from '@server/routes/protected/registerCombatRoutes';
import { registerJournalRoutes } from '@server/routes/protected/registerJournalRoutes';
import { registerUtilityRoutes } from '@server/routes/protected/registerUtilityRoutes';
import { createModuleRouter } from '@server/routes/modules/createModuleRouter';
import { createAdminRouter } from '@server/routes/admin/createAdminRouter';
import { createActorNormalizationService } from '@server/services/actors/ActorNormalizationService';
import { createSystemRouteFoundryClient } from '@server/shared/utils/createRouteFoundryClient';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';
import { logger } from '@shared/utils/logger';
import { getAdapter } from '@modules/registry/server';
import { SystemStatusPayload } from '@/shared/contracts/status';

type GetSystemStatusPayload = () => Promise<SystemStatusPayload>;

interface RegisterRoutesDeps {
    app: express.Express;
    config: AppConfig;
    sessionManager: SessionManager;
    getSystemStatusPayload: GetSystemStatusPayload;
    io: SocketIOServer;
}

export function registerRoutes(deps: RegisterRoutesDeps): void {
    // Build middleware instances once, then compose them in deterministic order.
    const authenticateSession = createAuthenticateSession(deps.sessionManager, deps.config);
    const tryAuthenticateSession = createTryAuthenticateSession(deps.sessionManager, deps.config);
    const ensureInitialized = createEnsureInitialized(deps.sessionManager);
    const loginLimiter = createLoginLimiter(deps.config);

    const appRouter = express.Router();

    // Status endpoint keeps the same payload contract while deriving auth state from token/session.
    const statusHandler = async (req: express.Request, res: express.Response) => {
        try {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');

            let isAuthenticated = false;
            let userSession = null;
            const authHeader = req.headers.authorization;
            if (authHeader && authHeader.startsWith('Bearer ')) {
                const token = authHeader.split(' ')[1];
                userSession = await deps.sessionManager.getOrRestoreSession(token);
                if (userSession && userSession.client.userId) {
                    isAuthenticated = true;
                }
            }

            const basePayload = await deps.getSystemStatusPayload();

            // Strip user identity data from public (unauthenticated) responses.
            // User IDs, names, roles, and online status should not be exposed without a valid session.
            res.json({
                ...basePayload,
                users: isAuthenticated ? basePayload.users : [],
                isAuthenticated,
                currentUserId: userSession?.userId || null
            });
        } catch (error: unknown) {
            logger.error(`Status Handler Error: ${getErrorMessage(error)}`);
            res.status(500).json({ error: 'Failed to retrieve status' });
        }
    };

    const getSanitizedConfig = () => ({
        app: { version: deps.config.app.version },
        foundry: {
            url: deps.config.foundry.url
        }
    });

    registerPublicRoutes(appRouter, {
        statusHandler,
        getSanitizedConfig,
        getSetupStatus: async () => {
            const cache = await SetupManager.loadCache();
            return { isConfigured: !!(cache.currentWorldId && cache.worlds[cache.currentWorldId]) };
        },
        loginLimiter,
        createSession: (username, password) => deps.sessionManager.createSession(username, password),
        destroySession: (token) => deps.sessionManager.destroySession(token)
    });

    // Preserve existing guard and auth order: init gate first, then protected route auth.
    appRouter.use(ensureInitialized);

    const actorNormalizationService = createActorNormalizationService();
    const { normalizeActors } = actorNormalizationService;

    appRouter.use(authenticateSession);

    registerSystemRoutes(appRouter, {
        getSystemClient: () => systemService.getSystemClient(),
        getAdapter
    });

    registerActorRoutes(appRouter, {
        normalizeActors,
        config: deps.config
    });

    if (deps.config.debug.enabled) {
        // Debug routes remain opt-in via debug.enabled and still enforce session token auth.
        registerDebugRoutes(deps.app, {
            getOrRestoreSession: (token) => deps.sessionManager.getOrRestoreSession(token)
        });
    } else {
        logger.info('Core Service | Debug routes disabled (debug.enabled=false).');
    }

    registerChatRoutes(appRouter, { config: deps.config });
    registerCombatRoutes(appRouter, { normalizeActors });
    registerJournalRoutes(appRouter);
    registerUtilityRoutes(appRouter, {
        getFallbackSharedContentClient: () => createSystemRouteFoundryClient(systemService.getSystemClient())
    });

    const moduleRouter = createModuleRouter({
        tryAuthenticateSession
    });
    // io is forwarded as a thin broadcast callback rather than the full Server object
    // so the admin router stays decoupled from the socket layer.
    const adminRouter = createAdminRouter({
        getSystemStatusPayload: deps.getSystemStatusPayload,
        broadcastToClients: (event, data) => deps.io.emit(event, data),
    });

    // Preserve mount order to avoid changing auth scope or module-router permissive behavior.
    deps.app.use('/api/modules', moduleRouter);
    deps.app.use('/api', appRouter);
    deps.app.use('/admin', adminRouter);
}
