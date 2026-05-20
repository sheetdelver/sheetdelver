import { strict as assert } from 'node:assert';
import {
    DocumentResolver,
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
    console.log('  - DocumentResolver: all checks passed');
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

    // Phase 1 deliberately avoids changing runtime resolution behavior.
    assert.equal(await resolver.fetchByUuid('Actor.actor-1'), null);
}
