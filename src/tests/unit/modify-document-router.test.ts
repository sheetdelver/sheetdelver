import { strict as assert } from 'node:assert';
import {
    ModifyDocumentRouter,
} from '@server/core/documents/primary/base/modifyDocumentRouter';
import {
    PrimaryDocumentStore,
    type ModifyDocumentAction,
    type PrimaryDocumentType,
} from '@server/core/documents/primary/base/PrimaryDocumentStore';
import {
    DocumentOwnershipLevel,
    getEffectiveOwnership,
    type DocumentAccessSubject,
    type DocumentOwnershipMap,
    type ResolvedDocumentOwnershipLevel,
} from '@server/core/documents/primary/base/ownership';

interface TestDoc {
    _id?: string;
    id?: string;
    ownership?: DocumentOwnershipMap;
}

/**
 * Lightweight Store that records the routing it observes.
 */
class RecordingStore extends PrimaryDocumentStore<TestDoc> {
    public readonly documentType: PrimaryDocumentType;
    public received: Array<{ type: string; action: ModifyDocumentAction; parentUuid?: string }> = [];

    constructor(type: PrimaryDocumentType) {
        super();
        this.documentType = type;
    }

    protected resolveOwnership(
        doc: TestDoc,
        subject: DocumentAccessSubject,
    ): ResolvedDocumentOwnershipLevel {
        return getEffectiveOwnership(doc.ownership, subject);
    }

    public applyModifyDocument(
        type: string,
        action: ModifyDocumentAction,
        _result: unknown,
        operation?: Record<string, unknown>,
    ): void {
        this.received.push({
            type,
            action,
            parentUuid: typeof operation?.parentUuid === 'string' ? operation.parentUuid : undefined,
        });
    }
}

export async function run() {
    await runDirectTypeRouting();
    await runEmbeddedParentRouting();
    await runJournalEntryPageEmbeddedRouting();
    await runCombatantEmbeddedRouting();
    await runActorDeltaDroppedSilently();
    await runUnregisteredTypeDroppedSilently();
    await runResetClearsRegistrations();
    await runMalformedPayloadDoesNotThrow();
    console.log('  - ModifyDocumentRouter: all checks passed');
}

async function runDirectTypeRouting() {
    const router = new ModifyDocumentRouter();
    const actor = new RecordingStore('Actor');
    const chat = new RecordingStore('ChatMessage');
    const folder = new RecordingStore('Folder');
    router.register(actor);
    router.register(chat);
    router.register(folder);

    router.route({ type: 'Actor', action: 'update', result: [{ _id: 'a' }] });
    router.route({ type: 'ChatMessage', action: 'create', result: [{ _id: 'm' }] });
    router.route({ type: 'Folder', action: 'update', result: [{ _id: 'f' }] });

    assert.equal(actor.received.length, 1);
    assert.equal(actor.received[0].type, 'Actor');
    assert.equal(chat.received.length, 1);
    assert.equal(chat.received[0].type, 'ChatMessage');
    assert.equal(folder.received.length, 1);
    assert.equal(folder.received[0].type, 'Folder');
}

async function runEmbeddedParentRouting() {
    const router = new ModifyDocumentRouter();
    const actor = new RecordingStore('Actor');
    router.register(actor);
    router.registerEmbeddedHandler('Actor', actor);

    // Item under an Actor → routes to ActorStore via embedded handler.
    router.route({
        type: 'Item',
        action: 'create',
        result: [{ _id: 'i' }],
        operation: { parentUuid: 'Actor.actor-1' },
    });

    // ActiveEffect under an Actor.<id>.Item → same handler.
    router.route({
        type: 'ActiveEffect',
        action: 'update',
        result: [{ _id: 'e' }],
        operation: { parentUuid: 'Actor.actor-1.Item.item-1' },
    });

    assert.equal(actor.received.length, 2);
    assert.equal(actor.received[0].type, 'Item');
    assert.equal(actor.received[0].parentUuid, 'Actor.actor-1');
    assert.equal(actor.received[1].type, 'ActiveEffect');
    assert.equal(actor.received[1].parentUuid, 'Actor.actor-1.Item.item-1');
}

async function runJournalEntryPageEmbeddedRouting() {
    const router = new ModifyDocumentRouter();
    const journal = new RecordingStore('JournalEntry');
    router.register(journal);
    router.registerEmbeddedHandler('JournalEntry', journal);

    // JournalEntryPage under a JournalEntry → routes to JournalStore embedded handler.
    router.route({
        type: 'JournalEntryPage',
        action: 'create',
        result: [{ _id: 'page-1' }],
        operation: { parentUuid: 'JournalEntry.entry-1' },
    });
    router.route({
        type: 'JournalEntryPage',
        action: 'update',
        result: [{ _id: 'page-1', name: 'Renamed' }],
        operation: { parentUuid: 'JournalEntry.entry-1' },
    });

    assert.equal(journal.received.length, 2);
    assert.equal(journal.received[0].type, 'JournalEntryPage');
    assert.equal(journal.received[0].parentUuid, 'JournalEntry.entry-1');
    assert.equal(journal.received[1].action, 'update');
}

async function runCombatantEmbeddedRouting() {
    const router = new ModifyDocumentRouter();
    const combat = new RecordingStore('Combat');
    router.register(combat);
    router.registerEmbeddedHandler('Combat', combat);

    // Combatant under a Combat → routes to CombatStore embedded handler.
    router.route({
        type: 'Combatant',
        action: 'create',
        result: [{ _id: 'c-1', actorId: 'a-1' }],
        operation: { parentUuid: 'Combat.combat-1' },
    });
    router.route({
        type: 'Combatant',
        action: 'update',
        result: [{ _id: 'c-1', initiative: 12 }],
        operation: { parentUuid: 'Combat.combat-1' },
    });

    assert.equal(combat.received.length, 2);
    assert.equal(combat.received[0].type, 'Combatant');
    assert.equal(combat.received[0].parentUuid, 'Combat.combat-1');
    assert.equal(combat.received[1].action, 'update');
}

async function runActorDeltaDroppedSilently() {
    const router = new ModifyDocumentRouter();
    const actor = new RecordingStore('Actor');
    router.register(actor);
    router.registerEmbeddedHandler('Actor', actor);

    // ActorDelta is the synthetic-token-actor wire type — out of scope per ADR-0011.
    // Direct-type route: no 'ActorDelta' registration, no embedded handler for 'ActorDelta'.
    router.route({ type: 'ActorDelta', action: 'update', result: [{ _id: 'd' }] });

    // Embedded under ActorDelta — same.
    router.route({
        type: 'Item',
        action: 'update',
        result: [{ _id: 'i' }],
        operation: { parentUuid: 'ActorDelta.delta-1.Item.item-1' },
    });

    // Nothing reached the actor store.
    assert.equal(actor.received.length, 0);
}

async function runUnregisteredTypeDroppedSilently() {
    const router = new ModifyDocumentRouter();
    // Macro / Playlist / Cards not registered — router should drop without throwing.
    router.route({ type: 'Macro', action: 'update', result: [{ _id: 'macro' }] });
    router.route({ type: 'Playlist', action: 'create', result: [{ _id: 'p' }] });
    // No assertion needed — the lack of a throw is the success.
    assert.ok(true);
}

async function runResetClearsRegistrations() {
    const router = new ModifyDocumentRouter();
    const actor = new RecordingStore('Actor');
    router.register(actor);
    router.route({ type: 'Actor', action: 'update', result: [{ _id: 'a' }] });
    assert.equal(actor.received.length, 1);

    router.reset();
    router.route({ type: 'Actor', action: 'update', result: [{ _id: 'b' }] });
    assert.equal(actor.received.length, 1); // still 1 — no new routing
}

async function runMalformedPayloadDoesNotThrow() {
    const router = new ModifyDocumentRouter();
    const actor = new RecordingStore('Actor');
    router.register(actor);

    // Missing result, missing operation — should still route by type without throwing.
    router.route({ type: 'Actor', action: 'delete' });
    assert.equal(actor.received.length, 1);

    // Non-string parentUuid in operation — should fall through to "no parent" path.
    router.route({
        type: 'UnknownType',
        action: 'update',
        operation: { parentUuid: 12345 as unknown as string },
    });
    // No additional actor receipt (UnknownType isn't registered).
    assert.equal(actor.received.length, 1);

    void DocumentOwnershipLevel;
}
