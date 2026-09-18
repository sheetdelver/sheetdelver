import { sanitizeRichHtml, type SafeHtml } from '@shared/security/safeHtml';

export type NotificationType = 'info' | 'success' | 'warning' | 'error';
export interface NotificationOptions {
    title?: string;
    html?: boolean;
    duration?: number;
    permanent?: boolean;
    progress?: number;
    key?: string;
}
export interface Notification extends NotificationOptions {
    id: number;
    content: string;
    type: NotificationType;
    duration: number;
    permanent: boolean;
    safeHtml?: SafeHtml;
}
export type NotificationUpdate = NotificationOptions & { content?: string; type?: NotificationType };
export interface NotificationSnapshot { notifications: readonly Notification[]; queued: number }
export const EMPTY_NOTIFICATIONS: NotificationSnapshot = { notifications: [], queued: 0 };
export const MAX_VISIBLE_NOTIFICATIONS = 3;
export const MAX_QUEUED_NOTIFICATIONS = 20;

export interface NotificationClock {
    now(): number;
    set(callback: () => void, delay: number): unknown;
    clear(handle: unknown): void;
}
const defaultClock: NotificationClock = {
    now: () => Date.now(),
    set: (callback, delay) => setTimeout(callback, delay),
    clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
interface Entry {
    notice: Notification;
    remaining: number;
    started: number;
    timer?: unknown;
    pauses: Set<string>;
}

function buildNotice(id: number, content: string, type: NotificationType, options: NotificationOptions): Notification {
    return {
        id, content, type: ['info', 'success', 'warning', 'error'].includes(type) ? type : 'info',
        title: options.title, html: options.html === true,
        duration: typeof options.duration === 'number' && Number.isFinite(options.duration)
            ? Math.max(1000, Math.min(60_000, options.duration)) : 5000,
        permanent: options.permanent === true,
        progress: typeof options.progress === 'number' && Number.isFinite(options.progress)
            ? Math.max(0, Math.min(1, options.progress)) : undefined,
        key: options.key || undefined,
        safeHtml: options.html ? sanitizeRichHtml(content) : undefined,
    };
}

/** Browser-owned transient feedback. Timers follow visible notices, not queued entries. */
export class NotificationStore {
    private entries: Entry[] = [];
    private nextId = 0;
    private hidden = false;
    private listeners = new Set<() => void>();
    private snapshot = EMPTY_NOTIFICATIONS;

    constructor(private readonly clock: NotificationClock = defaultClock) {}
    getSnapshot = () => this.snapshot;
    subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

    add = (content: string, type: NotificationType = 'info', options: NotificationOptions = {}): number => {
        const previous = options.key && this.entries.find(entry => entry.notice.key === options.key);
        if (previous) {
            this.replace(previous, buildNotice(previous.notice.id, content, type, options));
            return previous.notice.id;
        }
        if (this.entries.length >= MAX_VISIBLE_NOTIFICATIONS + MAX_QUEUED_NOTIFICATIONS) {
            this.removeEntry(MAX_VISIBLE_NOTIFICATIONS);
        }
        const notice = buildNotice(++this.nextId, content, type, options);
        this.entries.push({ notice, remaining: notice.duration, started: 0, pauses: new Set() });
        this.publish();
        return notice.id;
    };

    update = (id: number, patch: NotificationUpdate): boolean => {
        const entry = this.entries.find(value => value.notice.id === id);
        if (!entry) return false;
        this.replace(entry, buildNotice(id, patch.content ?? entry.notice.content, patch.type ?? entry.notice.type, { ...entry.notice, ...patch }));
        return true;
    };
    remove = (id: number): void => {
        const index = this.entries.findIndex(entry => entry.notice.id === id);
        if (index < 0) return;
        this.removeEntry(index);
        this.publish();
    };
    clear = (): void => {
        this.entries.forEach(entry => this.stopTimer(entry));
        this.entries = [];
        this.publish();
    };
    pause = (id: number, reason: 'hover' | 'focus', paused: boolean): void => {
        const entry = this.entries.find(value => value.notice.id === id);
        if (!entry) return;
        if (paused) entry.pauses.add(reason); else entry.pauses.delete(reason);
        this.syncTimers();
    };
    setHidden = (hidden: boolean): void => { this.hidden = hidden; this.syncTimers(); };

    private replace(entry: Entry, notice: Notification) {
        this.stopTimer(entry);
        entry.notice = notice;
        entry.remaining = notice.duration;
        this.publish();
    }
    private removeEntry(index: number) {
        this.stopTimer(this.entries[index]);
        this.entries.splice(index, 1);
    }
    private stopTimer(entry: Entry) {
        if (entry.timer === undefined) return;
        this.clock.clear(entry.timer);
        entry.timer = undefined;
        entry.remaining = Math.max(0, entry.remaining - Math.max(0, this.clock.now() - entry.started));
    }
    private syncTimers() {
        this.entries.forEach((entry, index) => {
            const { notice } = entry;
            if (index >= MAX_VISIBLE_NOTIFICATIONS || this.hidden || entry.pauses.size || notice.permanent
                || (notice.progress !== undefined && notice.progress < 1)) {
                this.stopTimer(entry);
            } else if (entry.timer === undefined) {
                entry.started = this.clock.now();
                entry.timer = this.clock.set(() => {
                    entry.timer = undefined;
                    this.remove(notice.id);
                }, entry.remaining);
            }
        });
    }
    private publish() {
        this.syncTimers();
        this.snapshot = {
            notifications: this.entries.slice(0, MAX_VISIBLE_NOTIFICATIONS).map(entry => entry.notice),
            queued: Math.max(0, this.entries.length - MAX_VISIBLE_NOTIFICATIONS),
        };
        this.listeners.forEach(listener => listener());
    }
}
