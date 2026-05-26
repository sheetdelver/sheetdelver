import express from 'express';
import type { AppConfig } from '@shared/interfaces';
import { systemService } from '@server/services/world';
import type { SessionManager } from '@core/session/SessionManager';
import {
    createSessionRouteFoundryClient,
    createSystemRouteFoundryClient,
} from '@server/shared/utils/createRouteFoundryClient';

export function createTryAuthenticateSession(sessionManager: SessionManager, config: AppConfig): express.RequestHandler {
    return (req: express.Request, res: express.Response, next: express.NextFunction) => {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return next();
        }

        const token = authHeader.split(' ')[1];

        // 1. Check for System Service Account using dedicated app service token
        if (config.security.serviceToken && token === config.security.serviceToken) {
            req.foundryClient = createSystemRouteFoundryClient(systemService.getSystemClient());
            req.isSystem = true;
            return next();
        }

        // 2. Fallback to User Session
        sessionManager.getOrRestoreSession(token).then((session) => {
            if (session && session.client.userId) {
                req.foundryClient = createSessionRouteFoundryClient(session.client, session.username);
                req.userSession = session;
                req.isSystem = false;
            }
            next();
        }).catch(() => next());
    };
}
