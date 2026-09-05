import { createElement, Fragment, useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ComponentType } from 'react';
import { useSDK, useSDKComponents } from './react';
import { processHtmlContent } from './utils';
import type { DocumentSnapshot, ClientDocumentMutations } from './client-documents';
import type { FoundryActor, ModuleSettingDeclaration } from './interfaces';

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

/** Props a presentational module `Sheet` receives. The module writes the view; the host owns mechanics. */
export interface ActorSheetProps<TActor = FoundryActor> {
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

/** The controller returned by `useActorSheet` — actor-focused (load/roll/update/refresh). */
export interface UseActorSheetResult<TActor = FoundryActor> {
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
 * Actor-focused sheet controller (decision 16). Reads the actor through the host cache,
 * and centralizes the roll/update mechanics modules used to hand-roll (rollMode + speaker
 * defaults, html notifications) so a module ships only a presentational `Sheet`.
 */
export function useActorSheet<TActor = FoundryActor>(
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
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type, key, options: rollOptions }),
            });
            const data = await res.json();
            if (data.success) {
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
export function createActorPage<TActor = FoundryActor>(
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
                'This character is no longer available.',
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
