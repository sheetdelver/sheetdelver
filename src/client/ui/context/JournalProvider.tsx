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
    JournalListPayload,
} from '@shared/contracts/journals';

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
    fetchJournals: () => Promise<void>;
    getJournal: (id: string) => Promise<JournalEntry | null>;
    createJournal: (name: string, folderId?: string) => Promise<void>;
    updateJournal: (id: string, data: Partial<JournalEntry>) => Promise<void>;
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
    const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const fetchInFlightRef = useRef<Promise<void> | null>(null);

    const fetchJournals = useCallback(async () => {
        if (!token) return;
        if (fetchInFlightRef.current) return fetchInFlightRef.current;
        setLoading(true);
        const request = (async () => {
            try {
                const data = await journalApi.fetchJournals(token);
                setJournals(data.journals || []);
                setFolders(data.folders || []);
            } catch (err: any) {
                if (err instanceof UnauthorizedApiError) {
                    return;
                }
                logger.error('JournalProvider | Fetch failed:', err);
                setError(err.message);
            } finally {
                setLoading(false);
            }
        })();
        fetchInFlightRef.current = request;
        request.finally(() => {
            if (fetchInFlightRef.current === request) {
                fetchInFlightRef.current = null;
            }
        });
        return request;
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
        const handleJournalChanged = () => { requestJournalsRefresh(); };
        const handleJournalListInvalidated = () => { requestJournalsRefresh(); };

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
        try {
            return await journalApi.fetchJournalById(token, id);
        } catch (err) {
            logger.error(`JournalProvider | Get detail failed for ${id}:`, err);
            return null;
        }
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
            journals, folders, loading, error,
            fetchJournals, getJournal, createJournal, updateJournal, deleteJournal, createFolder
        }}>
            {children}
        </JournalContext.Provider>
    );
}

export const useJournals = () => {
    const context = useContext(JournalContext);
    if (!context) throw new Error('useJournals must be used within a JournalProvider');
    return context;
};
