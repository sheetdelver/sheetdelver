'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { logger } from '@shared/utils/logger';
import { useNotifications } from '@client/ui/components/NotificationSystem';
import { UnauthorizedApiError } from '@client/ui/api/http';
import * as foundryApi from '@client/ui/api/foundryApi';
import { useSession } from '@client/ui/context/SessionContext';
import { useRealtime } from '@client/ui/context/RealtimeContext';
import { createCoalescedFetch, type CoalescedFetch } from '@client/ui/context/coalescedFetch';
import type { ChatMessageDto } from '@shared/contracts/chat';
import type {
    RealtimeChatMessageChangedPayload,
    RealtimeChatMessageListInvalidatedPayload,
} from '@shared/contracts/realtime';

interface ChatContextType {
    messages: ChatMessageDto[];
    fetchChat: () => Promise<void>;
    handleChatSend: (message: string, options?: { rollMode?: string; speaker?: string }) => Promise<void>;
    resetChatState: () => void;
}

const ChatContext = createContext<ChatContextType | undefined>(undefined);

export function ChatProvider({ children }: { children: React.ReactNode }) {
    const { token, setToken, step, registerLogoutCleanup } = useSession();
    const { appSocket } = useRealtime();
    const { addNotification } = useNotifications();
    const [messages, setMessages] = useState<ChatMessageDto[]>([]);
    const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const fetcherRef = useRef<{ token: string; fetch: CoalescedFetch<void> } | null>(null);

    const fetchChat = useCallback(async () => {
        if (step !== 'dashboard' || !token) return;
        if (fetcherRef.current?.token !== token) {
            fetcherRef.current = {
                token,
                // A realtime hint received during an active chat read queues a
                // trailing read so the pre-change log cannot become final.
                fetch: createCoalescedFetch<void>(async () => {
                    try {
                        const data = await foundryApi.fetchChatLog(token);
                        if (Array.isArray(data.messages)) {
                            setMessages(data.messages);
                        }
                    } catch (error) {
                        if (error instanceof UnauthorizedApiError) {
                            setToken(null);
                            return;
                        }
                        logger.error('ChatContext | Failed to fetch chat:', error);
                    }
                }),
            };
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
        setMessages([]);
    }, []);

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
        if (!appSocket) return;

        const handleChatMessageChanged = (_data: RealtimeChatMessageChangedPayload) => {
            requestChatRefresh();
        };
        const handleChatMessageListInvalidated = (_data: RealtimeChatMessageListInvalidatedPayload) => {
            requestChatRefresh();
        };

        appSocket.on('chatMessageChanged', handleChatMessageChanged);
        appSocket.on('chatMessageListInvalidated', handleChatMessageListInvalidated);
        return () => {
            appSocket.off('chatMessageChanged', handleChatMessageChanged);
            appSocket.off('chatMessageListInvalidated', handleChatMessageListInvalidated);
        };
    }, [appSocket, requestChatRefresh]);

    const value = useMemo(() => ({
        messages,
        fetchChat,
        handleChatSend,
        resetChatState,
    }), [messages, fetchChat, handleChatSend, resetChatState]);

    return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat() {
    const context = useContext(ChatContext);
    if (!context) {
        throw new Error('useChat must be used within a ChatProvider');
    }
    return context;
}
