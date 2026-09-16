import { EventEmitter } from 'node:events';
import { actorStore, type ActorStore } from '@server/core/documents/primary/actors/ActorStore';
import {
    cloneDocument,
    type ChangeAction,
    type DocumentChangedEvent,
} from '@server/core/documents/primary/base/PrimaryDocumentStore';
import type { DocumentAudience } from '@server/core/documents/primary/base/audience';
import type { ActorDocument } from '@server/shared/types/actors';
import type {
    ActorPreparationContext,
    ActorSheetData,
    FoundryActor,
    PreparedActorData,
    SystemAdapter,
} from '@shared/sdk';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';
import { logger } from '@shared/utils/logger';

export interface PreparedActorStoreContext {
    worldEpoch: number;
    systemId: string;
    systemVersion?: string;
    moduleId?: string;
    moduleVersion?: string;
}

export interface PreparedActorDiagnostic {
    code: 'PREPARATION_FAILED';
    message: string;
}

interface PreparedActorEntryBase {
    actorId: string;
    worldEpoch: number;
    sourceRevision: number;
    systemId: string;
    systemVersion?: string;
    moduleId?: string;
    moduleVersion?: string;
}

export interface ReadyPreparedActorEntry extends PreparedActorEntryBase {
    status: 'ready';
    data: PreparedActorData;
}

export interface FailedPreparedActorEntry extends PreparedActorEntryBase {
    status: 'failed';
    diagnostic: PreparedActorDiagnostic;
}

export type PreparedActorEntry = ReadyPreparedActorEntry | FailedPreparedActorEntry;

export interface PreparedActorChangedEvent {
    actorId: string;
    action: ChangeAction;
    audience: DocumentAudience;
    sourceRevision: number;
    status: PreparedActorEntry['status'] | 'deleted';
}

export interface PreparedActorRebuildResult {
    prepared: number;
    failed: number;
}

export class PreparedActorUnavailableError extends Error {
    public readonly code = 'PREPARED_ACTOR_UNAVAILABLE';

    public constructor(
        public readonly actorId: string,
        public readonly diagnostic?: PreparedActorDiagnostic,
    ) {
        super(diagnostic?.message ?? `Prepared Actor ${actorId} is unavailable`);
        this.name = 'PreparedActorUnavailableError';
    }
}

/**
 * Revisioned, user-invariant Actor model derived from ActorStore source data
 * (ADR-0038). Source authorization remains in ActorStore; this store owns only
 * deterministic preparation and clone-safe reads.
 */
export class PreparedActorStore extends EventEmitter {
    private entries = new Map<string, PreparedActorEntry>();
    private sourceRevisions = new Map<string, number>();
    private sourceStore: ActorStore | null = null;
    private adapter: SystemAdapter | null = null;
    private context: PreparedActorStoreContext | null = null;
    private ready = false;

    private readonly onSourceChanged = (event: DocumentChangedEvent): void => {
        const sourceRevision = (this.sourceRevisions.get(event.id) ?? 0) + 1;
        this.sourceRevisions.set(event.id, sourceRevision);

        if (event.action === 'delete') {
            this.entries.delete(event.id);
            this.emitChanged(event, sourceRevision, 'deleted');
            return;
        }

        const entry = this.prepareOne(event.id, sourceRevision);
        this.emitChanged(event, sourceRevision, entry.status);
    };

    public bind(sourceStore: ActorStore): void {
        if (this.sourceStore === sourceStore) return;
        if (this.sourceStore) {
            this.sourceStore.off('documentChanged', this.onSourceChanged);
        }
        this.sourceStore = sourceStore;
        sourceStore.on('documentChanged', this.onSourceChanged);
    }

    public configure(adapter: SystemAdapter | null, context: PreparedActorStoreContext): void {
        this.adapter = adapter;
        this.context = Object.freeze({ ...context });
        this.entries.clear();
        this.sourceRevisions.clear();
        this.ready = false;
    }

    /** Bulk build after adapter initialization. Like source seeding, it is silent. */
    public rebuildAll(): PreparedActorRebuildResult {
        this.assertConfigured();
        this.entries.clear();
        this.sourceRevisions.clear();

        let prepared = 0;
        let failed = 0;
        for (const actor of this.sourceStore?.list() ?? []) {
            const actorId = getActorId(actor);
            if (!actorId) continue;
            const sourceRevision = 1;
            this.sourceRevisions.set(actorId, sourceRevision);
            const entry = this.prepareSource(actor, sourceRevision);
            this.entries.set(actorId, entry);
            if (entry.status === 'ready') prepared += 1;
            else failed += 1;
        }

        this.ready = true;
        return { prepared, failed };
    }

    public rebuild(actorId: string): PreparedActorEntry | null {
        this.assertConfigured();
        const actor = this.sourceStore?.get(actorId) ?? null;
        if (!actor) {
            this.entries.delete(actorId);
            this.sourceRevisions.delete(actorId);
            return null;
        }
        const sourceRevision = (this.sourceRevisions.get(actorId) ?? 0) + 1;
        this.sourceRevisions.set(actorId, sourceRevision);
        return this.prepareOne(actorId, sourceRevision);
    }

    public clear(_reason?: string): void {
        this.entries.clear();
        this.sourceRevisions.clear();
        this.adapter = null;
        this.context = null;
        this.ready = false;
    }

    public isReady(): boolean {
        return this.ready;
    }

    public get(actorId: string): PreparedActorData | null {
        const entry = this.entries.get(actorId);
        return entry?.status === 'ready' ? cloneDocument(entry.data) : null;
    }

    public getRequired(actorId: string): PreparedActorData {
        const entry = this.entries.get(actorId);
        if (entry?.status === 'ready') return cloneDocument(entry.data);
        throw new PreparedActorUnavailableError(
            actorId,
            entry?.status === 'failed' ? cloneDocument(entry.diagnostic) : undefined,
        );
    }

    public getEntry(actorId: string): PreparedActorEntry | null {
        const entry = this.entries.get(actorId);
        return entry ? cloneDocument(entry) : null;
    }

    public list(): PreparedActorData[] {
        return Array.from(this.entries.values())
            .filter((entry): entry is ReadyPreparedActorEntry => entry.status === 'ready')
            .map(entry => cloneDocument(entry.data));
    }

    private prepareOne(actorId: string, sourceRevision: number): PreparedActorEntry {
        const source = this.sourceStore?.get(actorId) ?? null;
        if (!source) {
            this.entries.delete(actorId);
            throw new PreparedActorUnavailableError(actorId);
        }
        const entry = this.prepareSource(source, sourceRevision);
        this.entries.set(actorId, entry);
        return entry;
    }

    private prepareSource(actor: ActorDocument, sourceRevision: number): PreparedActorEntry {
        const context = this.assertConfigured();
        const actorId = getActorId(actor);
        if (!actorId) throw new Error('Cannot prepare an Actor without an id');
        const metadata: PreparedActorEntryBase = {
            actorId,
            worldEpoch: context.worldEpoch,
            sourceRevision,
            systemId: context.systemId,
            systemVersion: context.systemVersion,
            moduleId: context.moduleId,
            moduleVersion: context.moduleVersion,
        };

        try {
            const source = toFoundryActor(actor, actorId);
            const preparationContext: ActorPreparationContext = Object.freeze({
                ...context,
                sourceRevision,
            });
            const data = this.prepareWithAdapter(source, preparationContext);
            if (data._id !== actorId || data.id !== actorId) {
                throw new Error(`Actor preparer changed identity for ${actorId}`);
            }
            return { ...metadata, status: 'ready', data: cloneDocument(data) };
        } catch (error) {
            const message = getErrorMessage(error).slice(0, 500);
            logger.warn('PreparedActorStore | Actor preparation failed', {
                actorId,
                sourceRevision,
                systemId: context.systemId,
                message,
            });
            return {
                ...metadata,
                status: 'failed',
                diagnostic: { code: 'PREPARATION_FAILED', message },
            };
        }
    }

    private prepareWithAdapter(
        actor: FoundryActor,
        context: Readonly<ActorPreparationContext>,
    ): PreparedActorData {
        if (this.adapter?.prepareActorData) {
            return normalizePreparedActor(actor, this.adapter.prepareActorData(cloneDocument(actor), context));
        }

        const normalized = this.adapter?.normalizeActorData(cloneDocument(actor))
            ?? defaultActorSheetData(actor);
        const derived = this.adapter?.computeActorData?.(cloneDocument(normalized)) ?? {};
        return normalizePreparedActor(actor, {
            ...actor,
            ...normalized,
            _id: actor._id,
            id: normalized.id || actor._id,
            derived: { ...(normalized.derived ?? {}), ...derived },
        });
    }

    private assertConfigured(): PreparedActorStoreContext {
        if (!this.sourceStore) throw new Error('PreparedActorStore is not bound to an ActorStore');
        if (!this.context) throw new Error('PreparedActorStore is not configured');
        return this.context;
    }

    private emitChanged(
        event: DocumentChangedEvent,
        sourceRevision: number,
        status: PreparedActorChangedEvent['status'],
    ): void {
        const preparedEvent: PreparedActorChangedEvent = {
            actorId: event.id,
            action: event.action,
            audience: event.audience,
            sourceRevision,
            status,
        };
        this.emit('preparedActorChanged', preparedEvent);
    }
}

function getActorId(actor: ActorDocument): string | null {
    return actor._id || actor.id || null;
}

function toFoundryActor(actor: ActorDocument, actorId: string): FoundryActor {
    return {
        ...cloneDocument(actor),
        _id: actorId,
        name: actor.name ?? '',
        type: actor.type ?? '',
        img: actor.img ?? null,
        system: isRecord(actor.system) ? cloneDocument(actor.system) : {},
        items: (actor.items ?? []).map(item => ({
            ...cloneDocument(item),
            _id: item._id || item.id || '',
            name: item.name ?? '',
            type: item.type ?? '',
            img: item.img ?? null,
            system: item.system ?? {},
            parent: actorId,
        })),
    };
}

function defaultActorSheetData(actor: FoundryActor): ActorSheetData {
    return {
        id: actor._id,
        name: actor.name,
        type: actor.type,
        img: actor.img ?? '',
        system: actor.system ?? {},
        items: actor.items ?? [],
        effects: actor.effects ?? [],
        derived: {},
    };
}

function normalizePreparedActor(
    source: FoundryActor,
    prepared: PreparedActorData,
): PreparedActorData {
    return {
        ...source,
        ...prepared,
        _id: source._id,
        id: prepared.id || source._id,
        name: prepared.name || source.name,
        type: prepared.type || source.type,
        img: prepared.img || source.img || '',
        system: prepared.system ?? source.system ?? {},
        items: prepared.items ?? source.items ?? [],
        effects: prepared.effects ?? source.effects ?? [],
        derived: prepared.derived ?? {},
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const preparedActorStore = new PreparedActorStore();
preparedActorStore.bind(actorStore);
