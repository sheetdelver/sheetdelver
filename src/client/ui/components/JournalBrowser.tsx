'use client';

import React, { useState, useMemo } from 'react';
import { useJournal, Folder, JournalEntry } from '@client/ui/context/JournalProvider';
import { useUI } from '@client/ui/context/UIContext';
import { useSession } from '@client/ui/context/SessionContext';
import { Folder as FolderIcon, FileText, ChevronRight, ChevronDown, Plus, Search, Trash2, Book, X } from 'lucide-react';

export default function JournalBrowser() {
    const {
        journals, folders, loading,
        createJournal, createFolder, deleteJournal
    } = useJournal();
    const { isJournalOpen, setJournalOpen, setActiveJournalId } = useUI();
    const { currentUser } = useSession();
    const [search, setSearch] = useState('');
    const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});

    const userId = currentUser?._id || currentUser?.id;
    const isGM = currentUser?.isGM || (currentUser?.role && currentUser.role >= 3);
    const canCreateRoot = isGM || (currentUser?.role && currentUser.role >= 2);

    const toggleFolder = (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        setExpandedFolders(prev => ({ ...prev, [id]: !prev[id] }));
    };

    const filteredJournals = useMemo(() => {
        if (!search) return journals;
        return journals.filter(j => j.name.toLowerCase().includes(search.toLowerCase()));
    }, [journals, search]);

    const renderItem = (item: JournalEntry) => (
        <div
            key={item._id}
            className="group flex items-center justify-between px-2 py-1.5 hover:bg-amber-500/10 rounded cursor-pointer transition-colors"
            onClick={() => setActiveJournalId(item._id)}
        >
            <div className="flex items-center gap-2 overflow-hidden">
                <FileText className="w-4 h-4 text-blue-400 shrink-0" />
                <span className="text-sm text-neutral-300 truncate">{item.name}</span>
            </div>
            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                {(isGM || (userId && item.ownership?.[userId] === 3)) && (
                    <button
                        onClick={(e) => { e.stopPropagation(); if (confirm('Delete this journal?')) deleteJournal(item._id); }}
                        className="p-1 text-neutral-500 hover:text-red-400"
                    >
                        <Trash2 className="w-3 h-3" />
                    </button>
                )}
            </div>
        </div>
    );

    const renderFolder = (folder: Folder) => {
        const isExpanded = expandedFolders[folder._id];
        const childFolders = folders.filter(f => f.parent === folder._id);
        const childJournals = filteredJournals.filter(j => j.folder === folder._id);

        return (
            <div key={folder._id} className="select-none">
                <div
                    className="flex items-center justify-between px-1 py-1.5 hover:bg-white/5 rounded cursor-pointer group"
                    onClick={(e) => toggleFolder(folder._id, e)}
                >
                    <div className="flex items-center gap-1 overflow-hidden">
                        {isExpanded ? <ChevronDown className="w-4 h-4 text-neutral-500" /> : <ChevronRight className="w-4 h-4 text-neutral-500" />}
                        <FolderIcon className={`w-4 h-4 ${folder.color ? '' : 'text-amber-500'}`} style={folder.color ? { color: folder.color } : {}} />
                        <span className="text-sm font-bold text-neutral-200 truncate">{folder.name}</span>
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100">
                        {(isGM || (userId && folder.ownership?.[userId] === 3)) && (
                            <button
                                onClick={(e) => { e.stopPropagation(); createJournal('New Journal', folder._id); }}
                                className="p-1 text-neutral-500 hover:text-white"
                                title="Add Journal"
                            >
                                <Plus className="w-3 h-3" />
                            </button>
                        )}
                    </div>
                </div>
                {isExpanded && (
                    <div className="ml-4 border-l border-white/10 pl-1 mt-0.5">
                        {childFolders.map(renderFolder)}
                        {childJournals.map(renderItem)}
                    </div>
                )}
            </div>
        );
    };

    const rootFolders = folders.filter(f => !f.parent);
    const rootJournals = filteredJournals.filter(j => !j.folder);

    if (!isJournalOpen) return null;

    return (
        <>
            {/* Backdrop for mobile */}
            <div
                className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[119] sm:hidden"
                onClick={() => setJournalOpen(false)}
            />

            <div className="fixed inset-y-0 right-0 z-[120] w-[85vw] sm:w-[320px] bg-zinc-900 shadow-2xl border-l border-white/10 flex flex-col animate-in slide-in-from-right duration-300 hud-panel">
                {/* Header */}
                <div className="p-4 border-b border-white/5 flex items-center justify-between bg-black/40">
                    <h2 className="font-bold text-lg text-white flex items-center gap-2">
                        <Book className="w-5 h-5 text-blue-500" />
                        Library
                    </h2>
                    <button
                        onClick={() => setJournalOpen(false)}
                        className="p-1 hover:bg-white/10 rounded text-neutral-400 hover:text-white transition-colors"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* Actions */}
                <div className="p-3 bg-black/10 space-y-3">
                    <div className="relative">
                        <Search className="absolute left-2.5 top-2.5 w-4 h-4 text-neutral-500" />
                        <input
                            type="text"
                            placeholder="Search journals..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            className="w-full bg-zinc-800 border border-white/10 rounded-lg py-2 pl-9 pr-3 text-sm focus:outline-none focus:ring-1 focus:ring-amber-500/50 transition-all font-medium text-white placeholder:text-neutral-600"
                        />
                    </div>
                    {canCreateRoot && (
                        <div className="flex gap-2">
                            <button
                                onClick={() => createJournal('New Journal')}
                                className="flex-1 flex items-center justify-center gap-1.5 bg-amber-600 hover:bg-amber-500 text-black py-2 rounded-lg text-xs font-black transition-colors shadow-lg shadow-amber-900/20"
                            >
                                <Plus className="w-3.5 h-3.5" />
                                NEW JOURNAL
                            </button>
                            <button
                                onClick={() => createFolder('New Folder')}
                                className="flex-1 flex items-center justify-center gap-1.5 bg-white/5 hover:bg-white/10 text-white border border-white/10 py-2 rounded-lg text-xs font-black transition-colors"
                            >
                                <Plus className="w-3.5 h-3.5" />
                                FOLDER
                            </button>
                        </div>
                    )}
                </div>

                {/* List */}
                <div className="flex-1 overflow-y-auto p-2 scrollbar-thin scrollbar-thumb-white/10 custom-scrollbar">
                    {loading && journals.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-full text-neutral-500">
                            <div className="w-8 h-8 border-2 border-amber-500 border-t-transparent rounded-full animate-spin mb-3" />
                            <span className="text-[10px] uppercase tracking-widest font-black text-amber-500/50">Consulting Archives...</span>
                        </div>
                    ) : (
                        <div className="space-y-1">
                            {rootFolders.map(renderFolder)}
                            {rootJournals.map(renderItem)}
                            {journals.length === 0 && !loading && (
                                <div className="p-12 text-center">
                                    <div className="bg-white/5 w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3">
                                        <Book className="w-6 h-6 text-neutral-700" />
                                    </div>
                                    <p className="text-neutral-500 text-sm italic font-medium">The archives are empty.</p>
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {/* Footer Info */}
                <div className="p-3 border-t border-white/5 bg-black/20 text-[10px] text-neutral-500 flex justify-between font-medium tracking-tighter uppercase">
                    <span>{journals.length} Entries</span>
                    <span>{folders.length} Folders</span>
                </div>
            </div>

            <style jsx>{`
                .custom-scrollbar::-webkit-scrollbar {
                    width: 4px;
                }
                .custom-scrollbar::-webkit-scrollbar-track {
                    background: transparent;
                }
                .custom-scrollbar::-webkit-scrollbar-thumb {
                    background: rgba(255, 255, 255, 0.1);
                    border-radius: 10px;
                }
                .custom-scrollbar::-webkit-scrollbar-thumb:hover {
                    background: rgba(255, 255, 255, 0.2);
                }
            `}</style>
        </>
    );
}
