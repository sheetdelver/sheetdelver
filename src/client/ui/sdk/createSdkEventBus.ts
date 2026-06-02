'use client';

import type { SdkEvents, SdkSignal, SdkSignalHandler, SdkSignalPayloads, DocumentChangeAction } from '@shared/sdk';

/**
 * Host-owned realtime signal bus (ADR-0027 decision 20).
 *
 * Maps the platform's socket events onto the stable SDK signal set and fans them out to
 * module subscribers. Modules call `SDK.events.on(...)`; they never touch the socket.
 * Combat changes ride `document:changed { type: 'Combat' }` like any other document.
 */

type SocketLike = {
    on(event: string, handler: (...args: unknown[]) => void): void;
    off(event: string, handler: (...args: unknown[]) => void): void;
};

// `<type>Changed` socket events → a `document:changed` signal with the canonical type
// and the payload's id field.
const CHANGED_EVENTS: Record<string, { type: string; idField: string }> = {
    actorChanged: { type: 'Actor', idField: 'actorId' },
    combatChanged: { type: 'Combat', idField: 'combatId' },
    itemChanged: { type: 'Item', idField: 'itemId' },
    chatMessageChanged: { type: 'ChatMessage', idField: 'messageId' },
    journalChanged: { type: 'JournalEntry', idField: 'journalId' },
    folderChanged: { type: 'Folder', idField: 'folderId' },
    userChanged: { type: 'User', idField: 'userId' },
    rollTableChanged: { type: 'RollTable', idField: 'rollTableId' },
    macroChanged: { type: 'Macro', idField: 'macroId' },
    playlistChanged: { type: 'Playlist', idField: 'playlistId' },
    cardsChanged: { type: 'Cards', idField: 'cardsId' },
};

// `<type>ListInvalidated` socket events → a `document:listInvalidated` signal.
const LIST_INVALIDATED_EVENTS: Record<string, string> = {
    combatListInvalidated: 'Combat',
    itemListInvalidated: 'Item',
    chatMessageListInvalidated: 'ChatMessage',
    journalListInvalidated: 'JournalEntry',
    folderListInvalidated: 'Folder',
    userListInvalidated: 'User',
    rollTableListInvalidated: 'RollTable',
    macroListInvalidated: 'Macro',
    playlistListInvalidated: 'Playlist',
    cardsListInvalidated: 'Cards',
};

function extractId(payload: Record<string, unknown>, idField: string): string {
    return String(payload[idField] ?? payload.id ?? payload.documentId ?? '');
}

export function createSdkEventBus(socket: SocketLike | null): SdkEvents & { dispose: () => void } {
    const listeners = new Map<SdkSignal, Set<(payload: unknown) => void>>();

    const emit = <S extends SdkSignal>(signal: S, payload: SdkSignalPayloads[S]) => {
        listeners.get(signal)?.forEach((handler) => {
            try { handler(payload); } catch { /* a module handler must not break the bus */ }
        });
    };

    // Socket → signal adapters, registered once and torn down on dispose.
    const socketHandlers: Array<[string, (...args: unknown[]) => void]> = [];
    const bind = (event: string, handler: (payload: Record<string, unknown>) => void) => {
        const wrapped = (...args: unknown[]) => handler((args[0] ?? {}) as Record<string, unknown>);
        socketHandlers.push([event, wrapped]);
        socket?.on(event, wrapped);
    };

    if (socket) {
        for (const [event, { type, idField }] of Object.entries(CHANGED_EVENTS)) {
            bind(event, (payload) => emit('document:changed', {
                type,
                id: extractId(payload, idField),
                action: (payload.action as DocumentChangeAction) ?? 'update',
            }));
        }
        for (const [event, type] of Object.entries(LIST_INVALIDATED_EVENTS)) {
            bind(event, (payload) => emit('document:listInvalidated', {
                type,
                reason: String(payload.reason ?? 'invalidated'),
            }));
        }
        bind('sharedContentUpdate', (payload) => emit('content:shared', {
            kind: (payload.type as 'image' | 'journal' | null) ?? null,
            data: payload.data as Record<string, unknown> | undefined,
        }));

        // World/connection lifecycle from the status stream. Transitions of `connected`
        // surface as world:ready / world:teardown; every status emits connection:changed.
        let lastConnected: boolean | null = null;
        bind('systemStatus', (payload) => {
            const connected = Boolean(payload.connected);
            const worldId = (payload.worldId as string | null) ?? null;
            emit('connection:changed', { connected, worldId });
            if (lastConnected !== null && connected !== lastConnected) {
                emit(connected ? 'world:ready' : 'world:teardown', { worldId });
            }
            lastConnected = connected;
        });
    }

    return {
        on<S extends SdkSignal>(signal: S, handler: SdkSignalHandler<S>): () => void {
            let set = listeners.get(signal);
            if (!set) { set = new Set(); listeners.set(signal, set); }
            const erased = handler as (payload: unknown) => void;
            set.add(erased);
            return () => { set!.delete(erased); };
        },
        dispose() {
            for (const [event, handler] of socketHandlers) socket?.off(event, handler);
            socketHandlers.length = 0;
            listeners.clear();
        },
    };
}
