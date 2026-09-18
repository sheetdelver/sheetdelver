'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { logger } from '@shared/utils/logger';
import { useNotifications } from '@client/ui/components/NotificationSystem';
import { UnauthorizedApiError } from '@client/ui/api/http';
import * as foundryApi from '@client/ui/api/foundryApi';
import { useSession } from '@client/ui/context/SessionContext';
import { useRealtime } from '@client/ui/context/RealtimeContext';
import { useUI } from './UIContext';
import { LiveChatInbox } from './liveChatInbox';
import { chatToastContent, defaultChatToastSettings, normalizeChatToastSettings, type ChatToastSettings } from './chatToast';
import { createCoalescedFetch, type CoalescedFetch } from '@client/ui/context/coalescedFetch';
import type { ChatMessageDto } from '@shared/contracts/chat';
import type {
    RealtimeChatMessageChangedPayload,
    RealtimeChatMessageListInvalidatedPayload,
} from '@shared/contracts/realtime';

interface ChatContextType {
    messages: ChatMessageDto[];
    toastSettings: ChatToastSettings;
    setToastSettings: (settings: ChatToastSettings) => void;
    fetchChat: () => Promise<void>;
    handleChatSend: (message: string, options?: { rollMode?: string; speaker?: string }) => Promise<void>;
    resetChatState: () => void;
}

const ChatContext = createContext<ChatContextType | undefined>(undefined);

export function ChatProvider({ children }: { children: React.ReactNode }) {
    const { token, setToken, step, registerLogoutCleanup } = useSession();
    const { appSocket } = useRealtime();
    const { addNotification, removeNotification } = useNotifications();
    const { isChatOpen } = useUI();
    const [toastSettings, updateToastSettings] = useState(defaultChatToastSettings);
    const toastPreferences = useRef({ settings: toastSettings, isChatOpen });
    const toastInbox = useRef(new LiveChatInbox<ChatMessageDto>());
    const activeToast = useRef<{ notificationId: number; messageId: string } | null>(null);
    const latestMessages = useRef<ChatMessageDto[]>([]);
    const clearChatToast = useCallback(() => {
        if (activeToast.current) removeNotification(activeToast.current.notificationId);
        activeToast.current = null;
    }, [removeNotification]);
    const resetLiveToasts = useCallback(() => { toastInbox.current.reset(); clearChatToast(); }, [clearChatToast]);
    const setToastSettings = useCallback((settings: ChatToastSettings) => {
        const normalized = normalizeChatToastSettings(settings);
        updateToastSettings(normalized);
        try { localStorage.setItem('sheetdelver_chat_toasts', JSON.stringify(normalized)); } catch { /* Optional preference. */ }
    }, []);
    useEffect(() => {
        try { updateToastSettings(normalizeChatToastSettings(JSON.parse(localStorage.getItem('sheetdelver_chat_toasts') || 'null'))); } catch { /* Optional preference. */ }
    }, []);
    useEffect(() => {
        toastPreferences.current = { settings: toastSettings, isChatOpen };
        if (!toastSettings.enabled || isChatOpen) clearChatToast();
    }, [toastSettings, isChatOpen, clearChatToast]);
    const notifyLatest = useCallback((chat: ChatMessageDto[]) => {
        const fresh = toastInbox.current.consume(chat);
        const message = fresh.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0)).at(-1);
        const { settings, isChatOpen } = toastPreferences.current;
        if (!message || !settings.enabled || isChatOpen || document.visibilityState !== 'visible') return;
        clearChatToast();
        const toast = chatToastContent(message);
        activeToast.current = {
            notificationId: addNotification(toast.content, 'info', { title: toast.title, duration: settings.durationMs }),
            messageId: (message._id ?? message.id)!,
        };
    }, [addNotification, clearChatToast]);
    const [messages, setMessages] = useState<ChatMessageDto[]>([]);
    const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const fetcherRef = useRef<{ token: string; fetch: CoalescedFetch<void> } | null>(null);

    const fetchChat = useCallback(async () => {
        if (step !== 'dashboard' || !token) return;
        if (fetcherRef.current?.token !== token) {
            const owner: { token: string; fetch: CoalescedFetch<void> } = {
                token,
                // A realtime hint received during an active chat read queues a
                // trailing read so the pre-change log cannot become final.
                fetch: createCoalescedFetch<void>(async () => {
                    try {
                        const data = await foundryApi.fetchChatLog(token);
                        if (fetcherRef.current !== owner) return;
                        if (Array.isArray(data.messages)) {
                            setMessages(data.messages);
                        }
                    } catch (error) {
                        if (fetcherRef.current !== owner) return;
                        if (error instanceof UnauthorizedApiError) {
                            setToken(null);
                            return;
                        }
                        logger.error('ChatContext | Failed to fetch chat:', error);
                    }
                }),
            };
            fetcherRef.current = owner;
        }
        return fetcherRef.current.fetch();
    }, [step, token, setToken]);

    const requestChatRefresh = useCallback(() => {
        if (refreshTimerRef.current) {
            clearTimeout(refreshTimerRef.current);
        }

        refreshTimerRef.current = setTimeout(() => {
            refreshTimerRef.current = null;
            void fetchChat();
        }, 75);
    }, [fetchChat]);

    const handleChatSend = useCallback(async (message: string, options?: { rollMode?: string; speaker?: string }) => {
        try {
            const data = await foundryApi.sendChat(token, {
                message,
                rollMode: options?.rollMode,
                speaker: options?.speaker,
            });
            if (data.success) {
                requestChatRefresh();
            } else {
                addNotification('Failed: ' + data.error, 'error');
            }
        } catch (error: unknown) {
            const messageText = error instanceof Error ? error.message : 'Unknown chat error';
            addNotification('Error: ' + messageText, 'error');
        }
    }, [addNotification, requestChatRefresh, token]);

    const resetChatState = useCallback(() => {
        fetcherRef.current = null;
        latestMessages.current = [];
        resetLiveToasts();
        setMessages([]);
    }, [resetLiveToasts]);

    useEffect(() => {
        const unregister = registerLogoutCleanup(() => {
            resetChatState();
        });
        return unregister;
    }, [registerLogoutCleanup, resetChatState]);

    useEffect(() => {
        if (step === 'dashboard' && token) {
            fetchChat();
        }
    }, [fetchChat, step, token]);

    useEffect(() => () => {
        if (refreshTimerRef.current) {
            clearTimeout(refreshTimerRef.current);
            refreshTimerRef.current = null;
        }
    }, []);

    useEffect(() => {
        resetLiveToasts();
        if (!appSocket || !token || step !== 'dashboard') return;

        const handleChatMessageChanged = (data: RealtimeChatMessageChangedPayload) => {
            if (data.action === 'create') {
                toastInbox.current.created(data.messageId);
                notifyLatest(latestMessages.current);
            } else {
                toastInbox.current.invalidated(data.messageId);
                if (activeToast.current?.messageId === data.messageId) clearChatToast();
            }
            requestChatRefresh();
        };
        const handleChatMessageListInvalidated = (_data: RealtimeChatMessageListInvalidatedPayload) => {
            requestChatRefresh();
        };

        appSocket.on('disconnect', resetLiveToasts);
        appSocket.on('serverRestarting', resetLiveToasts);
        appSocket.on('chatMessageChanged', handleChatMessageChanged);
        appSocket.on('chatMessageListInvalidated', handleChatMessageListInvalidated);
        return () => {
            appSocket.off('disconnect', resetLiveToasts);
            appSocket.off('serverRestarting', resetLiveToasts);
            resetLiveToasts();
            appSocket.off('chatMessageChanged', handleChatMessageChanged);
            appSocket.off('chatMessageListInvalidated', handleChatMessageListInvalidated);
        };
    }, [appSocket, requestChatRefresh, token, step, notifyLatest, resetLiveToasts, clearChatToast]);

    useEffect(() => {
        latestMessages.current = messages;
        if (token && step === 'dashboard') notifyLatest(messages);
    }, [messages, token, step, notifyLatest]);

    const value = useMemo(() => ({
        messages, toastSettings, setToastSettings,
        fetchChat,
        handleChatSend,
        resetChatState,
    }), [messages, toastSettings, setToastSettings, fetchChat, handleChatSend, resetChatState]);

    return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat() {
    const context = useContext(ChatContext);
    if (!context) {
        throw new Error('useChat must be used within a ChatProvider');
    }
    return context;
}
