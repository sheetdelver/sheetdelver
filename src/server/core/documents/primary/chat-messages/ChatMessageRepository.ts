import type { RawChatMessage } from '@server/shared/types/documents';
import { PrimaryDocumentRepository, type DocumentTransport } from '../base/PrimaryDocumentRepository';
import type { ModifyDocumentAction } from '../base/PrimaryDocumentStore';
import { chatMessageStore } from './ChatMessageStore';

/**
 * ChatMessage primary-document Repository. Per-request transport binding
 * ensures sent messages dispatch as the requesting user. Foundry returns
 * the created message and broadcasts; the broadcast lands through the
 * modifyDocumentRouter into {@link ChatMessageStore.applyModifyDocument}
 * — the initiator-side mirror in {@link dispatchDocument} makes the
 * second apply idempotent via emit-only-on-change.
 *
 * Chat write paths use this Repository through the request-scoped route-client
 * helper. Public SDK compatibility facades may keep their old method names,
 * but they should delegate here for primary-document writes.
 */
export class ChatMessageRepository extends PrimaryDocumentRepository<RawChatMessage> {
    constructor(transport: DocumentTransport) {
        super(transport, chatMessageStore);
    }

    async dispatchDocument(
        type: string,
        action: ModifyDocumentAction,
        operation: Record<string, unknown> = {},
        parent?: { type: string; id: string },
    ): Promise<any> {
        return super.dispatchDocument(type, action, operation, parent);
    }

    /**
     * Create a chat message. Returns the raw Foundry response (with `result`
     * containing the newly-created docs).
     */
    async send(data: Record<string, unknown>): Promise<any> {
        return this.dispatchDocument('ChatMessage', 'create', { data: [data] });
    }

    /**
     * Update a chat message in place. Use sparingly — most chat content is
     * append-only, but edits are supported by Foundry.
     */
    async update(messageId: string, updates: Record<string, unknown>): Promise<any> {
        return this.dispatchDocument('ChatMessage', 'update', {
            updates: [{ _id: messageId, ...updates }],
        });
    }

    /**
     * Delete a chat message.
     */
    async delete(messageId: string): Promise<void> {
        await this.dispatchDocument('ChatMessage', 'delete', { ids: [messageId] });
    }
}
