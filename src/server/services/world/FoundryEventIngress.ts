import type { EventEmitter } from 'node:events';
import { logger } from '@shared/utils/logger';
import { modifyDocumentRouter } from '@server/core/documents/primary/base/modifyDocumentRouter';
import { userPresence } from '@server/core/documents/primary/users/UserPresence';
import { sharedContentStore } from '@server/core/world/SharedContentStore';
import { worldStateStore } from '@server/core/world/WorldStateStore';
import { compendiumStore } from '@server/core/compendium';
import { actorStore } from '@server/core/documents/primary/actors/ActorStore';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import type { RealtimeSharedContentPayload } from '@shared/contracts/realtime';
import type {
    FoundryDocumentCompatibilityEvent,
    FoundryDocumentDispatchConfirmedEvent,
    FoundryModifyDocumentEvent,
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

export class FoundryEventIngress {
    public attach(source: EventEmitter, options: FoundryEventIngressOptions = {}): () => void {
        const handlers: Array<{ event: string; handler: EventHandler }> = [
            ['foundry:modifyDocument', (event: unknown) => this.routeDocument(event as FoundryModifyDocumentEvent)],
            ['foundry:documentCompatibility', (event: unknown) => this.routeCompatibilityDocument(event as FoundryDocumentCompatibilityEvent, options)],
            ['foundry:documentDispatchConfirmed', (event: unknown) => this.routeDispatchConfirmation(event as FoundryDocumentDispatchConfirmedEvent)],
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

    private routeDocument(event: FoundryModifyDocumentEvent): void {
        this.route(event.type, event.action, event.result, event.operation);
    }

    private routeDispatchConfirmation(event: FoundryDocumentDispatchConfirmedEvent): void {
        this.route(event.type, event.action, event.result, event.operation);
    }

    private routeCompatibilityDocument(event: FoundryDocumentCompatibilityEvent, options: FoundryEventIngressOptions): void {
        this.route(event.type, event.action, event.result, event.operation);

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

    private route(type: string, action: string, result: unknown, operation?: unknown): void {
        modifyDocumentRouter.route({
            type,
            action: action as 'get' | 'create' | 'update' | 'delete',
            result,
            operation: this.toOperation(operation),
        });
    }

    private toOperation(operation: unknown): Record<string, unknown> | undefined {
        if (!operation || typeof operation !== 'object' || Array.isArray(operation)) return undefined;
        return operation as Record<string, unknown>;
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
