export interface CompendiumPackMetadata {
    id?: string;
    _id?: string;
    name?: string;
    label?: string;
    title?: string;
    type?: string;
    entity?: string;
    documentName?: string;
    packageName?: string;
    source?: string;
    moduleId?: string;
    [key: string]: unknown;
}

export interface CompendiumIndexEntry {
    _id?: string;
    id?: string;
    uuid?: string;
    name?: string;
    type?: string;
    img?: string;
    [key: string]: unknown;
}

export interface CompendiumIndexOptions {
    fields?: readonly string[] | null;
}

export interface CompendiumIndexVariant {
    fieldKey: string;
    fields: string[] | null;
    index: CompendiumIndexEntry[];
    updatedAt: number;
}

export interface CompendiumPackIndexSnapshot {
    id: string;
    metadata: CompendiumPackMetadata;
    variant: CompendiumIndexVariant;
}

export interface CompendiumDiscoveryResult {
    id: string;
    metadata: CompendiumPackMetadata;
    index: CompendiumIndexEntry[];
    fields?: readonly string[] | null;
}

export interface CompendiumIndexLookupResult {
    packId: string;
    documentId: string;
    type: string | null;
    metadata: CompendiumPackMetadata;
    entry: CompendiumIndexEntry;
    fieldKey: string;
}

export interface DiscoveryShardManifestEntry {
    id: string;
    hash: string;
    lastUpdated: number;
    rowCount: number;
    hydrate?: boolean;
    fields?: string[];
}

export interface DiscoveryShardManifest {
    systemId: string;
    packs: Record<string, DiscoveryShardManifestEntry>;
    _instanceId: string;
}
