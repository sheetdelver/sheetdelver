import { getAdapter } from '@modules/registry/server';
import type { ActorServiceClientLike, ActorDocument } from '@server/shared/types/actors';
import type { CompendiumPackReader } from '@shared/sdk';

interface NormalizedActor {
    derived?: Record<string, unknown>;
    [key: string]: unknown;
}

interface ActorNormalizationDeps {
    getAdapterBySystemId?: typeof getAdapter;
    getCompendiumPacks?: (moduleId: string) => Promise<CompendiumPackReader>;
}

export function createActorNormalizationService(deps: ActorNormalizationDeps = {}) {
    const getAdapterBySystemId = deps.getAdapterBySystemId || getAdapter;
    // Per ADR-0021, adapters receive the module-scoped `CompendiumPackReader`
    // built on the unified `CompendiumStore`. Undeclared packs return null
    // through the reader and the adapter leaves the UUID unresolved.
    const getCompendiumPacks = deps.getCompendiumPacks || (async (moduleId: string) => {
        const { createScopedCompendiumPacks } = await import('@server/shared/utils/createModuleContext');
        return createScopedCompendiumPacks(moduleId);
    });

    // Shared actor projection used by actor and combat services for UI-ready payloads.
    const normalizeActors = async (actorList: ActorDocument[], client: ActorServiceClientLike) => {
        const systemInfo = await client.getSystem();
        const adapter = await getAdapterBySystemId(systemInfo.id.toLowerCase());
        if (!adapter) throw new Error(`Adapter for ${systemInfo.id} not found`);

        const packs = await getCompendiumPacks(systemInfo.id.toLowerCase());

        return Promise.all(actorList.map(async (actor) => {
            if (!actor.computed) actor.computed = {};
            if (!actor.computed.resolvedNames) actor.computed.resolvedNames = {};
            if (adapter.resolveActorNames) await adapter.resolveActorNames(actor as any, packs);

            if (actor.img) actor.img = client.resolveUrl(actor.img);
            if (actor.prototypeToken?.texture?.src) {
                actor.prototypeToken.texture.src = client.resolveUrl(actor.prototypeToken.texture.src);
            }

            const normalized = adapter.normalizeActorData(actor as any, client as any) as NormalizedActor;
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
