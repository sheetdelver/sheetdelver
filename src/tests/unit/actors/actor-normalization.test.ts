import { strict as assert } from 'node:assert';
import { createActorNormalizationService } from '@server/services/actors/ActorNormalizationService';
import type { PreparedActorData } from '@shared/sdk';

function preparedActor(id: string): PreparedActorData {
    return {
        _id: id,
        id,
        name: `Prepared ${id}`,
        type: 'character',
        img: `/${id}.png`,
        system: { prepared: true },
        items: [],
        effects: [],
        derived: { score: 12 },
        prototypeToken: { texture: { src: `/token-${id}.png` } },
    };
}

export async function run() {
    const lookups: string[] = [];
    const prepared = new Map([
        ['a1', preparedActor('a1')],
        ['a2', preparedActor('a2')],
    ]);
    const service = createActorNormalizationService({
        getPreparedActor: (actorId) => {
            lookups.push(actorId);
            const actor = prepared.get(actorId);
            if (!actor) throw new Error(`Missing prepared Actor ${actorId}`);
            return structuredClone(actor);
        },
    });
    const client = {
        resolveUrl: (value?: string) => `resolved:${value || ''}`,
    } as any;

    const normalized = await service.normalizeActors([
        { _id: 'a1', name: 'Source Alpha' },
        { id: 'a2', name: 'Source Beta' },
    ] as any, client);

    assert.deepEqual(lookups, ['a1', 'a2']);
    assert.equal(normalized[0].name, 'Prepared a1');
    assert.deepEqual(normalized[0].derived, { score: 12 });
    assert.equal(normalized[0].img, 'resolved:/a1.png');
    assert.equal((normalized[0].prototypeToken as any)?.texture?.src, 'resolved:/token-a1.png');

    // Request projection mutates only the clone returned by the prepared store.
    assert.equal(prepared.get('a1')?.img, '/a1.png');
    assert.equal((prepared.get('a1')?.prototypeToken as any)?.texture?.src, '/token-a1.png');

    const empty = await service.normalizeActors([], client);
    assert.deepEqual(empty, []);

    await assert.rejects(
        () => service.normalizeActors([{ name: 'No id' }] as any, client),
        /without an id/,
    );
    await assert.rejects(
        () => service.normalizeActors([{ _id: 'missing' }] as any, client),
        /Missing prepared Actor missing/,
    );
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('actor-normalization.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
