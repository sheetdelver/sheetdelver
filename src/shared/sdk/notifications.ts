/** Transient browser-local handle. Do not persist it or send it to the server. */
export type NotificationId = number;
export type NotificationType = 'info' | 'success' | 'warning' | 'error';

export interface NotificationOptions {
    title?: string;
    /** Opt into host-sanitized rich text; plain text is the default. */
    html?: boolean;
    /** Visible milliseconds; default 5000, bounded to 1000-60000 by the host. */
    duration?: number;
    /** Remain until dismissed, or updated with permanent: false. */
    permanent?: boolean;
    /** Fraction from 0 to 1. Incomplete progress pauses expiry. */
    progress?: number;
}

export type NotificationUpdate = NotificationOptions & {
    content?: string;
    type?: NotificationType;
};

/** Client-only feedback supplied by useSDK(), not chat or a realtime broadcast. */
export interface NotificationAPI {
    addNotification(message: string, type?: NotificationType, options?: NotificationOptions): NotificationId;
    /** Reset the notice's lifetime; false if it has expired, been removed or cleared. */
    updateNotification(id: NotificationId, patch: NotificationUpdate): boolean;
    /** Missing handles are harmless. Only dismiss notifications you created. */
    removeNotification(id: NotificationId): void;
}
