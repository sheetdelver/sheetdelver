'use client';

import type { ReactNode, MouseEvent } from 'react';
import type { ChatMessageDto } from '@shared/contracts/chat';
import type { RollMode } from '@shared/sdk';
import { sanitizeRichHtml } from '@shared/security/safeHtml';
import { SafeHtmlContent } from '../SafeHtmlContent';
import { defaultChatStyles } from './chatStyles';
import { formatChatContent, messageAuthor, messageId, messageRolls } from './chatMessage';

export interface ChatActions {
    onSend?: (message: string, options?: { rollMode?: RollMode; speaker?: string }) => void;
    onRoll?: (type: string, key: string, options?: { rollMode?: RollMode; speaker?: string }) => void;
    speaker?: string;
}
export function ChatMessageCard({ message, foundryUrl, styles, actions, controls }: {
    message: ChatMessageDto;
    foundryUrl?: string;
    styles?: Partial<typeof defaultChatStyles>;
    actions?: ChatActions;
    controls?: ReactNode;
}) {
    const s = { ...defaultChatStyles, ...styles };
    const rolls = messageRolls(message);
    const hidden = message.isContentVisible === false;
    const click = (event: MouseEvent<HTMLDivElement>) => {
        if (hidden) return;
        const button = (event.target as HTMLElement).closest('button[data-action]');
        if (!button || !event.currentTarget.contains(button)) return;
        if (button.getAttribute('data-action') === 'roll-formula') {
            const formula = button.getAttribute('data-formula');
            if (formula) actions?.onSend?.('/roll ' + formula, { speaker: actions.speaker });
        } else if (button.getAttribute('data-action') === 'roll-check') {
            const stat = button.getAttribute('data-stat');
            if (stat) actions?.onRoll?.('ability', stat, { speaker: actions.speaker });
        }
    };
    return <article data-chat-message-id={messageId(message)}
        className={s.msgContainer(!!message.isRoll) + ' min-w-0 !mx-0 !rounded-md [overflow-wrap:anywhere]'}
        style={{ letterSpacing: 0 }}>
        <header className="flex items-center gap-2 border-b border-white/10 pb-1 mb-2">
            <span className={s.user + ' min-w-0 flex-1 !tracking-normal'}>{messageAuthor(message)}</span>
            {typeof message.timestamp === 'number' && Number.isFinite(message.timestamp) && <time className={s.time} dateTime={new Date(message.timestamp).toISOString()}>
                {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </time>}
            {controls}
        </header>
        {hidden ? <div className="text-center"><p className={s.flavor}>Privately rolled dice.</p><div className={s.rollTotal}>???</div></div> : <>
            {message.flavor && <SafeHtmlContent className={s.flavor} html={sanitizeRichHtml(message.flavor, { foundryBaseUrl: foundryUrl })} />}
            <SafeHtmlContent onClick={click}
                className={s.content + ' !text-sm !font-normal [&_img]:max-w-full [&_img]:max-h-40 [&_img]:object-contain [&_button]:border [&_button]:rounded [&_button]:px-2 ' + (rolls.length ? '[&_.dice-roll]:hidden [&_.dice-tooltip]:hidden' : '')}
                html={formatChatContent(rolls.length === 1 && message.content?.trim() === String(rolls[0].total) ? '' : message.content || '', foundryUrl, { roll: !!actions?.onSend, check: !!actions?.onRoll })} />
            {rolls.map((roll, index) => <div key={index} className={s.rollResult}>
                <div className={s.rollFormula + ' !tracking-normal'}>{roll.formula}</div>
                <div className={s.rollTotal}>{index === 0 && message.isCritical ? 'Critical Success! ' : index === 0 && message.isFumble ? 'Critical Failure! ' : ''}{roll.total}</div>
            </div>)}
        </>}
    </article>;
}
