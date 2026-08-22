import express from 'express';
import type { AppConfig } from '@shared/interfaces';
import { systemService } from '@server/services/world';
import type { FoundryUserConnectionServiceLike } from '@server/shared/types/foundry';
import {
    createSessionRouteFoundryClient,
    createSystemRouteFoundryClient,
} from '@server/shared/utils/createRouteFoundryClient';
import { readBearerToken, readRequestSessionCredential } from '@server/security/playerSessionCookie';

export function createTryAuthenticateSession(
    foundryUserConnections: Pick<FoundryUserConnectionServiceLike, 'getOrRestoreSession'>,
    config: AppConfig,
): express.RequestHandler {
    return (req: express.Request, res: express.Response, next: express.NextFunction) => {
        const token = readRequestSessionCredential(req);
        if (!token) return next();

        // 1. Check for System Service Account using dedicated app service token
        if (readBearerToken(req) && config.security.serviceToken && token === config.security.serviceToken) {
            req.foundryClient = createSystemRouteFoundryClient(systemService.getSystemClient());
            req.isSystem = true;
            return next();
        }

        // 2. Fallback to User Session
        foundryUserConnections.getOrRestoreSession(token).then((session) => {
            if (session && session.client.userId) {
                req.foundryClient = createSessionRouteFoundryClient(session.client, session.username);
                req.userSession = session;
                req.isSystem = false;
            }
            next();
        }).catch(() => next());
    };
}
