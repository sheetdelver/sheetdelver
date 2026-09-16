import { strict as assert } from 'node:assert';
import { ActorStore } from '@server/core/documents/primary/actors/ActorStore';
import {
    PreparedActorStore,
    PreparedActorUnavailableError,
    type PreparedActorChangedEvent,
} from '@server/core/documents/prepared/actors/PreparedActorStore';
import { DocumentOwnershipLevel } from '@server/core/documents/primary/base/ownership';
import { BaseSystemAdapter } from '@shared/sdk';
import type {
    ActorPreparationContext,
    ActorSheetData,
    FoundryActor,
    PreparedActorData,
    SystemAdapter,
} from '@shared/sdk';

class TestAdapter extends BaseSystemAdapter {
    public override systemId = 'test-system';

    public override prepareActorData(
        actor: FoundryActor,
        context: Readonly<ActorPreparationContext>,
    ): PreparedActorData {
        const prepared = super.prepareActorData(actor, context);
        const hp = Number((actor.system.hp as number | undefined) ?? 0);
        actor.name = 'mutated preparer input';
        return {
            ...prepared,
            name: `Prepared ${prepared.name}`,
            derived: {
                hpDouble: hp * 2,
                sourceRevision: context.sourceRevision,
            },
        };
    }
}

function context(worldEpoch = 7) {
    return {
        worldEpoch,
        systemId: 'test-system',
        systemVersion: '2.0.0',
        moduleId: 'test-system',
        moduleVersion: '1.4.0',
    };
}

async function createStore(adapter: SystemAdapter | null = new TestAdapter()) {
    const source = new ActorStore();
    await source.seed(async () => ([
        {
            _id: 'actor-1',
            name: 'One',
            type: 'character',
            img: 'one.webp',
            system: { hp: 4 },
            items: [{ _id: 'item-1', name: 'Sword', type: 'weapon', system: { quantity: 1 } }],
            ownership: { default: DocumentOwnershipLevel.OWNER },
        },
    ]));
    const prepared = new PreparedActorStore();
    prepared.bind(source);
    prepared.configure(adapter, context());
    return { source, prepared };
}

export async function run() {
    await runInitialPreparationAndCloneSafety();
    await runRevisionAndEventOrdering();
    await runEmbeddedChangeAndDelete();
    await runFailureIsolation();
    await runLegacyAdapterBridge();
    console.log('  - PreparedActorStore: all checks passed');
}

async function runInitialPreparationAndCloneSafety() {
    const { source, prepared } = await createStore();
    assert.deepEqual(prepared.rebuildAll(), { prepared: 1, failed: 0 });
    assert.equal(prepared.isReady(), true);

    const entry = prepared.getEntry('actor-1');
    assert.equal(entry?.status, 'ready');
    assert.equal(entry?.worldEpoch, 7);
    assert.equal(entry?.sourceRevision, 1);
    assert.equal(entry?.systemVersion, '2.0.0');
    assert.equal(entry?.moduleVersion, '1.4.0');

    const actor = prepared.getRequired('actor-1');
    assert.equal(actor.name, 'Prepared One');
    assert.equal(actor.derived.hpDouble, 8);
    assert.equal(actor.ownership?.default, DocumentOwnershipLevel.OWNER,
        'prepared data retains the complete source shape');
    assert.equal(source.get('actor-1')?.name, 'One',
        'preparer receives a defensive source clone');

    actor.name = 'changed by reader';
    actor.items[0].name = 'changed item';
    assert.equal(prepared.getRequired('actor-1').name, 'Prepared One');
    assert.equal(prepared.getRequired('actor-1').items[0].name, 'Sword');
}

async function runRevisionAndEventOrdering() {
    const { source, prepared } = await createStore();
    prepared.rebuildAll();
    const events: PreparedActorChangedEvent[] = [];
    prepared.on('preparedActorChanged', (event: PreparedActorChangedEvent) => {
        events.push(event);
        if (event.status === 'ready') {
            assert.equal(
                prepared.getRequired(event.actorId).derived.sourceRevision,
                event.sourceRevision,
                'prepared revision is published before its invalidation event',
            );
        }
    });

    source.patch('actor-1', { 'system.hp': 6 });

    assert.equal(prepared.getRequired('actor-1').derived.hpDouble, 12);
    assert.deepEqual(events.map(event => ({
        action: event.action,
        revision: event.sourceRevision,
        status: event.status,
    })), [{ action: 'update', revision: 2, status: 'ready' }]);
}

async function runEmbeddedChangeAndDelete() {
    const { source, prepared } = await createStore();
    prepared.rebuildAll();

    source.applyModifyDocument('Item', 'update', [
        { _id: 'item-1', system: { quantity: 3 } },
    ], { parentUuid: 'Actor.actor-1' });

    assert.equal(prepared.getRequired('actor-1').items[0].system.quantity, 3);
    assert.equal(prepared.getEntry('actor-1')?.sourceRevision, 2);

    const deleteEvents: PreparedActorChangedEvent[] = [];
    prepared.on('preparedActorChanged', (event: PreparedActorChangedEvent) => {
        if (event.action === 'delete') deleteEvents.push(event);
    });
    source.delete('actor-1');

    assert.equal(prepared.get('actor-1'), null);
    assert.equal(prepared.getEntry('actor-1'), null);
    assert.equal(deleteEvents.at(-1)?.status, 'deleted');
    assert.throws(() => prepared.getRequired('actor-1'), PreparedActorUnavailableError);
}

async function runFailureIsolation() {
    class FailingAdapter extends TestAdapter {
        public override prepareActorData(): PreparedActorData {
            throw new Error('intentional preparation failure');
        }
    }

    const { source, prepared } = await createStore(new FailingAdapter());
    source.upsert({
        _id: 'actor-2',
        name: 'Two',
        type: 'character',
        system: {},
        items: [],
    });
    assert.deepEqual(prepared.rebuildAll(), { prepared: 0, failed: 2 });
    assert.equal(prepared.isReady(), true, 'one failed Actor does not make the store unavailable');
    assert.equal(prepared.list().length, 0);
    assert.equal(prepared.getEntry('actor-1')?.status, 'failed');
    assert.throws(
        () => prepared.getRequired('actor-1'),
        (error: unknown) => error instanceof PreparedActorUnavailableError
            && error.diagnostic?.code === 'PREPARATION_FAILED'
            && error.message.includes('intentional preparation failure'),
    );
}

async function runLegacyAdapterBridge() {
    let computeCalls = 0;
    const legacyAdapter: SystemAdapter = {
        systemId: 'legacy',
        match: () => true,
        normalizeActorData(actor: FoundryActor): ActorSheetData {
            return {
                id: actor._id,
                name: actor.name,
                type: actor.type,
                img: actor.img ?? '',
                system: actor.system,
                items: actor.items,
                effects: actor.effects,
                derived: { normalized: true },
            };
        },
        computeActorData() {
            computeCalls += 1;
            return { computed: true };
        },
    };
    const { prepared } = await createStore(legacyAdapter);
    prepared.rebuildAll();

    assert.equal(computeCalls, 1);
    assert.deepEqual(prepared.getRequired('actor-1').derived, {
        normalized: true,
        computed: true,
    });
}
