'use client';

import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useFoundry } from '@client/ui/context/FoundryContext';
import { useSession } from '@client/ui/context/SessionContext';
import { useConfig } from '@client/ui/context/ConfigContext';
import { useUI } from '@client/ui/context/UIContext';
import type { RealtimeSharedContentPayload } from '@shared/contracts/realtime';
import { readDismissedShare, sharedContentKey } from '@client/ui/context/sharedContentState';
import { useModalFocus } from '@client/ui/hooks/useModalFocus';

/** One world-scoped presentation owner, mounted in the persistent player layout. */
export function SharedContentHost() {
    const { sharedContent, worldId } = useFoundry();
    const { currentUserId } = useSession();
    const { resolveImageUrl } = useConfig();
    const {
        dismissedShareKey, dismissSharedContent, setActiveShareKey,
        activeShareKey, activeJournalId, sharedJournalId, setActiveJournalId, setSharedJournalId, setSharedJournalPageId,
        setSharedJournalReceipt,
    } = useUI();
    const [image, setImage] = useState<RealtimeSharedContentPayload | null>(null);
    const lastPresentedKey = useRef<string | null>(null);

    useEffect(() => {
        if (!worldId || !currentUserId || !sharedContent?.type) {
            lastPresentedKey.current = null;
            setImage(null);
            if (sharedJournalId) {
                if (activeJournalId === sharedJournalId) setActiveJournalId(null);
                setSharedJournalId(null);
                setSharedJournalPageId(null);
                setSharedJournalReceipt(null);
                setActiveShareKey(null);
            }
            return;
        }
        const key = sharedContentKey(worldId, currentUserId, sharedContent);
        let remembered: string | null = null;
        try { remembered = readDismissedShare(window.sessionStorage); } catch { /* In-memory state suffices. */ }
        if (lastPresentedKey.current === key || dismissedShareKey === key || remembered === key) return;
        if (sharedContent.type === 'journal' && (typeof sharedContent.data?.id !== 'string' || !sharedContent.data.id)) return;
        lastPresentedKey.current = key;
        setActiveShareKey(key);
        if (sharedContent.type === 'journal') {
            const id = sharedContent.data?.id;
            if (typeof id !== 'string' || !id) return;
            const pageId = sharedContent.data?.pageId;
            setImage(null);
            setSharedJournalPageId(typeof pageId === 'string' ? pageId : null);
            const { streamId, sequence, shareId } = sharedContent;
            setSharedJournalReceipt(typeof streamId === 'string' && typeof sequence === 'number' && typeof shareId === 'string'
                ? { streamId, sequence, shareId } : null);
            setSharedJournalId(id);
            setActiveJournalId(id);
        } else if (sharedContent.type === 'image') {
            setActiveJournalId(null);
            setSharedJournalId(null);
            setSharedJournalPageId(null);
            setSharedJournalReceipt(null);
            setImage(sharedContent);
        }
    }, [worldId, currentUserId, sharedContent, dismissedShareKey, activeJournalId, sharedJournalId,
        setActiveShareKey, setActiveJournalId, setSharedJournalId, setSharedJournalPageId, setSharedJournalReceipt]);

    useEffect(() => {
        if (image && activeJournalId) {
            dismissSharedContent();
            setImage(null);
        }
    }, [image, activeJournalId, dismissSharedContent]);

    if (!image || image.type !== 'image') return null;
    const close = () => { dismissSharedContent(); setImage(null); };
    const imageUrl = resolveImageUrl(image.data?.url || '');
    const title = image.data?.title || 'Shared image';
    // Only the asset remounts per receipt. Keep the dialog's focus lifetime
    // intact when replacing an already-open share.
    return <SharedImageDialog assetKey={activeShareKey} imageUrl={imageUrl} title={title} close={close} />;
}

function SharedImageDialog({ assetKey, imageUrl, title, close }: {
    assetKey: string | null; imageUrl: string; title: string; close: () => void;
}) {
    const dialogRef = useRef<HTMLDivElement>(null);
    useModalFocus(dialogRef, true, close);

    return (
        <div className="sd-ui-overlay fixed inset-0 z-[220] flex items-center justify-center p-4 backdrop-blur-sm"
            onClick={close}>
            <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}
                className="sd-ui-panel-raised flex max-h-[calc(100dvh-2rem)] w-full max-w-5xl flex-col overflow-hidden rounded-xl shadow-2xl outline-none"
                onClick={event => event.stopPropagation()}>
                <div className="sd-ui-inset flex shrink-0 items-center justify-between gap-3 border-b sd-ui-divider px-4 py-2">
                    <h2 className="min-w-0 truncate text-sm font-bold">{title}</h2>
                    <button type="button" onClick={close} className="sd-ui-button shrink-0 rounded-lg p-2"
                        aria-label="Close shared image"><X className="h-5 w-5" /></button>
                </div>
                <SharedImageAsset key={assetKey} imageUrl={imageUrl} title={title} />
            </div>
        </div>
    );
}

function SharedImageAsset({ imageUrl, title }: { imageUrl: string; title: string }) {
    const [imageState, setImageState] = useState<'loading' | 'ready' | 'error'>('loading');
    return <div className="flex min-h-0 items-center justify-center overflow-auto p-3">
        {imageUrl && imageState === 'loading' && <p role="status">Loading image…</p>}
        {imageState === 'error' && <p role="alert">This image could not be loaded.</p>}
        {imageUrl && <img src={imageUrl} alt={title}
            onLoad={() => setImageState('ready')} onError={() => setImageState('error')}
            className={`max-h-[calc(100dvh-8rem)] max-w-full object-contain ${imageState === 'ready' ? '' : 'hidden'}`} />}
        {!imageUrl && <p role="alert">This image has no available URL.</p>}
    </div>;
}
