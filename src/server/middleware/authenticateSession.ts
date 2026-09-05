import express from 'express';
import type { AppConfig } from '@shared/interfaces';
import { systemService } from '@server/services/world';
import { logger } from '@shared/utils/logger';
import type { FoundryUserConnectionServiceLike } from '@server/shared/types/foundry';
import {
    createSessionRouteFoundryClient,
    createSystemRouteFoundryClient,
} from '@server/shared/utils/createRouteFoundryClient';
import { readBearerToken, readRequestSessionCredential } from '@server/security/playerSessionCookie';

export function createAuthenticateSession(
    foundryUserConnections: Pick<FoundryUserConnectionServiceLike, 'getOrRestoreSession'>,
    config: AppConfig,
): express.RequestHandler {
    return (req: express.Request, res: express.Response, next: express.NextFunction) => {
        // Exempt Socket.io handshake from REST middleware
        if (req.url.includes('socket.io')) return next();

        const token = readRequestSessionCredential(req);
        if (!token) {
            return res.status(401).json({ error: 'Unauthorized: Missing Session Token' });
        }

        // 1. Check for System Service Account using dedicated app service token
        if (readBearerToken(req) && config.security.serviceToken && token === config.security.serviceToken) {
            req.foundryClient = createSystemRouteFoundryClient(systemService.getSystemClient());
            req.isSystem = true;
            return next();
        }

        // 2. Fallback to Standard User Session
        foundryUserConnections.getOrRestoreSession(token).then((session) => {
            if (!session || !session.client.userId) {
                return res.status(401).json({ error: 'Unauthorized: Invalid or Expired Session' });
            }

            req.foundryClient = createSessionRouteFoundryClient(session.client, session.username);
            req.userSession = session;
            req.isSystem = false;
            next();
        }).catch((err: Error) => {
            logger.error(`Authentication Error: ${err.message}`);
            res.status(500).json({ error: 'Internal Authentication Error' });
        });
    };
}
