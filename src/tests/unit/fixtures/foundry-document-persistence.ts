export const v13SingleUpdateFixture = {
    type: 'Actor',
    action: 'update',
    operation: {
        updates: [{ _id: 'actor-1', name: 'Updated Actor' }],
    },
    result: [{ _id: 'actor-1', name: 'Updated Actor' }],
    userId: 'gm-1',
};

export const v14SingleDeleteFixture = {
    type: 'Combat',
    action: 'delete',
    operation: {},
    result: ['combat-1'],
    userId: 'gm-1',
    timestamp: 1_725_000_000_000,
};

export const v14BatchFixture = {
    results: [
        {
            type: 'Actor',
            action: 'update',
            operation: {
                updates: [{ _id: 'actor-1', 'system.attributes.hp.value': 7 }],
            },
            result: [{ _id: 'actor-1', system: { attributes: { hp: { value: 7 } } } }],
            sideEffect: false,
            userId: 'gm-1',
        },
        {
            type: 'ActiveEffect',
            action: 'create',
            operation: {
                parentUuid: 'Actor.actor-1',
            },
            result: [{ _id: 'effect-1', name: 'Concentrating' }],
            sideEffect: true,
            userId: 'gm-1',
        },
        {
            type: 'Item',
            action: 'update',
            operation: {
                pack: 'synthetic.items',
                updates: [{ _id: 'item-1', name: 'Pack Item' }],
            },
            result: [{ _id: 'item-1', name: 'Pack Item' }],
            sideEffect: true,
            userId: 'gm-1',
        },
        {
            type: 'Actor',
            action: 'delete',
            operation: {
                ids: ['actor-2'],
            },
            error: {
                message: 'Synthetic permission failure',
            },
            sideEffect: false,
            userId: 'gm-1',
        },
    ],
};

export const terseAcknowledgementFixture = {
    operation: {
        updates: [{ _id: 'actor-1', name: 'Terse response' }],
    },
    result: [{ _id: 'actor-1', name: 'Terse response' }],
};

export const autosaveFixtures = {
    direct: {
        uuid: 'Actor.actor-1#system.biography.value',
        html: '<p>Direct actor biography</p>',
    },
    embedded: {
        uuid: 'JournalEntry.journal-1.JournalEntryPage.page-1#text.content',
        html: '<p>Embedded journal page</p>',
    },
    compendium: {
        uuid: 'Compendium.synthetic.items.Item.item-1#system.description.value',
        html: '<p>Pack item description</p>',
    },
    malformed: {
        uuid: 'not-a-document-uuid',
        html: '<p>Malformed target</p>',
    },
} as const;

export const manageCompendiumFixtures = {
    create: {
        request: {
            action: 'create',
            data: {
                name: 'new-pack',
                label: 'New Pack',
                type: 'Item',
            },
        },
        result: {
            collection: 'world.new-pack',
        },
    },
    delete: {
        request: {
            action: 'delete',
            data: {
                collection: 'world.old-pack',
            },
        },
        result: 'world.old-pack',
    },
} as const;
