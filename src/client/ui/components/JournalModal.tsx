'use client';

import React, { useState, useEffect } from 'react';
import { useJournal, JournalEntry } from '@client/ui/context/JournalProvider';
import { useUI } from '@client/ui/context/UIContext';
import { X, Edit, Book, ChevronLeft, ChevronRight, Share2, Loader2 } from 'lucide-react';
import RichTextEditor from './RichTextEditor';
import { useConfig } from '@client/ui/context/ConfigContext';
import { useSession } from '@client/ui/context/SessionContext';
import { logger } from '@shared/utils/logger';
import { sanitizeRichHtml } from '@shared/security/safeHtml';
import { SafeHtmlContent } from './SafeHtmlContent';
import {
    getJournalPageId,
    resolveJournalPageSelection,
    sortJournalPages,
} from './journalOrdering';

export default function JournalModal() {
    const { activeJournalId, setActiveJournalId, sharedJournalId, setSharedJournalId } = useUI();
    const {
        getJournal,
        updateJournal,
        updateJournalPage,
        journalRevisions,
        journalGlobalRevision,
    } = useJournal();
    const { foundryUrl } = useConfig();
    const { currentUser } = useSession();

    const [journal, setJournal] = useState<JournalEntry | null>(null);
    const [loading, setLoading] = useState(false);
    const [isEditing, setIsEditing] = useState(false);
    const [activePageId, setActivePageId] = useState<string | null>(null);
    const requestedJournalIdRef = React.useRef<string | null>(null);
    const activeJournalRevision = activeJournalId ? (journalRevisions[activeJournalId] ?? 0) : 0;
    // Foundry persists page order in each JournalEntryPage.sort value; socket
    // and REST payload array order is not itself the ordering contract.
    const orderedPages = React.useMemo(
        () => sortJournalPages(journal?.pages ?? []), [journal?.pages],
    );
    const selectedPageIndex = activePageId
        ? orderedPages.findIndex(page => getJournalPageId(page) === activePageId)
        : 0;
    const activePageIndex = selectedPageIndex >= 0 ? selectedPageIndex : 0;

    const selectPageAtIndex = (index: number) => {
        setActivePageId(getJournalPageId(orderedPages[index]));
    };

    useEffect(() => {
        if (activeJournalId) {
            const journalChanged = requestedJournalIdRef.current !== activeJournalId;
            requestedJournalIdRef.current = activeJournalId;
            if (journalChanged) {
                setLoading(true);
                setIsEditing(false);
                setActivePageId(null);
            }
            getJournal(activeJournalId).then(data => {
                // Ignore a late response from a journal that has since closed
                // or been replaced by another journal in the same modal.
                if (requestedJournalIdRef.current !== activeJournalId) return;
                setJournal(data);
                setActivePageId(current => resolveJournalPageSelection(data?.pages ?? [], current));
                setLoading(false);
            });
        } else {
            requestedJournalIdRef.current = null;
            setJournal(null);
            setIsEditing(false);
            setActivePageId(null);
        }
    // Realtime revisions are scoped by Journal id; broad invalidations use the
    // global revision. getJournal coalesces a change during an active detail
    // read into one trailing request whose result is returned to this modal.
    }, [
        activeJournalId,
        activeJournalRevision,
        getJournal,
        journalGlobalRevision,
    ]);

    const close = () => {
        setActiveJournalId(null);
        setSharedJournalId(null);
        setJournal(null);
    };

    const handleSave = async (html: string) => {
        if (!journal) return;

        try {
            if (journal.pages && journal.pages.length > 0) {
                const page = orderedPages[activePageIndex];
                const pageId = page?._id || page?.id;
                if (!pageId) throw new Error('Cannot update a journal page without an id');
                // Pages are embedded Foundry documents. Sending only the page
                // delta preserves fields omitted from mutation responses.
                await updateJournalPage(journal._id, pageId, {
                    text: { ...page.text, content: html },
                });
            } else {
                await updateJournal(journal._id, { content: html });
            }

            // Refresh local state
            const updated = await getJournal(journal._id);
            setJournal(updated);
            setIsEditing(false);
        } catch (error) {
            logger.error('Failed to save journal:', error);
        }
    };

    const isShared = activeJournalId === sharedJournalId;
    const isGM = currentUser?.isGM || false;
    const currentUserId = currentUser?._id || currentUser?.id || '';
    const canEdit = !isShared && (isGM || (journal?.ownership?.[currentUserId] || 0) >= 3);
    const canShare = isGM && !isShared;

    const currentPage = orderedPages[activePageIndex];
    const rawContent = currentPage?.text?.content || journal?.content || '';

    // Keep editor input raw for round-tripping; only display content receives
    // the SafeHtml brand and Foundry-relative URL transformation.
    const displayContent = React.useMemo(() => {
        return sanitizeRichHtml(rawContent, { foundryBaseUrl: foundryUrl ?? undefined });
    }, [rawContent, foundryUrl]);

    if (!activeJournalId) return null;

    return (
        <div className="sd-ui-overlay fixed inset-0 z-[200] flex items-center justify-center p-4 sm:p-8 backdrop-blur-md animate-in fade-in duration-300">
            {/* Backdrop click to close */}
            <div className="absolute inset-0" onClick={close} />

            <div className="sd-ui-panel-raised w-full max-w-5xl h-full sm:h-[85vh] rounded-2xl shadow-2xl flex flex-col overflow-hidden relative hud-panel" onClick={e => e.stopPropagation()}>

                {/* Header */}
                <div className="sd-ui-inset p-4 sm:p-5 border-b sd-ui-divider flex items-center justify-between">
                    <div className="flex items-center gap-3 min-w-0">
                        <div className="sd-ui-panel p-2 rounded-lg shrink-0">
                            <Book className="w-5 h-5 sd-ui-accent" />
                        </div>
                        <div className="min-w-0">
                            <h2 className="font-bold text-lg leading-tight truncate">
                                {journal?.name || 'Loading Journal...'}
                            </h2>
                            {orderedPages.length > 0 && (
                                <p className="sd-ui-muted text-[10px] uppercase font-bold tracking-widest mt-0.5">
                                    Page {activePageIndex + 1} of {orderedPages.length} {currentPage?.name ? `• ${currentPage.name}` : ''}
                                </p>
                            )}
                        </div>
                    </div>
                    <div className="flex items-center gap-1 sm:gap-2">
                        {canShare && (
                            <button
                                className="sd-ui-button p-2 rounded-full transition-all"
                                title="Share with players"
                            >
                                <Share2 className="w-5 h-5  sm:w-5 sm:h-5 " />
                            </button>
                        )}
                        <button
                            onClick={close}
                            className="sd-ui-button p-2 rounded-full transition-all ml-1"
                        >
                            <X className="w-6 h-6" />
                        </button>
                    </div>
                </div>

                {/* Content Area */}
                <div className="flex-1 overflow-hidden relative flex flex-col">
                    {loading ? (
                        <div className="flex-1 flex flex-col items-center justify-center space-y-4">
                            <Loader2 className="sd-ui-accent w-10 h-10 animate-spin" />
                            <span className="sd-ui-muted text-xs uppercase font-black tracking-widest">Unrolling Parchment...</span>
                        </div>
                    ) : (
                        <>
                            {isEditing ? (
                                <div className="flex-1 overflow-hidden h-full">
                                    <RichTextEditor
                                        content={rawContent}
                                        onSave={handleSave}
                                    />
                                </div>
                            ) : (
                                <div className="flex-1 overflow-y-auto p-6 sm:p-12 prose prose-zinc max-w-none scroll-smooth selection:bg-amber-500/30 bg-white">
                                    {currentPage?.name && (
                                        <div className="bg-black text-white px-8 py-4 mb-10 -mx-6 sm:-mx-12 -mt-6 sm:-mt-12 text-center uppercase tracking-[0.2em] border-b border-black/20">
                                            <h2 className="text-xl sm:text-3xl m-0 text-white font-cinzel leading-relaxed">{currentPage.name}</h2>
                                        </div>
                                    )}
                                    {rawContent ? (
                                        <SafeHtmlContent
                                            className="journal-content-render"
                                            html={displayContent}
                                        />
                                    ) : (
                                        <div className="flex flex-col items-center justify-center h-full opacity-20 py-20">
                                            <Book className="w-16 h-16 mb-4" />
                                            <p className="italic font-serif text-lg">This page is currently blank.</p>
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Floating Edit Button */}
                            {canEdit && !isEditing && !loading && (
                                <button
                                    onClick={() => setIsEditing(true)}
                                    className="sd-ui-button sd-ui-button-primary absolute bottom-8 right-8 px-6 py-3 rounded-full font-black shadow-xl hover:scale-105 active:scale-95 transition-all flex items-center gap-2 z-10"
                                >
                                    <Edit className="w-4 h-4" />
                                    EDIT PAGE
                                </button>
                            )}
                        </>
                    )}
                </div>

                {/* Footer / Pagination */}
                {orderedPages.length > 1 && !isEditing && (
                    <div className="sd-ui-inset p-4 border-t sd-ui-divider flex items-center justify-between">
                        <button
                            disabled={activePageIndex === 0}
                            onClick={() => selectPageAtIndex(activePageIndex - 1)}
                            className="sd-ui-muted flex items-center gap-2 text-xs font-black hover:opacity-80 disabled:opacity-10 transition-opacity uppercase tracking-widest"
                        >
                            <ChevronLeft className="w-5 h-5 font-bold" />
                            Previous
                        </button>

                        <div className="hidden sm:flex gap-2">
                            {orderedPages.map((page, i) => (
                                <button
                                    key={getJournalPageId(page) ?? i}
                                    onClick={() => selectPageAtIndex(i)}
                                    className={`w-2 h-2 rounded-full transition-all hover:scale-125 ${i === activePageIndex ? 'sd-ui-button-primary w-6' : 'sd-ui-button'}`}
                                    title={`Go to page ${i + 1}`}
                                />
                            ))}
                        </div>

                        <div className="sd-ui-muted sm:hidden text-[10px] font-black">
                            {activePageIndex + 1} / {orderedPages.length}
                        </div>

                        <button
                            disabled={activePageIndex === orderedPages.length - 1}
                            onClick={() => selectPageAtIndex(activePageIndex + 1)}
                            className="sd-ui-muted flex items-center gap-2 text-xs font-black hover:opacity-80 disabled:opacity-10 transition-opacity uppercase tracking-widest"
                        >
                            Next
                            <ChevronRight className="w-5 h-5 font-bold" />
                        </button>
                    </div>
                )}
            </div>

            <style jsx global>{`
                .journal-content-render h1 { color: #1a1a1a; font-family: var(--font-cinzel), serif; border-bottom: 2px solid rgba(0, 0, 0, 0.1); padding-bottom: 0.5rem; margin-top: 2rem; }
                .journal-content-render h2 { color: #333; font-family: var(--font-cinzel), serif; }
                .journal-content-render p { line-height: 1.8; color: #1a1a1a; font-size: 1.05rem; }
                .journal-content-render img { border-radius: 0.75rem; border: 1px solid rgba(0,0,0,0.1); box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1); }
                .journal-content-render blockquote { border-left-color: #f59e0b; font-style: italic; background: rgba(0,0,0,0.03); padding: 1rem 1.5rem; border-radius: 0 0.5rem 0.5rem 0; color: #444; }
                .journal-content-render table { border-collapse: collapse; width: 100%; margin: 2rem 0; font-size: 0.9rem; color: #1a1a1a; }
                .journal-content-render th { background: rgba(0,0,0,0.05); padding: 0.75rem; text-align: left; border: 1px solid rgba(0,0,0,0.1); }
                .journal-content-render td { padding: 0.75rem; border: 1px solid rgba(0,0,0,0.1); }
                .journal-content-render { color: #1a1a1a; }
                .journal-content-render strong { color: #000; }
                .journal-content-render a { color: #b45309; text-decoration: underline; }
            `}</style>
        </div>
    );
}
