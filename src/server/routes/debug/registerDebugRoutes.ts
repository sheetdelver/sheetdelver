import express from 'express';
import { createDebugService } from '@server/services/debug/DebugService';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';
import type { ClientSocket } from '@server/core/foundry/sockets/ClientSocket';
import type { UserSessionLike } from '@server/shared/types/foundry';

type DebugSession = UserSessionLike & {
    client: ClientSocket;
};

type GetOrRestoreSession = (token: string) => Promise<DebugSession | undefined>;

interface DebugRouteDeps {
    getOrRestoreSession: GetOrRestoreSession;
}

export function registerDebugRoutes(app: express.Express, deps: DebugRouteDeps) {
    // Debug domain service: session-bound actor lookup with no system fallback.
    const debugService = createDebugService(deps);

    // Debug route requires an authenticated session token.
    app.get('/api/debug/actor/:id', async (req, res) => {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Unauthorized: Missing Session Token' });
        }

        try {
            const actor = await debugService.getActor(req.params.id, authHeader);
            res.json(actor);
        } catch (error: unknown) {
            const status = typeof error === 'object' && error !== null && 'status' in error && typeof (error as { status?: unknown }).status === 'number'
                ? (error as { status: number }).status
                : 500;
            res.status(status).json({ error: getErrorMessage(error) });
        }
    });
}
