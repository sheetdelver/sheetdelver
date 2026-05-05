import { useState, useRef, useEffect } from 'react';
import { RollMode } from '@shared/sdk';
import DiceTray from './DiceTray';
import type { ChatMessageDto } from '@shared/contracts/chat';

interface ChatTabProps {
    messages: ChatMessageDto[];
    onSend: (msg: string, options?: { rollMode?: RollMode; speaker?: string }) => void;
    onRoll?: (type: string, key: string, options?: { rollMode?: RollMode; speaker?: string }) => void;
    foundryUrl?: string;
    hideDiceTray?: boolean;
    hideHeader?: boolean;
    speaker?: string;
}

const defaultStyles = {
    container: "bg-black/60 backdrop-blur-md rounded-2xl border border-white/10 shadow-2xl flex flex-col",
    header: "text-white/40 text-[10px] font-bold uppercase mb-4 border-b border-white/10 pb-2 flex items-center gap-2 tracking-widest px-4 pt-4",
    msgContainer: (isRoll: boolean) => `mx-4 p-2 rounded-xl border text-sm transition-colors ${isRoll ? 'bg-white/10 border-white/20' : 'bg-neutral-800/20 border-white/10 whitespace-pre-wrap'}`,
    user: "font-bold text-amber-500 text-[10px] uppercase tracking-widest",
    time: "text-[10px] text-white/40 font-sans",
    flavor: "text-[11px] italic text-white/50 mb-1 font-sans leading-tight",
    content: "text-center text-white/90 text-lg font-bold [&_.table-draw]:flex [&_.table-draw]:flex-col [&_.table-draw]:gap-0 [&_.table-draw]:text-left [&_.table-draw]:!m-0 [&_.table-draw]:!p-0 [&_.result-row]:flex [&_.result-row]:items-center [&_.result-row]:gap-2 [&_.result-row]:px-2 [&_.result-row]:py-1 [&_.result-row]:!mt-0 [&_.result-row]:!mb-0 [&_.result-row]:bg-white/5 [&_.result-row]:border [&_.result-row]:border-white/10 [&_.result-row:not(:first-child)]:-mt-px [&_.result-image]:w-8 [&_.result-image]:h-8 [&_.result-image]:rounded [&_.result-image]:!border-none [&_.result-image]:!m-0 [&_.result-image]:shrink-0 [&_.result-text]:text-sm [&_.result-text]:font-medium [&_.result-text]:text-white/90 [&_.chat-card]:!block [&_.chat-card]:bg-white/5 [&_.chat-card]:border [&_.chat-card]:border-white/10 [&_.chat-card]:rounded-lg [&_.chat-card]:overflow-hidden [&_.chat-card]:text-left [&_.card-header]:flex [&_.card-header]:items-center [&_.card-header]:gap-2 [&_.card-header]:bg-white/10 [&_.card-header]:px-2 [&_.card-header]:py-0.5 [&_.card-header]:border-b [&_.card-header]:border-white/10 [&_.card-header_img]:w-8 [&_.card-header_img]:h-8 [&_.card-header_img]:rounded [&_.card-header_img]:shrink-0 [&_.item-name]:text-sm [&_.item-name]:font-bold [&_.item-name]:text-white/90 [&_.item-name]:!m-0 [&_.card-content]:px-2 [&_.card-content]:py-0.5 [&_.card-content]:text-xs [&_.card-content]:text-white/70 [&_.card-content_p]:!m-0 [&_.card-footer]:hidden [&_.dice-roll]:hidden [&_.dice-tooltip]:hidden [&_.table-results]:flex [&_.table-results]:flex-col [&_.table-results]:gap-0 [&_.table-results]:!m-0 [&_.table-results]:!p-0 [&_.table-results]:list-none [&_.table-results_li]:flex [&_.table-results_li]:items-center [&_.table-results_li]:gap-2 [&_.table-results_li]:px-2 [&_.table-results_li]:py-1 [&_.table-results_li]:bg-white/5 [&_.table-results_li]:border [&_.table-results_li]:border-white/10 [&_.table-results_li:not(:first-child)]:-mt-px [&_.table-results_img]:w-8 [&_.table-results_img]:h-8 [&_.table-results_img]:rounded [&_.table-results_img]:shrink-0 [&_.content-link]:text-sm [&_.content-link]:text-white/90 [&_.content-link]:no-underline [&_.content-link_i]:hidden [&_.description]:text-sm [&_.description]:text-white/90",
    rollResult: "mt-1 bg-white/10 p-1.5 rounded-lg border border-white/20 text-center font-sans",
    rollFormula: "text-md text-white/40 uppercase tracking-tighter font-bold",
    rollTotal: "text-lg font-bold text-white",
    button: "inline-flex items-center gap-1 bg-white/10 hover:bg-white/20 border border-white/20 hover:border-amber-500/50 rounded-lg px-2 py-0.5 text-[10px] font-bold text-white/90 transition-all cursor-pointer my-1 shadow-sm active:scale-95",
    buttonText: "text-white/40 uppercase tracking-widest",
    buttonValue: "text-amber-500 font-bold",
    scrollButton: "bg-white/10 hover:bg-white/20 border border-white/20 hover:border-amber-500/50 rounded-lg px-3 py-1.5 text-xs font-bold text-white/90 transition-all active:scale-95",
    inputContainer: "col-span-2 flex gap-2 p-1 bg-neutral-900/50 backdrop-blur-sm rounded-lg border border-white/5 mb-2",
    inputField: "flex-1 bg-white/5 border border-white/10 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-amber-500/50 text-white placeholder:text-white/20",
    sendBtn: "bg-amber-600 hover:bg-amber-500 disabled:opacity-50 disabled:hover:bg-amber-600 text-black px-4 py-1.5 rounded-md text-xs font-black transition-colors"
};

import { useFoundry } from '@client/ui/context/FoundryContext';

export default function ChatTab({ messages, onSend, foundryUrl, onRoll, hideDiceTray = false, hideHeader = false, speaker }: ChatTabProps) {
    const { system } = useFoundry();
    const s = system?.config?.componentStyles?.chat || defaultStyles;
    const scrollRef = useRef<HTMLDivElement>(null);
    const [isAtTop, setIsAtTop] = useState(true);
    // We no longer auto-scroll to bottom. In fact, we might want to stay at top.
    // However, if we reverse, new messages are at the very top.
    // If we are at the top, they just appear.

    const [now, setNow] = useState<number>(() => messages.length > 0 ? (messages[0].timestamp ?? Date.now()) : Date.now());

    useEffect(() => {
        setNow(Date.now());
        const interval = setInterval(() => setNow(Date.now()), 30000);
        return () => clearInterval(interval);
    }, []);

    const handleScroll = () => {
        if (!scrollRef.current) return;
        const { scrollTop } = scrollRef.current;
        const atTop = scrollTop < 50;
        setIsAtTop(atTop);
    };

    const [chatInput, setChatInput] = useState('');

    const handleInputSend = () => {
        if (!chatInput.trim()) return;
        onSend(chatInput, { speaker });
        setChatInput('');
    };

    const getTimeAgo = (timestamp: number, current: number) => {
        const diff = Math.max(0, current - timestamp);
        const seconds = Math.floor(diff / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (seconds < 30) return "Just now";
        if (minutes === 0) return `${seconds} secs ago`;
        if (hours === 0) return `${minutes} min${minutes > 1 ? 's' : ''} ago`;

        const parts = [];
        if (days > 0) parts.push(`${days} day${days > 1 ? 's' : ''}`);
        if (hours % 24 > 0) parts.push(`${hours % 24} hour${hours % 24 > 1 ? 's' : ''}`);
        if (minutes % 60 > 0) parts.push(`${minutes % 60} min${minutes % 60 > 1 ? 's' : ''}`);

        return `${parts.join(', ')} ago`;
    };

    // Helper to format content content with fixed image URLs AND parsing inline checks
    const formatContent = (html: string) => {
        if (!html) return '';

        let fixed = html;

        // 1. Fix Image URLs
        if (foundryUrl) {
            fixed = fixed.replace(/src="([^"]+)"/g, (match, p1) => {
                if (p1.startsWith('http') || p1.startsWith('data:')) return match;
                const cleanUrl = foundryUrl.endsWith('/') ? foundryUrl : `${foundryUrl}/`;
                const cleanPath = p1.startsWith('/') ? p1.slice(1) : p1;
                return `src="${cleanUrl}${cleanPath}"`;
            });

            fixed = fixed.replace(/url\(([^)]+)\)/g, (match, p1) => {
                const path = p1.replace(/['"]/g, '');
                if (path.startsWith('http') || path.startsWith('data:')) return match;
                const cleanUrl = foundryUrl.endsWith('/') ? foundryUrl : `${foundryUrl}/`;
                const cleanPath = path.startsWith('/') ? path.slice(1) : path;
                return `url('${cleanUrl}${cleanPath}')`;
            });
        }

        // 2. UUID Links: @UUID[...]{Label} -> Label
        fixed = fixed.replace(/@UUID\[[^\]]+\]\{([^}]+)\}/g, '$1');

        // 3. Parse Inline Checks: [[check 15 cha]] OR [[/r 1d20]]
        fixed = fixed.replace(/\[\[(.*?)\]\]/gi, (match, content) => {
            const clean = content.replace(/&nbsp;/g, ' ').trim();
            const lower = clean.toLowerCase();

            // Check
            const checkMatch = lower.match(/^check\s+(\d+)\s+(\w+)$/);
            if (checkMatch) {
                return `<button 
                    data-action="roll-check" 
                    data-dc="${checkMatch[1]}" 
                    data-stat="${checkMatch[2]}"
                    class="${s.button}"
                >
                    <span class="${s.buttonText || ''}">${checkMatch[2]}</span>
                    <span class="${s.buttonValue || ''}">DC ${checkMatch[1]}</span>
                </button>`;
            }

            // Roll Formula
            if (lower.startsWith('/r') || lower.startsWith('/roll')) {
                const formula = clean.replace(/^\/(r|roll)\s*/i, '').trim();
                return `<button 
                    data-action="roll-formula"
                    data-formula="${formula}"
                    class="${s.button}"
                >
                    <span class="${s.buttonText || ''}">roll</span>
                    <span class="${s.buttonValue || ''}">${formula}</span>
                </button>`;
            }

            return match;
        });

        // 4. Strip inline styles from HTML to allow full CSS control
        fixed = fixed.replace(/\s+style="[^"]*"/gi, '');

        return fixed;
    };

    const handleChatClick = (e: React.MouseEvent<HTMLDivElement>) => {
        const target = e.target as HTMLElement;
        const button = target.closest('button[data-action]');

        if (button) {
            const action = button.getAttribute('data-action');

            if (action === 'roll-check' && onRoll) {
                const stat = button.getAttribute('data-stat');
                if (stat) {
                    onRoll('ability', stat, { speaker });
                }
            } else if (action === 'roll-formula' && onSend) {
                const formula = button.getAttribute('data-formula');
                if (formula) {
                    onSend(`/roll ${formula}`, { speaker });
                }
            }
        }
    };

    return (
        <div className="flex flex-col h-full gap-4">
            {/* Chat Log (Top) */}
            <div className={`flex-1 flex flex-col p-4 overflow-hidden min-h-0 ${s.container}`}>
                {!hideHeader && <h3 className={s.header}>Chat Log</h3>}
                <div
                    ref={scrollRef}
                    className="flex-1 overflow-y-auto space-y-4 pr-2 scroll-smooth"
                    onClick={handleChatClick}
                    onScroll={handleScroll}
                >
                    {[...messages].reverse().map((msg, idx) => (
                        <div key={`${msg.id || msg._id || 'msg'}-${idx}`} className={s.msgContainer ? s.msgContainer(!!msg.isRoll) : defaultStyles.msgContainer(!!msg.isRoll)}>
                            <div className="flex justify-between items-center mb-1">
                                <span className={s.user}>{msg.user}</span>
                                <span className={s.time}>{getTimeAgo(msg.timestamp ?? now, now)}</span>
                            </div>
                            {msg.flavor && <div className={s.flavor} dangerouslySetInnerHTML={{ __html: msg.flavor }} />}
                            <div className={s.content} dangerouslySetInnerHTML={{ __html: formatContent(msg.content || '') }} />
                            {msg.rollTotal !== undefined && (
                                <div className="mt-2 space-y-1">
                                    <div className={s.rollResult}>
                                        <div className={s.rollFormula}>
                                            {msg.rollFormula}
                                        </div>
                                        <div className={`
                                            ${s.rollTotal}
                                            ${msg.isCritical ? 'text-green-500' : msg.isFumble ? 'text-red-500' : ''}
                                        `}>
                                            {msg.isCritical ? `Critical Success! (${msg.rollTotal})` :
                                                msg.isFumble ? `Critical Failure! (${msg.rollTotal})` :
                                                    msg.rollTotal}
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    ))}
                    {messages.length === 0 && <div className="text-center text-slate-500 italic mt-10">No messages yet...</div>}
                </div>

                {/* Scroll Buttons */}
                <div className="grid grid-cols-2 gap-2 px-4 pt-2">
                    <button
                        onClick={() => scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
                        className={s.scrollButton || defaultStyles.scrollButton}
                    >
                        ↑ Newest
                    </button>
                    <button
                        onClick={() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })}
                        className={s.scrollButton || defaultStyles.scrollButton}
                    >
                        ↓ Older
                    </button>

                    {/* Chat Input at bottom for easy access */}
                    <div className={s.inputContainer || defaultStyles.inputContainer}>
                        <input
                            type="text"
                            value={chatInput}
                            onChange={(e) => setChatInput(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleInputSend()}
                            placeholder="Type a message..."
                            className={s.inputField || defaultStyles.inputField}
                        />
                        <button
                            onClick={handleInputSend}
                            disabled={!chatInput.trim()}
                            className={s.sendBtn || defaultStyles.sendBtn}
                        >
                            SEND
                        </button>
                    </div>
                </div>
            </div>

            {/* Dice Tray / Chat Input (Bottom) */}
            {!hideDiceTray && (
                <div className="flex-none">
                    <DiceTray onSend={onSend} speaker={speaker} />
                </div>
            )}
        </div>
    );
}
