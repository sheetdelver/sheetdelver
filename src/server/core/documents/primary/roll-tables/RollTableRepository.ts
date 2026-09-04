import type { RollTableDocument } from '@server/shared/types/documents';
import { PrimaryDocumentRepository, type DocumentTransport } from '../base/PrimaryDocumentRepository';
import type { ModifyDocumentAction } from '../base/PrimaryDocumentStore';
import { rollTableStore } from './RollTableStore';

/**
 * RollTable primary-document Repository. Per-request transport binds writes
 * to the requesting user's authenticated socket. Foundry's broadcast lands
 * through `modifyDocumentRouter` into `RollTableStore.applyModifyDocument`
 * (direct-type) or `RollTableStore.applyEmbeddedChange` (`TableResult`
 * with `parentUuid: RollTable.<id>`).
 */
export class RollTableRepository extends PrimaryDocumentRepository<RollTableDocument> {
    constructor(transport: DocumentTransport) {
        super(transport, rollTableStore);
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
        return this.dispatchDocument('RollTable', 'create', { data: [data] });
    }

    async update(tableId: string, updates: Record<string, unknown>): Promise<any> {
        return this.dispatchDocument('RollTable', 'update', {
            updates: [{ _id: tableId, ...updates }],
        });
    }

    async delete(tableId: string): Promise<void> {
        await this.dispatchDocument('RollTable', 'delete', { ids: [tableId] });
    }

    async createResult(tableId: string, data: Record<string, unknown>): Promise<any> {
        return this.dispatchDocument(
            'TableResult',
            'create',
            { data: [data] },
            { type: 'RollTable', id: tableId },
        );
    }

    async updateResult(tableId: string, resultId: string, updates: Record<string, unknown>): Promise<any> {
        return this.dispatchDocument(
            'TableResult',
            'update',
            { updates: [{ _id: resultId, ...updates }] },
            { type: 'RollTable', id: tableId },
        );
    }

    async deleteResult(tableId: string, resultId: string): Promise<void> {
        await this.dispatchDocument(
            'TableResult',
            'delete',
            { ids: [resultId] },
            { type: 'RollTable', id: tableId },
        );
    }
}
