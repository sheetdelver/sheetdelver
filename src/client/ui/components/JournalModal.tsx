'use client';

import React, { useState, useEffect } from 'react';
import { useJournal, JournalEntry } from '@client/ui/context/JournalProvider';
import { useUI } from '@client/ui/context/UIContext';
import { X, Edit, Book, ChevronLeft, ChevronRight, Share2, Loader2 } from 'lucide-react';
import RichTextEditor from './RichTextEditor';
import { useConfig } from '@client/ui/context/ConfigContext';
import { useSession } from '@client/ui/context/SessionContext';
import { logger } from '@shared/utils/logger';

export default function JournalModal() {
    const { activeJournalId, setActiveJournalId, sharedJournalId, setSharedJournalId } = useUI();
    const { getJournal, updateJournal } = useJournal();
    const { foundryUrl } = useConfig();
    const { currentUser } = useSession();

    const [journal, setJournal] = useState<JournalEntry | null>(null);
    const [loading, setLoading] = useState(false);
    const [isEditing, setIsEditing] = useState(false);
    const [activePageIndex, setActivePageIndex] = useState(0);

    useEffect(() => {
        if (activeJournalId) {
            setLoading(true);
            setIsEditing(false);
            setActivePageIndex(0);
            getJournal(activeJournalId).then(data => {
                setJournal(data);
                setLoading(false);
            });
        } else {
            setJournal(null);
            setIsEditing(false);
            setActivePageIndex(0);
        }
    }, [activeJournalId, getJournal]);

    const close = () => {
        setActiveJournalId(null);
        setSharedJournalId(null);
        setJournal(null);
    };

    const handleSave = async (html: string) => {
        if (!journal) return;

        try {
            if (journal.pages && journal.pages.length > 0) {
                const page = journal.pages[activePageIndex];
                const newPages = [...journal.pages];
                newPages[activePageIndex] = {
                    ...page,
                    text: { ...page.text, content: html }
                };
                await updateJournal(journal._id, { pages: newPages });
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

    const currentPage = journal?.pages?.[activePageIndex];
    const rawContent = currentPage?.text?.content || journal?.content || '';

    // Sanitize content: Prefix relative Foundry URLs with foundryUrl
    const content = React.useMemo(() => {
        if (!rawContent || !foundryUrl) return rawContent;
        // Prefix relative image/media/link paths
        return rawContent.replace(
            /(src|href)="([^"]+)"/g,
            (match: string, attr: string, path: string) => {
                if (path.startsWith('http') || path.startsWith('data:') || path.startsWith('/') || path.startsWith('#')) {
                    return match;
                }
                return `${attr}="${foundryUrl}/${path}"`;
            }
        ).replace(
            /(src|href)='([^']+)'/g,
            (match: string, attr: string, path: string) => {
                if (path.startsWith('http') || path.startsWith('data:') || path.startsWith('/') || path.startsWith('#')) {
                    return match;
                }
                return `${attr}='${foundryUrl}/${path}'`;
            }
        );
    }, [rawContent, foundryUrl]);

    if (!activeJournalId) return null;

    return (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 sm:p-8 bg-black/70 backdrop-blur-md animate-in fade-in duration-300">
            {/* Backdrop click to close */}
            <div className="absolute inset-0" onClick={close} />

            <div className="bg-zinc-900 w-full max-w-5xl h-full sm:h-[85vh] rounded-2xl shadow-2xl border border-white/10 flex flex-col overflow-hidden relative hud-panel" onClick={e => e.stopPropagation()}>

                {/* Header */}
                <div className="p-4 sm:p-5 border-b border-white/5 flex items-center justify-between bg-black/40">
                    <div className="flex items-center gap-3 min-w-0">
                        <div className="bg-blue-500/10 p-2 rounded-lg shrink-0">
                            <Book className="w-5 h-5 text-blue-500" />
                        </div>
                        <div className="min-w-0">
                            <h2 className="font-bold text-lg text-white leading-tight truncate">
                                {journal?.name || 'Loading Journal...'}
                            </h2>
                            {journal?.pages && journal.pages.length > 0 && (
                                <p className="text-[10px] text-zinc-500 uppercase font-bold tracking-widest mt-0.5">
                                    Page {activePageIndex + 1} of {journal.pages.length} {currentPage?.name ? `• ${currentPage.name}` : ''}
                                </p>
                            )}
                        </div>
                    </div>
                    <div className="flex items-center gap-1 sm:gap-2">
                        {canShare && (
                            <button
                                className="p-2 text-zinc-400 hover:text-white hover:bg-white/5 rounded-full transition-all"
                                title="Share with players"
                            >
                                <Share2 className="w-5 h-5  sm:w-5 sm:h-5 " />
                            </button>
                        )}
                        <button
                            onClick={close}
                            className="p-2 hover:bg-white/10 rounded-full text-zinc-400 hover:text-white transition-all ml-1"
                        >
                            <X className="w-6 h-6" />
                        </button>
                    </div>
                </div>

                {/* Content Area */}
                <div className="flex-1 overflow-hidden relative flex flex-col bg-zinc-900/50">
                    {loading ? (
                        <div className="flex-1 flex flex-col items-center justify-center space-y-4">
                            <Loader2 className="w-10 h-10 text-amber-500 animate-spin" />
                            <span className="text-xs uppercase font-black tracking-widest text-amber-500/50">Unrolling Parchment...</span>
                        </div>
                    ) : (
                        <>
                            {isEditing ? (
                                <div className="flex-1 overflow-hidden h-full">
                                    <RichTextEditor
                                        content={content}
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
                                    {content ? (
                                        <div
                                            className="journal-content-render"
                                            dangerouslySetInnerHTML={{ __html: content }}
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
                                    className="absolute bottom-8 right-8 bg-amber-600 hover:bg-amber-500 text-black px-6 py-3 rounded-full font-black shadow-xl shadow-amber-900/20 hover:scale-105 active:scale-95 transition-all flex items-center gap-2 z-10"
                                >
                                    <Edit className="w-4 h-4" />
                                    EDIT PAGE
                                </button>
                            )}
                        </>
                    )}
                </div>

                {/* Footer / Pagination */}
                {journal?.pages && journal.pages.length > 1 && !isEditing && (
                    <div className="p-4 bg-black/40 border-t border-white/5 flex items-center justify-between">
                        <button
                            disabled={activePageIndex === 0}
                            onClick={() => setActivePageIndex(p => p - 1)}
                            className="flex items-center gap-2 text-xs font-black text-zinc-500 hover:text-white disabled:opacity-10 transition-colors uppercase tracking-widest"
                        >
                            <ChevronLeft className="w-5 h-5 font-bold" />
                            Previous
                        </button>

                        <div className="hidden sm:flex gap-2">
                            {journal.pages.map((_, i) => (
                                <button
                                    key={i}
                                    onClick={() => setActivePageIndex(i)}
                                    className={`w-2 h-2 rounded-full transition-all hover:scale-125 ${i === activePageIndex ? 'bg-amber-500 w-6' : 'bg-white/10 hover:bg-white/30'}`}
                                    title={`Go to page ${i + 1}`}
                                />
                            ))}
                        </div>

                        <div className="sm:hidden text-[10px] font-black text-zinc-600">
                            {activePageIndex + 1} / {journal.pages.length}
                        </div>

                        <button
                            disabled={activePageIndex === journal.pages.length - 1}
                            onClick={() => setActivePageIndex(p => p + 1)}
                            className="flex items-center gap-2 text-xs font-black text-zinc-500 hover:text-white disabled:opacity-10 transition-colors uppercase tracking-widest"
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
