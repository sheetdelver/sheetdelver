import type { RawPlaylist } from '@server/shared/types/documents';
import { PrimaryDocumentRepository, type DocumentTransport } from '../base/PrimaryDocumentRepository';
import type { ModifyDocumentAction } from '../base/PrimaryDocumentStore';
import { playlistStore } from './PlaylistStore';

/**
 * Playlist primary-document Repository. Per-request transport binds writes
 * to the requesting user's authenticated socket. Foundry's broadcast lands
 * through `modifyDocumentRouter` into `PlaylistStore.applyModifyDocument`
 * (direct-type) or `PlaylistStore.applyEmbeddedChange` (`PlaylistSound`
 * with `parentUuid: Playlist.<id>`).
 */
export class PlaylistRepository extends PrimaryDocumentRepository<RawPlaylist> {
    constructor(transport: DocumentTransport) {
        super(transport, playlistStore);
    }

    async dispatchDocument(
        type: string,
        action: ModifyDocumentAction,
        operation: Record<string, unknown> = {},
        parent?: { type: string; id: string },
    ): Promise<any> {
        return super.dispatchDocument(type, action, operation, parent);
    }

    async create(data: Record<string, unknown>): Promise<any> {
        return this.dispatchDocument('Playlist', 'create', { data: [data] });
    }

    async update(playlistId: string, updates: Record<string, unknown>): Promise<any> {
        return this.dispatchDocument('Playlist', 'update', {
            updates: [{ _id: playlistId, ...updates }],
        });
    }

    async delete(playlistId: string): Promise<void> {
        await this.dispatchDocument('Playlist', 'delete', { ids: [playlistId] });
    }

    async createSound(playlistId: string, data: Record<string, unknown>): Promise<any> {
        return this.dispatchDocument(
            'PlaylistSound',
            'create',
            { data: [data] },
            { type: 'Playlist', id: playlistId },
        );
    }

    async updateSound(playlistId: string, soundId: string, updates: Record<string, unknown>): Promise<any> {
        return this.dispatchDocument(
            'PlaylistSound',
            'update',
            { updates: [{ _id: soundId, ...updates }] },
            { type: 'Playlist', id: playlistId },
        );
    }

    async deleteSound(playlistId: string, soundId: string): Promise<void> {
        await this.dispatchDocument(
            'PlaylistSound',
            'delete',
            { ids: [soundId] },
            { type: 'Playlist', id: playlistId },
        );
    }
}
