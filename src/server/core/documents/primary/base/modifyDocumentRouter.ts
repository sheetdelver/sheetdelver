import { logger } from '@shared/utils/logger';
import type {
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

/**
 * Single inbound dispatch point that routes Foundry modifyDocument events into
 * the right per-type Store. Replaces the per-type switch in CoreSocket and the
 * duplicate relay in ClientSocket. See ADR-0012.
 *
 * Routing rules:
 *   1. If `payload.type` matches a directly-registered Store, route there.
 *   2. Otherwise, parse `operation.parentUuid` and route to the Store registered
 *      as the handler for that parent type (e.g., ActorStore handles 'Item' /
 *      'ActiveEffect' events with parentUuid 'Actor.<id>...').
 *   3. Unrecognized types (e.g., 'ActorDelta' for synthetic token actors) are
 *      logged at debug and dropped silently — never thrown.
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

    route(payload: ModifyDocumentPayload): void {
        const direct = this.storesByType.get(payload.type);
        if (direct) {
            direct.applyModifyDocument(payload.type, payload.action, payload.result, payload.operation);
            return;
        }

        const parentUuid = typeof payload.operation?.parentUuid === 'string'
            ? payload.operation.parentUuid
            : '';
        if (parentUuid) {
            const parentType = parentUuid.split('.')[0];
            const parentStore = this.embeddedParentHandlers.get(parentType);
            if (parentStore) {
                parentStore.applyModifyDocument(payload.type, payload.action, payload.result, payload.operation);
                return;
            }
            logger.debug(
                `modifyDocumentRouter | Dropping unrouted embedded event: type=${payload.type} parentUuid=${parentUuid}`,
            );
            return;
        }

        logger.debug(`modifyDocumentRouter | Dropping unrouted event: type=${payload.type} action=${payload.action}`);
    }
}

export const modifyDocumentRouter = new ModifyDocumentRouter();
