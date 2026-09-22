import type { NotificationAPI } from '@shared/sdk/notifications';

/** Bind async feedback to its initiating session. Zero is an inert, never-issued handle. */
export function scopeAdminNotifications(api: NotificationAPI, isCurrent: () => boolean): NotificationAPI {
    return {
        addNotification: (...args) => isCurrent() ? api.addNotification(...args) : 0,
        updateNotification: (...args) => isCurrent() && api.updateNotification(...args),
        removeNotification: (...args) => { if (isCurrent()) api.removeNotification(...args); },
    };
}
