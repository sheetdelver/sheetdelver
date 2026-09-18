'use client';

import { Check, CircleAlert, Info, ListX, TriangleAlert, X } from 'lucide-react';
import { SafeHtmlContent } from '../SafeHtmlContent';
import type { Notification, NotificationStore } from './notificationStore';

const severity = {
    info: { label: 'Information', Icon: Info, color: '#8cc9ee', border: '#46738e', background: '#19272f' },
    success: { label: 'Success', Icon: Check, color: '#9cddba', border: '#477b60', background: '#1b2c23' },
    warning: { label: 'Warning', Icon: TriangleAlert, color: '#f1cf87', border: '#a38444', background: '#30291b' },
    error: { label: 'Error', Icon: CircleAlert, color: '#f3acb4', border: '#a55964', background: '#321e24' },
};

export function NotificationContainer({ notifications, queued, removeNotification, clearNotifications, pauseNotification }: {
    notifications: readonly Notification[];
    queued: number;
    removeNotification: NotificationStore['remove'];
    clearNotifications: NotificationStore['clear'];
    pauseNotification: NotificationStore['pause'];
}) {
    return <section aria-label="Notifications" className="pointer-events-none shrink-0" style={{ letterSpacing: 0 }}>
        {notifications.length + queued > 1 && <div className="flex items-center justify-end gap-2 mb-1">
            {queued > 0 && <span className="text-xs px-2 py-1 rounded bg-neutral-950 text-neutral-200" role="status">{queued} waiting</span>}
            <button type="button" title="Dismiss all notifications" aria-label="Dismiss all notifications" onClick={clearNotifications}
                className="pointer-events-auto grid place-items-center w-9 h-9 rounded border border-neutral-600 bg-neutral-900 text-neutral-200 hover:bg-neutral-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300">
                <ListX size={18} aria-hidden="true" />
            </button>
        </div>}
        <div className="flex flex-col gap-2 overflow-y-auto pointer-events-auto" style={{ maxHeight: 'calc(100dvh - 11rem)', scrollbarWidth: 'thin' }}>
            {notifications.map(notice => {
                const { Icon, label, color, border, background } = severity[notice.type];
                const title = notice.title || label;
                return <article key={notice.id} data-notification-id={notice.id} data-notification-type={notice.type}
                    role={notice.type === 'error' || notice.type === 'warning' ? 'alert' : 'status'} aria-atomic="true"
                    onMouseEnter={() => pauseNotification(notice.id, 'hover', true)} onMouseLeave={() => pauseNotification(notice.id, 'hover', false)}
                    onFocusCapture={() => pauseNotification(notice.id, 'focus', true)}
                    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) pauseNotification(notice.id, 'focus', false); }}
                    className="relative shrink-0 rounded border shadow-lg overflow-hidden"
                    style={{ borderColor: border, background, color: '#f3f3f3', fontSize: 14, lineHeight: 1.4 }}>
                    <header className="flex items-center gap-2 pl-3 pr-1 py-1 border-b border-white/10 bg-black/15">
                        <Icon size={17} style={{ color, flexShrink: 0 }} aria-hidden="true" />
                        <span className="sr-only">{notice.title ? `${label}: ` : ''}</span>
                        <h3 className="text-sm font-semibold min-w-0 flex-1 [overflow-wrap:anywhere]" style={{ color }}>{title}</h3>
                        <button type="button" aria-label="Dismiss notification" title="Dismiss notification" onClick={() => removeNotification(notice.id)}
                            className="grid place-items-center w-9 h-9 shrink-0 rounded hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-amber-300">
                            <X size={17} aria-hidden="true" />
                        </button>
                    </header>
                    <div className="px-3 py-2 max-h-32 overflow-auto [overflow-wrap:anywhere] [&_img]:max-h-16 [&_img]:max-w-full [&_img]:object-contain [&_h1]:text-base [&_h2]:text-base [&_h3]:text-sm [&_p]:m-0 [&_pre]:whitespace-pre-wrap">
                        {notice.safeHtml !== undefined ? <SafeHtmlContent html={notice.safeHtml} /> : <p>{notice.content}</p>}
                    </div>
                    {notice.progress !== undefined && <div className="px-3 pb-2 flex items-center gap-2">
                        <div role="progressbar" aria-label={title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(notice.progress * 100)}
                            className="h-1.5 bg-black/40 rounded overflow-hidden flex-1">
                            <div className="h-full transition-[width] duration-150 motion-reduce:transition-none" style={{ width: `${notice.progress * 100}%`, background: color }} />
                        </div>
                        <span className="text-xs tabular-nums w-9 text-right" style={{ color }}>{Math.round(notice.progress * 100)}%</span>
                    </div>}
                </article>;
            })}
        </div>
    </section>;
}
