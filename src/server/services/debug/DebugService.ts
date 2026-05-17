import type { ClientSocket } from '@server/core/foundry/sockets/ClientSocket';
import type { UserSessionLike } from '@server/shared/types/foundry';
import { createSessionRouteFoundryClient } from '@server/shared/utils/createRouteFoundryClient';

type DebugSession = UserSessionLike & {
    client: ClientSocket;
};

type GetOrRestoreSession = (token: string) => Promise<DebugSession | undefined>;

interface DebugServiceDeps {
    getOrRestoreSession: GetOrRestoreSession;
}

export function createDebugService(deps: DebugServiceDeps) {
    // Debug actor lookup requires a valid user session; no system client fallback is allowed.
    const getActor = async (actorId: string, authorization: string) => {
        if (!authorization.startsWith('Bearer ')) {
            const err = new Error('Unauthorized: Missing Session Token') as Error & { status?: number };
            err.status = 401;
            throw err;
        }

        const token = authorization.split(' ')[1];
        const session = await deps.getOrRestoreSession(token);
        if (!session || !session.client?.userId) {
            const err = new Error('Unauthorized: Invalid or Expired Session') as Error & { status?: number };
            err.status = 401;
            throw err;
        }

        return createSessionRouteFoundryClient(session.client, session.username).getActor(actorId);
    };

    return {
        getActor
    };
}
