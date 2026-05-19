import { strict as assert } from 'node:assert';
import { PlaylistStore, playlistStore } from '@server/core/documents/primary/playlists/PlaylistStore';
import { PlaylistRepository } from '@server/core/documents/primary/playlists/PlaylistRepository';
import {
    DOCUMENT_VISIBILITY,
    DocumentOwnershipLevel,
    FoundryUserRole,
    type DocumentAccessSubject,
} from '@server/core/documents/primary/base/ownership';
import type { DocumentChangedEvent } from '@server/core/documents/primary/base/PrimaryDocumentStore';
import type { RawPlaylist } from '@server/shared/types/documents';

const player: DocumentAccessSubject = { userId: 'p-1', role: FoundryUserRole.PLAYER };
const otherPlayer: DocumentAccessSubject = { userId: 'p-2', role: FoundryUserRole.PLAYER };
const gm: DocumentAccessSubject = { userId: 'gm-1', role: FoundryUserRole.GAMEMASTER };

export async function run() {
    await runSeedAndCloneOnRead();
    await runOwnershipPolicy();
    await runEmbeddedSoundRouting();
    await runRepositoryMirrorsWrites();
    console.log('  - PlaylistStore: all checks passed');
}

async function runSeedAndCloneOnRead() {
    const store = new PlaylistStore();
    await store.seed(async () => [
        {
            _id: 'pl-1',
            name: 'Tavern',
            folder: 'folder-1',
            ownership: { default: DocumentOwnershipLevel.OBSERVER },
            sounds: [
                { _id: 's-1', name: 'Lute', path: 'sounds/lute.ogg', playing: false },
            ],
        },
    ]);

    assert.equal(store.isReady(), true);
    assert.equal(store.list().length, 1);

    const clone = store.get('pl-1')!;
    clone.name = 'Mutated';
    assert.equal(store.get('pl-1')?.name, 'Tavern');
}

async function runOwnershipPolicy() {
    const store = new PlaylistStore();
    const playlists: RawPlaylist[] = [
        { _id: 'pl-public', ownership: { default: DocumentOwnershipLevel.OBSERVER } },
        { _id: 'pl-private', ownership: { default: DocumentOwnershipLevel.NONE, 'p-1': DocumentOwnershipLevel.OBSERVER } },
        { _id: 'pl-hidden', ownership: { default: DocumentOwnershipLevel.NONE } },
    ];
    await store.seed(async () => playlists);

    assert.equal(store.canReadDocument('pl-public', player, DOCUMENT_VISIBILITY.LIST_VISIBLE), true);
    assert.equal(store.canReadDocument('pl-private', player, DOCUMENT_VISIBILITY.LIST_VISIBLE), true);
    assert.equal(store.canReadDocument('pl-private', otherPlayer, DOCUMENT_VISIBILITY.LIST_VISIBLE), false);
    assert.equal(store.canReadDocument('pl-hidden', player, DOCUMENT_VISIBILITY.LIST_VISIBLE), false);
    assert.equal(store.canReadDocument('pl-hidden', gm, DOCUMENT_VISIBILITY.WRITEABLE), true);
}

async function runEmbeddedSoundRouting() {
    const store = new PlaylistStore();
    await store.seed(async () => [
        {
            _id: 'pl-with-sounds',
            ownership: { default: DocumentOwnershipLevel.OBSERVER },
            sounds: [
                { _id: 's-existing', name: 'Lute', playing: false },
            ],
        },
    ] as RawPlaylist[]);

    const events: DocumentChangedEvent[] = [];
    store.on('documentChanged', (e) => events.push(e as DocumentChangedEvent));

    store.applyModifyDocument('PlaylistSound', 'create', [
        { _id: 's-new', name: 'Drum', playing: false },
    ], { parentUuid: 'Playlist.pl-with-sounds' });
    assert.equal(store.get('pl-with-sounds')?.sounds?.length, 2);
    assert.equal(events.find((e) => e.id === 'pl-with-sounds')?.action, 'update');

    // playback state flips through as normal embedded update.
    store.applyModifyDocument('PlaylistSound', 'update', [
        { _id: 's-existing', playing: true, pausedTime: null },
    ], { parentUuid: 'Playlist.pl-with-sounds' });
    const existing = (store.get('pl-with-sounds')?.sounds || []).find((s: any) => s._id === 's-existing') as any;
    assert.equal(existing?.playing, true);

    // Idempotent re-apply: no event emitted.
    const before = events.length;
    store.applyModifyDocument('PlaylistSound', 'update', [
        { _id: 's-existing', playing: true, pausedTime: null },
    ], { parentUuid: 'Playlist.pl-with-sounds' });
    assert.equal(events.length, before, 'no-op sound update emits nothing');

    store.applyModifyDocument('PlaylistSound', 'delete', null, {
        parentUuid: 'Playlist.pl-with-sounds',
        ids: ['s-new'],
    });
    assert.equal(store.get('pl-with-sounds')?.sounds?.length, 1);

    // Unknown embedded type silently dropped.
    store.applyModifyDocument('NotAPlaylistChild', 'create', [{ _id: 'x' }], {
        parentUuid: 'Playlist.pl-with-sounds',
    });
    assert.equal(store.get('pl-with-sounds')?.sounds?.length, 1);
}

async function runRepositoryMirrorsWrites() {
    const store = playlistStore;
    await store.seed(async () => []);

    const dispatches: Array<{ type: string; action: string; operation: any; parent?: any }> = [];
    const repository = new PlaylistRepository({
        dispatchDocument: async (type, action, operation, parent) => {
            dispatches.push({ type, action, operation, parent });
            if (type === 'Playlist' && action === 'create') {
                return {
                    result: [
                        {
                            _id: 'created-playlist',
                            name: 'Created Playlist',
                            folder: null,
                            ownership: { default: DocumentOwnershipLevel.OBSERVER },
                            sounds: [],
                        },
                    ],
                    operation,
                };
            }
            if (type === 'PlaylistSound' && action === 'create') {
                return {
                    result: [{ _id: 'created-sound', name: 'New Sound', playing: false }],
                    operation,
                };
            }
            return { result: [], operation };
        },
    });

    try {
        await repository.create({ name: 'Created Playlist' });
        assert.equal(store.get('created-playlist')?.name, 'Created Playlist');

        await repository.createSound('created-playlist', { name: 'New Sound' });
        const sDispatch = dispatches.find((d) => d.type === 'PlaylistSound' && d.action === 'create');
        assert.ok(sDispatch);
        assert.deepEqual(sDispatch!.parent, { type: 'Playlist', id: 'created-playlist' });
        assert.equal(store.get('created-playlist')?.sounds?.length, 1);
        assert.equal((store.get('created-playlist')?.sounds?.[0] as any)?._id, 'created-sound');
    } finally {
        store.clear('playlist-repository-test');
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('playlist-store.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
