
'use client';

import React, { useEffect, useState, useRef } from 'react';
import { logger } from '@shared/utils/logger';

import { useFoundry } from '@client/ui/context/FoundryContext';
import { useConfig } from '@client/ui/context/ConfigContext';
import { useUI } from '@client/ui/context/UIContext';
import type { RealtimeSharedContentPayload } from '@shared/contracts/realtime';

export function SharedContentModal() {
    const { sharedContent } = useFoundry();
    const { resolveImageUrl } = useConfig();
    const { setActiveJournalId, setSharedJournalId } = useUI();
    const [isVisible, setIsVisible] = useState(false);
    const lastTimestampRef = useRef<number>(0);

    const [content, setContent] = useState<RealtimeSharedContentPayload | null>(null);

    useEffect(() => {
        if (sharedContent && sharedContent.type) {
            const ts = sharedContent.timestamp ?? 0;
            // Check if dismissed
            const dismissedTs = sessionStorage.getItem('sheet-delver-dismissed-share');
            if (dismissedTs && parseInt(dismissedTs) === ts) {
                return;
            }

            if (ts > lastTimestampRef.current) {
                logger.debug('Received new shared content:', sharedContent);
                lastTimestampRef.current = ts;

                if (sharedContent.type === 'journal') {
                    // Delegate to specialized JournalModal
                    const journalId = (sharedContent.data?.id as string | undefined) || null;
                    setSharedJournalId(journalId);
                    setActiveJournalId(journalId);
                } else {
                    setContent(sharedContent);
                    setIsVisible(true);
                }
            }
        }
    }, [sharedContent, setActiveJournalId, setSharedJournalId]);

    if (!isVisible || !content || !content.type) return null;

    const close = () => {
        setIsVisible(false);
        if (content) {
            sessionStorage.setItem('sheet-delver-dismissed-share', String(content.timestamp ?? 0));
        }
    };

    // Resolve Image URL
    const imageUrl = content.type === 'image' ? resolveImageUrl(content.data?.url || '') : '';

    return (
        <div className="sd-ui-overlay fixed inset-0 z-[150] flex items-center justify-center backdrop-blur-sm p-4 animate-in fade-in duration-200" onClick={close}>
            <div className="relative max-w-4xl max-h-[90vh] w-full flex flex-col items-center justify-center" onClick={(e) => e.stopPropagation()}>

                <button
                    onClick={close}
                    className="absolute -top-12 right-0 sd-ui-button p-2"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                </button>

                {content.type === 'image' && (
                    <div className="sd-ui-panel-raised rounded-lg overflow-hidden shadow-2xl">
                        {content.data?.title && (
                            <div className="sd-ui-inset px-4 py-2 border-b sd-ui-divider text-center font-bold uppercase tracking-widest text-xs">
                                {content.data?.title}
                            </div>
                        )}
                        <img
                            src={imageUrl}
                            alt={content.data?.title || 'Shared Image'}
                            className="max-h-[80vh] w-auto object-contain"
                        />
                    </div>
                )}
            </div>
        </div>
    );
}
