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
import { worldStateStore, type WorldStateStore } from '@server/core/world/WorldStateStore';
import {
    discoveryShardStore,
    type DiscoveryShardStore,
} from '@server/core/compendium/DiscoveryShardStore';
import type { CompendiumService } from '@server/services/compendium/CompendiumService';

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

export interface DocumentStoreReader {
    isReady(): boolean;
    get(id: string): unknown | null | undefined;
}

export type DocumentResolverStoreMap = Partial<Record<DocumentStoreKey, DocumentStoreReader>>;

export interface DocumentResolverCompendiumService {
    getPackDocument(packId: string, documentId: string, type?: string | null): Promise<Record<string, unknown> | null>;
}

export interface DocumentResolverDeps {
    documentStores?: DocumentResolverStoreMap;
    worldStateStore?: WorldStateStore;
    discoveryShardStore?: DiscoveryShardStore;
    getCompendiumService?: () => DocumentResolverCompendiumService | Pick<CompendiumService, 'getPackDocument'> | null;
}

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

function parsePairs(parts: string[]): UuidPathSegment[] | null {
    if (parts.length % 2 !== 0) return null;

    const pairs: UuidPathSegment[] = [];
    for (let i = 0; i < parts.length; i += 2) {
        pairs.push({ type: parts[i], id: parts[i + 1] });
    }
    return pairs;
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
    private readonly worldState: WorldStateStore;
    private readonly discoveryShards: DiscoveryShardStore;
    private readonly getCompendiumService?: DocumentResolverDeps['getCompendiumService'];

    public constructor(deps: DocumentResolverDeps = {}) {
        this.documentStores = {
            ...defaultDocumentStores(),
            ...(deps.documentStores || {}),
        };
        this.worldState = deps.worldStateStore || worldStateStore;
        this.discoveryShards = deps.discoveryShardStore || discoveryShardStore;
        this.getCompendiumService = deps.getCompendiumService;
    }

    public parse(uuid: string): ParsedDocumentUuid | null {
        return parseDocumentUuid(uuid);
    }

    public async fetchByUuid(uuid: string): Promise<unknown | null> {
        void this.parse(uuid);
        void this.documentStores;
        void this.worldState;
        void this.discoveryShards;
        void this.getCompendiumService;
        // ADR-0016 Phase 1 only establishes the parser and service home.
        // Store-backed, embedded, and compendium resolution land in later phases.
        return null;
    }
}
