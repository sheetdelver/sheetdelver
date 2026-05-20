import { strict as assert } from 'node:assert';
import { PrimaryDocumentCacheNotReadyError } from '@server/core/documents/primary/errors';
import {
    DocumentResolver,
    type DocumentResolverStoreMap,
    type DocumentStoreReader,
    parseCompendiumUuid,
    parseDocumentUuid,
    parseWorldUuid,
} from '@server/services/documents';

export async function run() {
    runInvalidUuidParsing();
    runDirectWorldUuidParsing();
    runEmbeddedWorldUuidParsing();
    runCompendiumUuidParsing();
    await runResolverShell();
    await runStoreBackedWorldResolution();
    await runStoreNotReadyFailures();
    await runUnknownAndDeferredWorldTypes();
    await runEmbeddedWorldResolution();
    await runEmbeddedMissingAndMalformedResolution();
    console.log('  - DocumentResolver: all checks passed');
}

class SyntheticDocumentStore implements DocumentStoreReader {
    public constructor(
        private readonly ready: boolean,
        private readonly documents: Record<string, unknown> = {},
    ) {}

    public isReady(): boolean {
        return this.ready;
    }

    public get(id: string): unknown | null {
        return this.documents[id] ?? null;
    }
}

function runInvalidUuidParsing() {
    assert.equal(parseDocumentUuid(''), null);
    assert.equal(parseDocumentUuid('   '), null);
    assert.equal(parseDocumentUuid('Actor'), null);
    assert.equal(parseDocumentUuid('Actor.'), null);
    assert.equal(parseDocumentUuid('Actor.actor-1.Item'), null);
    assert.equal(parseDocumentUuid('Compendium'), null);
    assert.equal(parseDocumentUuid('Compendium.synthetic'), null);
    assert.equal(parseCompendiumUuid('Actor.actor-1'), null);
    assert.equal(parseWorldUuid('Compendium.synthetic.items.Item.torch'), null);
}

function runDirectWorldUuidParsing() {
    const actor = parseDocumentUuid('Actor.actor-1');
    assert.ok(actor && actor.kind === 'world');
    assert.equal(actor.documentType, 'Actor');
    assert.equal(actor.documentId, 'actor-1');
    assert.equal(actor.raw, 'Actor.actor-1');

    const unknown = parseWorldUuid('Mystery.mystery-1');
    assert.ok(unknown && unknown.kind === 'world');
    assert.equal(unknown.documentType, 'Mystery');
    assert.equal(unknown.documentId, 'mystery-1');
}

function runEmbeddedWorldUuidParsing() {
    const item = parseDocumentUuid('Actor.actor-1.Item.item-1');
    assert.ok(item && item.kind === 'embedded-world');
    assert.deepEqual(item.root, { type: 'Actor', id: 'actor-1' });
    assert.deepEqual(item.path, [{ type: 'Item', id: 'item-1' }]);

    const nestedEffect = parseDocumentUuid('Actor.actor-1.Item.item-1.ActiveEffect.effect-1');
    assert.ok(nestedEffect && nestedEffect.kind === 'embedded-world');
    assert.deepEqual(nestedEffect.root, { type: 'Actor', id: 'actor-1' });
    assert.deepEqual(nestedEffect.path, [
        { type: 'Item', id: 'item-1' },
        { type: 'ActiveEffect', id: 'effect-1' },
    ]);

    const journalPage = parseWorldUuid('JournalEntry.journal-1.JournalEntryPage.page-1');
    assert.ok(journalPage && journalPage.kind === 'embedded-world');
    assert.deepEqual(journalPage.root, { type: 'JournalEntry', id: 'journal-1' });
    assert.deepEqual(journalPage.path, [{ type: 'JournalEntryPage', id: 'page-1' }]);
}

function runCompendiumUuidParsing() {
    const noType = parseDocumentUuid('Compendium.synthetic.items.torch');
    assert.ok(noType && noType.kind === 'compendium');
    assert.equal(noType.packId, 'synthetic.items');
    assert.equal(noType.type, null);
    assert.equal(noType.documentId, 'torch');

    const typed = parseCompendiumUuid('Compendium.synthetic.items.Item.torch');
    assert.ok(typed);
    assert.equal(typed.packId, 'synthetic.items');
    assert.equal(typed.type, 'Item');
    assert.equal(typed.documentId, 'torch');

    const dottedPack = parseCompendiumUuid('Compendium.vendor.system.roll-tables.RollTable.talents');
    assert.ok(dottedPack);
    assert.equal(dottedPack.packId, 'vendor.system.roll-tables');
    assert.equal(dottedPack.type, 'RollTable');
    assert.equal(dottedPack.documentId, 'talents');

    const cardsPack = parseCompendiumUuid('Compendium.synthetic.cards.Cards.deck-1');
    assert.ok(cardsPack);
    assert.equal(cardsPack.packId, 'synthetic.cards');
    assert.equal(cardsPack.type, 'Cards');
    assert.equal(cardsPack.documentId, 'deck-1');

    const capitalPackSegment = parseCompendiumUuid('Compendium.synthetic.Spell.fireball');
    assert.ok(capitalPackSegment);
    assert.equal(capitalPackSegment.packId, 'synthetic.Spell');
    assert.equal(capitalPackSegment.type, null);
    assert.equal(capitalPackSegment.documentId, 'fireball');
}

async function runResolverShell() {
    const resolver = new DocumentResolver();

    const parsed = resolver.parse('Actor.actor-1');
    assert.ok(parsed && parsed.kind === 'world');
    assert.equal(parsed.documentId, 'actor-1');

    // Phase 3 still leaves compendium UUIDs dormant.
    assert.equal(await resolver.fetchByUuid('Compendium.synthetic.items.Item.torch'), null);
}

async function runStoreBackedWorldResolution() {
    const storeBackedDocuments = {
        Actor: { _id: 'actor-1', type: 'Actor' },
        Item: { _id: 'item-1', type: 'Item' },
        ChatMessage: { _id: 'message-1', type: 'ChatMessage' },
        Folder: { _id: 'folder-1', type: 'Folder' },
        User: { _id: 'user-1', type: 'User' },
        JournalEntry: { _id: 'journal-1', type: 'JournalEntry' },
        Combat: { _id: 'combat-1', type: 'Combat' },
        RollTable: { _id: 'table-1', type: 'RollTable' },
        Macro: { _id: 'macro-1', type: 'Macro' },
        Playlist: { _id: 'playlist-1', type: 'Playlist' },
        Cards: { _id: 'cards-1', type: 'Cards' },
    } as const;

    const documentStores = Object.fromEntries(
        Object.entries(storeBackedDocuments).map(([type, document]) => [
            type,
            new SyntheticDocumentStore(true, { [document._id]: document }),
        ]),
    ) as DocumentResolverStoreMap;

    const resolver = new DocumentResolver({ documentStores });
    for (const [type, document] of Object.entries(storeBackedDocuments)) {
        assert.deepEqual(await resolver.fetchByUuid(`${type}.${document._id}`), document);
    }
    assert.equal(await resolver.fetchByUuid('Actor.missing'), null);
}

async function runStoreNotReadyFailures() {
    const resolver = new DocumentResolver({
        documentStores: {
            Actor: new SyntheticDocumentStore(false),
        },
    });

    await assert.rejects(
        () => resolver.fetchByUuid('Actor.actor-1'),
        (error: unknown) => error instanceof PrimaryDocumentCacheNotReadyError
            && error.message.includes('Actor document cache is not ready'),
    );
}

async function runUnknownAndDeferredWorldTypes() {
    const resolver = new DocumentResolver({
        documentStores: {
            Scene: new SyntheticDocumentStore(false, { 'scene-1': { _id: 'scene-1' } }),
            FogExploration: new SyntheticDocumentStore(false, { 'fog-1': { _id: 'fog-1' } }),
            Adventure: new SyntheticDocumentStore(false, { 'adventure-1': { _id: 'adventure-1' } }),
            Setting: new SyntheticDocumentStore(false, { 'setting-1': { _id: 'setting-1' } }),
        },
    });

    assert.equal(await resolver.fetchByUuid('Mystery.mystery-1'), null);
    assert.equal(await resolver.fetchByUuid('Scene.scene-1'), null);
    assert.equal(await resolver.fetchByUuid('FogExploration.fog-1'), null);
    assert.equal(await resolver.fetchByUuid('Adventure.adventure-1'), null);
    assert.equal(await resolver.fetchByUuid('Setting.setting-1'), null);
}

async function runEmbeddedWorldResolution() {
    const actorItem = {
        _id: 'actor-item-1',
        type: 'weapon',
        effects: [{ _id: 'item-effect-1', label: 'Item effect' }],
    };
    const actorEffect = { _id: 'actor-effect-1', label: 'Actor effect' };
    const journalPage = { _id: 'page-1', type: 'text', name: 'Arrival' };
    const combatant = { _id: 'combatant-1', name: 'Rival' };
    const sound = { _id: 'sound-1', name: 'Door creak' };
    const card = { _id: 'card-1', name: 'Ace' };
    const worldItemEffect = { _id: 'world-item-effect-1', label: 'World item effect' };

    const resolver = new DocumentResolver({
        documentStores: {
            Actor: new SyntheticDocumentStore(true, {
                'actor-1': {
                    _id: 'actor-1',
                    items: [actorItem],
                    effects: [actorEffect],
                },
            }),
            Item: new SyntheticDocumentStore(true, {
                'world-item-1': {
                    _id: 'world-item-1',
                    effects: [worldItemEffect],
                },
            }),
            JournalEntry: new SyntheticDocumentStore(true, {
                'journal-1': {
                    _id: 'journal-1',
                    pages: [journalPage],
                },
            }),
            Combat: new SyntheticDocumentStore(true, {
                'combat-1': {
                    _id: 'combat-1',
                    combatants: [combatant],
                },
            }),
            Playlist: new SyntheticDocumentStore(true, {
                'playlist-1': {
                    _id: 'playlist-1',
                    sounds: [sound],
                },
            }),
            Cards: new SyntheticDocumentStore(true, {
                'deck-1': {
                    _id: 'deck-1',
                    cards: [card],
                },
            }),
        },
    });

    assert.deepEqual(await resolver.fetchByUuid('Actor.actor-1.Item.actor-item-1'), actorItem);
    assert.deepEqual(await resolver.fetchByUuid('Actor.actor-1.ActiveEffect.actor-effect-1'), actorEffect);
    assert.deepEqual(
        await resolver.fetchByUuid('Actor.actor-1.Item.actor-item-1.ActiveEffect.item-effect-1'),
        actorItem.effects[0],
    );
    assert.deepEqual(
        await resolver.fetchByUuid('Item.world-item-1.ActiveEffect.world-item-effect-1'),
        worldItemEffect,
    );
    assert.deepEqual(await resolver.fetchByUuid('JournalEntry.journal-1.JournalEntryPage.page-1'), journalPage);
    assert.deepEqual(await resolver.fetchByUuid('Combat.combat-1.Combatant.combatant-1'), combatant);
    assert.deepEqual(await resolver.fetchByUuid('Playlist.playlist-1.PlaylistSound.sound-1'), sound);
    assert.deepEqual(await resolver.fetchByUuid('Cards.deck-1.Card.card-1'), card);
}

async function runEmbeddedMissingAndMalformedResolution() {
    const rollTable = {
        _id: 'table-1',
        results: [{ _id: 'result-1', text: 'A clue' }],
    };

    const resolver = new DocumentResolver({
        documentStores: {
            Actor: new SyntheticDocumentStore(true, {
                'actor-1': {
                    _id: 'actor-1',
                    items: [{ _id: 'item-1', effects: [] }],
                    effects: [],
                },
            }),
            JournalEntry: new SyntheticDocumentStore(true, {
                'journal-1': {
                    _id: 'journal-1',
                    pages: [],
                },
            }),
            RollTable: new SyntheticDocumentStore(true, {
                'table-1': rollTable,
            }),
        },
    });

    assert.equal(await resolver.fetchByUuid('Actor.missing.Item.item-1'), null);
    assert.equal(await resolver.fetchByUuid('Actor.actor-1.Item.missing'), null);
    assert.equal(await resolver.fetchByUuid('Actor.actor-1.Item.item-1.ActiveEffect.missing'), null);
    assert.equal(await resolver.fetchByUuid('JournalEntry.journal-1.JournalEntryPage.missing'), null);
    assert.equal(await resolver.fetchByUuid('Actor.actor-1.JournalEntryPage.page-1'), null);
    assert.equal(await resolver.fetchByUuid('Actor.actor-1.Item.item-1.JournalEntryPage.page-1'), null);
    assert.equal(await resolver.fetchByUuid('Actor.actor-1.Item'), null);
    assert.deepEqual(await resolver.fetchByUuid('RollTable.table-1'), rollTable);
    assert.equal(await resolver.fetchByUuid('RollTable.table-1.RollTableResult.result-1'), null);
}
