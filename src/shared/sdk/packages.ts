/** Native Foundry packages observed in the current world, not SheetDelver modules. */
export interface FoundryPackageDescriptor {
    id: string;
    title: string;
    version: string | null;
    kind: 'system' | 'module';
    enabled: boolean | null;
    /** Presence describes a declaration, not executable browser-hook support. */
    capabilities: { compendiumArt: boolean };
    /** Request/browser snapshots contain only packs readable by that caller. */
    packs: Array<{ id: string; label: string; type: string }>;
}

export type FoundryPackageSnapshot =
    | { status: 'ready'; worldId: string; revision: number; system: FoundryPackageDescriptor; modules: FoundryPackageDescriptor[] }
    | { status: 'unavailable'; reason: 'not-ready' | 'incomplete-metadata' };

export interface FoundryPackageContext {
    /** Immutable metadata; performs no transport or filesystem scans. */
    snapshot(): Readonly<FoundryPackageSnapshot>;
}

export type CompendiumArtworkKind = 'image' | 'token';
export type CompendiumArtworkResult =
    | { status: 'resolved'; src: string; packageId: string; credit?: string }
    | { status: 'none' }
    | { status: 'unavailable'; reason: 'not-ready' | 'unsupported-version' | 'not-visible' | 'invalid-reference' | 'invalid-configuration' | 'asset-unavailable' };

export interface CompendiumArtworkReader {
    /** Exact Compendium UUID only. Image means Actor portrait or Item image.
     * Does not change source img/prototypeToken, hydrate packs, or execute scripts.
     */
    resolve(uuid: string, kind?: CompendiumArtworkKind): Promise<CompendiumArtworkResult>;
}
