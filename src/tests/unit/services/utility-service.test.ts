import { strict as assert } from 'node:assert';
import { createUtilityService } from '@server/services/utility/UtilityService';
import { sharedContentStore } from '@server/core/world/SharedContentStore';
import { actorStore } from '@server/core/documents/primary/actors/ActorStore';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import {
    DocumentOwnershipLevel,
    FoundryUserRole,
} from '@server/core/documents/primary/base/ownership';


function createClient(
    fetchByUuid: (uuid: string) => Promise<unknown>,
    userId = 'player-1',
) {
    return {
        userId,
        fetchByUuid,
        resolveUrl: (url?: string) => url ? `https://foundry.test${url}` : '',
    } as any;
}

export async function run() {
    const observedDocument = {
        _id: 'actor-observed',
        name: 'Ada',
        system: { privateValue: 'observer-visible' },
        ownership: { default: DocumentOwnershipLevel.NONE, 'player-1': DocumentOwnershipLevel.OBSERVER },
    };
    await userStore.seed(async () => [
        { _id: 'player-1', name: 'Player', role: FoundryUserRole.PLAYER },
    ]);
    await actorStore.seed(async () => [
        observedDocument,
        { _id: 'actor-hidden', name: 'Hidden', system: { secret: true }, ownership: { default: DocumentOwnershipLevel.NONE } },
    ]);

    const fallbackClient = createClient(async () => null);
    const utilityService = createUtilityService({
        getFallbackSharedContentClient: () => fallbackClient,
    });

    assert.deepEqual(
        await utilityService.getFoundryDocument(createClient(async () => null), undefined),
        { error: 'Missing uuid', status: 400 },
    );

    assert.deepEqual(
        await utilityService.getFoundryDocument(createClient(async () => null), 'Actor.missing'),
        { error: 'Document not found', status: 404 },
    );

    assert.deepEqual(
        await utilityService.getFoundryDocument(createClient(async () => ({ forged: true })), 'Actor.actor-observed'),
        observedDocument,
    );
    assert.deepEqual(
        await utilityService.getFoundryDocument(createClient(async () => ({ forged: true })), 'Actor.actor-hidden'),
        { error: 'Document not found', status: 404 },
    );

    sharedContentStore.clear('utility-service-test');
    assert.deepEqual(await utilityService.getSharedContent(), { type: null });

    sharedContentStore.set({
        type: 'image',
        data: { url: '/worlds/test/map.webp', title: 'Map' },
        timestamp: 123,
    });
    const shared = await utilityService.getSharedContent(createClient(async () => null));
    assert.deepEqual(shared, {
        type: 'image',
        data: { url: 'https://foundry.test/worlds/test/map.webp', title: 'Map' },
        timestamp: 123,
    });

    assert.deepEqual(sharedContentStore.getCurrent(), {
        type: 'image',
        data: { url: '/worlds/test/map.webp', title: 'Map' },
        timestamp: 123,
    });

    sharedContentStore.clear('utility-service-test');
    actorStore.clear('utility-service-test');
    userStore.clear('utility-service-test');
    console.log('  - UtilityService: all checks passed');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('utility-service.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
