'use client';

import { useEffect } from 'react';
import { X } from 'lucide-react';
import DiceTray from './DiceTray';
import { useDiceTrayFeedbackAnchor } from './Notifications/NotificationProvider';
import { RollMode } from '@shared/sdk';
import { useFoundry } from '@client/ui/context/FoundryContext';

interface DiceTrayDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onSend?: (msg: string, options?: { rollMode?: RollMode; speaker?: string }) => void;
    speaker?: string;
}

export default function DiceTrayDialog({ isOpen, onClose, onSend, speaker }: DiceTrayDialogProps) {
    const diceFeedbackAnchor = useDiceTrayFeedbackAnchor();
    const { system: adapter } = useFoundry();

    // Kept for compatibility with modules that may still import internal UI components.
    useEffect(() => {
        if (!isOpen) return;
        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && !event.defaultPrevented) onClose();
        };
        document.addEventListener('keydown', handleEscape);
        return () => document.removeEventListener('keydown', handleEscape);
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    const s = {
        window: "sd-ui-panel-raised rounded-2xl shadow-2xl",
        header: "sd-ui-inset p-4 flex justify-between items-center",
        title: "font-serif font-bold text-xl uppercase tracking-widest mx-auto",
        closeBtn: "sd-ui-muted hover:opacity-80 transition-opacity",
        ...adapter?.componentStyles?.globalChat,
    };

    return (
        <div className="sd-ui-overlay fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div
                ref={diceFeedbackAnchor}
                className={`w-full max-w-lg overflow-hidden animate-in zoom-in-95 duration-200 ${s.window}`}
            >
                <div className={s.header}>
                    <h3 className={s.title}>Dice Tray</h3>
                    <button
                        onClick={onClose}
                        aria-label="Close dice tray"
                        title="Close dice tray"
                        className={s.closeBtn}
                    >
                        <X size={20} />
                    </button>
                </div>
                <div className="p-0">
                    <DiceTray onSend={(msg, options) => { if (onSend) onSend(msg, { ...options, speaker: options?.speaker || speaker }); }} hideHeader={true} speaker={speaker} />
                </div>
            </div>
        </div>
    );
}
