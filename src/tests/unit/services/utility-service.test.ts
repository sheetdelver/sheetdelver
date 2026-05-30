import { strict as assert } from 'node:assert';
import { createUtilityService } from '@server/services/utility/UtilityService';
import { sharedContentStore } from '@server/core/world/SharedContentStore';

function createClient(fetchByUuid: (uuid: string) => Promise<unknown>) {
    return {
        fetchByUuid,
        resolveUrl: (url?: string) => url ? `https://foundry.test${url}` : '',
    } as any;
}

export async function run() {
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

    const document = { id: 'actor-1', name: 'Ada' };
    assert.deepEqual(
        await utilityService.getFoundryDocument(createClient(async () => document), 'Actor.actor-1'),
        document,
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
