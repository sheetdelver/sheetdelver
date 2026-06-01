import { getAdapter } from '@modules/registry/server';
import type { ActorServiceClientLike, ActorDocument } from '@server/shared/types/actors';

interface NormalizedActor {
    derived?: Record<string, unknown>;
    [key: string]: unknown;
}

interface ActorNormalizationDeps {
    getAdapterBySystemId?: typeof getAdapter;
}

export function createActorNormalizationService(deps: ActorNormalizationDeps = {}) {
    const getAdapterBySystemId = deps.getAdapterBySystemId || getAdapter;

    // Shared actor projection used by actor and combat services for UI-ready payloads.
    // Per ADR-0027, `normalizeActorData` is pure projection (no client); adapters that
    // need declared-pack data read it through `runtime.compendium` (resolveActorNames removed).
    const normalizeActors = async (actorList: ActorDocument[], client: ActorServiceClientLike) => {
        const systemInfo = await client.getSystem();
        const adapter = await getAdapterBySystemId(systemInfo.id.toLowerCase());
        if (!adapter) throw new Error(`Adapter for ${systemInfo.id} not found`);

        return Promise.all(actorList.map(async (actor) => {
            if (!actor.computed) actor.computed = {};

            if (actor.img) actor.img = client.resolveUrl(actor.img);
            if (actor.prototypeToken?.texture?.src) {
                actor.prototypeToken.texture.src = client.resolveUrl(actor.prototypeToken.texture.src);
            }

            const normalized = adapter.normalizeActorData(actor as any) as NormalizedActor;
            if (adapter.computeActorData) {
                normalized.derived = adapter.computeActorData(normalized as any) as Record<string, unknown>;
            }

            return normalized;
        }));
    };

    return {
        normalizeActors
    };
}
