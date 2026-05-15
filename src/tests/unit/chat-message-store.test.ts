import { strict as assert } from 'node:assert';
import { ChatMessageStore } from '@server/core/documents/primary/chat-messages/ChatMessageStore';
import {
    DocumentOwnershipLevel,
    FoundryUserRole,
    type DocumentAccessSubject,
} from '@server/core/documents/primary/base/ownership';
import { DOCUMENT_VISIBILITY } from '@server/core/documents/primary/base/ownership';
import type { DocumentChangedEvent } from '@server/core/documents/primary/base/PrimaryDocumentStore';

export async function run() {
    await runWorldVisibleMessages();
    await runWhisperRestrictsVisibility();
    await runBlindRollHidesFromOthersButAuthor();
    await runGmSeesEverything();
    await runBroadcastUpdatesStoreAndEmits();
    await runFullMirrorRetention();
    console.log('  - ChatMessageStore: all checks passed');
}

const gm: DocumentAccessSubject = { userId: 'gm-1', role: FoundryUserRole.GAMEMASTER };
const author: DocumentAccessSubject = { userId: 'p-author', role: FoundryUserRole.PLAYER };
const recipient: DocumentAccessSubject = { userId: 'p-recipient', role: FoundryUserRole.PLAYER };
const bystander: DocumentAccessSubject = { userId: 'p-bystander', role: FoundryUserRole.PLAYER };

async function runWorldVisibleMessages() {
    const store = new ChatMessageStore();
    await store.seed(async () => [
        { _id: 'm1', author: 'p-author', whisper: [], blind: false, content: 'hello world' },
    ]);

    // Empty whisper + blind: false → all authenticated users see (OBSERVER).
    assert.equal(store.canReadDocument('m1', author, DOCUMENT_VISIBILITY.LIST_VISIBLE), true);
    assert.equal(store.canReadDocument('m1', recipient, DOCUMENT_VISIBILITY.LIST_VISIBLE), true);
    assert.equal(store.canReadDocument('m1', bystander, DOCUMENT_VISIBILITY.LIST_VISIBLE), true);
}

async function runWhisperRestrictsVisibility() {
    const store = new ChatMessageStore();
    await store.seed(async () => [
        { _id: 'm-whisper', author: 'p-author', whisper: ['p-recipient'], blind: false, content: 'psst' },
    ]);

    // Author sees their own whisper.
    assert.equal(store.canReadDocument('m-whisper', author, DOCUMENT_VISIBILITY.LIST_VISIBLE), true);
    // Listed recipient sees it.
    assert.equal(store.canReadDocument('m-whisper', recipient, DOCUMENT_VISIBILITY.LIST_VISIBLE), true);
    // Non-listed player does not.
    assert.equal(store.canReadDocument('m-whisper', bystander, DOCUMENT_VISIBILITY.LIST_VISIBLE), false);
    // GM sees everything.
    assert.equal(store.canReadDocument('m-whisper', gm, DOCUMENT_VISIBILITY.LIST_VISIBLE), true);
}

async function runBlindRollHidesFromOthersButAuthor() {
    const store = new ChatMessageStore();
    await store.seed(async () => [
        { _id: 'm-blind', author: 'p-author', whisper: [], blind: true, content: 'blind roll' },
    ]);

    // Author always sees their own blind rolls.
    assert.equal(store.canReadDocument('m-blind', author, DOCUMENT_VISIBILITY.LIST_VISIBLE), true);
    // GM sees blind rolls.
    assert.equal(store.canReadDocument('m-blind', gm, DOCUMENT_VISIBILITY.LIST_VISIBLE), true);
    // Other players do not.
    assert.equal(store.canReadDocument('m-blind', recipient, DOCUMENT_VISIBILITY.LIST_VISIBLE), false);
    assert.equal(store.canReadDocument('m-blind', bystander, DOCUMENT_VISIBILITY.LIST_VISIBLE), false);
}

async function runGmSeesEverything() {
    const store = new ChatMessageStore();
    await store.seed(async () => [
        { _id: 'm-1', author: 'p-author', whisper: [], blind: false },
        { _id: 'm-2', author: 'p-author', whisper: ['someone-else'], blind: false },
        { _id: 'm-3', author: 'p-author', whisper: [], blind: true },
    ]);

    const gmList = store.list({ subject: gm }).map(m => m._id).sort();
    assert.deepEqual(gmList, ['m-1', 'm-2', 'm-3']);

    // Author player sees their own m-1 (world), m-2 (whispered to other - they're author), m-3 (blind - they're author)
    const authorList = store.list({ subject: author }).map(m => m._id).sort();
    assert.deepEqual(authorList, ['m-1', 'm-2', 'm-3']);

    // Bystander sees only m-1.
    const bystanderList = store.list({ subject: bystander }).map(m => m._id).sort();
    assert.deepEqual(bystanderList, ['m-1']);
}

async function runBroadcastUpdatesStoreAndEmits() {
    const store = new ChatMessageStore();
    await store.seed(async () => []);

    const events: DocumentChangedEvent[] = [];
    store.on('documentChanged', e => events.push(e as DocumentChangedEvent));

    // Foundry broadcast for a new chat message arrives via the router.
    store.applyModifyDocument('ChatMessage', 'create', [
        { _id: 'new', author: 'p-author', whisper: [], blind: false, content: 'hi' },
    ]);

    assert.equal(store.get('new')?._id, 'new');
    assert.equal(events.length, 1);
    assert.equal(events[0].action, 'create');
    assert.equal(events[0].type, 'ChatMessage');

    // Idempotent: applying the same create payload again is a no-op (state unchanged).
    store.applyModifyDocument('ChatMessage', 'create', [
        { _id: 'new', author: 'p-author', whisper: [], blind: false, content: 'hi' },
    ]);
    assert.equal(events.length, 1);

    // Delete broadcast removes from the store.
    store.applyModifyDocument('ChatMessage', 'delete', null, { ids: ['new'] });
    assert.equal(store.get('new'), null);
    assert.equal(events.length, 2);
    assert.equal(events[1].action, 'delete');
}

async function runFullMirrorRetention() {
    // Store mirrors the full set Foundry hands back — no platform-side cap.
    // Display limits live at the service boundary (ChatService.getChatLog), not here.
    // Seed with N messages and assert all N are present.
    const N = 250;
    const docs = Array.from({ length: N }, (_, i) => ({
        _id: `m-${i}`,
        author: 'p-author',
        whisper: [],
        blind: false,
    }));
    const store = new ChatMessageStore();
    await store.seed(async () => docs);

    assert.equal(store.list().length, N);
    // Beyond what config.app.chatHistory (default 100) would display:
    // The store mirrors Foundry's set in full.
    void DocumentOwnershipLevel; // keep symbol referenced
}
