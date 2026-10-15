import { ALL_DOCUMENT_AUDIENCE, type DocumentAudience } from '../base/audience';
import type { ChatMessageDocument } from '@server/shared/types/documents';
import {
    PrimaryDocumentStore,
    type PrimaryDocumentType,
} from '../base/PrimaryDocumentStore';
import {
    DocumentOwnershipLevel,
    isGM,
    type DocumentAccessSubject,
    type ResolvedDocumentOwnershipLevel,
} from '../base/ownership';

export function hasChatRolls(message: ChatMessageDocument): boolean {
    return (Array.isArray(message.rolls) && message.rolls.length > 0) || message.type === 5;
}

/**
 * ChatMessage primary-document Store. Full hydration + bootstrap seed:
 * mirrors whatever Foundry returns from `ChatMessage.get`. No platform-side
 * cap — display limits (e.g., `config.app.chatHistory`) live on the consumer
 * side (the chat route / UI), not in the data model.
 *
 * Visibility (per ADR-0013):
 *   - Ordinary whispers are visible only to author/recipients, including for GMs.
 *   - Existing roll raw-access policy retains the GM OWNER rule.
 *   - Author always sees their own messages (OBSERVER).
 *   - Non-empty whisper restricts to listed users (OBSERVER for listed, NONE otherwise).
 *   - blind: true restricts to author + GMs (NONE for others).
 *   - Otherwise world-visible (OBSERVER for authenticated subjects).
 *
 * ChatMessage has no `ownership` map field — visibility is computed from
 * `whisper`, `blind`, and `author` fields on the message itself.
 */
export class ChatMessageStore extends PrimaryDocumentStore<ChatMessageDocument> {
    public readonly documentType: PrimaryDocumentType = 'ChatMessage';

    protected audienceForDocument(message: ChatMessageDocument | null | undefined): DocumentAudience {
        // Roll existence is public in Foundry; only metadata refresh hints use this audience.
        // Raw document reads remain restricted below; ChatService redacts hidden results.
        if (message && hasChatRolls(message)) return ALL_DOCUMENT_AUDIENCE;
        return super.audienceForDocument(message);
    }

    protected resolveOwnership(
        message: ChatMessageDocument,
        subject: DocumentAccessSubject,
    ): ResolvedDocumentOwnershipLevel {
        // Native v13/v14 ChatMessage.visible has no GM exception for a
        // non-roll whisper. Use this same gate for reads and realtime audiences.
        const author = typeof message.author === 'string' ? message.author : null;
        const whisper = Array.isArray(message.whisper) ? message.whisper : [];
        if (!hasChatRolls(message) && whisper.length > 0
            && author !== subject.userId && !whisper.includes(subject.userId)) {
            return DocumentOwnershipLevel.NONE;
        }

        // Preserve existing roll authorization independently of text whispers.
        if (isGM(subject)) return DocumentOwnershipLevel.OWNER;

        // Author always sees their own messages — even blind ones.
        if (author && author === subject.userId) return DocumentOwnershipLevel.OBSERVER;

        // Blind rolls are stricter than whispers: only author + GMs can see them.
        if (message.blind === true) return DocumentOwnershipLevel.NONE;

        // Whispered messages: visibility limited to listed recipients.
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
