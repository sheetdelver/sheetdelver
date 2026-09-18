'use client';

// Stable host import boundary; module UI continues through SDKProvider.
export { NotificationProvider, useNotifications } from './Notifications/NotificationProvider';
export { NotificationContainer } from './Notifications/NotificationContainer';
export type { Notification, NotificationType, NotificationOptions, NotificationUpdate } from './Notifications/notificationStore';
