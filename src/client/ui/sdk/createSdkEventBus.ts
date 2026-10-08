'use client';

import type { SdkEvents, SdkSignal, SdkSignalHandler, SdkSignalPayloads, DocumentChangeAction } from '@shared/sdk/events';

/**
 * Host-owned realtime signal bus (ADR-0027 decision 20).
 *
 * Maps the platform's socket events onto the stable SDK signal set and fans them out to
 * module subscribers. Modules call `SDK.events.on(...)`; they never touch the socket.
 * Combat changes ride `document:changed { type: 'Combat' }` like any other document.
 *
 * The bus is created **pure** (no side effects) so it can be memoized once and stay stable;
 * the socket is bound via `attach()` / `detach()` from an effect. Binding the socket inside
 * the constructor (in `useMemo`) was a render-time side effect: React can render a component
 * more than once before commit, so a discarded render's bus would bind the socket while the
 * committed bus — the one carrying subscribers — stayed unbound, silently dropping events.
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
    sceneChanged: { type: 'Scene', idField: 'sceneId' },
    settingChanged: { type: 'Setting', idField: 'settingId' },
};

// `<type>ListInvalidated` socket events → a `document:listInvalidated` signal.
const LIST_INVALIDATED_EVENTS: Record<string, string> = {
    actorListInvalidated: 'Actor',
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
    sceneListInvalidated: 'Scene',
    settingListInvalidated: 'Setting',
};

function extractId(payload: Record<string, unknown>, idField: string): string {
    return String(payload[idField] ?? payload.id ?? payload.documentId ?? '');
}

export interface SdkEventBus extends SdkEvents {
    /** Bind the bus to a socket. Replaces any previously attached socket. */
    attach(socket: SocketLike | null): void;
    /** Unbind from the current socket (keeps subscribers). */
    detach(): void;
    /** Tear down: detach the socket and drop all subscribers. */
    dispose(): void;
}

export function createSdkEventBus(): SdkEventBus {
    const listeners = new Map<SdkSignal, Set<(payload: unknown) => void>>();

    const emit = <S extends SdkSignal>(signal: S, payload: SdkSignalPayloads[S]) => {
        listeners.get(signal)?.forEach((handler) => {
            try { handler(payload); } catch { /* a module handler must not break the bus */ }
        });
    };

    // Socket → signal adapters for the currently attached socket.
    let socket: SocketLike | null = null;
    let socketHandlers: Array<[string, (...args: unknown[]) => void]> = [];
    // World identity survives transport re-attachment. Connectivity is not
    // world lifetime: a brief same-world outage must not dispose module state.
    let observedStatus = false;
    let retainedWorldId: string | null = null;
    let establishedWorld = false;

    const detach = () => {
        if (socket) {
            for (const [event, handler] of socketHandlers) socket.off(event, handler);
        }
        socketHandlers = [];
        socket = null;
    };

    const attach = (next: SocketLike | null) => {
        detach();
        socket = next;
        if (!socket) return;

        const bind = (event: string, handler: (payload: Record<string, unknown>) => void) => {
            const wrapped = (...args: unknown[]) => handler((args[0] ?? {}) as Record<string, unknown>);
            socketHandlers.push([event, wrapped]);
            socket!.on(event, wrapped);
        };

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

        // Every status reports link health. Only authenticated world identity
        // and definitive terminal state drive world lifecycle signals.
        bind('systemStatus', (payload) => {
            const connected = Boolean(payload.connected);
            const worldId = typeof payload.worldId === 'string' && payload.worldId
                ? payload.worldId : null;
            const authenticatedProjection = Object.prototype.hasOwnProperty.call(payload, 'worldId');
            const system = payload.system as { status?: string } | undefined;
            const terminal = system?.status === 'setup' || system?.status === 'closed';
            const ready = connected && payload.initialized !== false && system?.status === 'active';
            emit('connection:changed', { connected, worldId });

            if (terminal) {
                if (retainedWorldId && establishedWorld) {
                    emit('world:teardown', { worldId: retainedWorldId });
                }
                retainedWorldId = null;
                establishedWorld = false;
            } else if (authenticatedProjection && worldId) {
                if (retainedWorldId && retainedWorldId !== worldId && establishedWorld) {
                    emit('world:teardown', { worldId: retainedWorldId });
                }
                if (retainedWorldId !== worldId) {
                    const wasObserved = observedStatus;
                    retainedWorldId = worldId;
                    establishedWorld = ready;
                    if (ready && wasObserved) emit('world:ready', { worldId });
                } else if (ready && !establishedWorld) {
                    establishedWorld = true;
                    if (observedStatus) emit('world:ready', { worldId });
                }
            }
            observedStatus = true;
        });
    };

    return {
        on<S extends SdkSignal>(signal: S, handler: SdkSignalHandler<S>): () => void {
            let set = listeners.get(signal);
            if (!set) { set = new Set(); listeners.set(signal, set); }
            const erased = handler as (payload: unknown) => void;
            set.add(erased);
            return () => { set!.delete(erased); };
        },
        attach,
        detach,
        dispose() {
            detach();
            listeners.clear();
        },
    };
}
