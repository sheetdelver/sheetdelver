'use client';

import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { ArrowDown, ArrowUp, Send } from 'lucide-react';
import { RollMode } from '@shared/sdk';
import DiceTray from './DiceTray';
import type { ChatMessageDto } from '@shared/contracts/chat';
import { useFoundry } from '@client/ui/context/FoundryContext';
import { useSession } from '@client/ui/context/SessionContext';
import { ChatMessageCard } from './Chat/ChatMessageCard';
import { defaultChatStyles } from './Chat/chatStyles';
import { messageId, orderedMessages } from './Chat/chatMessage';

interface ChatTabProps {
    messages: ChatMessageDto[];
    onSend: (msg: string, options?: { rollMode?: RollMode; speaker?: string; throwOnError?: boolean }) => void | Promise<void>;
    onRoll?: (type: string, key: string, options?: { rollMode?: RollMode; speaker?: string }) => void;
    foundryUrl?: string;
    hideDiceTray?: boolean;
    hideHeader?: boolean;
    speaker?: string;
    active?: boolean;
}
export default function ChatTab({ messages, onSend, foundryUrl, onRoll, hideDiceTray = false, hideHeader = false, speaker, active = true }: ChatTabProps) {
    const { system } = useFoundry();
    const { currentUserId } = useSession();
    const s = { ...defaultChatStyles, ...system?.config?.componentStyles?.chat };
    const ordered = orderedMessages(messages);
    const scrollRef = useRef<HTMLDivElement>(null);
    const atBottom = useRef(true);
    const previousIds = useRef<Set<string> | null>(null);
    const [newMessages, setNewMessages] = useState(false);
    const [chatInput, setChatInput] = useState('');
    const [sending, setSending] = useState(false);
    const newest = ordered.at(-1);
    const newestId = newest ? messageId(newest) : '';
    const scrollBottom = () => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
        atBottom.current = true;
        setNewMessages(false);
    };
    useLayoutEffect(() => {
        if (!active) return;
        const added = previousIds.current !== null && messages.some(message => !previousIds.current!.has(messageId(message)));
        if (atBottom.current || (added && newest?.author === currentUserId)) scrollBottom();
        else if (added) setNewMessages(true);
        previousIds.current = new Set(messages.map(messageId));
    }, [messages, newestId, newest?.author, currentUserId, active]);
    useEffect(() => {
        const el = scrollRef.current;
        const content = el?.firstElementChild;
        if (!el || !content || !active) return;
        const observer = new ResizeObserver(() => { if (atBottom.current) el.scrollTop = el.scrollHeight; });
        observer.observe(content);
        return () => observer.disconnect();
    }, [active]);
    const send = async () => {
        if (!chatInput.trim() || sending) return;
        const draft = chatInput;
        setSending(true);
        try {
            await onSend(draft, { speaker, throwOnError: true });
            setChatInput(current => current === draft ? '' : current);
        } catch { /* The caller owns error feedback; preserve the draft. */ }
        finally { setSending(false); }
    };
    return <div className={`${system?.id ? `sdk-module--${system.id}` : ''} flex flex-col h-full min-h-0 gap-3`}>
        <div className={s.container + ' flex flex-col flex-1 min-h-0 overflow-hidden !rounded-md p-3'}>
            {!hideHeader && <h3 className={s.header}>Chat Log</h3>}
            <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto" aria-label="Chat messages"
                onScroll={() => {
                    const el = scrollRef.current!;
                    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
                    if (atBottom.current) setNewMessages(false);
                }}>
                <div className="space-y-3">
                    {ordered.map((message, index) => <ChatMessageCard key={messageId(message) || index} message={message}
                        foundryUrl={foundryUrl} styles={s} actions={{ onSend, onRoll, speaker }} />)}
                    {!ordered.length && <p className="text-center text-neutral-400 text-sm p-4">No messages yet.</p>}
                </div>
            </div>
            <div className="flex items-center justify-between py-2">
                <button type="button" title="Oldest message" aria-label="Oldest message" className={s.scrollButton + " p-2 rounded"}
                    onClick={() => { atBottom.current = false; scrollRef.current?.scrollTo({ top: 0 }); }}><ArrowUp size={18} /></button>
                <button type="button" title="Latest message" aria-label="Latest message" className={s.scrollButton + " flex items-center gap-2 p-2 rounded"}
                    onClick={scrollBottom}>{newMessages && <span className="text-xs text-amber-300">New messages</span>}<ArrowDown size={18} /></button>
            </div>
            <form className="flex gap-2" onSubmit={event => { event.preventDefault(); void send(); }}>
                <input aria-label="Chat message" value={chatInput} onChange={event => setChatInput(event.target.value)}
                    placeholder="Type a message..." className={s.inputField + ' min-w-0'} />
                <button type="submit" aria-label="Send message" title="Send message" disabled={sending || !chatInput.trim()}
                    className={s.sendBtn}><Send size={18} /></button>
            </form>
        </div>
        {!hideDiceTray && <DiceTray onSend={onSend} speaker={speaker} />}
    </div>;
}
