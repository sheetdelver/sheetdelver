import { strict as assert } from 'node:assert';
import { createActorNormalizationService } from '@server/services/actors/ActorNormalizationService';

export async function run() {
    const baseClient = {
        getSystem: async () => ({ id: 'shadowdark' }),
        resolveUrl: (value?: string) => `resolved:${value || ''}`,
    } as any;

    const missingAdapterService = createActorNormalizationService({
        getAdapterBySystemId: async () => null as any,
    });

    let missingError: Error | null = null;
    try {
        await missingAdapterService.normalizeActors([], baseClient);
    } catch (error) {
        missingError = error as Error;
    }
    assert.ok(missingError);
    assert.ok(missingError?.message.includes('shadowdark'));

    // Per ADR-0027, `normalizeActorData` is pure projection (no client) and
    // `resolveActorNames` is removed — adapters read declared packs via `runtime.compendium`.
    const normalizeCalls: Array<{ actorId: string; argCount: number }> = [];
    const computeCalls: Array<{ actorId: string }> = [];

    const adapterWithCompute = {
        normalizeActorData: (...args: any[]) => {
            const actor = args[0];
            normalizeCalls.push({ actorId: String(actor._id || actor.id), argCount: args.length });
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
    assert.equal(normalizeCalls.length, 2);
    // Projection receives the actor only — no client argument.
    assert.equal(normalizeCalls[0].argCount, 1);
    assert.equal(normalizeCalls[1].argCount, 1);
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
