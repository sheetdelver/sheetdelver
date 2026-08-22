import express from 'express';
import { logger } from '@shared/utils/logger';
import { getRegisteredModules, getModuleActiveSources } from '@modules/registry/server';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';
import {
    clearPlayerSessionCookie,
    readRequestSessionCredential,
    setPlayerSessionCookie,
} from '@server/security/playerSessionCookie';
import { summarizeCspReports } from '@server/security/cspReport';

const cspReportParser = express.json({
    limit: '16kb',
    type: ['application/csp-report', 'application/reports+json'],
});

interface PublicRouteDeps {
    statusHandler: express.RequestHandler;
    getSanitizedConfig: () => unknown;
    getSetupStatus: () => Promise<{ isConfigured: boolean }>;
    cspReportLimiter: express.RequestHandler;
    loginLimiter: express.RequestHandler;
    createSession: (username: string, password?: string) => Promise<{ sessionId: string; userId: string }>;
    destroySession: (token: string) => Promise<void>;
    securePlayerCookie: boolean;
}

export function registerPublicRoutes(appRouter: express.Router, deps: PublicRouteDeps) {
    appRouter.get('/status', deps.statusHandler);
    appRouter.get('/session/connect', deps.statusHandler);

    appRouter.post('/csp-report', deps.cspReportLimiter, cspReportParser, (req, res) => {
        // CSP reports are unauthenticated browser telemetry. Log only the
        // bounded summary, never the raw payload or URL query strings.
        for (const report of summarizeCspReports(req.body)) {
            logger.warn('Browser CSP violation', report);
        }
        res.status(204).end();
    });

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
            // The browser receives only an HttpOnly cookie; the reusable session
            // UUID never enters JavaScript or the JSON response body.
            setPlayerSessionCookie(res, session.sessionId, deps.securePlayerCookie);
            res.json({ success: true, userId: session.userId });
        } catch (error: unknown) {
            res.status(401).json({ success: false, error: getErrorMessage(error) });
        }
    });

    appRouter.post('/logout', async (req, res) => {
        const token = readRequestSessionCredential(req);
        try {
            if (token) await deps.destroySession(token);
        } finally {
            // A failed server-side teardown must not leave the browser holding
            // a reusable session credential after the user chose to log out.
            clearPlayerSessionCookie(res, deps.securePlayerCookie);
        }
        res.json({ success: true });
    });
}
