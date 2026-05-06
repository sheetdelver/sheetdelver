import express from 'express';
import { logger } from '@shared/utils/logger';
import { getRegisteredModules, getModuleActiveSources } from '@modules/registry/server';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';

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
