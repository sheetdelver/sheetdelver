import express from 'express';
import type { FoundryUserConnectionServiceLike } from '@server/shared/types/foundry';
import { worldWorkGate, withWorldWorkScope } from '@server/core/world/WorldWorkGate';
import { moduleWorldContext } from '@server/services/world/ModuleWorldContextService';

export function createEnsureInitialized(
    foundryUserConnections: Pick<FoundryUserConnectionServiceLike, 'isCacheReady'>,
    isWorldReady: () => boolean,
): express.RequestHandler {
    return (req: express.Request, res: express.Response, next: express.NextFunction) => {
        if (!worldWorkGate.isOpen()) {
            return res.status(503).json({ status: 'maintenance', maintenance: worldWorkGate.status(), message: 'World unavailable' });
        }
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && worldWorkGate.getServingToken()
            && req.get('X-SheetDelver-Runtime') !== worldWorkGate.getServingToken()) {
            return res.status(409).json({ error: 'Module runtime changed; reload before trying again', code: 'runtime-changed' });
        }
        const contextRevision = req.get?.('X-SheetDelver-Context-Revision');
        if (contextRevision !== undefined && Number(contextRevision) !== moduleWorldContext.snapshot().identity.contextRevision) {
            return res.status(409).json({ error: 'World rules changed; refresh this action', code: 'world-context-changed' });
        }
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
        const revision = worldWorkGate.capture();
        const send = res.json.bind(res);
        res.json = (body: unknown) => {
            try { worldWorkGate.assertOpen(revision); }
            catch { res.status(503); return send({ status: 'maintenance', message: 'World unavailable' }); }
            return send(body);
        };
        withWorldWorkScope(next);
    };
}
