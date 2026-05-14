import { EventEmitter } from 'node:events';
import type { RawActor, RawItem } from '@server/shared/types/actors';
import {
    cloneDocument,
    getDocumentId,
    type PrimaryDocumentStore,
} from '../base/PrimaryDocumentStore';
import {
    DOCUMENT_VISIBILITY,
    getEffectiveOwnership,
    type DocumentAccessSubject,
    type DocumentOwnershipMap,
    type ResolvedDocumentOwnershipLevel,
} from '../base/ownership';

export type ActorMutationAction = 'create' | 'update' | 'delete' | 'get';

export type ActorStoreEvent =
    | { type: 'actorChanged'; actorId: string; action: Exclude<ActorMutationAction, 'get'> }
    | { type: 'actorListInvalidated'; reason: string; actorId?: string; targetUserIds?: string[] };

type ActorStoreListener = (event: ActorStoreEvent) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
    for (const [key, value] of Object.entries(source)) {
        if (key.includes('.')) {
            const parts = key.split('.');
            let current = target;
            for (let i = 0; i < parts.length - 1; i += 1) {
                const part = parts[i];
                if (!isRecord(current[part])) current[part] = {};
                current = current[part] as Record<string, unknown>;
            }
            current[parts[parts.length - 1]] = value;
            continue;
        }

        if (isRecord(value) && isRecord(target[key]) && !Array.isArray(value)) {
            deepMerge(target[key] as Record<string, unknown>, value);
        } else {
            target[key] = value;
        }
    }
    return target;
}

function stableJson(value: unknown): string {
    return JSON.stringify(value);
}

export class ActorStore extends EventEmitter implements PrimaryDocumentStore<RawActor> {
    public readonly documentType = 'Actor';
    private documents = new Map<string, RawActor>();
    private ready = false;
    private staleDocumentIds = new Set<string>();

    public async seed(loader: () => Promise<RawActor[]>): Promise<void> {
        const actors = await loader();
        this.documents.clear();
        for (const actor of actors) {
            const id = getDocumentId(actor);
            if (id) this.documents.set(id, cloneDocument(actor));
        }
        this.staleDocumentIds.clear();
        this.ready = true;
    }

    public clear(_reason?: string): void {
        this.documents.clear();
        this.staleDocumentIds.clear();
        this.ready = false;
    }

    public isReady(): boolean {
        return this.ready;
    }

    public list(): RawActor[] {
        return Array.from(this.documents.values(), actor => cloneDocument(actor));
    }

    public get(documentId: string): RawActor | null {
        const actor = this.documents.get(documentId);
        return actor ? cloneDocument(actor) : null;
    }

    public listActors(options: {
        subject: DocumentAccessSubject;
        minOwnership?: ResolvedDocumentOwnershipLevel;
    }): RawActor[] {
        return this.list().filter(actor => this.canReadActorByDocument(
            actor,
            options.subject,
            options.minOwnership ?? DOCUMENT_VISIBILITY.LIST_VISIBLE,
        ));
    }

    public getActor(
        actorId: string,
        options: {
            subject: DocumentAccessSubject;
            minOwnership?: ResolvedDocumentOwnershipLevel;
        },
    ): RawActor | null {
        const actor = this.documents.get(actorId);
        if (!actor) return null;
        if (!this.canReadActorByDocument(
            actor,
            options.subject,
            options.minOwnership ?? DOCUMENT_VISIBILITY.DETAIL_VISIBLE,
        )) {
            return null;
        }
        return cloneDocument(actor);
    }

    public canReadActor(
        actorId: string,
        subject: DocumentAccessSubject,
        minOwnership: ResolvedDocumentOwnershipLevel = DOCUMENT_VISIBILITY.DETAIL_VISIBLE,
    ): boolean {
        const actor = this.documents.get(actorId);
        return actor ? this.canReadActorByDocument(actor, subject, minOwnership) : false;
    }

    public upsert(document: RawActor): void {
        const id = getDocumentId(document);
        if (!id) return;
        this.documents.set(id, cloneDocument(document));
    }

    public patch(documentId: string, diff: Record<string, unknown>): void {
        const existing = this.documents.get(documentId);
        if (!existing) {
            this.markStale(documentId, 'patch-miss');
            return;
        }
        deepMerge(existing as Record<string, unknown>, diff);
        this.documents.set(documentId, existing);
    }

    public delete(documentId: string): void {
        this.documents.delete(documentId);
        this.staleDocumentIds.delete(documentId);
    }

    public markStale(documentId?: string, _reason?: string): void {
        if (documentId) this.staleDocumentIds.add(documentId);
        else this.ready = false;
    }

    public applyModifyDocument(
        type: string,
        action: ActorMutationAction,
        result: unknown,
        operation?: Record<string, unknown>,
    ): void {
        if (type === 'Actor') {
            this.applyActorChange(action, result, operation);
        } else if (type === 'Item') {
            this.applyEmbeddedItemChangeFromResult(action, result, operation);
        } else if (type === 'ActiveEffect') {
            this.applyEmbeddedEffectChangeFromResult(action, result, operation);
        }
    }

    public onActorStoreEvent(listener: ActorStoreListener): void {
        this.on('actorStoreEvent', listener);
    }

    public offActorStoreEvent(listener: ActorStoreListener): void {
        this.off('actorStoreEvent', listener);
    }

    private canReadActorByDocument(
        actor: RawActor,
        subject: DocumentAccessSubject,
        minOwnership: ResolvedDocumentOwnershipLevel,
    ): boolean {
        const ownership = actor.ownership as DocumentOwnershipMap | undefined;
        return getEffectiveOwnership(ownership, subject) >= minOwnership;
    }

    private applyActorChange(
        action: ActorMutationAction,
        result: unknown,
        operation?: Record<string, unknown>,
    ): void {
        const docs = this.toDocumentArray(result);
        if (action === 'delete') {
            const ids = this.getOperationIds(operation, docs);
            for (const id of ids) {
                const existed = this.documents.delete(id);
                this.staleDocumentIds.delete(id);
                if (existed) this.emitChanged(id, 'delete');
            }
            return;
        }

        for (const actor of docs) {
            const id = getDocumentId(actor);
            if (!id) continue;
            const existing = this.documents.get(id);
            if (existing && action === 'update') {
                const before = stableJson(existing);
                deepMerge(existing as Record<string, unknown>, actor as Record<string, unknown>);
                this.documents.set(id, existing);
                if (stableJson(existing) !== before) this.emitChanged(id, 'update');
            } else if (action === 'update') {
                this.markStale(id, 'actor-update-miss');
            } else {
                const before = existing ? stableJson(existing) : null;
                this.documents.set(id, cloneDocument(actor));
                if (action === 'create' && stableJson(actor) !== before) this.emitChanged(id, 'create');
            }
        }
    }

    private applyEmbeddedItemChangeFromResult(
        action: ActorMutationAction,
        result: unknown,
        operation?: Record<string, unknown>,
    ): void {
        const actorId = this.getActorIdFromOperation(operation);
        if (!actorId) return;
        const actor = this.documents.get(actorId);
        if (!actor) return;
        const before = stableJson(actor);

        const docs = this.toDocumentArray<RawItem>(result);
        actor.items = actor.items || [];

        if (action === 'delete') {
            const ids = this.getOperationIds(operation, docs);
            actor.items = actor.items.filter(item => {
                const id = getDocumentId(item);
                return !id || !ids.includes(id);
            });
        } else if (action === 'update') {
            for (const item of docs) {
                const itemId = getDocumentId(item);
                const index = actor.items.findIndex(existing => getDocumentId(existing) === itemId);
                if (index >= 0) {
                    deepMerge(actor.items[index] as Record<string, unknown>, item as Record<string, unknown>);
                }
            }
        } else if (action === 'create') {
            actor.items.push(...docs.map(item => cloneDocument(item)));
        }

        this.documents.set(actorId, actor);
        if (action !== 'get' && stableJson(actor) !== before) this.emitChanged(actorId, 'update');
    }

    private applyEmbeddedEffectChangeFromResult(
        action: ActorMutationAction,
        result: unknown,
        operation?: Record<string, unknown>,
    ): void {
        const parentUuid = typeof operation?.parentUuid === 'string' ? operation.parentUuid : '';
        const parts = parentUuid.split('.');
        if (parts[0] !== 'Actor') return;

        const actorId = parts[1];
        const actor = this.documents.get(actorId);
        if (!actor) return;
        const before = stableJson(actor);

        if (parts.length >= 4 && parts[2] === 'Item') {
            const itemId = parts[3];
            const item = actor.items?.find(existing => getDocumentId(existing) === itemId);
            if (!item) return;
            item.effects = this.applyEffectArray(item.effects, action, result, operation);
        } else {
            const actorRecord = actor as RawActor & { effects?: unknown[] };
            actorRecord.effects = this.applyEffectArray(actorRecord.effects, action, result, operation);
        }

        this.documents.set(actorId, actor);
        if (action !== 'get' && stableJson(actor) !== before) this.emitChanged(actorId, 'update');
    }

    private applyEffectArray(
        current: unknown[] | undefined,
        action: ActorMutationAction,
        result: unknown,
        operation?: Record<string, unknown>,
    ): unknown[] {
        const effects = [...(current || [])];
        const docs = this.toDocumentArray<Record<string, unknown>>(result);

        if (action === 'delete') {
            const ids = this.getOperationIds(operation, docs);
            return effects.filter(effect => {
                const id = isRecord(effect) ? getDocumentId(effect) : null;
                return !id || !ids.includes(id);
            });
        }

        if (action === 'update') {
            for (const effect of docs) {
                const effectId = getDocumentId(effect);
                const index = effects.findIndex(existing => isRecord(existing) && getDocumentId(existing) === effectId);
                if (index >= 0 && isRecord(effects[index])) {
                    deepMerge(effects[index] as Record<string, unknown>, effect);
                }
            }
            return effects;
        }

        if (action === 'create') {
            return [...effects, ...docs.map(effect => cloneDocument(effect))];
        }

        return effects;
    }

    private getActorIdFromOperation(operation?: Record<string, unknown>): string | null {
        if (typeof operation?.parentId === 'string') return operation.parentId;
        if (typeof operation?.parentUuid !== 'string') return null;

        const parts = operation.parentUuid.split('.');
        if (parts[0] === 'Actor') return parts[1] || null;
        return null;
    }

    private getOperationIds<TDocument extends { id?: string; _id?: string }>(
        operation: Record<string, unknown> | undefined,
        docs: TDocument[],
    ): string[] {
        if (Array.isArray(operation?.ids)) return operation.ids.filter((id): id is string => typeof id === 'string');
        return docs.map(doc => getDocumentId(doc)).filter((id): id is string => Boolean(id));
    }

    private toDocumentArray<TDocument extends { id?: string; _id?: string } = RawActor>(result: unknown): TDocument[] {
        if (!result) return [];
        if (Array.isArray(result)) return result.filter(isRecord) as TDocument[];
        if (isRecord(result)) return [result as TDocument];
        return [];
    }

    private emitChanged(actorId: string, action: Exclude<ActorMutationAction, 'get'>): void {
        this.emit('actorStoreEvent', { type: 'actorChanged', actorId, action } satisfies ActorStoreEvent);
    }
}

export const actorStore = new ActorStore();
