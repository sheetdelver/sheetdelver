// ADR-0014 captures Foundry v13's non-document world-state contract. Keep these
// shapes broad at the edges (`unknown` + index signatures) so the Store can type
// the fields Sheet Delver reads without pretending to own every Foundry detail.
export type JsonObject = Record<string, unknown>;

export interface FoundryCompatibility {
    minimum?: string;
    verified?: string;
    maximum?: string;
    [key: string]: unknown;
}

export interface FoundryPackageRelationshipSet {
    systems?: unknown[];
    requires?: unknown[];
    recommends?: unknown[];
    conflicts?: unknown[];
    flags?: JsonObject;
    [key: string]: unknown;
}

export interface FoundryPackageMedia {
    type?: string;
    url?: string;
    thumbnail?: string;
    loop?: boolean;
    flags?: JsonObject;
    [key: string]: unknown;
}

export interface FoundryPackageLanguage {
    lang?: string;
    name?: string;
    path?: string;
    flags?: JsonObject;
    [key: string]: unknown;
}

export interface FoundryPackManifest {
    id?: string;
    name?: string;
    label?: string;
    path?: string;
    type?: string;
    entity?: string;
    documentName?: string;
    system?: string;
    ownership?: Record<string, unknown>;
    flags?: JsonObject;
    [key: string]: unknown;
}

export interface FoundryPackageBase {
    id?: string;
    title?: string;
    description?: string | null;
    authors?: unknown[];
    flags?: JsonObject;
    media?: FoundryPackageMedia[];
    version?: string | null;
    compatibility?: FoundryCompatibility;
    scripts?: unknown[];
    esmodules?: unknown[];
    styles?: unknown[];
    languages?: FoundryPackageLanguage[];
    packs?: FoundryPackManifest[];
    packFolders?: unknown[];
    relationships?: FoundryPackageRelationshipSet;
    socket?: boolean;
    protected?: boolean;
    exclusive?: boolean;
    persistentStorage?: boolean;
    [key: string]: unknown;
}

// World/system/module manifests share Foundry's package envelope, then add the
// fields Sheet Delver projects into status/routes and adapter bootstrap.
export interface WorldManifest extends FoundryPackageBase {
    id?: string;
    title?: string;
    system?: string;
    systemVersion?: string;
    background?: string | null;
    coreVersion?: string;
    lastPlayed?: string | null;
    nextSession?: string | null;
    playtime?: number;
}

export interface SystemManifest extends FoundryPackageBase {
    id?: string;
    title?: string;
    url?: string;
    manifest?: string;
    download?: string;
    grid?: JsonObject;
    documentTypes?: Record<string, string[]>;
    primaryTokenAttribute?: string | null;
    background?: string;
    worldBackground?: string;
    initiative?: string;
}

export interface ModuleManifest extends FoundryPackageBase {
    active?: boolean;
    manifest?: string;
    url?: string;
    download?: string;
}

export interface FoundryRelease {
    generation?: number;
    maxGeneration?: number;
    maxStableGeneration?: number;
    channel?: string;
    suffix?: string;
    build?: string;
    time?: string;
    node_version?: string;
    flags?: JsonObject;
    [key: string]: unknown;
}

export interface FoundryUpdate {
    type?: string;
    channel?: string;
    version?: string;
    [key: string]: unknown;
}

export interface ServerOptions {
    language?: string;
    port?: number;
    routePrefix?: string;
    updateChannel?: string;
    [key: string]: unknown;
}

export interface ServerAddresses {
    local?: string[];
    remote?: string;
    remoteIsAccessible?: boolean;
    [key: string]: unknown;
}

export interface FileStorage {
    storages?: JsonObject;
    s3?: unknown;
    [key: string]: unknown;
}

export interface PackageWarnings {
    world?: unknown[];
    system?: unknown[];
    modules?: Record<string, unknown[]>;
    [key: string]: unknown;
}

// v13 exposes schema models for all document families in `game.data.model`.
// The per-type schema bodies vary by system, so the keys are typed and values
// stay JSON-shaped.
export type SchemaModelTypeName =
    | 'ActiveEffect'
    | 'Actor'
    | 'ActorDelta'
    | 'Adventure'
    | 'AmbientLight'
    | 'AmbientSound'
    | 'Card'
    | 'Cards'
    | 'ChatMessage'
    | 'Combat'
    | 'Combatant'
    | 'CombatantGroup'
    | 'Drawing'
    | 'FogExploration'
    | 'Folder'
    | 'Item'
    | 'JournalEntry'
    | 'JournalEntryCategory'
    | 'JournalEntryPage'
    | 'Macro'
    | 'MeasuredTemplate'
    | 'Note'
    | 'Playlist'
    | 'PlaylistSound'
    | 'Region'
    | 'RegionBehavior'
    | 'RollTable'
    | 'Scene'
    | 'Setting'
    | 'TableResult'
    | 'Tile'
    | 'Token'
    | 'User'
    | 'Wall';

export type DocumentTypeModel = JsonObject;
export type SchemaModel = Partial<Record<SchemaModelTypeName, DocumentTypeModel>> & Record<string, DocumentTypeModel>;

export type SceneDataCache = Record<string, { background?: { src?: string }; [key: string]: unknown }>;

export interface ProbeWorldData {
    id?: string;
    title?: string;
    description?: string | null;
    [key: string]: unknown;
}

// Full Foundry `game.data` envelope. Primary documents are listed here because
// they exist on the wire, but ADR-0011 Stores own their canonical state; this
// Store's typed accessors focus on the residual non-document fields above.
export interface GameData {
    world?: WorldManifest;
    system?: SystemManifest;
    modules?: ModuleManifest[];
    release?: FoundryRelease;
    coreUpdate?: FoundryUpdate;
    systemUpdate?: FoundryUpdate;
    options?: ServerOptions;
    addresses?: ServerAddresses;
    files?: FileStorage;
    paused?: boolean;
    demoMode?: boolean;
    idleLogout?: boolean;
    packageWarnings?: PackageWarnings;
    template?: unknown;
    userId?: string;
    activeUsers?: unknown[];
    model?: SchemaModel;
    users?: unknown[];
    scenes?: unknown[];
    packs?: FoundryPackManifest[];
    actors?: unknown[];
    items?: unknown[];
    messages?: unknown[];
    folders?: unknown[];
    journal?: unknown[];
    combats?: unknown[];
    playlists?: unknown[];
    tables?: unknown[];
    macros?: unknown[];
    cards?: unknown[];
    settings?: unknown[];
    indices?: unknown[];
    [key: string]: unknown;
}
