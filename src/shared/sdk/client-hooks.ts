import { createElement, Fragment, useCallback, useEffect, useMemo, useSyncExternalStore, useState } from 'react';
import type { ModuleWorldSnapshot, WorldSettingResult } from './world';
import type { FoundryPackageSnapshot } from './packages';

/** Caller-filtered native package discovery. Presence never grants content access. */
export function useFoundryPackages(): Readonly<FoundryPackageSnapshot> {
    const { events, fetchWithAuth, worldId, moduleId, currentUser, isConnected } = useSDK();
    const userId = currentUser?.id;
    const role = currentUser?.role;
    const scope = JSON.stringify([worldId, moduleId, userId, role, isConnected]);
    const [state, setState] = useState<{ scope: string; snapshot: FoundryPackageSnapshot } | null>(null);
    useEffect(() => {
        let generation = 0;
        let retired = false;
        let controller: AbortController | undefined;
        const refresh = async () => {
            const request = ++generation;
            controller?.abort(); controller = new AbortController();
            setState(null);
            if (!worldId || !userId || !isConnected) return;
            try {
                const response = await fetchWithAuth('/api/module-packages', { cache: 'no-store', signal: controller.signal });
                if (!response.ok) throw Error('Package context unavailable');
                const snapshot = await response.json() as FoundryPackageSnapshot;
                if (!snapshot || !['ready', 'unavailable'].includes(snapshot.status)) throw Error('Invalid package context');
                if (retired || request !== generation || snapshot.status === 'ready' && snapshot.worldId !== worldId) return;
                setState({ scope, snapshot });
            } catch { if (!retired && request === generation) setState(null); }
        };
        void refresh();
        const disposers = [events.on('world:packagesChanged', () => { void refresh(); }),
            events.on('world:contextChanged', () => { void refresh(); }), events.on('world:ready', () => { void refresh(); }),
            events.on('world:teardown', () => { generation++; controller?.abort(); setState(null); })];
        return () => { retired = true; generation++; controller?.abort(); disposers.forEach(dispose => dispose()); };
    }, [scope, events, fetchWithAuth, worldId, userId, role, isConnected]);
    return state?.scope === scope ? state.snapshot : { status: 'unavailable', reason: 'not-ready' };
}

/** Authorized host snapshot; no localStorage defaults or native Setting documents. */
export function useWorldSetting(key: string): { result: WorldSettingResult; revision: number | null } {
    const { events, fetchWithAuth, worldId, moduleId, currentUser, isConnected } = useSDK();
    const scope = JSON.stringify([worldId, moduleId, currentUser?.id, currentUser?.role, isConnected, key]);
    const [state, setState] = useState<{ scope: string; result: WorldSettingResult; revision: number } | null>(null);
    useEffect(() => {
        let retired = false;
        let generation = 0;
        const refresh = async () => {
            const request = ++generation;
            try {
                if (!worldId || !currentUser || !isConnected) return;
                const response = await fetchWithAuth('/api/module-world-context', { cache: 'no-store' });
                if (!response.ok) throw new Error('World context unavailable');
                const snapshot = await response.json() as ModuleWorldSnapshot;
                if (retired || request !== generation || snapshot.identity.worldId !== worldId) return;
                setState({ scope, result: snapshot.settings[key] ?? { status: 'unavailable', reason: 'undeclared' }, revision: snapshot.identity.contextRevision });
            } catch {
                if (!retired && request === generation) setState(null);
            }
        };
        void refresh();
        const dispose = events.on('world:contextChanged', () => { void refresh(); });
        return () => { retired = true; generation += 1; dispose(); };
    }, [scope, events, fetchWithAuth, worldId, currentUser, isConnected, key]);
    return state?.scope === scope ? { result: state.result, revision: state.revision }
        : { result: { status: 'unavailable', reason: 'not-ready' }, revision: null };
}
import type { ComponentType } from 'react';
import { useSDK, useSDKComponents } from './react';
import { isPostedChatMessage } from '@shared/utils/postedChatMessage';
import { processHtmlContent } from './utils';
import type { DocumentSnapshot, ClientDocumentMutations } from './client-documents';
import type { ModuleSettingDeclaration, PreparedActorData } from './interfaces';

/**
 * Client data hooks (ADR-0027 decisions 16/17/25).
 *
 * These are the only module-facing data API. They are thin wrappers over the
 * host-owned cache on `useSDK().documents`: `useDocument` reads + subscribes a single
 * document (deduped across surfaces), `useDocumentMutation` exposes the typed write
 * surface, and `useActorSheet` is the actor-focused controller a presentational `Sheet`
 * consumes. Modules write presentation, not page mechanics.
 */

const EMPTY_SNAPSHOT: DocumentSnapshot = Object.freeze({ data: null, loading: false, notFound: false, error: null });

/** Read + subscribe to a single document by `type` + `id` (decision 17). */
export function useDocument<T = unknown>(type: string, id: string | null | undefined): DocumentSnapshot<T> {
    const { documents } = useSDK();

    const subscribe = useCallback(
        (onStoreChange: () => void) => (id ? documents.subscribe(type, id, onStoreChange) : () => {}),
        [documents, type, id],
    );
    const getSnapshot = useCallback(
        () => (id ? documents.getSnapshot<T>(type, id) : (EMPTY_SNAPSHOT as DocumentSnapshot<T>)),
        [documents, type, id],
    );

    const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

    useEffect(() => {
        if (id) void documents.refresh(type, id);
    }, [documents, type, id]);

    return snapshot;
}

/** Typed write surface for a document type (create/patch/delete + embedded) (decision 17). */
export function useDocumentMutation(type: string): ClientDocumentMutations {
    const { documents } = useSDK();
    return useMemo(() => documents.mutate(type), [documents, type]);
}

// ---------------------------------------------------------------------------
// Actor sheet SDK (decision 16)
// ---------------------------------------------------------------------------

/**
 * Props a presentational module `Sheet` receives. The default Actor type is the
 * authorization-bounded prepared revision; the module writes the view while the
 * host owns read, roll, update, and refresh mechanics.
 */
export interface ActorSheetProps<TActor = PreparedActorData> {
    actor: TActor;
    isOwner: boolean;
    foundryUrl?: string;
    onRoll: (type: string, key: string, options?: Record<string, unknown>) => Promise<void>;
    onUpdate: (path: string, value: unknown) => Promise<void>;
    refreshActor?: () => void;
}

/** Props the platform passes to an actor page surface. */
export interface ActorPageProps {
    actorId: string;
    token?: string | null;
}

/** The prepared-Actor controller returned by `useActorSheet` (load/roll/update/refresh). */
export interface UseActorSheetResult<TActor = PreparedActorData> {
    actor: TActor | null;
    loading: boolean;
    notFound: boolean;
    isOwner: boolean;
    foundryUrl?: string;
    refresh: () => void;
    roll: (type: string, key: string, options?: Record<string, unknown>) => Promise<void>;
    update: (path: string, value: unknown) => Promise<void>;
}

const ROLL_MODE_STORAGE_KEY = 'sheetdelver_roll_mode';

/**
 * Actor-focused sheet controller (decision 16). Reads the authorized prepared Actor through the host cache,
 * and centralizes the roll/update mechanics modules used to hand-roll (rollMode + speaker
 * defaults, html notifications) so a module ships only a presentational `Sheet`.
 */
export function useActorSheet<TActor = PreparedActorData>(
    actorId: string,
): UseActorSheetResult<TActor> {
    const { documents, fetchWithAuth, addNotification, foundryUrl } = useSDK();
    const snapshot = useDocument<Record<string, unknown> & { id?: string; name?: string; isOwner?: boolean; foundryUrl?: string }>('Actor', actorId);
    const actor = snapshot.data;
    const resolvedFoundryUrl = (actor?.foundryUrl as string | undefined) ?? foundryUrl ?? undefined;

    const refresh = useCallback(() => { void documents.refresh('Actor', actorId); }, [documents, actorId]);

    const roll = useCallback(async (type: string, key: string, options: Record<string, unknown> = {}) => {
        if (!actor) return;
        const storedMode = typeof window !== 'undefined' ? window.localStorage.getItem(ROLL_MODE_STORAGE_KEY) : null;
        const rollOptions = {
            ...options,
            rollMode: options.rollMode ?? storedMode ?? 'publicroll',
            speaker: options.speaker ?? { actor: actor.id, alias: actor.name },
        };
        try {
            const res = await fetchWithAuth(`/api/actors/${actor.id}/roll`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(typeof actor.worldContextRevision === 'number'
                    ? { 'X-SheetDelver-Context-Revision': String(actor.worldContextRevision) } : {}) },
                body: JSON.stringify({ type, key, options: rollOptions }),
            });
            const data = await res.json();
            if (data.success) {
                if (isPostedChatMessage(data.result)) return;
                if (data.html) addNotification(processHtmlContent(data.html, resolvedFoundryUrl ?? ''), 'success', { html: true });
                else if (data.result?.total !== undefined) addNotification(`Rolled ${data.label || 'Result'}: ${data.result.total}`, 'success');
            } else {
                addNotification('Roll failed: ' + (data.error ?? 'Unknown error'), 'error');
            }
        } catch (e) {
            addNotification('Error: ' + (e instanceof Error ? e.message : 'roll failed'), 'error');
        }
    }, [actor, fetchWithAuth, addNotification, resolvedFoundryUrl]);

    const update = useCallback(async (path: string, value: unknown) => {
        if (!actor?.id) return;
        try {
            await documents.mutate('Actor').patch(actor.id, { [path]: value });
        } catch (e) {
            addNotification('Error updating: ' + (e instanceof Error ? e.message : 'update failed'), 'error');
        }
    }, [actor, documents, addNotification]);

    return {
        actor: (actor as TActor | null) ?? null,
        loading: snapshot.loading,
        notFound: snapshot.notFound,
        isOwner: Boolean(actor?.isOwner ?? true),
        foundryUrl: resolvedFoundryUrl,
        refresh,
        roll,
        update,
    };
}

// ---------------------------------------------------------------------------
// Module settings (decision 21)
// ---------------------------------------------------------------------------

/** The `useModuleSettings` controller — get/set client settings persisted to localStorage. */
export interface ModuleSettings {
    /** Read a setting: stored value, else the schema default, else `fallback`. */
    get<T = unknown>(key: string, fallback?: T): T | undefined;
    /** Persist a setting and notify every consumer in the same namespace. */
    set<T = unknown>(key: string, value: T): void;
    /** Snapshot of all settings (schema defaults merged with stored values). */
    all(): Record<string, unknown>;
}

interface SettingsEntry {
    values: Record<string, unknown>;
    listeners: Set<() => void>;
}

// One reactive store per `worldId+moduleId` namespace so every consumer (e.g. a theme
// toggle and the layout reading the theme) observes the same value. Seeded from
// localStorage; `set` reassigns `values` (stable-snapshot contract) and notifies.
const settingsStores = new Map<string, SettingsEntry>();

function settingsEntryFor(ns: string): SettingsEntry {
    let entry = settingsStores.get(ns);
    if (!entry) {
        const values: Record<string, unknown> = {};
        if (typeof window !== 'undefined') {
            const prefix = `${ns}:`;
            for (let i = 0; i < window.localStorage.length; i++) {
                const k = window.localStorage.key(i);
                if (!k || !k.startsWith(prefix)) continue;
                const raw = window.localStorage.getItem(k);
                if (raw === null) continue;
                try { values[k.slice(prefix.length)] = JSON.parse(raw); } catch { /* skip */ }
            }
        }
        entry = { values, listeners: new Set() };
        settingsStores.set(ns, entry);
    }
    return entry;
}

function writeSetting(ns: string, key: string, value: unknown) {
    const entry = settingsEntryFor(ns);
    entry.values = { ...entry.values, [key]: value };
    if (typeof window !== 'undefined') {
        window.localStorage.setItem(`${ns}:${key}`, JSON.stringify(value));
    }
    entry.listeners.forEach((listener) => listener());
}

/**
 * Module-scoped client settings (decision 21). Values persist to localStorage namespaced
 * by the host-provided `worldId + moduleId`; `schema` (from `info.json` `settings`) seeds
 * defaults. The client counterpart to the server-side `DataStore` (decision 12); replaces
 * ad-hoc per-module localStorage.
 */
export function useModuleSettings(schema?: ModuleSettingDeclaration[]): ModuleSettings {
    const { worldId, moduleId } = useSDK();
    const ns = `sheetdelver:settings:${worldId ?? 'global'}:${moduleId ?? 'unknown'}`;
    const entry = settingsEntryFor(ns);

    const subscribe = useCallback((onStoreChange: () => void) => {
        entry.listeners.add(onStoreChange);
        return () => { entry.listeners.delete(onStoreChange); };
    }, [entry]);
    const values = useSyncExternalStore(subscribe, () => entry.values, () => entry.values);

    const defaults = useMemo(() => {
        const out: Record<string, unknown> = {};
        for (const decl of schema ?? []) {
            if (decl.default !== undefined) out[decl.key] = decl.default;
        }
        return out;
    }, [schema]);

    return useMemo<ModuleSettings>(() => ({
        get: <T,>(key: string, fallback?: T) =>
            (key in values ? values[key] : (key in defaults ? defaults[key] : fallback)) as T | undefined,
        set: (key, value) => writeSetting(ns, key, value),
        all: () => ({ ...defaults, ...values }),
    }), [values, defaults, ns]);
}

/**
 * Wrap a presentational `Sheet` into a full actor page surface (decision 16). Handles
 * load / not-found through the platform components; the module owns only the visual sheet.
 * A module may instead ship a custom `actorPage` as the escape hatch.
 */
export function createActorPage<TActor = PreparedActorData>(
    Sheet: ComponentType<ActorSheetProps<TActor>>,
): ComponentType<ActorPageProps> {
    function PlatformActorPage({ actorId }: ActorPageProps) {
        const { LoadingModal, SharedContentModal } = useSDKComponents();
        const sheet = useActorSheet<TActor>(actorId);

        if (sheet.loading && !sheet.actor) {
            return createElement(LoadingModal, { message: 'Loading...' });
        }
        if (sheet.notFound || !sheet.actor) {
            return createElement(
                'div',
                { className: 'p-8 text-center text-white' },
                sheet.notFound
                    ? 'This character is no longer available.'
                    : 'This character is temporarily unavailable.',
            );
        }
        // The platform host owns shared-content presentation (GM image/journal shares),
        // so modules don't re-implement it (ADR-0027 Phase 3 — restore via the host).
        return createElement(
            Fragment,
            null,
            createElement(Sheet, {
                actor: sheet.actor,
                isOwner: sheet.isOwner,
                foundryUrl: sheet.foundryUrl,
                onRoll: sheet.roll,
                onUpdate: sheet.update,
                refreshActor: sheet.refresh,
            }),
            createElement(SharedContentModal, {}),
        );
    }
    PlatformActorPage.displayName = 'PlatformActorPage';
    return PlatformActorPage;
}
