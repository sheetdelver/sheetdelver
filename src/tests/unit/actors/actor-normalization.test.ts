import { strict as assert } from 'node:assert';
import { createActorNormalizationService } from '@server/services/actors/ActorNormalizationService';

export async function run() {
    const baseClient = {
        getSystem: async () => ({ id: 'shadowdark' }),
        resolveUrl: (value?: string) => `resolved:${value || ''}`,
    } as any;

    const missingAdapterService = createActorNormalizationService({
        getAdapterBySystemId: async () => null as any,
        getCompendiumCache: async () => ({}),
    });

    let missingError: Error | null = null;
    try {
        await missingAdapterService.normalizeActors([], baseClient);
    } catch (error) {
        missingError = error as Error;
    }
    assert.ok(missingError);
    assert.ok(missingError?.message.includes('shadowdark'));

    const cache = { marker: 'cache' };
    const resolveActorNamesCalls: Array<{ actorId: string; cacheRef: unknown }> = [];
    const normalizeCalls: Array<{ actorId: string; clientRef: unknown }> = [];
    const computeCalls: Array<{ actorId: string }> = [];

    const adapterWithCompute = {
        resolveActorNames: async (actor: any, cacheRef: unknown) => {
            resolveActorNamesCalls.push({ actorId: String(actor._id || actor.id), cacheRef });
        },
        normalizeActorData: (actor: any, clientRef: unknown) => {
            normalizeCalls.push({ actorId: String(actor._id || actor.id), clientRef });
            return {
                _id: actor._id,
                id: actor.id,
                img: actor.img,
                prototypeToken: actor.prototypeToken,
                normalized: true,
            };
        },
        computeActorData: (actor: any) => {
            computeCalls.push({ actorId: String(actor._id || actor.id) });
            return { power: 'high' };
        },
    } as any;

    const serviceWithCompute = createActorNormalizationService({
        getAdapterBySystemId: async () => adapterWithCompute,
        getCompendiumCache: async () => cache,
    });

    const actors = [
        {
            _id: 'a1',
            id: 'a1',
            name: 'Alpha',
            img: '/alpha.png',
            computed: undefined,
            prototypeToken: { texture: { src: '/token-alpha.png' } },
        },
        {
            _id: 'a2',
            id: 'a2',
            name: 'Beta',
            computed: {},
        },
    ] as any[];

    const normalizedWithCompute = await serviceWithCompute.normalizeActors(actors as any, baseClient);
    assert.equal(normalizedWithCompute.length, 2);
    assert.equal(resolveActorNamesCalls.length, 2);
    assert.equal(resolveActorNamesCalls[0].cacheRef, cache);
    assert.equal(resolveActorNamesCalls[1].cacheRef, cache);
    assert.equal(normalizeCalls.length, 2);
    assert.equal(normalizeCalls[0].clientRef, baseClient);
    assert.equal(normalizeCalls[1].clientRef, baseClient);
    assert.equal(computeCalls.length, 2);
    assert.deepEqual((normalizedWithCompute[0] as any).derived, { power: 'high' });
    assert.equal((actors[0] as any).img, 'resolved:/alpha.png');
    assert.equal((actors[0] as any).prototypeToken.texture.src, 'resolved:/token-alpha.png');

    const normalizeOnlyCalls: string[] = [];
    const adapterWithoutOptionalMethods = {
        normalizeActorData: (actor: any) => {
            normalizeOnlyCalls.push(String(actor._id || actor.id));
            return {
                _id: actor._id,
                id: actor.id,
            };
        },
    } as any;

    const serviceWithoutOptionalMethods = createActorNormalizationService({
        getAdapterBySystemId: async () => adapterWithoutOptionalMethods,
        getCompendiumCache: async () => cache,
    });

    const normalizedWithoutOptional = await serviceWithoutOptionalMethods.normalizeActors([
        { _id: 'a3', id: 'a3', name: 'Gamma' },
    ] as any, baseClient);

    assert.equal(normalizeOnlyCalls.length, 1);
    assert.equal(normalizedWithoutOptional.length, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(normalizedWithoutOptional[0], 'derived'), false);

    const emptyCalls: string[] = [];
    const emptyAdapter = {
        normalizeActorData: (actor: any) => {
            emptyCalls.push(String(actor._id || actor.id));
            return actor;
        },
    } as any;

    const emptyService = createActorNormalizationService({
        getAdapterBySystemId: async () => emptyAdapter,
        getCompendiumCache: async () => cache,
    });

    const emptyResult = await emptyService.normalizeActors([], baseClient);
    assert.deepEqual(emptyResult, []);
    assert.equal(emptyCalls.length, 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('actor-normalization.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
