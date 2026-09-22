'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { logger } from '@shared/utils/logger';
import { useNotifications } from '@client/ui/components/NotificationSystem';
import { UnauthorizedApiError } from '@client/ui/api/http';
import * as foundryApi from '@client/ui/api/foundryApi';
import { useSession } from '@client/ui/context/SessionContext';
import { useRealtime } from '@client/ui/context/RealtimeContext';
import { useUI } from './UIContext';
import { useDicePresentation } from './DicePresentationContext';
import { LiveChatInbox } from './liveChatInbox';
import { defaultChatToastSettings, normalizeChatToastSettings, type ChatToastSettings } from './chatToast';
import { createCoalescedFetch, type CoalescedFetch } from '@client/ui/context/coalescedFetch';
import type { ChatMessageDto } from '@shared/contracts/chat';
import type {
    RealtimeChatMessageChangedPayload,
    RealtimeChatMessageListInvalidatedPayload,
} from '@shared/contracts/realtime';

interface ChatContextType {
    messages: ChatMessageDto[];
    preview: ChatMessageDto | null;
    hasUnread: boolean;
    dismissPreview: () => void;
    toastSettings: ChatToastSettings;
    setToastSettings: (settings: ChatToastSettings) => void;
    fetchChat: () => Promise<void>;
    handleChatSend: (message: string, options?: { rollMode?: string; speaker?: string; throwOnError?: boolean }) => Promise<void>;
    resetChatState: () => void;
}

const ChatContext = createContext<ChatContextType | undefined>(undefined);

export function ChatProvider({ children }: { children: React.ReactNode }) {
    const { token, setToken, step, registerLogoutCleanup } = useSession();
    const { appSocket } = useRealtime();
    const { addNotification } = useNotifications();
    const { isChatOpen } = useUI();
    const { heldMessageIds, recordCreated, prepareMessages, invalidateMessage, resetPresentation } = useDicePresentation();
    const heldIds = useRef(heldMessageIds);
    useEffect(() => { heldIds.current = heldMessageIds; }, [heldMessageIds]);
    const [toastSettings, updateToastSettings] = useState(defaultChatToastSettings);
    const toastPreferences = useRef({ settings: toastSettings, isChatOpen });
    // Three bounded throws, including loading, linger and fade, finish within one minute.
    const toastInbox = useRef(new LiveChatInbox<ChatMessageDto>(60_000));
    const latestNotified = useRef<{ id: string; timestamp: number } | null>(null);
    const [previewId, setPreviewId] = useState<string | null>(null);
    const [hasUnread, setHasUnread] = useState(false);
    const activePreviewId = useRef<string | null>(null);
    const latestMessages = useRef<ChatMessageDto[]>([]);
    const clearChatToast = useCallback(() => {
        activePreviewId.current = null;
        setPreviewId(null);
    }, []);
    const resetLiveToasts = useCallback(() => {
        toastInbox.current.reset(); latestNotified.current = null;
        clearChatToast(); setHasUnread(false); resetPresentation();
    }, [clearChatToast, resetPresentation]);
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
        if (!toastSettings.enabled || isChatOpen) {
            for (const id of heldIds.current) toastInbox.current.invalidated(id);
        }
        if (!toastSettings.enabled || isChatOpen) clearChatToast();
        if (isChatOpen) setHasUnread(false);
    }, [toastSettings, isChatOpen, clearChatToast]);
    const notifyLatest = useCallback((chat: ChatMessageDto[]) => {
        const { settings, isChatOpen } = toastPreferences.current;
        if (!settings.enabled || isChatOpen || document.visibilityState !== 'visible') {
            for (const id of heldIds.current) toastInbox.current.invalidated(id);
        }
        const fresh = toastInbox.current.consume(chat);
        const message = fresh.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0)).at(-1);
        if (fresh.length && !isChatOpen) setHasUnread(true);
        if (!message) return;
        const timestamp = message.timestamp ?? 0;
        const previous = latestNotified.current;
        if (previous && (timestamp < previous.timestamp || (timestamp === previous.timestamp &&
            chat.indexOf(message) < chat.findIndex(item => (item._id ?? item.id) === previous.id)))) return;
        latestNotified.current = { id: (message._id ?? message.id)!, timestamp };
        if (!settings.enabled || isChatOpen || document.visibilityState !== 'visible') return;
        clearChatToast();
        activePreviewId.current = (message._id ?? message.id)!;
        setPreviewId(activePreviewId.current);
    }, [clearChatToast]);
    const [rawMessages, setMessages] = useState<ChatMessageDto[]>([]);
    const messages = useMemo(() => rawMessages.filter(message => !heldMessageIds.has((message._id ?? message.id)!)), [rawMessages, heldMessageIds]);
    // A preview is a reference into the current authorized read, never its own message cache.
    const preview = messages.find(message => (message._id ?? message.id) === previewId) ?? null;
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
                            // Admit before publishing the read so results cannot flash on the first paint.
                            prepareMessages(data.messages);
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
    }, [step, token, setToken, prepareMessages]);

    const requestChatRefresh = useCallback(() => {
        if (refreshTimerRef.current) {
            clearTimeout(refreshTimerRef.current);
        }

        refreshTimerRef.current = setTimeout(() => {
            refreshTimerRef.current = null;
            void fetchChat();
        }, 75);
    }, [fetchChat]);

    const handleChatSend = useCallback(async (message: string, options?: { rollMode?: string; speaker?: string; throwOnError?: boolean }) => {
        try {
            const data = await foundryApi.sendChat(token, {
                message,
                rollMode: options?.rollMode,
                speaker: options?.speaker,
            });
            if (data.success) {
                requestChatRefresh();
            } else {
                throw new Error(data.error || 'Chat send failed');
            }
        } catch (error: unknown) {
            const messageText = error instanceof Error ? error.message : 'Unknown chat error';
            addNotification('Error: ' + messageText, 'error');
            if (options?.throwOnError) throw error;
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
                recordCreated(data.messageId);
                toastInbox.current.created(data.messageId);
                notifyLatest(latestMessages.current);
            } else {
                toastInbox.current.invalidated(data.messageId);
                if (activePreviewId.current === data.messageId) clearChatToast();
                if (data.action === 'delete' || heldIds.current.has(data.messageId)) {
                    setMessages(current => current.filter(message => (message._id ?? message.id) !== data.messageId));
                }
                invalidateMessage(data.messageId);
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
    }, [appSocket, requestChatRefresh, token, step, notifyLatest, resetLiveToasts, clearChatToast, recordCreated, invalidateMessage]);

    useEffect(() => {
        latestMessages.current = messages;
        if (token && step === 'dashboard') notifyLatest(messages);
    }, [messages, token, step, notifyLatest]);

    const value = useMemo(() => ({
        messages, preview, hasUnread, dismissPreview: clearChatToast, toastSettings, setToastSettings,
        fetchChat,
        handleChatSend,
        resetChatState,
    }), [messages, preview, hasUnread, clearChatToast, toastSettings, setToastSettings, fetchChat, handleChatSend, resetChatState]);

    return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat() {
    const context = useContext(ChatContext);
    if (!context) {
        throw new Error('useChat must be used within a ChatProvider');
    }
    return context;
}
