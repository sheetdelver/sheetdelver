import { strict as assert } from 'node:assert';
import { CardsStore, cardsStore } from '@server/core/documents/primary/cards/CardsStore';
import { CardsRepository } from '@server/core/documents/primary/cards/CardsRepository';
import {
    DOCUMENT_VISIBILITY,
    DocumentOwnershipLevel,
    FoundryUserRole,
    type DocumentAccessSubject,
} from '@server/core/documents/primary/base/ownership';
import type { DocumentChangedEvent } from '@server/core/documents/primary/base/PrimaryDocumentStore';
import type { RawCards } from '@server/shared/types/documents';

const player: DocumentAccessSubject = { userId: 'p-1', role: FoundryUserRole.PLAYER };
const otherPlayer: DocumentAccessSubject = { userId: 'p-2', role: FoundryUserRole.PLAYER };
const gm: DocumentAccessSubject = { userId: 'gm-1', role: FoundryUserRole.GAMEMASTER };

export async function run() {
    await runSeedAndCloneOnRead();
    await runOwnershipPolicy();
    await runEmbeddedCardRouting();
    await runCrossDocTransferPairedEvents();
    await runRepositoryMirrorsWrites();
    console.log('  - CardsStore: all checks passed');
}

async function runSeedAndCloneOnRead() {
    const store = new CardsStore();
    await store.seed(async () => [
        {
            _id: 'deck-1',
            name: 'Tarot',
            type: 'deck',
            ownership: { default: DocumentOwnershipLevel.OBSERVER },
            cards: [
                { _id: 'c-1', name: 'The Fool', drawn: false, value: 0 },
            ],
        },
    ]);

    assert.equal(store.isReady(), true);
    assert.equal(store.list().length, 1);

    const clone = store.get('deck-1')!;
    clone.name = 'Mutated';
    assert.equal(store.get('deck-1')?.name, 'Tarot');
}

async function runOwnershipPolicy() {
    const store = new CardsStore();
    const cards: RawCards[] = [
        { _id: 'cards-public', ownership: { default: DocumentOwnershipLevel.OBSERVER } },
        { _id: 'cards-private', ownership: { default: DocumentOwnershipLevel.NONE, 'p-1': DocumentOwnershipLevel.OBSERVER } },
        { _id: 'cards-hidden', ownership: { default: DocumentOwnershipLevel.NONE } },
    ];
    await store.seed(async () => cards);

    assert.equal(store.canReadDocument('cards-public', player, DOCUMENT_VISIBILITY.LIST_VISIBLE), true);
    assert.equal(store.canReadDocument('cards-private', player, DOCUMENT_VISIBILITY.LIST_VISIBLE), true);
    assert.equal(store.canReadDocument('cards-private', otherPlayer, DOCUMENT_VISIBILITY.LIST_VISIBLE), false);
    assert.equal(store.canReadDocument('cards-hidden', player, DOCUMENT_VISIBILITY.LIST_VISIBLE), false);
    assert.equal(store.canReadDocument('cards-hidden', gm, DOCUMENT_VISIBILITY.WRITEABLE), true);
}

async function runEmbeddedCardRouting() {
    const store = new CardsStore();
    await store.seed(async () => [
        {
            _id: 'deck-with-cards',
            type: 'deck',
            ownership: { default: DocumentOwnershipLevel.OBSERVER },
            cards: [
                { _id: 'c-existing', name: 'Ace', drawn: false },
            ],
        },
    ] as RawCards[]);

    const events: DocumentChangedEvent[] = [];
    store.on('documentChanged', (e) => events.push(e as DocumentChangedEvent));

    store.applyModifyDocument('Card', 'create', [
        { _id: 'c-new', name: 'King', drawn: false },
    ], { parentUuid: 'Cards.deck-with-cards' });
    assert.equal(store.get('deck-with-cards')?.cards?.length, 2);
    assert.equal(events.find((e) => e.id === 'deck-with-cards')?.action, 'update');

    // Draw — drawn flips to true via embedded update.
    store.applyModifyDocument('Card', 'update', [
        { _id: 'c-existing', drawn: true },
    ], { parentUuid: 'Cards.deck-with-cards' });
    const existing = (store.get('deck-with-cards')?.cards || []).find((c: any) => c._id === 'c-existing') as any;
    assert.equal(existing?.drawn, true);

    // Idempotent: same update fires no extra event.
    const before = events.length;
    store.applyModifyDocument('Card', 'update', [
        { _id: 'c-existing', drawn: true },
    ], { parentUuid: 'Cards.deck-with-cards' });
    assert.equal(events.length, before, 'no-op card update emits nothing');

    store.applyModifyDocument('Card', 'delete', null, {
        parentUuid: 'Cards.deck-with-cards',
        ids: ['c-new'],
    });
    assert.equal(store.get('deck-with-cards')?.cards?.length, 1);

    // Unknown embedded type silently dropped.
    store.applyModifyDocument('NotACardsChild', 'create', [{ _id: 'x' }], {
        parentUuid: 'Cards.deck-with-cards',
    });
    assert.equal(store.get('deck-with-cards')?.cards?.length, 1);
}

async function runCrossDocTransferPairedEvents() {
    // Foundry's `Cards#pass` deck→hand arrives as paired update/delete events
    // across two parents. Each leg lands on its own parent through the same
    // in-place handler so both deck and hand caches stay coherent.
    const store = new CardsStore();
    await store.seed(async () => [
        {
            _id: 'deck',
            type: 'deck',
            ownership: { default: DocumentOwnershipLevel.OBSERVER },
            cards: [{ _id: 'card-x', name: 'Card X', drawn: false }],
        },
        {
            _id: 'hand',
            type: 'hand',
            ownership: { default: DocumentOwnershipLevel.OBSERVER },
            cards: [],
        },
    ] as RawCards[]);

    // Leg 1: remove from deck.
    store.applyModifyDocument('Card', 'delete', null, {
        parentUuid: 'Cards.deck',
        ids: ['card-x'],
    });
    assert.equal(store.get('deck')?.cards?.length, 0);

    // Leg 2: create on hand.
    store.applyModifyDocument('Card', 'create', [
        { _id: 'card-x', name: 'Card X', drawn: false },
    ], { parentUuid: 'Cards.hand' });
    assert.equal(store.get('hand')?.cards?.length, 1);
    assert.equal((store.get('hand')?.cards?.[0] as any)?._id, 'card-x');
}

async function runRepositoryMirrorsWrites() {
    const store = cardsStore;
    await store.seed(async () => []);

    const dispatches: Array<{ type: string; action: string; operation: any; parent?: any }> = [];
    const repository = new CardsRepository({
        dispatchDocument: async (type, action, operation, parent) => {
            dispatches.push({ type, action, operation, parent });
            if (type === 'Cards' && action === 'create') {
                return {
                    result: [
                        {
                            _id: 'created-deck',
                            name: 'Created Deck',
                            type: 'deck',
                            ownership: { default: DocumentOwnershipLevel.OBSERVER },
                            cards: [],
                        },
                    ],
                    operation,
                };
            }
            if (type === 'Card' && action === 'create') {
                return {
                    result: [{ _id: 'created-card', name: 'Created Card', drawn: false }],
                    operation,
                };
            }
            return { result: [], operation };
        },
    });

    try {
        await repository.create({ name: 'Created Deck', type: 'deck' });
        assert.equal(store.get('created-deck')?.name, 'Created Deck');

        await repository.createCard('created-deck', { name: 'Created Card' });
        const cDispatch = dispatches.find((d) => d.type === 'Card' && d.action === 'create');
        assert.ok(cDispatch);
        assert.deepEqual(cDispatch!.parent, { type: 'Cards', id: 'created-deck' });
        assert.equal(store.get('created-deck')?.cards?.length, 1);
        assert.equal((store.get('created-deck')?.cards?.[0] as any)?._id, 'created-card');
    } finally {
        store.clear('cards-repository-test');
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('cards-store.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
