/** Match live create hints to authorized chat reads, without replaying history. */
export class LiveChatInbox<T> {
    private pending = new Map<string, number>();
    private seen = new Set<string>();

    constructor(private readonly ttlMs = 10_000) {}

    created(id: string, now = Date.now()) {
        if (!id || this.seen.has(id) || this.pending.has(id)) return;
        this.pending.set(id, now);
        if (this.pending.size > 32) this.pending.delete(this.pending.keys().next().value!);
    }

    consume(messages: readonly T[], now = Date.now()): T[] {
        const output: T[] = [];
        for (const [id, time] of this.pending) {
            if (now - time > this.ttlMs) { this.pending.delete(id); continue; }
            const message = messages.find(value => {
                const data = value as { _id?: unknown; id?: unknown } | null;
                return data && (data._id ?? data.id) === id;
            });
            if (!message) continue;
            this.pending.delete(id);
            this.seen.add(id);
            if (this.seen.size > 512) this.seen.delete(this.seen.values().next().value!);
            output.push(message);
        }
        return output;
    }

    invalidated(id: string) { this.pending.delete(id); }
    reset() { this.pending.clear(); this.seen.clear(); }
}
