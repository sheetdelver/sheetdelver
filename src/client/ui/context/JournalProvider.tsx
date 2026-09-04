'use client';

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { useSession } from './SessionContext';
import { useRealtime } from '@client/ui/context/RealtimeContext';
import { logger } from '@shared/utils/logger';
import { UnauthorizedApiError } from '@client/ui/api/http';
import * as journalApi from '@client/ui/api/journalApi';
import type {
    JournalEntryDto,
    JournalFolderDto,
    JournalPageDto,
} from '@shared/contracts/journals';
import { createCoalescedFetch, type CoalescedFetch } from '@client/ui/context/coalescedFetch';
import type {
    RealtimeJournalChangedPayload,
    RealtimeJournalListInvalidatedPayload,
} from '@shared/contracts/realtime';

// Walkthrough/Changelog Notes:
// - **Permissions**: "Edit" & "Share" buttons are now hidden for shared content and non-authorized users. Journals are now restricted to users with `Observer` level or higher.
// - **Folder Logic**: Folders are now automatically hidden if they don't contain any journals you have permission to see.
// - **Foundry Style**: Added a prominent "Chapter" header to pages (black bar with white text) matching the core Foundry VTT journal aesthetic.
// - **Creation Fix**: Resolve backend errors when creating new journals or folders by correctly formatting the payload.

export type JournalEntry = JournalEntryDto;
export type Folder = JournalFolderDto;

interface JournalContextType {
    journals: JournalEntry[];
    folders: Folder[];
    loading: boolean;
    error: string | null;
    journalRevisions: Record<string, number>;
    journalGlobalRevision: number;
    fetchJournals: () => Promise<void>;
    getJournal: (id: string) => Promise<JournalEntry | null>;
    createJournal: (name: string, folderId?: string) => Promise<void>;
    updateJournal: (id: string, data: Partial<JournalEntry>) => Promise<void>;
    updateJournalPage: (journalId: string, pageId: string, data: Partial<JournalPageDto>) => Promise<void>;
    deleteJournal: (id: string) => Promise<void>;
    createFolder: (name: string, parentId?: string) => Promise<void>;
}

const JournalContext = createContext<JournalContextType | undefined>(undefined);

export function JournalProvider({ children }: { children: React.ReactNode }) {
    const { token, step } = useSession();
    const { appSocket } = useRealtime();
    const [journals, setJournals] = useState<JournalEntry[]>([]);
    const [folders, setFolders] = useState<Folder[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [journalRevisions, setJournalRevisions] = useState<Record<string, number>>({});
    const [journalGlobalRevision, setJournalGlobalRevision] = useState(0);
    const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const listFetcherRef = useRef<{ token: string; fetch: CoalescedFetch<void> } | null>(null);
    const detailFetchersRef = useRef(new Map<string, CoalescedFetch<JournalEntry | null>>());

    const fetchJournals = useCallback(async () => {
        if (!token) return;
        if (listFetcherRef.current?.token !== token) {
            listFetcherRef.current = {
                token,
                // Folder/Journal invalidations observed during this request
                // guarantee one post-change list read.
                fetch: createCoalescedFetch<void>(async () => {
                    setLoading(true);
                    try {
                        const data = await journalApi.fetchJournals(token);
                        setJournals(data.journals || []);
                        setFolders(data.folders || []);
                    } catch (err: any) {
                        if (err instanceof UnauthorizedApiError) return;
                        logger.error('JournalProvider | Fetch failed:', err);
                        setError(err.message);
                    } finally {
                        setLoading(false);
                    }
                }),
            };
        }
        return listFetcherRef.current.fetch();
    }, [token]);

    const requestJournalsRefresh = useCallback(() => {
        if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = setTimeout(() => {
            refreshTimerRef.current = null;
            void fetchJournals();
        }, 75);
    }, [fetchJournals]);

    useEffect(() => {
        // Only fetch journals when we're in the dashboard state
        // Prevents fetches during setup, login, startup, authenticating, etc.
        if (token && step === 'dashboard') {
            fetchJournals();
        }
    }, [token, step, fetchJournals]);

    useEffect(() => () => {
        if (refreshTimerRef.current) {
            clearTimeout(refreshTimerRef.current);
            refreshTimerRef.current = null;
        }
    }, []);

    // FolderStore and JournalStore broadcast through the system bridge. The
    // /api/journals payload includes both, so any folder rename/move/permission
    // change or journal entry/page mutation triggers a debounced re-fetch.
    useEffect(() => {
        if (!appSocket) return;
        const handleFolderChanged = () => { requestJournalsRefresh(); };
        const handleFolderListInvalidated = () => { requestJournalsRefresh(); };
        const invalidateJournalDetail = (journalId?: string) => {
            if (!journalId) {
                setJournalGlobalRevision(revision => revision + 1);
                return;
            }
            setJournalRevisions(revisions => ({
                ...revisions,
                [journalId]: (revisions[journalId] ?? 0) + 1,
            }));
        };
        const handleJournalChanged = (data: RealtimeJournalChangedPayload) => {
            invalidateJournalDetail(data.journalId);
            requestJournalsRefresh();
        };
        const handleJournalListInvalidated = (data: RealtimeJournalListInvalidatedPayload) => {
            invalidateJournalDetail(data.journalId);
            requestJournalsRefresh();
        };

        appSocket.on('folderChanged', handleFolderChanged);
        appSocket.on('folderListInvalidated', handleFolderListInvalidated);
        appSocket.on('journalChanged', handleJournalChanged);
        appSocket.on('journalListInvalidated', handleJournalListInvalidated);
        return () => {
            appSocket.off('folderChanged', handleFolderChanged);
            appSocket.off('folderListInvalidated', handleFolderListInvalidated);
            appSocket.off('journalChanged', handleJournalChanged);
            appSocket.off('journalListInvalidated', handleJournalListInvalidated);
        };
    }, [appSocket, requestJournalsRefresh]);

    const getJournal = useCallback(async (id: string) => {
        if (!token) return null;
        const key = `${token}:${id}`;
        let fetcher = detailFetchersRef.current.get(key);
        if (!fetcher) {
            fetcher = createCoalescedFetch<JournalEntry | null>(async () => {
                try {
                    return await journalApi.fetchJournalById(token, id);
                } catch (err) {
                    logger.error(`JournalProvider | Get detail failed for ${id}:`, err);
                    return null;
                }
            });
            detailFetchersRef.current.set(key, fetcher);
        }
        return (await fetcher()) ?? null;
    }, [token]);

    const createJournal = async (name: string, folderId?: string) => {
        try {
            await journalApi.createJournalEntry(token, name, folderId);
            await fetchJournals();
        } catch (err) {
            logger.error('JournalProvider | Create failed:', err);
        }
    };

    const updateJournal = async (id: string, data: Partial<JournalEntry>) => {
        try {
            await journalApi.updateJournalEntry(token, id, data);
            await fetchJournals();
        } catch (err) {
            logger.error(`JournalProvider | Update failed for ${id}:`, err);
        }
    };

    const updateJournalPage = async (
        journalId: string,
        pageId: string,
        data: Partial<JournalPageDto>,
    ) => {
        // Keep page writes on Foundry's embedded-document path. The resulting
        // JournalEntryPage event invalidates the parent journal detail.
        await journalApi.updateJournalPage(token, journalId, pageId, data);
    };

    const deleteJournal = async (id: string) => {
        try {
            await journalApi.deleteJournalEntry(token, id);
            await fetchJournals();
        } catch (err) {
            logger.error(`JournalProvider | Delete failed for ${id}:`, err);
        }
    };

    const createFolder = async (name: string, parentId?: string) => {
        try {
            await journalApi.createJournalFolder(token, name, parentId);
            await fetchJournals();
        } catch (err) {
            logger.error('JournalProvider | Create folder failed:', err);
        }
    };

    return (
        <JournalContext.Provider value={{
            journals, folders, loading, error, journalRevisions, journalGlobalRevision,
            fetchJournals, getJournal, createJournal, updateJournal, updateJournalPage,
            deleteJournal, createFolder
        }}>
            {children}
        </JournalContext.Provider>
    );
}

export const useJournal = () => {
    const context = useContext(JournalContext);
    if (!context) throw new Error('useJournal must be used within a JournalProvider');
    return context;
};
