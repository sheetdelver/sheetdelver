import { actorStore } from '@server/core/documents/primary/actors/ActorStore';
import { itemStore } from '@server/core/documents/primary/items/ItemStore';
import { chatMessageStore } from '@server/core/documents/primary/chat-messages/ChatMessageStore';
import { folderStore } from '@server/core/documents/primary/folders/FolderStore';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import { journalStore } from '@server/core/documents/primary/journals/JournalStore';
import { combatStore } from '@server/core/documents/primary/combats/CombatStore';
import { rollTableStore } from '@server/core/documents/primary/roll-tables/RollTableStore';
import { macroStore } from '@server/core/documents/primary/macros/MacroStore';
import { playlistStore } from '@server/core/documents/primary/playlists/PlaylistStore';
import { cardsStore } from '@server/core/documents/primary/cards/CardsStore';
import { sceneStore } from '@server/core/documents/primary/scenes/SceneStore';
import { fogExplorationStore } from '@server/core/documents/primary/fog-explorations/FogExplorationStore';
import { adventureStore } from '@server/core/documents/primary/adventures/AdventureStore';
import { settingStore } from '@server/core/documents/primary/settings/SettingStore';
import { worldStateStore } from '@server/core/world/WorldStateStore';
import { discoveryShardStore, type DiscoveryShardDocument } from '@server/core/compendium/DiscoveryShardStore';
import {
    cloneDocument,
    getDocumentId,
    isRecord,
} from '@server/core/documents/primary/base/PrimaryDocumentStore';
import { PrimaryDocumentCacheNotReadyError } from '@server/core/documents/primary/errors';
import type { CompendiumService } from '@server/services/compendium/CompendiumService';
import type { DiscoveryShardManifest } from '@server/core/compendium/types';
import { logger } from '@shared/utils/logger';

// DocumentResolver is the service-layer owner for UUID routing. Callers ask for
// a UUID; this service decides which Store/service owns the bytes. Socket
// classes should not grow parsing or fallback policy from this point forward.

// Compendium UUIDs may include an optional document type segment before the id:
// `Compendium.vendor.pack.Item.item-id`. Only known core pack document types are
// peeled off here; unknown capitalized segments remain part of the pack id.
export const COMPENDIUM_DOCUMENT_TYPES = [
    'Item',
    'Actor',
    'JournalEntry',
    'RollTable',
    'Scene',
    'Macro',
    'Playlist',
    'Cards',
] as const;

export type CompendiumDocumentType = typeof COMPENDIUM_DOCUMENT_TYPES[number];

export interface UuidPathSegment {
    type: string;
    id: string;
}

export interface ParsedWorldUuid {
    kind: 'world';
    raw: string;
    documentType: string;
    documentId: string;
}

export interface ParsedEmbeddedWorldUuid {
    kind: 'embedded-world';
    raw: string;
    root: UuidPathSegment;
    path: UuidPathSegment[];
}

export interface ParsedCompendiumUuid {
    kind: 'compendium';
    raw: string;
    packId: string;
    documentId: string;
    type: CompendiumDocumentType | null;
}

export type ParsedDocumentUuid = ParsedWorldUuid | ParsedEmbeddedWorldUuid | ParsedCompendiumUuid;

export type DocumentStoreKey =
    | 'Actor'
    | 'Item'
    | 'ChatMessage'
    | 'Folder'
    | 'User'
    | 'JournalEntry'
    | 'Combat'
    | 'RollTable'
    | 'Macro'
    | 'Playlist'
    | 'Cards'
    | 'Scene'
    | 'FogExploration'
    | 'Adventure'
    | 'Setting';

// These world document types are fully hydrated in primary-document Stores.
// A direct UUID such as `Actor.<id>` can be answered from the Store snapshot.
const STORE_BACKED_WORLD_DOCUMENT_TYPES = [
    'Actor',
    'Item',
    'ChatMessage',
    'Folder',
    'User',
    'JournalEntry',
    'Combat',
    'RollTable',
    'Macro',
    'Playlist',
    'Cards',
] as const satisfies readonly DocumentStoreKey[];

// These Stores exist as shape placeholders, but their seeding and visibility
// rules are not established yet. Keep them fail-closed until that work lands.
const DEFERRED_WORLD_DOCUMENT_TYPES = [
    'Scene',
    'FogExploration',
    'Adventure',
    'Setting',
] as const satisfies readonly DocumentStoreKey[];

// Embedded resolution follows the same ownership direction as embedded Store
// mutations: read the parent document from its Store, then walk child arrays
// on that defensive snapshot. No socket fallback is involved here.
const EMBEDDED_COLLECTIONS_BY_PARENT: Record<string, Record<string, string>> = {
    Actor: {
        Item: 'items',
        ActiveEffect: 'effects',
    },
    Item: {
        ActiveEffect: 'effects',
    },
    JournalEntry: {
        JournalEntryPage: 'pages',
    },
    Combat: {
        Combatant: 'combatants',
    },
    Playlist: {
        PlaylistSound: 'sounds',
    },
    Cards: {
        Card: 'cards',
    },
};
// RollTableResult is intentionally absent. Result rows are part of the
// `RollTable.<id>` payload used by draw simulation, not standalone UUID targets.

export interface DocumentStoreReader {
    isReady(): boolean;
    get(id: string): unknown | null | undefined;
}

export type DocumentResolverStoreMap = Partial<Record<DocumentStoreKey, DocumentStoreReader>>;

export interface DocumentResolverCompendiumService {
    getPackDocument(packId: string, documentId: string, type?: string | null): Promise<Record<string, unknown> | null>;
}

export interface DocumentResolverWorldStateReader {
    getSystem(): { id?: string | null } | null;
}

export interface DocumentResolverDiscoveryShardReader {
    getManifest(systemId: string): Promise<DiscoveryShardManifest | null>;
    findDocument(
        systemId: string,
        packId: string,
        documentId: string,
        type?: string | null,
    ): Promise<DiscoveryShardDocument | null>;
}

export interface DocumentResolverDeps {
    documentStores?: DocumentResolverStoreMap;
    worldStateStore?: DocumentResolverWorldStateReader;
    discoveryShardStore?: DocumentResolverDiscoveryShardReader;
    getCompendiumService?: () => DocumentResolverCompendiumService | Pick<CompendiumService, 'getPackDocument'> | null;
    allowLiveCompendiumUuidFallback?: boolean;
}

type HydratedShardLookupResult =
    | { status: 'hit'; document: Record<string, unknown>; systemId: string }
    | { status: 'no-system' }
    | { status: 'no-manifest'; systemId: string }
    | { status: 'undeclared-pack'; systemId: string }
    | { status: 'not-hydrated'; systemId: string }
    | { status: 'missing-document'; systemId: string };

function normalizeUuid(uuid: string): string[] | null {
    const normalized = String(uuid || '').trim();
    if (!normalized) return null;

    const parts = normalized.split('.').map(part => part.trim());
    if (parts.some(part => part.length === 0)) return null;
    return parts;
}

function isCompendiumDocumentType(value: string): value is CompendiumDocumentType {
    return COMPENDIUM_DOCUMENT_TYPES.includes(value as CompendiumDocumentType);
}

function isStoreBackedWorldDocumentType(value: string): value is DocumentStoreKey {
    return STORE_BACKED_WORLD_DOCUMENT_TYPES.includes(value as typeof STORE_BACKED_WORLD_DOCUMENT_TYPES[number]);
}

function isDeferredWorldDocumentType(value: string): value is DocumentStoreKey {
    return DEFERRED_WORLD_DOCUMENT_TYPES.includes(value as typeof DEFERRED_WORLD_DOCUMENT_TYPES[number]);
}

function parsePairs(parts: string[]): UuidPathSegment[] | null {
    if (parts.length % 2 !== 0) return null;

    const pairs: UuidPathSegment[] = [];
    for (let i = 0; i < parts.length; i += 2) {
        pairs.push({ type: parts[i], id: parts[i + 1] });
    }
    return pairs;
}

function findEmbeddedChild(parent: unknown, parentType: string, child: UuidPathSegment): unknown | null {
    if (!isRecord(parent)) return null;

    // The child type is only valid under the current parent type. For example,
    // `Actor.<id>.Item.<id>.ActiveEffect.<id>` is valid because Actor -> Item
    // and Item -> ActiveEffect are both declared in the map above.
    const collectionKey = EMBEDDED_COLLECTIONS_BY_PARENT[parentType]?.[child.type];
    if (!collectionKey) return null;

    const collection = parent[collectionKey];
    if (!Array.isArray(collection)) return null;

    // Parent-local scan only: the resolver has already loaded the root Store
    // document by id. If a real payload makes this child-array scan expensive,
    // promote an embedded id index into that parent Store.
    const match = collection.find(entry => isRecord(entry) && getDocumentId(entry) === child.id);
    return match ? cloneDocument(match) : null;
}

function getActiveSystemId(worldState: DocumentResolverWorldStateReader): string | null {
    const systemId = worldState.getSystem()?.id;
    return typeof systemId === 'string' && systemId.trim() ? systemId : null;
}

export function parseWorldUuid(uuid: string): ParsedWorldUuid | ParsedEmbeddedWorldUuid | null {
    const parts = normalizeUuid(uuid);
    if (!parts || parts[0] === 'Compendium') return null;

    if (parts.length === 2) {
        return {
            kind: 'world',
            raw: parts.join('.'),
            documentType: parts[0],
            documentId: parts[1],
        };
    }

    const pairs = parsePairs(parts);
    if (!pairs || pairs.length < 2) return null;

    return {
        kind: 'embedded-world',
        raw: parts.join('.'),
        root: pairs[0],
        path: pairs.slice(1),
    };
}

export function parseCompendiumUuid(uuid: string): ParsedCompendiumUuid | null {
    const parts = normalizeUuid(uuid);
    if (!parts || parts[0] !== 'Compendium' || parts.length < 3) return null;

    const documentId = parts[parts.length - 1];
    const possibleType = parts[parts.length - 2];
    const hasType = isCompendiumDocumentType(possibleType);
    // Dotted pack ids are preserved by joining everything between `Compendium`
    // and the document id, minus the optional known type segment.
    const packParts = hasType ? parts.slice(1, -2) : parts.slice(1, -1);
    if (packParts.length === 0) return null;

    return {
        kind: 'compendium',
        raw: parts.join('.'),
        packId: packParts.join('.'),
        documentId,
        type: hasType ? possibleType : null,
    };
}

export function parseDocumentUuid(uuid: string): ParsedDocumentUuid | null {
    return parseCompendiumUuid(uuid) || parseWorldUuid(uuid);
}

function defaultDocumentStores(): DocumentResolverStoreMap {
    return {
        Actor: actorStore,
        Item: itemStore,
        ChatMessage: chatMessageStore,
        Folder: folderStore,
        User: userStore,
        JournalEntry: journalStore,
        Combat: combatStore,
        RollTable: rollTableStore,
        Macro: macroStore,
        Playlist: playlistStore,
        Cards: cardsStore,
        Scene: sceneStore,
        FogExploration: fogExplorationStore,
        Adventure: adventureStore,
        Setting: settingStore,
    };
}

export class DocumentResolver {
    private readonly documentStores: DocumentResolverStoreMap;
    private readonly worldState: DocumentResolverWorldStateReader;
    private readonly discoveryShards: DocumentResolverDiscoveryShardReader;
    private readonly getCompendiumService?: DocumentResolverDeps['getCompendiumService'];
    private readonly allowLiveCompendiumUuidFallback: boolean;

    public constructor(deps: DocumentResolverDeps = {}) {
        this.documentStores = {
            ...defaultDocumentStores(),
            ...(deps.documentStores || {}),
        };
        this.worldState = deps.worldStateStore || worldStateStore;
        this.discoveryShards = deps.discoveryShardStore || discoveryShardStore;
        this.getCompendiumService = deps.getCompendiumService;
        this.allowLiveCompendiumUuidFallback = deps.allowLiveCompendiumUuidFallback === true;
    }

    public parse(uuid: string): ParsedDocumentUuid | null {
        return parseDocumentUuid(uuid);
    }

    public async fetchByUuid(uuid: string): Promise<unknown | null> {
        const parsed = this.parse(uuid);
        if (!parsed) return null;

        // Dispatch by parsed UUID shape first. Each branch owns one lookup
        // strategy, which keeps socket transport fallbacks out of the resolver.
        if (parsed.kind === 'world') return this.resolveDirectWorldDocument(parsed);
        if (parsed.kind === 'embedded-world') return this.resolveEmbeddedWorldDocument(parsed);
        if (parsed.kind === 'compendium') return this.resolveCompendiumDocument(parsed);

        return null;
    }

    private resolveDirectWorldDocument(parsed: ParsedWorldUuid): unknown | null {
        return this.resolveStoreBackedWorldDocument(parsed.documentType, parsed.documentId);
    }

    private resolveStoreBackedWorldDocument(documentType: string, documentId: string): unknown | null {
        if (isDeferredWorldDocumentType(documentType)) {
            // These Stores are registered as primary-document stubs, but ADR-0016
            // does not resolve them until their seeding and visibility policy is
            // explicit. Returning null keeps the resolver fail-closed for now.
            return null;
        }

        if (!isStoreBackedWorldDocumentType(documentType)) return null;

        const store = this.documentStores[documentType];
        if (!store) return null;
        // Store readiness is part of the boundary contract: never silently fall
        // through to socket reads when bootstrap has not seeded the cache.
        if (!store.isReady()) throw new PrimaryDocumentCacheNotReadyError(documentType);
        return store.get(documentId) ?? null;
    }

    private resolveEmbeddedWorldDocument(parsed: ParsedEmbeddedWorldUuid): unknown | null {
        // Start from the root world document, then walk child arrays on the
        // defensive clone returned by the Store. This keeps embedded resolution
        // read-only and aligned with Store ownership.
        let current = this.resolveStoreBackedWorldDocument(parsed.root.type, parsed.root.id);
        if (!current) return null;

        let parentType = parsed.root.type;
        for (const child of parsed.path) {
            current = findEmbeddedChild(current, parentType, child);
            if (!current) return null;
            parentType = child.type;
        }

        return current;
    }

    private async resolveCompendiumDocument(parsed: ParsedCompendiumUuid): Promise<Record<string, unknown> | null> {
        const shardLookup = await this.resolveHydratedShardDocument(parsed);
        if (shardLookup.status === 'hit') return shardLookup.document;

        this.warnCompendiumShardMiss(parsed, shardLookup);

        if (!this.allowLiveCompendiumUuidFallback) return null;

        const service = this.getCompendiumService?.();
        if (!service) return null;

        try {
            logger.warn(
                `DocumentResolver | Live compendium UUID fallback enabled for ${parsed.raw} `
                + `(pack: ${parsed.packId}, document: ${parsed.documentId}, type: ${parsed.type || 'unknown'}). `
                + 'Update module discovery config so normal SDK reads come from a hydrated shard.',
            );
            return await service.getPackDocument(parsed.packId, parsed.documentId, parsed.type);
        } catch {
            return null;
        }
    }

    private async resolveHydratedShardDocument(
        parsed: ParsedCompendiumUuid,
    ): Promise<HydratedShardLookupResult> {
        const systemId = getActiveSystemId(this.worldState);
        if (!systemId) return { status: 'no-system' };

        const manifest = await this.discoveryShards.getManifest(systemId);
        if (!manifest) return { status: 'no-manifest', systemId };

        const packEntry = manifest?.packs?.[parsed.packId];
        // Only module-declared hydrated shards contain full document payloads.
        // Indexed shards may have enough shape for search, but not for fetchByUuid.
        if (!packEntry) return { status: 'undeclared-pack', systemId };
        if (!packEntry.hydrate) return { status: 'not-hydrated', systemId };

        const document = await this.discoveryShards.findDocument(
            systemId,
            parsed.packId,
            parsed.documentId,
            parsed.type,
        );
        return document
            ? { status: 'hit', document: cloneDocument(document), systemId }
            : { status: 'missing-document', systemId };
    }

    private warnCompendiumShardMiss(
        parsed: ParsedCompendiumUuid,
        lookup: Exclude<HydratedShardLookupResult, { status: 'hit' }>,
    ): void {
        const base =
            `DocumentResolver | Compendium UUID ${parsed.raw} was not served from a hydrated discovery shard `
            + `(pack: ${parsed.packId}, document: ${parsed.documentId}, type: ${parsed.type || 'unknown'})`;

        if (lookup.status === 'no-system') {
            logger.warn(`${base}: no active system id is available.`);
            return;
        }

        if (lookup.status === 'no-manifest') {
            logger.warn(`${base}: no discovery manifest for system ${lookup.systemId}.`);
            return;
        }

        if (lookup.status === 'undeclared-pack') {
            logger.warn(`${base}: pack is not declared for system ${lookup.systemId}.`);
            return;
        }

        if (lookup.status === 'not-hydrated') {
            logger.warn(`${base}: pack is declared for system ${lookup.systemId} but not hydrated.`);
            return;
        }

        logger.warn(`${base}: hydrated shard for system ${lookup.systemId} does not contain the document.`);
    }
}
