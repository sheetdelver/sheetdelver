import { strict as assert } from 'node:assert';
import { SceneStore } from '@server/core/documents/primary/scenes/SceneStore';
import type { SceneDocument } from '@server/shared/types/documents';
import type { DocumentChangedEvent } from '@server/core/documents/primary/base/PrimaryDocumentStore';

/**
 * SceneStore (ADR-0028 Phase 7, scene/token slice): embedded Token
 * maintenance plus Foundry's ActorDelta translation — unlinked-token-actor
 * mutations arrive as ActorDelta / delta-child events rooted at
 * `Scene.<id>` and must land on the owning token's `delta`.
 */
export async function run() {
    await runEmbeddedTokenRouting();
    await runActorDeltaMerging();
    await runDeltaChildEffects();
    await runTargetedTokenLookup();
    console.log('  - SceneStore: all checks passed');
}

async function seedScene(): Promise<{ store: SceneStore; events: DocumentChangedEvent[] }> {
    const store = new SceneStore();
    await store.seed(async () => [
        {
            _id: 'scene-1',
            name: 'Cave',
            active: true,
            tokens: [
                {
                    _id: 'tok-1',
                    name: 'Goblin 1',
                    actorId: 'actor-goblin',
                    actorLink: false,
                    texture: { src: 'tokens/goblin-1.webp' },
                    delta: { _id: 'delta-1', effects: [] },
                },
            ],
        },
    ] as SceneDocument[]);
    const events: DocumentChangedEvent[] = [];
    store.on('documentChanged', (e) => events.push(e as DocumentChangedEvent));
    return { store, events };
}

async function runEmbeddedTokenRouting() {
    const { store, events } = await seedScene();

    // Token create (idempotent by id — mirror + broadcast double-apply).
    store.applyModifyDocument('Token', 'create', [
        { _id: 'tok-2', name: 'Goblin 2', actorId: 'actor-goblin' },
    ], { parentUuid: 'Scene.scene-1' });
    store.applyModifyDocument('Token', 'create', [
        { _id: 'tok-2', name: 'Goblin 2', actorId: 'actor-goblin' },
    ], { parentUuid: 'Scene.scene-1' });
    assert.equal(store.get('scene-1')?.tokens?.length, 2, 'token create is idempotent');
    assert.ok(events.some((e) => e.id === 'scene-1' && e.action === 'update'));

    // Token rename updates in place.
    store.applyModifyDocument('Token', 'update', [
        { _id: 'tok-1', name: 'Goblin Chief' },
    ], { parentUuid: 'Scene.scene-1' });
    assert.equal(store.getToken('scene-1', 'tok-1')?.name, 'Goblin Chief');

    // Broadcast-shaped token delete (string ids in result — ADR-0031).
    store.applyModifyDocument('Token', 'delete', ['tok-2'], {
        parentUuid: 'Scene.scene-1',
    });
    assert.equal(store.get('scene-1')?.tokens?.length, 1);

    // Unknown embedded shape drops silently.
    store.applyModifyDocument('AmbientLight', 'create', [{ _id: 'x' }], {
        parentUuid: 'Scene.scene-1',
    });
    assert.equal(store.get('scene-1')?.tokens?.length, 1);
}

async function runActorDeltaMerging() {
    const { store, events } = await seedScene();

    // Foundry translates unlinked-token-actor updates into ActorDelta updates
    // with parentUuid Scene.<id>.Token.<id> (syntheticActorUpdate).
    store.applyModifyDocument('ActorDelta', 'update', [
        { _id: 'delta-1', name: 'Wounded Goblin', system: { hp: { value: 2 } } },
    ], { parentUuid: 'Scene.scene-1.Token.tok-1' });

    const delta = store.getToken('scene-1', 'tok-1')?.delta;
    assert.equal(delta?.name, 'Wounded Goblin');
    assert.deepEqual(delta?.system, { hp: { value: 2 } });
    assert.ok(events.some((e) => e.id === 'scene-1' && e.action === 'update'),
        'delta merge emits a scene update');

    // No-op re-apply emits nothing further.
    const count = events.length;
    store.applyModifyDocument('ActorDelta', 'update', [
        { _id: 'delta-1', name: 'Wounded Goblin', system: { hp: { value: 2 } } },
    ], { parentUuid: 'Scene.scene-1.Token.tok-1' });
    assert.equal(events.length, count, 'idempotent delta merge stays silent');
}

async function runDeltaChildEffects() {
    const { store } = await seedScene();

    // Dead status applied to the unlinked token: ActiveEffect create under
    // the token's ActorDelta.
    store.applyModifyDocument('ActiveEffect', 'create', [
        { _id: 'fx-dead', statuses: ['dead'] },
    ], { parentUuid: 'Scene.scene-1.Token.tok-1.ActorDelta.delta-1' });
    let effects = store.getToken('scene-1', 'tok-1')?.delta?.effects as Array<Record<string, unknown>>;
    assert.equal(effects.length, 1);
    assert.deepEqual(effects[0].statuses, ['dead']);

    // Broadcast-shaped delete removes it (status cleared in Foundry).
    store.applyModifyDocument('ActiveEffect', 'delete', ['fx-dead'], {
        parentUuid: 'Scene.scene-1.Token.tok-1.ActorDelta.delta-1',
    });
    effects = store.getToken('scene-1', 'tok-1')?.delta?.effects as Array<Record<string, unknown>>;
    assert.equal(effects.length, 0);
}

async function runTargetedTokenLookup() {
    const { store } = await seedScene();

    const token = store.getToken('scene-1', 'tok-1');
    assert.equal(token?.name, 'Goblin 1');
    // Clone-on-read: mutations must not reach the cache.
    token!.name = 'Mutated';
    assert.equal(store.getToken('scene-1', 'tok-1')?.name, 'Goblin 1');

    assert.equal(store.getToken('scene-1', 'tok-missing'), null);
    assert.equal(store.getToken('scene-missing', 'tok-1'), null);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('scene-store.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
