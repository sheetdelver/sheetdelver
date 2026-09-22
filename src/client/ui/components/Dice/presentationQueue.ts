import type { ChatMessageDto } from '@shared/contracts/chat';
import { allowsDicePresentation, defaultDiceBehavior, type DiceBehavior } from './behavior';
import { LiveDiceInbox, toDicePresentation, type DicePresentation } from './presentation';

export interface QueuedDice extends DicePresentation { sequence: number; held: boolean }

/** One admission decision controls both animation and visible chat. No message bodies are retained. */
export class DicePresentationQueue {
    private inbox = new LiveDiceInbox();
    private observed = new Set<string>();
    private sequence = 0;
    private active = false;
    private behavior = defaultDiceBehavior;
    private userId: string | null = null;
    private queue: QueuedDice[] = [];

    snapshot(): readonly QueuedDice[] { return this.queue; }

    configure(active: boolean, behavior: DiceBehavior, userId: string | null) {
        this.active = active;
        this.behavior = behavior;
        this.userId = userId;
        if (!active) this.inbox.reset();
        this.queue = this.queue.filter(roll => active && allowsDicePresentation(roll, behavior, userId))
            .map(roll => behavior.showResultsImmediately && roll.held ? { ...roll, held: false } : roll);
    }

    created(id: string, now = Date.now()) {
        // A late hint must never re-hide an already displayed history/read result.
        if (this.active && !this.observed.has(id)) this.inbox.created(id, now);
    }

    read(messages: readonly ChatMessageDto[], now = Date.now()) {
        const ids = new Set(messages.map(message => message._id ?? message.id ?? ''));
        this.queue = this.queue.filter(roll => {
            const current = toDicePresentation(messages.find(message => (message._id ?? message.id) === roll.id));
            return current && current.notation === roll.notation && current.authorId === roll.authorId && current.privateRoll === roll.privateRoll;
        });
        for (const roll of this.inbox.consume(messages, now)) {
            if (!this.active || this.queue.length >= 3 || !allowsDicePresentation(roll, this.behavior, this.userId)) continue;
            this.queue = [...this.queue, { ...roll, sequence: ++this.sequence, held: !this.behavior.showResultsImmediately }];
        }
        this.observed = ids;
    }

    settled(sequence: number) {
        this.queue = this.queue.map(roll => roll.sequence === sequence ? { ...roll, held: false } : roll);
    }

    done(sequence: number) { this.queue = this.queue.filter(roll => roll.sequence !== sequence); }

    invalidated(id: string) {
        this.inbox.invalidated(id);
        this.queue = this.queue.filter(roll => roll.id !== id);
    }

    reset() {
        this.inbox.reset();
        this.queue = [];
        this.observed.clear();
        // Sequence numbers survive resets so late renderer callbacks cannot match new work.
    }
}
