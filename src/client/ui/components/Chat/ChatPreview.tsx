'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MessageSquare, X } from 'lucide-react';
import type { ChatMessageDto } from '@shared/contracts/chat';
import { useChat } from '../../context/ChatContext';
import { useConfig } from '../../context/ConfigContext';
import { useFoundry } from '../../context/FoundryContext';
import { useUI } from '../../context/UIContext';
import { useNotifications } from '../NotificationSystem';
import { ChatMessageCard, type ChatActions } from './ChatMessageCard';
import { messageId } from './chatMessage';
import type { defaultChatStyles } from './chatStyles';

export function ChatPreviewCard({ message, duration, dismiss, openChat, foundryUrl, styles, actions, moduleId }: {
    message: ChatMessageDto; duration: number; dismiss: () => void; openChat: () => void;
    moduleId?: string | null; actions?: ChatActions; foundryUrl?: string; styles?: Partial<typeof defaultChatStyles>;
}) {
    const [hovered, setHovered] = useState(false);
    const [focused, setFocused] = useState(false);
    const [hidden, setHidden] = useState(false);
    const remaining = useRef(duration);
    useEffect(() => {
        const change = () => setHidden(document.visibilityState !== 'visible');
        change();
        document.addEventListener('visibilitychange', change);
        return () => document.removeEventListener('visibilitychange', change);
    }, []);
    useEffect(() => { remaining.current = duration; }, [duration]);
    useEffect(() => {
        if (hovered || focused || hidden || document.visibilityState !== 'visible') return;
        const start = Date.now();
        const timer = setTimeout(dismiss, remaining.current);
        return () => { clearTimeout(timer); remaining.current = Math.max(0, remaining.current - (Date.now() - start)); };
    }, [duration, hovered, focused, hidden, dismiss]);
    return <section aria-label="New chat message" role="status" aria-atomic="true"
        className={`${moduleId ? `sdk-module--${moduleId}` : ''} hud-panel pointer-events-auto shrink-0 rounded-md border border-neutral-600 bg-neutral-900 text-white shadow-lg max-h-[45dvh] overflow-auto`}
        onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
        onFocusCapture={() => setFocused(true)}
        onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false); }}>
        <ChatMessageCard message={message} foundryUrl={foundryUrl} styles={styles} actions={actions} controls={<>
            <button type="button" title="Open chat" aria-label="Open chat" onClick={openChat} className="p-2 rounded hover:bg-white/10"><MessageSquare size={16} /></button>
            <button type="button" title="Dismiss chat preview" aria-label="Dismiss chat preview" onClick={dismiss} className="p-2 rounded hover:bg-white/10"><X size={16} /></button>
        </>} />
    </section>;
}
export function ChatPreview() {
    const { preview, toastSettings, dismissPreview, handleChatSend } = useChat();
    const { viewport } = useNotifications();
    const { foundryUrl } = useConfig();
    const { system } = useFoundry();
    const { setChatOpen, isChatOpen } = useUI();
    if (!viewport || !preview || !toastSettings.enabled || isChatOpen) return null;
    return createPortal(<ChatPreviewCard key={messageId(preview)} message={preview} duration={toastSettings.durationMs}
        dismiss={dismissPreview} openChat={() => setChatOpen(true)} foundryUrl={foundryUrl}
        moduleId={system?.id} styles={system?.config?.componentStyles?.chat} actions={{ onSend: handleChatSend }} />, viewport);
}
