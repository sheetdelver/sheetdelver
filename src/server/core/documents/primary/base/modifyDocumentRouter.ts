import { logger } from '@shared/utils/logger';
import type {
    DocumentRepairTarget,
    ModifyDocumentAction,
    PrimaryDocumentStore,
    PrimaryDocumentType,
} from './PrimaryDocumentStore';

/**
 * The inbound `modifyDocument` payload shape, normalized for routing.
 * Mirrors Foundry's wire format from foundry.mjs:59054 — `{ type, action, operation }`
 * with `result` populated when present on the dispatch response.
 */
export interface ModifyDocumentPayload {
    type: string;
    action: ModifyDocumentAction;
    result?: unknown;
    operation?: Record<string, unknown>;
}

export type ModifyDocumentRouteOutcome =
    | {
        status: 'dispatched';
        route: 'direct' | 'embedded';
        storeType: string;
        repairTargets?: DocumentRepairTarget[];
    }
    | { status: 'dropped'; reason: 'unregistered-direct-type' | 'unregistered-parent-type' };

/**
 * Single inbound dispatch point that routes Foundry modifyDocument events into
 * the right per-type Store. Replaces the per-type switch in CoreSocket and the
 * duplicate relay in ClientSocket. See ADR-0012.
 *
 * Routing rules:
     *   1. If `operation.parentUuid` is present, route to the registered embedded
     *      handler for its parent type or drop. No direct-type fall-through is
     *      allowed for parented events.
     *   2. If no `parentUuid` exists and `payload.type` matches a directly-registered
     *      Store, route there (the common case for world documents).
     *   3. Unrecognized events are logged at debug and dropped silently — never thrown.
 */
export class ModifyDocumentRouter {
    private storesByType = new Map<string, PrimaryDocumentStore<any>>();
    private embeddedParentHandlers = new Map<string, PrimaryDocumentStore<any>>();

    /**
     * Register a Store as the owner of its primary document type.
     * (`type === store.documentType`).
     */
    register(store: PrimaryDocumentStore<any>): void {
        this.storesByType.set(store.documentType, store);
    }

    /**
     * Register a Store as the embedded handler for events whose parentUuid
     * begins with the given parent type. Example: `registerEmbeddedHandler('Actor', actorStore)`
     * makes ActorStore receive 'Item' / 'ActiveEffect' events with parentUuid 'Actor.xxx...'.
     */
    registerEmbeddedHandler(parentType: PrimaryDocumentType, store: PrimaryDocumentStore<any>): void {
        this.embeddedParentHandlers.set(parentType, store);
    }

    /**
     * Reset all registrations. Useful for tests.
     */
    reset(): void {
        this.storesByType.clear();
        this.embeddedParentHandlers.clear();
    }

    route(payload: ModifyDocumentPayload): ModifyDocumentRouteOutcome {
        // parentUuid present means this is an embedded event. Route to the
        // registered handler for the parent type, or drop. No fall-through to
        // direct-type — an `Item` with `parentUuid: ActorDelta.<id>.Item.<id>`
        // is a synthetic-token mutation, not a world-Item event, and must not
        // leak into ItemStore.
        const parentUuid = typeof payload.operation?.parentUuid === 'string'
            ? payload.operation.parentUuid
            : '';
        if (parentUuid) {
            const parentType = parentUuid.split('.')[0];
            const parentStore = this.embeddedParentHandlers.get(parentType);
            if (parentStore) {
                const outcome = parentStore.applyModifyDocument(
                    payload.type,
                    payload.action,
                    payload.result,
                    payload.operation,
                );
                return {
                    status: 'dispatched',
                    route: 'embedded',
                    storeType: parentStore.documentType,
                    ...(outcome.repairTargets.length > 0
                        ? { repairTargets: outcome.repairTargets }
                        : {}),
                };
            }
            logger.debug(
                `modifyDocumentRouter | Dropping unrouted embedded event: type=${payload.type} parentUuid=${parentUuid}`,
            );
            return { status: 'dropped', reason: 'unregistered-parent-type' };
        }

        // No parentUuid → direct-type lookup. This is the common case for
        // world-level documents.
        const direct = this.storesByType.get(payload.type);
        if (direct) {
            const outcome = direct.applyModifyDocument(
                payload.type,
                payload.action,
                payload.result,
                payload.operation,
            );
            return {
                status: 'dispatched',
                route: 'direct',
                storeType: direct.documentType,
                ...(outcome.repairTargets.length > 0
                    ? { repairTargets: outcome.repairTargets }
                    : {}),
            };
        }

        logger.debug(`modifyDocumentRouter | Dropping unrouted event: type=${payload.type} action=${payload.action}`);
        return { status: 'dropped', reason: 'unregistered-direct-type' };
    }
}

export const modifyDocumentRouter = new ModifyDocumentRouter();
