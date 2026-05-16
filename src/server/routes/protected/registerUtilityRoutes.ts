import express from 'express';
import { logger } from '@shared/utils/logger';
import { createUtilityService } from '@server/services/utility/UtilityService';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';
import type { RouteFoundryClient } from '@server/shared/types/requestContext';
import { isErrorPayload } from '@server/shared/utils/isErrorPayload';

interface UtilityRouteDeps {
    getFallbackSharedContentClient: () => RouteFoundryClient;
}

export function registerUtilityRoutes(appRouter: express.Router, deps: UtilityRouteDeps) {
    // Utility domain service: displaced dashboard helper logic for documents, users, and shared content.
    const utilityService = createUtilityService(deps);

    appRouter.get('/foundry/document', async (req, res) => {
        try {
            const client = req.foundryClient;
            const payload = await utilityService.getFoundryDocument(client, req.query.uuid as string);
            if (isErrorPayload(payload)) {
                return res.status(payload.status).json({ error: payload.error });
            }
            res.json(payload);
        } catch (error: unknown) {
            res.status(500).json({ error: getErrorMessage(error) });
        }
    });

    appRouter.get('/session/users', async (req, res) => {
        try {
            const client = req.foundryClient;
            const payload = await utilityService.getSessionUsers(client);
            res.json(payload);
        } catch (error: unknown) {
            logger.error(`User Fetch Error: ${getErrorMessage(error)}`);
            res.status(500).json({ error: 'Failed to retrieve users' });
        }
    });

    // --- Shared Content API ---
    appRouter.get('/shared-content', (req, res) => {
        try {
            const client = req.foundryClient;
            utilityService.getSharedContent(client).then(payload => res.json(payload)).catch((error: unknown) => {
                logger.error('Error fetching shared content:', error);
                res.status(500).json({ error: 'Internal server error' });
            });
        } catch (error: unknown) {
            logger.error('Error fetching shared content:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    });
}
