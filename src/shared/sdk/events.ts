/**
 * Module-facing realtime signal bus (ADR-0027 decision 20).
 *
 * `SDK.events.on(signal, handler)` replaces the actor-only `onActorChanged`. The host
 * owns the subscriptions (it maps the platform's socket events onto this stable signal
 * set); modules never touch raw sockets. A `Combat` is a primary document, so combat
 * turn/round changes ride `document:changed { type: 'Combat' }` — there is no per-type
 * special-casing.
 */

export type SdkSignal =
    | 'world:ready'
    | 'world:teardown'
    | 'connection:changed'
    | 'module:initialized'
    | 'module:disposed'
    | 'document:changed'
    | 'document:listInvalidated'
    | 'content:shared';

export type DocumentChangeAction = 'create' | 'update' | 'delete';

/** Payload shape per signal. */
export interface SdkSignalPayloads {
    'world:ready': { worldId: string | null };
    'world:teardown': { worldId: string | null };
    'connection:changed': { connected: boolean; worldId: string | null };
    'module:initialized': { moduleId: string };
    'module:disposed': { moduleId: string };
    'document:changed': { type: string; id: string; action: DocumentChangeAction };
    'document:listInvalidated': { type: string; reason: string };
    'content:shared': { kind: 'image' | 'journal' | null; data?: Record<string, unknown> };
}

export type SdkSignalHandler<S extends SdkSignal> = (payload: SdkSignalPayloads[S]) => void;

/**
 * The host-owned event bus exposed on `SDKContextValue.events`. `on` registers a handler
 * for a signal and returns an unsubscribe function (React effect-cleanup friendly).
 */
export interface SdkEvents {
    on<S extends SdkSignal>(signal: S, handler: SdkSignalHandler<S>): () => void;
}
