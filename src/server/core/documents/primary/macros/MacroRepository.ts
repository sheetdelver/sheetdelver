import type { RawMacro } from '@server/shared/types/documents';
import { PrimaryDocumentRepository, type DocumentTransport } from '../base/PrimaryDocumentRepository';
import type { ModifyDocumentAction } from '../base/PrimaryDocumentStore';
import { macroStore } from './MacroStore';

/**
 * Macro primary-document Repository. Per-request transport binds writes
 * to the requesting user's authenticated socket. Foundry's broadcast lands
 * through `modifyDocumentRouter` into `MacroStore.applyModifyDocument`.
 *
 * No embedded surfaces — Macros are flat docs.
 */
export class MacroRepository extends PrimaryDocumentRepository<RawMacro> {
    constructor(transport: DocumentTransport) {
        super(transport, macroStore);
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
        return this.dispatchDocument('Macro', 'create', { data: [data] });
    }

    async update(macroId: string, updates: Record<string, unknown>): Promise<any> {
        return this.dispatchDocument('Macro', 'update', {
            updates: [{ _id: macroId, ...updates }],
        });
    }

    async delete(macroId: string): Promise<void> {
        await this.dispatchDocument('Macro', 'delete', { ids: [macroId] });
    }
}
