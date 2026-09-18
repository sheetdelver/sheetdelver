'use client';

import { useState, useRef, useEffect, useCallback, createContext, useContext, ReactNode } from 'react';
import { X } from 'lucide-react';
import { sanitizeRichHtml, type SafeHtml } from '@shared/security/safeHtml';
import { SafeHtmlContent } from './SafeHtmlContent';

export type NotificationType = 'info' | 'success' | 'error';

export interface Notification {
    id: number;
    content: string;
    type: NotificationType;
    safeHtml?: SafeHtml;
    title?: string;
}

interface NotificationOptions {
    title?: string;
    html?: boolean;
    duration?: number;
}

interface NotificationContextType {
    notifications: Notification[];
    addNotification: (content: string, type?: NotificationType, options?: NotificationOptions) => number;
    removeNotification: (id: number) => void;
}

const NotificationContext = createContext<NotificationContextType | undefined>(undefined);

export function NotificationProvider({ children }: { children: ReactNode }) {
    const [notifications, setNotifications] = useState<Notification[]>([]);
    const notificationIdRef = useRef(0);
    const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
    useEffect(() => {
        const pending = timers.current;
        return () => { pending.forEach(clearTimeout); pending.clear(); };
    }, []);

    const addNotification = useCallback((content: string, type: NotificationType = 'info', options?: NotificationOptions) => {
        const id = ++notificationIdRef.current;
        const duration = options?.duration || 5000;

        // HTML notifications are sanitized at the host boundary even when an
        // SDK caller already passed branded output; defense does not rely on it.
        const safeHtml = options?.html ? sanitizeRichHtml(content) : undefined;
        setNotifications(prev => [...prev, { id, content, type, safeHtml, title: options?.title }]);

        // Auto-dismiss
        timers.current.set(id, setTimeout(() => {
            timers.current.delete(id);
            setNotifications(prev => prev.filter(n => n.id !== id));
        }, duration));
        return id;
    }, []);

    const removeNotification = useCallback((id: number) => {
        clearTimeout(timers.current.get(id));
        timers.current.delete(id);
        setNotifications(prev => prev.filter(n => n.id !== id));
    }, []);

    return (
        <NotificationContext.Provider value={{ notifications, addNotification, removeNotification }}>
            {children}
            <NotificationContainer notifications={notifications} removeNotification={removeNotification} />
        </NotificationContext.Provider>
    );
}

export const useNotifications = () => {
    const context = useContext(NotificationContext);
    if (!context) {
        throw new Error('useNotifications must be used within a NotificationProvider');
    }
    return context;
};

export const NotificationContainer = ({ notifications, removeNotification }: { notifications: Notification[], removeNotification: (id: number) => void }) => {
    return (
        <div aria-live="polite" aria-relevant="additions text" className="fixed bottom-24 right-4 z-[200] flex flex-col gap-2 max-w-sm w-[calc(100vw-2rem)] pointer-events-none">
            {notifications.map(n => (
                <div
                    key={n.id}
                    role="status"
                    className={`relative p-4 rounded-lg shadow-2xl border-l-4 transform transition-all animate-in slide-in-from-right fade-in duration-300 pointer-events-auto ${n.type === 'success' ? 'bg-slate-800 border-green-500 text-green-100' :
                        n.type === 'error' ? 'bg-slate-800 border-red-500 text-red-100' :
                            'bg-slate-800 border-blue-500 text-blue-100'
                        }`}
                >
                    {n.title && <header className="-mx-4 -mt-4 mb-3 px-4 py-2 pr-10 border-b border-white/10 bg-black/15 rounded-t-lg">
                        <h3 className="text-sm font-semibold break-words">{n.title}</h3>
                    </header>}
                    <button
                        aria-label="Dismiss notification" title="Dismiss notification"
                        onClick={(e) => {
                            e.stopPropagation();
                            removeNotification(n.id);
                        }}
                        className="absolute top-2 right-2 text-current opacity-50 hover:opacity-100 p-1 rounded hover:bg-black/20 transition-colors"
                    >
                        <X size={16} aria-hidden="true" />
                    </button>
                    <div
                        className="text-sm pr-6 break-words [&_img]:max-h-16 [&_img]:w-auto [&_img]:object-contain [&_img]:rounded [&_img]:inline-block [&_img]:mr-2 [&_img]:align-middle [&_header]:font-bold [&_header]:mb-1 [&_header]:border-b [&_header]:border-white/20 [&_h3]:inline [&_h3]:m-0 [&_p]:m-0"
                    >
                        {n.safeHtml ? (
                            <SafeHtmlContent html={n.safeHtml} />
                        ) : (
                            <p className="font-medium">{n.content}</p>
                        )}
                    </div>
                </div>
            ))}
        </div>
    );
};
