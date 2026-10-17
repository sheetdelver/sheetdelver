import express from 'express';
import { logger } from '@shared/utils/logger';
import { createUtilityService } from '@server/services/utility/UtilityService';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';
import { isErrorPayload } from '@server/shared/utils/isErrorPayload';
import { isSdkError } from '@shared/sdk/errors';

export function registerUtilityRoutes(appRouter: express.Router) {
    // Utility domain service: displaced dashboard helper logic for documents, users, and shared content.
    const utilityService = createUtilityService();

    appRouter.get('/foundry/document', async (req, res) => {
        try {
            const client = req.foundryClient;
            const payload = await utilityService.getFoundryDocument(client, req.query.uuid as string);
            if (isErrorPayload(payload)) {
                return res.status(payload.status).json({ error: payload.error });
            }
            res.json(payload);
        } catch (error: unknown) {
            if (isSdkError(error)) return res.status(error.status).json({
                error: ['permission_denied', 'out_of_scope'].includes(error.code) ? 'Document access denied'
                    : error.code === 'internal' ? 'Document read failed' : error.message.slice(0, 512),
                code: error.code, status: error.status,
            });
            logger.error(`Document read failed: ${getErrorMessage(error)}`);
            res.status(500).json({ error: 'Document read failed' });
        }
    });

    appRouter.get('/session/users', async (req, res) => {
        try {
            res.setHeader('Cache-Control', 'no-store');
            const client = req.foundryClient;
            const payload = await utilityService.getSessionUsers(client);
            res.json({ ...payload, currentUserId: req.isSystem ? null : req.userSession?.userId || client.userId || null });
        } catch (error: unknown) {
            logger.error(`User Fetch Error: ${getErrorMessage(error)}`);
            res.status(500).json({ error: 'Failed to retrieve users' });
        }
    });

    // --- Shared Content API ---
    appRouter.get('/shared-content', (req, res) => {
        try {
            res.setHeader('Cache-Control', 'no-store');
            const sessionId = req.userSession?.id;
            const worldId = req.userSession?.worldId;
            if (req.isSystem || !sessionId || !worldId) {
                return res.status(403).json({ error: 'A player world session is required' });
            }
            const client = req.foundryClient;
            utilityService.getSharedContent(client, sessionId, worldId).then(payload => res.json(payload)).catch((error: unknown) => {
                logger.error('Error fetching shared content:', error);
                res.status(500).json({ error: 'Internal server error' });
            });
        } catch (error: unknown) {
            logger.error('Error fetching shared content:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    });
}
