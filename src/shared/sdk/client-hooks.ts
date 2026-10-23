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
import { createModuleSettingsStore, moduleSettingsValues } from './module-settings-store';

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

/** Browser preferences in the existing world/module namespace (shared by same-browser accounts). */
export interface ModuleSettings {
    get<T = unknown>(key: string, fallback?: T): T | undefined;
    /** Validates schema-backed values; throws on invalid values or failed persistence. */
    set<T = unknown>(key: string, value: T): void;
    all(): Record<string, unknown>;
    /** Remove only declared overrides; omitted keys means this schema's keys. Throws on failure. */
    reset(keys?: readonly string[]): void;
    /** Read/storage failure, for inline presentation. Mutations also throw. */
    error: Error | null;
}

const settingsStores = new Map<string, ReturnType<typeof createModuleSettingsStore>>();
function moduleSettingsStore(ns: string) {
    let store = settingsStores.get(ns);
    if (!store) {
        store = createModuleSettingsStore(ns, () => typeof window === 'undefined' ? undefined : window.localStorage);
        settingsStores.set(ns, store);
    }
    return store;
}

export function useModuleSettings(schema?: ModuleSettingDeclaration[]): ModuleSettings {
    const { worldId, moduleId } = useSDK();
    const ns = `sheetdelver:settings:${worldId ?? 'global'}:${moduleId ?? 'unknown'}`;
    const store = moduleSettingsStore(ns);
    const subscribe = useCallback((onStoreChange: () => void) => {
        const dispose = store.subscribe(onStoreChange);
        const changed = (event: StorageEvent) => {
            if (event.key === null || event.key.startsWith(`${ns}:`)) store.read();
        };
        window.addEventListener('storage', changed);
        store.read(); // Include changes made while no consumer was mounted.
        return () => { dispose(); window.removeEventListener('storage', changed); };
    }, [store, ns]);
    const snapshot = useSyncExternalStore(subscribe, store.getSnapshot, store.getSnapshot);
    const values = useMemo(() => moduleSettingsValues(snapshot.values, schema), [snapshot.values, schema]);
    return useMemo<ModuleSettings>(() => ({
        get: <T,>(key: string, fallback?: T) => (Object.hasOwn(values, key) ? values[key] : fallback) as T | undefined,
        set: (key, value) => store.set(key, value, schema),
        all: () => ({ ...values }),
        reset: keys => store.reset(keys, schema),
        error: snapshot.error,
    }), [values, schema, store, snapshot.error]);
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
