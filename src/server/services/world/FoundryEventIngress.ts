import type { EventEmitter } from 'node:events';
import { logger } from '@shared/utils/logger';
import { modifyDocumentRouter } from '@server/core/documents/primary/base/modifyDocumentRouter';
import {
    isPackScopedDocumentResult,
    normalizeFoundryDocumentResponse,
    type FoundryDocumentResponseFallback,
    type NormalizedFoundryDocumentResult,
} from '@server/core/foundry/sockets/FoundryDocumentResponse';
import { userPresence } from '@server/core/documents/primary/users/UserPresence';
import { sharedContentStore } from '@server/core/world/SharedContentStore';
import { worldStateStore } from '@server/core/world/WorldStateStore';
import { compendiumStore } from '@server/core/compendium';
import type { CompendiumPackMetadata } from '@server/core/compendium/types';
import { actorStore } from '@server/core/documents/primary/actors/ActorStore';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import { parseDocumentUuid, type ParsedDocumentUuid } from '@server/services/documents';
import type { RealtimeSharedContentPayload } from '@shared/contracts/realtime';
import type {
    FoundryAutosaveEvent,
    FoundryDocumentCompatibilityEvent,
    FoundryDocumentDispatchConfirmedEvent,
    FoundryManageCompendiumEvent,
    FoundryModifyDocumentEvent,
    FoundryModifyDocumentBatchEvent,
    FoundryShareImageEvent,
    FoundryShowEntryEvent,
    FoundryUserActivityEvent,
    FoundryUserConnectedEvent,
    FoundryUserDisconnectedEvent,
    FoundryRuntimeTeardownEvent,
} from '@server/core/foundry/sockets/FoundrySocketEvents';

interface FoundryEventIngressOptions {
    onStatusUpdate?: () => void;
}

type EventHandler = (...args: unknown[]) => void;
type UnknownRecord = Record<string, unknown>;

interface FoundryIngressTransport extends EventEmitter {
    emitSocketEvent?<T>(event: string, ...payloads: unknown[]): Promise<T>;
}

interface FoundryIngressCompendiumStore {
    setPackMetadata(packId: string, metadata: CompendiumPackMetadata): void;
    invalidatePackContent(
        systemId: string | null | undefined,
        packId: string,
        reason?: string,
    ): Promise<void>;
    removePack(
        systemId: string | null | undefined,
        packId: string,
        reason?: string,
    ): Promise<void>;
}

interface FoundryEventIngressDeps {
    routeDocument?: (...args: Parameters<typeof modifyDocumentRouter.route>) =>
        ReturnType<typeof modifyDocumentRouter.route> | void;
    compendiumStore?: FoundryIngressCompendiumStore;
    parseDocumentUuid?: (uuid: string) => ParsedDocumentUuid | null;
    getActiveSystemId?: () => string | null;
}

interface RootRefreshTarget {
    type: string;
    id: string;
}

interface RootRefreshState {
    dirty: boolean;
}

const ACTIVE_WORLD_ROOT_TYPES = new Set([
    'Actor',
    'ChatMessage',
    'Folder',
    'User',
    'JournalEntry',
    'Combat',
    'Item',
    'RollTable',
    'Macro',
    'Playlist',
    'Cards',
    'Scene',
    'Setting',
]);

export class FoundryEventIngress {
    private readonly routeDocumentResult: (...args: Parameters<typeof modifyDocumentRouter.route>) =>
        ReturnType<typeof modifyDocumentRouter.route> | void;
    private readonly packStore: FoundryIngressCompendiumStore;
    private readonly parseUuid: (uuid: string) => ParsedDocumentUuid | null;
    private readonly getActiveSystemId: () => string | null;
    private readonly rootRefreshes = new Map<string, RootRefreshState>();

    public constructor(deps: FoundryEventIngressDeps = {}) {
        this.routeDocumentResult = deps.routeDocument ?? modifyDocumentRouter.route.bind(modifyDocumentRouter);
        this.packStore = deps.compendiumStore ?? compendiumStore;
        this.parseUuid = deps.parseDocumentUuid ?? parseDocumentUuid;
        this.getActiveSystemId = deps.getActiveSystemId ?? (() => worldStateStore.getSystem()?.id || null);
    }

    public attach(source: FoundryIngressTransport, options: FoundryEventIngressOptions = {}): () => void {
        const handlers: Array<{ event: string; handler: EventHandler }> = [
            ['foundry:modifyDocument', (event: unknown) => this.routeDocumentResponse(
                event as FoundryModifyDocumentEvent,
                'broadcast-single',
            )],
            ['foundry:modifyDocumentBatch', (event: unknown) => this.routeDocumentResponse(
                event as FoundryModifyDocumentBatchEvent,
                'broadcast-batch',
            )],
            ['foundry:documentCompatibility', (event: unknown) => this.routeCompatibilityDocument(event as FoundryDocumentCompatibilityEvent, options)],
            ['foundry:documentDispatchConfirmed', (event: unknown) => this.routeDocumentResponse(
                event as FoundryDocumentDispatchConfirmedEvent,
                'dispatch-acknowledgement',
            )],
            ['foundry:pmAutosave', (event: unknown) => this.handleAutosave(
                event as FoundryAutosaveEvent,
                source,
            )],
            ['foundry:manageCompendium', (event: unknown) => this.handleManageCompendium(
                event as FoundryManageCompendiumEvent,
            )],
            ['foundry:userConnected', (event: unknown) => this.handleUserConnected(event as FoundryUserConnectedEvent, options)],
            ['foundry:userDisconnected', (event: unknown) => this.handleUserDisconnected(event as FoundryUserDisconnectedEvent, options)],
            ['foundry:userActivity', (event: unknown) => this.handleUserActivity(event as FoundryUserActivityEvent, options)],
            ['foundry:shareImage', (event: unknown) => this.handleShareImage(event as FoundryShareImageEvent)],
            ['foundry:showEntry', (event: unknown) => this.handleShowEntry(event as FoundryShowEntryEvent)],
            ['foundry:shutdown', () => options.onStatusUpdate?.()],
            ['foundry:reload', () => options.onStatusUpdate?.()],
            ['foundry:runtimeTeardown', (event: unknown) => this.handleRuntimeTeardown(event as FoundryRuntimeTeardownEvent)],
        ].map(([event, handler]) => ({ event: event as string, handler: handler as EventHandler }));

        for (const { event, handler } of handlers) {
            source.on(event, handler);
        }

        return () => {
            for (const { event, handler } of handlers) {
                source.off(event, handler);
            }
        };
    }

    private routeCompatibilityDocument(event: FoundryDocumentCompatibilityEvent, options: FoundryEventIngressOptions): void {
        this.routeDocumentResponse(event, 'compatibility-event');

        if (event.type === 'User' && event.action === 'delete') {
            const ids = (event.operation as { ids?: unknown } | undefined)?.ids;
            if (Array.isArray(ids)) {
                for (const id of ids) {
                    if (typeof id === 'string' && userPresence.delete(id)) {
                        options.onStatusUpdate?.();
                    }
                }
            }
        }
    }

    private routeDocumentResponse(
        event: FoundryModifyDocumentEvent | FoundryModifyDocumentBatchEvent | FoundryDocumentDispatchConfirmedEvent,
        origin: string,
    ): void {
        const eventRecord = this.toRecord(event);
        const response = eventRecord && Object.hasOwn(eventRecord, 'response')
            ? eventRecord.response
            : event;
        const explicitFallback = this.toRecord(eventRecord?.fallback);
        const fallback: FoundryDocumentResponseFallback = explicitFallback || {
            type: typeof eventRecord?.type === 'string' ? eventRecord.type : undefined,
            action: typeof eventRecord?.action === 'string' ? eventRecord.action : undefined,
            operation: eventRecord?.operation,
        };

        // Both v13 single responses and v14 single/batch responses enter this
        // one ordered loop. Side effects retain their wire position and never
        // borrow the initiating request's type/action fallback.
        const entries = normalizeFoundryDocumentResponse(response, fallback);
        for (const entry of entries) {
            if (!this.isRoutableEntry(entry, origin)) continue;

            if (isPackScopedDocumentResult(entry)) {
                this.invalidatePackEntry(entry, origin);
                continue;
            }

            const routeOutcome = this.routeDocumentResult({
                type: entry.type!,
                action: entry.action!,
                result: entry.result,
                operation: entry.operation,
            });
            logger.debug('FoundryEventIngress | Dispatched document response', {
                origin,
                source: entry.source,
                index: entry.index,
                type: entry.type,
                action: entry.action,
                sideEffect: entry.sideEffect,
                routeOutcome,
            });
        }
    }

    private isRoutableEntry(entry: NormalizedFoundryDocumentResult, origin: string): boolean {
        if (entry.malformedReason) {
            logger.warn('FoundryEventIngress | Rejected malformed document response', {
                origin,
                source: entry.source,
                index: entry.index,
                type: entry.type,
                action: entry.action,
                sideEffect: entry.sideEffect,
                reason: entry.malformedReason,
            });
            return false;
        }

        if (entry.error != null) {
            logger.warn('FoundryEventIngress | Rejected failed document response', {
                origin,
                source: entry.source,
                index: entry.index,
                type: entry.type,
                action: entry.action,
                sideEffect: entry.sideEffect,
                error: entry.error,
            });
            return false;
        }

        return true;
    }

    private invalidatePackEntry(entry: NormalizedFoundryDocumentResult, origin: string): void {
        const packId = typeof entry.operation?.pack === 'string' ? entry.operation.pack : null;
        if (!packId) {
            logger.warn('FoundryEventIngress | Rejected pack-scoped response without a string pack id', {
                origin,
                index: entry.index,
                type: entry.type,
                action: entry.action,
            });
            return;
        }

        // Pack reads are isolated from world Stores but do not make an already
        // hydrated shard stale. Only persisted mutations invalidate content.
        if (entry.action === 'get') return;
        void this.packStore.invalidatePackContent(
            this.getActiveSystemId(),
            packId,
            `${origin}:${entry.action}`,
        ).catch(error => {
            logger.error('FoundryEventIngress | Failed to invalidate compendium pack content', {
                origin,
                packId,
                error: error instanceof Error ? error.message : String(error),
            });
        });
    }

    private handleAutosave(event: FoundryAutosaveEvent, source: FoundryIngressTransport): void {
        const uuid = typeof event?.uuid === 'string' ? event.uuid : '';
        const fieldSeparator = uuid.indexOf('#');
        if (fieldSeparator <= 0 || fieldSeparator === uuid.length - 1) {
            logger.warn('FoundryEventIngress | Rejected malformed pm.autosave UUID', { uuid });
            return;
        }

        const documentUuid = uuid.slice(0, fieldSeparator);
        const parsed = this.parseUuid(documentUuid);
        if (!parsed) {
            logger.warn('FoundryEventIngress | Rejected unresolvable pm.autosave UUID', { uuid });
            return;
        }

        if (parsed.kind === 'compendium') {
            void this.packStore.invalidatePackContent(
                this.getActiveSystemId(),
                parsed.packId,
                'pm.autosave',
            ).catch(error => {
                logger.error('FoundryEventIngress | Failed to invalidate autosaved compendium pack', {
                    packId: parsed.packId,
                    error: error instanceof Error ? error.message : String(error),
                });
            });
            return;
        }

        const root = parsed.kind === 'world'
            ? { type: parsed.documentType, id: parsed.documentId }
            : { type: parsed.root.type, id: parsed.root.id };
        if (!ACTIVE_WORLD_ROOT_TYPES.has(root.type)) {
            logger.warn('FoundryEventIngress | Ignored autosave for unsupported world root', {
                uuid,
                rootType: root.type,
            });
            return;
        }

        if (typeof source.emitSocketEvent !== 'function') {
            logger.warn('FoundryEventIngress | Cannot refresh autosave root without a Foundry transport', {
                uuid,
                rootType: root.type,
                rootId: root.id,
            });
            return;
        }

        this.scheduleRootRefresh(root, source);
    }

    private scheduleRootRefresh(root: RootRefreshTarget, source: FoundryIngressTransport): void {
        const key = `${root.type}.${root.id}`;
        const existing = this.rootRefreshes.get(key);
        if (existing) {
            existing.dirty = true;
            return;
        }

        const state: RootRefreshState = { dirty: false };
        this.rootRefreshes.set(key, state);

        // An autosave that arrives during the read marks the root dirty. The
        // loop guarantees one trailing authoritative read before the key can
        // be considered current.
        void (async () => {
            try {
                do {
                    state.dirty = false;
                    await this.refreshRoot(root, source);
                } while (state.dirty);
            } catch (error) {
                logger.error('FoundryEventIngress | Autosave root refresh failed', {
                    rootType: root.type,
                    rootId: root.id,
                    error: error instanceof Error ? error.message : String(error),
                });
            } finally {
                if (this.rootRefreshes.get(key) === state) this.rootRefreshes.delete(key);
            }
        })();
    }

    private async refreshRoot(root: RootRefreshTarget, source: FoundryIngressTransport): Promise<void> {
        const operation = { ids: [root.id], broadcast: false };
        const response = await source.emitSocketEvent!<unknown>('modifyDocument', {
            type: root.type,
            action: 'get',
            operation,
        }, 5000);
        const entries = normalizeFoundryDocumentResponse(response, {
            type: root.type,
            action: 'get',
            operation,
        });

        let applied = false;
        for (const entry of entries) {
            if (!this.isRoutableEntry(entry, 'pm.autosave-refresh')) continue;
            if (isPackScopedDocumentResult(entry)) {
                this.invalidatePackEntry(entry, 'pm.autosave-refresh');
                continue;
            }

            // A targeted get returns the authoritative full root. Apply it as
            // an update so Store comparison emits the invalidation that the
            // autosave event itself does not carry.
            this.routeDocumentResult({
                type: root.type,
                action: 'update',
                result: entry.result,
                operation,
            });
            applied = true;
        }

        if (!applied) {
            logger.warn('FoundryEventIngress | Autosave root refresh returned no routable document', {
                rootType: root.type,
                rootId: root.id,
            });
        }
    }

    private handleManageCompendium(event: FoundryManageCompendiumEvent): void {
        const eventRecord = this.toRecord(event);
        const response = this.toRecord(
            eventRecord && Object.hasOwn(eventRecord, 'response')
                ? eventRecord.response
                : event,
        );
        const request = this.toRecord(response?.request);
        const action = typeof request?.action === 'string' ? request.action : null;
        const systemId = this.getActiveSystemId();

        if (action === 'create') {
            const metadata = this.toRecord(response?.result);
            const packId = this.readPackId(metadata);
            if (!metadata || !packId) {
                logger.warn('FoundryEventIngress | Rejected malformed compendium create response', {
                    action,
                    result: response?.result,
                });
                return;
            }

            // The server result is authoritative pack metadata in both v13
            // and v14. Keep it visible in the catalog while invalidating any
            // prior shard which happened to use the same collection id.
            this.packStore.setPackMetadata(packId, {
                ...metadata,
                id: packId,
            });
            void this.packStore.invalidatePackContent(systemId, packId, 'manageCompendium:create')
                .catch(error => {
                    logger.error('FoundryEventIngress | Failed to invalidate created compendium pack', {
                        packId,
                        error: error instanceof Error ? error.message : String(error),
                    });
                });
            return;
        }

        if (action === 'delete') {
            const packId = this.readPackId(response?.result)
                || this.readPackId(request?.data);
            if (!packId) {
                logger.warn('FoundryEventIngress | Rejected malformed compendium delete response', {
                    action,
                    result: response?.result,
                });
                return;
            }

            void this.packStore.removePack(systemId, packId, 'manageCompendium:delete')
                .catch(error => {
                    logger.error('FoundryEventIngress | Failed to remove deleted compendium pack', {
                        packId,
                        error: error instanceof Error ? error.message : String(error),
                    });
                });
            return;
        }

        logger.warn('FoundryEventIngress | Ignored unsupported compendium lifecycle response', {
            action,
        });
    }

    private readPackId(value: unknown): string | null {
        if (typeof value === 'string' && value.trim()) return value.trim();
        const record = this.toRecord(value);
        if (!record) return null;

        for (const key of ['id', '_id', 'collection']) {
            const candidate = record[key];
            if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
        }

        const name = typeof record.name === 'string' ? record.name.trim() : '';
        const packageName = typeof record.packageName === 'string'
            ? record.packageName.trim()
            : typeof record.package === 'string'
                ? record.package.trim()
                : typeof record.moduleId === 'string'
                    ? record.moduleId.trim()
                    : '';
        if (name && packageName) return `${packageName}.${name}`;
        return name ? `world.${name}` : null;
    }

    private toRecord(value: unknown): UnknownRecord | undefined {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
        return value as UnknownRecord;
    }

    private handleUserConnected(event: FoundryUserConnectedEvent, options: FoundryEventIngressOptions): void {
        const user = event.user as { _id?: string; id?: string; name?: string } | undefined;
        const id = user?._id || user?.id;
        if (!id) return;

        logger.info(`FoundryEventIngress | User connected: ${user?.name ?? 'unknown'} (${id})`);
        if (userPresence.setActive(id, true)) {
            options.onStatusUpdate?.();
        }
    }

    private handleUserDisconnected(event: FoundryUserDisconnectedEvent, options: FoundryEventIngressOptions): void {
        const data = event.data as string | { userId?: string; _id?: string; id?: string } | undefined;
        const id = typeof data === 'string' ? data : (data?.userId || data?._id || data?.id);
        if (!id) return;

        logger.info(`FoundryEventIngress | User disconnected: ${id}`);
        if (userPresence.setActive(id, false)) {
            options.onStatusUpdate?.();
        }
    }

    private handleUserActivity(event: FoundryUserActivityEvent, options: FoundryEventIngressOptions): void {
        if (!event.userId || !event.data) return;

        const data = event.data as { active?: boolean };
        const isActive = data.active !== false;
        if (userPresence.setActive(event.userId, isActive)) {
            options.onStatusUpdate?.();
        }
    }

    private handleShareImage(event: FoundryShareImageEvent): void {
        logger.info(`FoundryEventIngress | Received shared image: ${event.data?.image}`);
        const payload: RealtimeSharedContentPayload = {
            type: 'image',
            data: {
                url: event.data?.image,
                title: event.data?.title,
            },
            timestamp: Date.now(),
        };
        sharedContentStore.set(payload);
    }

    private handleShowEntry(event: FoundryShowEntryEvent): void {
        logger.info(`FoundryEventIngress | Received shared entry: ${event.uuid}`);
        const parts = event.uuid.split('.');
        if (parts.length < 2 || parts[0] !== 'JournalEntry') return;

        const payload: RealtimeSharedContentPayload = {
            type: 'journal',
            data: {
                id: parts[1],
                uuid: event.uuid,
            },
            timestamp: Date.now(),
        };
        sharedContentStore.set(payload);
    }

    private handleRuntimeTeardown(event: FoundryRuntimeTeardownEvent): void {
        const reason = event.reason || 'foundry-runtime-teardown';
        worldStateStore.clearRuntimeState(reason);
        sharedContentStore.clear(reason);
        compendiumStore.clear(reason);
        userPresence.clear();
        userStore.clear(reason);
        actorStore.clear(reason);
    }
}

export const foundryEventIngress = new FoundryEventIngress();
