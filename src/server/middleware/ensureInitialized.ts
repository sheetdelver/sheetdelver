import express from 'express';
import type { FoundryUserConnectionServiceLike } from '@server/shared/types/foundry';

export function createEnsureInitialized(
    foundryUserConnections: Pick<FoundryUserConnectionServiceLike, 'isCacheReady'>,
    isWorldReady: () => boolean,
): express.RequestHandler {
    return (req: express.Request, res: express.Response, next: express.NextFunction) => {
        if (!foundryUserConnections.isCacheReady()) {
            return res.status(503).json({
                status: 'initializing',
                message: 'Compendium cache is warming up, please wait.'
            });
        }
        if (!isWorldReady()) {
            return res.status(503).json({
                status: 'initializing',
                message: 'World runtime is initializing or restarting, please wait.'
            });
        }
        next();
    };
}
