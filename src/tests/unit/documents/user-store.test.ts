import { strict as assert } from 'node:assert';
import { UserStore } from '@server/core/documents/primary/users/UserStore';
import { userPresence } from '@server/core/documents/primary/users/UserPresence';
import {
    DocumentOwnershipLevel,
    DOCUMENT_VISIBILITY,
    FoundryUserRole,
    type DocumentAccessSubject,
} from '@server/core/documents/primary/base/ownership';
import type { DocumentChangedEvent } from '@server/core/documents/primary/base/PrimaryDocumentStore';
import type { UserDocument } from '@server/shared/types/users';

const gm: DocumentAccessSubject = { userId: 'gm-1', role: FoundryUserRole.GAMEMASTER };
const player: DocumentAccessSubject = { userId: 'p-1', role: FoundryUserRole.PLAYER };

const users: UserDocument[] = [
    { _id: 'gm-1', name: 'Gamemaster', role: FoundryUserRole.GAMEMASTER, color: '#ff0000' },
    { _id: 'p-1', name: 'Alice', role: FoundryUserRole.PLAYER, color: '#0000ff' },
    { _id: 'p-2', name: 'Bob', role: FoundryUserRole.TRUSTED },
];

export async function run() {
    await runSeedAndList();
    await runOwnershipPolicy();
    await runRoleLookup();
    await runReadModelHelpers();
    await runFindByName();
    await runBroadcastUpdatesStore();
    await runNoUserOwnershipMap();
    await runNoEmbeddedChildren();
    console.log('  - UserStore: all checks passed');
}

async function runSeedAndList() {
    const store = new UserStore();
    await store.seed(async () => users);

    assert.equal(store.isReady(), true);
    assert.equal(store.list().length, 3);

    // Clone-on-read: mutating the returned doc must not affect cache state.
    const u = store.get('p-1')!;
    u.name = 'Mutated';
    assert.equal(store.get('p-1')?.name, 'Alice');
}

async function runOwnershipPolicy() {
    const store = new UserStore();
    await store.seed(async () => users);

    // Authenticated subjects see the roster (OBSERVER).
    const playerList = store.list({ subject: player });
    assert.equal(playerList.length, 3, 'players see the full roster');

    // GMs see it as OWNER (same set, just with OWNER level).
    const gmList = store.list({ subject: gm });
    assert.equal(gmList.length, 3, 'GMs see the full roster');

    // canReadDocument: authenticated → DETAIL_VISIBLE; GM → WRITEABLE.
    assert.equal(store.canReadDocument('p-1', player, DOCUMENT_VISIBILITY.LIST_VISIBLE), true);
    assert.equal(store.canReadDocument('p-1', player, DOCUMENT_VISIBILITY.DETAIL_VISIBLE), true);
    assert.equal(store.canReadDocument('p-1', player, DOCUMENT_VISIBILITY.WRITEABLE), false);
    assert.equal(store.canReadDocument('p-1', gm, DOCUMENT_VISIBILITY.WRITEABLE), true);

    // get(id, { subject }) returns the user when the subject can read at the requested level.
    assert.equal(store.get('p-1', { subject: player })?.name, 'Alice');
    assert.equal(store.get('p-1', { subject: gm })?.name, 'Alice');
}

async function runRoleLookup() {
    const store = new UserStore();
    await store.seed(async () => users);

    assert.equal(store.getRole('gm-1'), FoundryUserRole.GAMEMASTER);
    assert.equal(store.getRole('p-1'), FoundryUserRole.PLAYER);
    assert.equal(store.getRole('p-2'), FoundryUserRole.TRUSTED);
    // Missing user returns NONE — fail-closed for unknown subjects.
    assert.equal(store.getRole('missing'), FoundryUserRole.NONE);
}

async function runReadModelHelpers() {
    const store = new UserStore();
    await store.seed(async () => users);
    userPresence.clear();
    userPresence.setActive('p-1', true);

    try {
        assert.equal(store.createAccessSubject('gm-1')?.role, FoundryUserRole.GAMEMASTER);
        assert.equal(store.createAccessSubject('missing')?.role, FoundryUserRole.NONE);
        assert.equal(store.createAccessSubject(null), null);

        assert.deepEqual(store.getGmUserIds(), ['gm-1']);

        const activeUser = store.getWithPresence('p-1');
        assert.equal(activeUser?.active, true);
        assert.equal(activeUser?.name, 'Alice');

        const roster = store.listWithPresence();
        assert.equal(roster.find(u => u._id === 'p-1')?.active, true);
        assert.equal(roster.find(u => u._id === 'p-2')?.active, false);
    } finally {
        userPresence.clear();
    }
}

async function runFindByName() {
    const store = new UserStore();
    await store.seed(async () => users);

    assert.equal(store.findByName('Alice')?._id, 'p-1');
    assert.equal(store.findByName('Gamemaster')?._id, 'gm-1');
    assert.equal(store.findByName('Nonexistent'), null);
}

async function runBroadcastUpdatesStore() {
    const store = new UserStore();
    await store.seed(async () => users);

    const events: DocumentChangedEvent[] = [];
    store.on('documentChanged', e => events.push(e as DocumentChangedEvent));

    // Foundry broadcast for a User update arrives via the router.
    store.applyModifyDocument('User', 'update', [{ _id: 'p-1', color: '#00ff00' }]);
    assert.equal(store.get('p-1')?.color, '#00ff00');
    assert.equal(events.length, 1);
    assert.equal(events[0].action, 'update');
    assert.equal(events[0].type, 'User');

    // Idempotent: applying the same update again emits nothing.
    store.applyModifyDocument('User', 'update', [{ _id: 'p-1', color: '#00ff00' }]);
    assert.equal(events.length, 1);

    // Role-derived authorization reads the current Store value on demand; an
    // existing request/socket does not retain the user's former role.
    store.applyModifyDocument('User', 'update', [{ _id: 'p-1', role: FoundryUserRole.TRUSTED }]);
    assert.equal(store.createAccessSubject('p-1')?.role, FoundryUserRole.TRUSTED);

    // Create broadcast adds a new user.
    store.applyModifyDocument('User', 'create', [
        { _id: 'p-3', name: 'Charlie', role: FoundryUserRole.PLAYER },
    ]);
    assert.equal(store.get('p-3')?.name, 'Charlie');
    assert.equal(events.find(e => e.id === 'p-3' && e.action === 'create')?.action, 'create');

    // Delete broadcast removes.
    userPresence.setActive('p-3', true);
    store.applyModifyDocument('User', 'delete', null, { ids: ['p-3'] });
    assert.equal(store.get('p-3'), null);
    assert.equal(userPresence.isActive('p-3'), false, 'User deletion clears subordinate presence state');
    assert.ok(events.find(e => e.id === 'p-3' && e.action === 'delete'), 'delete event emitted');
}

async function runNoUserOwnershipMap() {
    const store = new UserStore();
    // User docs don't carry an `ownership` map. Even if a caller stuffs one in,
    // the policy ignores it — all authenticated subjects get OBSERVER, GMs get OWNER.
    await store.seed(async () => [
        // Deliberately put an ownership map on the user doc to confirm it's not consulted.
        { _id: 'odd', name: 'Odd', ownership: { default: DocumentOwnershipLevel.NONE } } as any,
    ]);

    assert.equal(store.canReadDocument('odd', player, DOCUMENT_VISIBILITY.LIST_VISIBLE), true,
        'user docs are world-visible to authenticated subjects regardless of any stuffed ownership map');
    assert.equal(store.canReadDocument('odd', gm, DOCUMENT_VISIBILITY.WRITEABLE), true,
        'GMs see users as OWNER');
}

async function runNoEmbeddedChildren() {
    // User documents have no embedded children. applyEmbeddedChange should
    // silently drop unrelated types — the default base behavior.
    const store = new UserStore();
    await store.seed(async () => users);

    const events: DocumentChangedEvent[] = [];
    store.on('documentChanged', e => events.push(e as DocumentChangedEvent));

    // Fake "child" event on a different type — should be ignored.
    store.applyModifyDocument('NotAUserChild', 'create', [{ _id: 'x' }], { parentUuid: 'User.p-1' });

    assert.equal(events.length, 0, 'unrelated embedded events are ignored');
    assert.equal(store.list().length, 3, 'user roster unchanged');
}
