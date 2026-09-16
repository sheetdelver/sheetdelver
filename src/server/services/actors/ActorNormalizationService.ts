import { preparedActorStore } from '@server/core/documents/prepared/actors/PreparedActorStore';
import type { ActorServiceClientLike, ActorDocument } from '@server/shared/types/actors';
import type { PreparedActorData } from '@shared/sdk';

interface ActorNormalizationDeps {
    getPreparedActor?: (actorId: string) => PreparedActorData;
}

/**
 * Clone-safe projection of authorized Actor ids onto their current prepared
 * revisions. The request client remains responsible for source visibility;
 * this service adds only URL projection and never re-runs system preparation.
 */
export function createActorNormalizationService(deps: ActorNormalizationDeps = {}) {
    const getPreparedActor = deps.getPreparedActor
        ?? ((actorId: string) => preparedActorStore.getRequired(actorId));

    const normalizeActors = async (
        actorList: ActorDocument[],
        client: ActorServiceClientLike,
    ): Promise<PreparedActorData[]> => actorList.map((sourceActor) => {
        const actorId = sourceActor._id || sourceActor.id;
        if (!actorId) throw new Error('Cannot project an Actor without an id');

        const prepared = getPreparedActor(actorId);
        if (prepared.img) prepared.img = client.resolveUrl(prepared.img);
        const prototypeToken = prepared.prototypeToken as {
            texture?: { src?: string };
        } | undefined;
        if (prototypeToken?.texture?.src) {
            prototypeToken.texture.src = client.resolveUrl(prototypeToken.texture.src);
        }
        return prepared;
    });

    return { normalizeActors };
}
