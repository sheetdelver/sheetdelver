import type { RawChatMessage } from '@server/shared/types/documents';
import {
    PrimaryDocumentStore,
    type PrimaryDocumentType,
} from '../base/PrimaryDocumentStore';
import {
    DocumentOwnershipLevel,
    FoundryUserRole,
    type DocumentAccessSubject,
    type ResolvedDocumentOwnershipLevel,
} from '../base/ownership';

/**
 * ChatMessage primary-document Store. Full hydration + bootstrap seed:
 * mirrors whatever Foundry returns from `ChatMessage.get`. No platform-side
 * cap — display limits (e.g., `config.app.chatHistory`) live on the consumer
 * side (the chat route / UI), not in the data model.
 *
 * Visibility (per ADR-0013):
 *   - GMs see everything (OWNER).
 *   - Author always sees their own messages (OBSERVER).
 *   - Non-empty whisper restricts to listed users + GMs (OBSERVER for listed, NONE otherwise).
 *   - blind: true restricts to author + GMs (NONE for others).
 *   - Otherwise world-visible (OBSERVER for authenticated subjects).
 *
 * ChatMessage has no `ownership` map field — visibility is computed from
 * `whisper`, `blind`, and `author` fields on the message itself.
 */
export class ChatMessageStore extends PrimaryDocumentStore<RawChatMessage> {
    public readonly documentType: PrimaryDocumentType = 'ChatMessage';

    protected resolveOwnership(
        message: RawChatMessage,
        subject: DocumentAccessSubject,
    ): ResolvedDocumentOwnershipLevel {
        // GMs see everything.
        if (subject.role >= FoundryUserRole.GAMEMASTER) return DocumentOwnershipLevel.OWNER;

        // Author always sees their own messages — even blind ones.
        const author = typeof message.author === 'string' ? message.author : null;
        if (author && author === subject.userId) return DocumentOwnershipLevel.OBSERVER;

        // Blind rolls are stricter than whispers: only author + GMs can see them.
        if (message.blind === true) return DocumentOwnershipLevel.NONE;

        // Whispered messages: visibility limited to listed recipients.
        const whisper = Array.isArray(message.whisper) ? message.whisper : [];
        if (whisper.length > 0) {
            return whisper.includes(subject.userId)
                ? DocumentOwnershipLevel.OBSERVER
                : DocumentOwnershipLevel.NONE;
        }

        // World-visible.
        return DocumentOwnershipLevel.OBSERVER;
    }
}

export const chatMessageStore = new ChatMessageStore();
