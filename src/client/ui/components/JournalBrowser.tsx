'use client';

import React, { useState, useMemo } from 'react';
import { useJournal, Folder, JournalEntry } from '@client/ui/context/JournalProvider';
import { useUI } from '@client/ui/context/UIContext';
import { useSession } from '@client/ui/context/SessionContext';
import { Folder as FolderIcon, FileText, ChevronRight, ChevronDown, Plus, Search, Trash2, Book, X } from 'lucide-react';
import { sortDirectorySiblings } from './journalOrdering';

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
            className="group flex items-center justify-between px-2 py-1.5 hover:opacity-80 rounded cursor-pointer transition-opacity"
            onClick={() => setActiveJournalId(item._id)}
        >
            <div className="flex items-center gap-2 overflow-hidden">
                <FileText className="w-4 h-4 sd-ui-accent shrink-0" />
                <span className="text-sm truncate">{item.name}</span>
            </div>
            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                {(isGM || (userId && item.ownership?.[userId] === 3)) && (
                    <button
                        onClick={(e) => { e.stopPropagation(); if (confirm('Delete this journal?')) deleteJournal(item._id); }}
                        className="sd-ui-muted p-1 hover:opacity-80"
                    >
                        <Trash2 className="w-3 h-3" />
                    </button>
                )}
            </div>
        </div>
    );

    const renderFolder = (folder: Folder) => {
        const isExpanded = expandedFolders[folder._id];
        const mode = folder.sorting === 'a' ? 'a' : 'm';
        const childFolders = sortDirectorySiblings(folders.filter(f => f.parent === folder._id), mode);
        const childJournals = sortDirectorySiblings(filteredJournals.filter(j => j.folder === folder._id), mode);

        return (
            <div key={folder._id} className="select-none">
                <div
                    className="flex items-center justify-between px-1 py-1.5 hover:opacity-80 rounded cursor-pointer group"
                    onClick={(e) => toggleFolder(folder._id, e)}
                >
                    <div className="flex items-center gap-1 overflow-hidden">
                        {isExpanded ? <ChevronDown className="w-4 h-4 sd-ui-muted" /> : <ChevronRight className="w-4 h-4 sd-ui-muted" />}
                        <FolderIcon className={`w-4 h-4 ${folder.color ? '' : 'sd-ui-accent'}`} style={folder.color ? { color: folder.color } : {}} />
                        <span className="text-sm font-bold truncate">{folder.name}</span>
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100">
                        {(isGM || (userId && folder.ownership?.[userId] === 3)) && (
                            <button
                                onClick={(e) => { e.stopPropagation(); createJournal('New Journal', folder._id); }}
                                className="sd-ui-muted p-1 hover:opacity-80"
                                title="Add Journal"
                            >
                                <Plus className="w-3 h-3" />
                            </button>
                        )}
                    </div>
                </div>
                {isExpanded && (
                    <div className="ml-4 border-l sd-ui-divider pl-1 mt-0.5">
                        {childFolders.map(renderFolder)}
                        {childJournals.map(renderItem)}
                    </div>
                )}
            </div>
        );
    };

    // Foundry's root sort toggle is browser-local and is not present on socket
    // documents; preserve the shared persisted manual order in Sheet Delver.
    const rootFolders = sortDirectorySiblings(folders.filter(f => !f.parent), 'm');
    const rootJournals = sortDirectorySiblings(filteredJournals.filter(j => !j.folder), 'm');

    if (!isJournalOpen) return null;

    return (
        <>
            {/* Backdrop for mobile */}
            <div
                className="sd-ui-overlay fixed inset-0 backdrop-blur-sm z-[119] sm:hidden"
                onClick={() => setJournalOpen(false)}
            />

            <div className="sd-ui-panel-raised fixed inset-y-0 right-0 z-[120] w-[85vw] sm:w-[320px] shadow-2xl border-l flex flex-col animate-in slide-in-from-right duration-300 hud-panel">
                {/* Header */}
                <div className="sd-ui-inset p-4 border-b sd-ui-divider flex items-center justify-between">
                    <h2 className="font-bold text-lg flex items-center gap-2">
                        <Book className="w-5 h-5 sd-ui-accent" />
                        Library
                    </h2>
                    <button
                        onClick={() => setJournalOpen(false)}
                        className="sd-ui-button p-1 rounded transition-colors"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* Actions */}
                <div className="p-3 space-y-3">
                    <div className="relative">
                        <Search className="sd-ui-muted absolute left-2.5 top-2.5 w-4 h-4" />
                        <input
                            type="text"
                            placeholder="Search journals..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            className="sd-ui-control w-full rounded-lg py-2 pl-9 pr-3 text-sm transition-all font-medium"
                        />
                    </div>
                    {canCreateRoot && (
                        <div className="flex gap-2">
                            <button
                                onClick={() => createJournal('New Journal')}
                                className="sd-ui-button sd-ui-button-primary flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-black shadow-lg"
                            >
                                <Plus className="w-3.5 h-3.5" />
                                NEW JOURNAL
                            </button>
                            <button
                                onClick={() => createFolder('New Folder')}
                                className="sd-ui-button flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-black transition-colors"
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
                        <div className="sd-ui-muted flex flex-col items-center justify-center h-full">
                            <div className="sd-ui-spinner w-8 h-8 border-2 border-t-transparent rounded-full animate-spin mb-3" />
                            <span className="text-[10px] uppercase tracking-widest font-black">Consulting Archives...</span>
                        </div>
                    ) : (
                        <div className="space-y-1">
                            {rootFolders.map(renderFolder)}
                            {rootJournals.map(renderItem)}
                            {journals.length === 0 && !loading && (
                                <div className="p-12 text-center">
                                    <div className="sd-ui-inset w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3">
                                        <Book className="w-6 h-6 sd-ui-muted" />
                                    </div>
                                    <p className="sd-ui-muted text-sm italic font-medium">The archives are empty.</p>
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {/* Footer Info */}
                <div className="sd-ui-muted p-3 border-t sd-ui-divider text-[10px] flex justify-between font-medium tracking-tighter uppercase">
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
