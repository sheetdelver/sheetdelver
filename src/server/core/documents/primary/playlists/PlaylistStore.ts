import type { PlaylistDocument, PlaylistSoundDocument } from '@server/shared/types/documents';
import {
    cloneDocument,
    deepMerge,
    getDocumentId,
    getOperationIds,
    isRecord,
    PrimaryDocumentStore,
    stableJson,
    toDocumentArray,
    type ModifyDocumentAction,
    type PrimaryDocumentType,
} from '../base/PrimaryDocumentStore';
import {
    DocumentOwnershipLevel,
    getEffectiveOwnership,
    type DocumentAccessSubject,
    type DocumentOwnershipMap,
    type ResolvedDocumentOwnershipLevel,
} from '../base/ownership';

function soundId(sound: unknown): string | null {
    if (!isRecord(sound)) return null;
    return getDocumentId(sound);
}

/**
 * Playlist primary-document Store. Full hydration + bootstrap seed.
 *
 * Visibility (per ADR-0013): standard `ownership` map — GMs short-circuit to
 * OWNER via `getEffectiveOwnership`; non-GM subjects read explicit user entry
 * or fall back to `ownership.default`. Same policy as Actor, Item, JournalEntry,
 * RollTable.
 *
 * Embedded children: `PlaylistSound` events with `parentUuid: Playlist.<id>`
 * apply to the parent playlist's `sounds[]` array. Mutable playback state
 * (`playing`, `pausedTime`, `repeat`) flips through as normal embedded
 * `update` events.
 */
export class PlaylistStore extends PrimaryDocumentStore<PlaylistDocument> {
    public readonly documentType: PrimaryDocumentType = 'Playlist';

    protected resolveOwnership(
        playlist: PlaylistDocument,
        subject: DocumentAccessSubject,
    ): ResolvedDocumentOwnershipLevel {
        const ownership = playlist.ownership as DocumentOwnershipMap | undefined;
        return getEffectiveOwnership(ownership, subject);
    }

    public listByFolderIds(folderIds: Iterable<string | null>, options?: {
        subject?: DocumentAccessSubject;
        minOwnership?: ResolvedDocumentOwnershipLevel;
    }): PlaylistDocument[] {
        const ids = new Set<string | null>();
        for (const id of folderIds) ids.add(id);

        const filterByFolder = (playlists: PlaylistDocument[]) =>
            playlists.filter(p => ids.has((p.folder as string | null) ?? null));

        if (options?.subject) {
            const subject = options.subject;
            const threshold = options.minOwnership ?? DocumentOwnershipLevel.LIMITED;
            return filterByFolder(this.list({ subject, minOwnership: threshold }));
        }
        return filterByFolder(this.list());
    }

    /**
     * Embedded handler for `PlaylistSound` events under Playlists. Foundry
     * dispatches these with `parentUuid: Playlist.<id>`; the parent playlist's
     * `sounds[]` array is mutated in place and a `documentChanged` (update)
     * fires on the parent.
     */
    protected applyEmbeddedChange(
        type: string,
        action: ModifyDocumentAction,
        result: unknown,
        operation?: Record<string, unknown>,
    ): void {
        if (type !== 'PlaylistSound') return;
        const playlistId = this.getPlaylistIdFromOperation(operation);
        if (!playlistId) return;
        const playlist = this.documents.get(playlistId);
        if (!playlist) return;

        const before = stableJson(playlist);
        const docs = toDocumentArray<Record<string, unknown>>(result);
        const sounds = [...(playlist.sounds || [])];

        if (action === 'delete') {
            const ids = getOperationIds(operation, docs);
            playlist.sounds = sounds.filter(s => {
                const id = soundId(s);
                return !id || !ids.includes(id);
            }) as PlaylistSoundDocument[];
        } else if (action === 'update') {
            for (const incoming of docs) {
                const id = getDocumentId(incoming);
                if (!id) continue;
                const index = sounds.findIndex(existing => isRecord(existing) && getDocumentId(existing) === id);
                if (index >= 0 && isRecord(sounds[index])) {
                    deepMerge(sounds[index] as Record<string, unknown>, incoming);
                }
            }
            playlist.sounds = sounds as PlaylistSoundDocument[];
        } else if (action === 'create') {
            playlist.sounds = [...sounds, ...docs.map(s => cloneDocument(s))] as PlaylistSoundDocument[];
        }

        this.documents.set(playlistId, playlist);
        if (action !== 'get' && stableJson(playlist) !== before) {
            this.emitChanged(playlistId, 'update');
        }
    }

    private getPlaylistIdFromOperation(operation?: Record<string, unknown>): string | null {
        if (typeof operation?.parentId === 'string') return operation.parentId;
        if (typeof operation?.parentUuid !== 'string') return null;
        const parts = operation.parentUuid.split('.');
        if (parts[0] === 'Playlist') return parts[1] || null;
        return null;
    }
}

export const playlistStore = new PlaylistStore();
