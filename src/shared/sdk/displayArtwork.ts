import type { FoundryActor } from './interfaces';
import type { ModuleRequestRuntime, ReadonlyDocumentStore } from './runtime';

/** Presentation only. No source image, Actor or Token is changed. */
export interface DisplayArtworkContext {
    purpose: 'actor-card' | 'combat-portrait' | 'combat-token';
    actor: Readonly<FoundryActor>;
    /** Native relative image path; not the browser's expanded URL. */
    currentImage: string | null;
    imageSource: 'actor' | 'token' | 'combatant';
    /** Exact host-verified compendium Actor origin for an encounter-owned copy.
     * Does not imply access to the source pack or mutate Actor._stats. */
    compendiumSourceUuid?: string;
    /** Minimal display metadata, never a privileged Scene/ActorDelta dump. */
    token?: Readonly<{ id: string; actorLink: boolean; img: string | null }>;
}
export type DisplayArtworkRuntime = Pick<ModuleRequestRuntime, 'world' | 'packages' | 'artwork' | 'access' | 'compendium'> & {
    documents: ReadonlyDocumentStore;
    /** Abort optional work when Core retires the request or its deadline expires. */
    signal: AbortSignal;
};
export interface DisplayArtworkResult { src: string; credit?: string }
