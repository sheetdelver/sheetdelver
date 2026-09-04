import type { CombatDocument } from '@server/shared/types/documents';
import { PrimaryDocumentRepository, type DocumentTransport } from '../base/PrimaryDocumentRepository';
import type { ModifyDocumentAction } from '../base/PrimaryDocumentStore';
import { combatStore } from './CombatStore';

/**
 * Combat primary-document Repository. Per-request transport binds writes to
 * the requesting user's authenticated socket; Foundry broadcasts the result
 * which lands through `modifyDocumentRouter` into `CombatStore.applyModifyDocument`
 * (for direct-type Combat ops) or `CombatStore.applyEmbeddedChange` (for
 * `Combatant` / `CombatantGroup` ops carrying `parentUuid: Combat.<id>`). The
 * initiator-side mirror in {@link dispatchDocument} makes the second apply
 * idempotent via emit-only-on-change.
 */
export class CombatRepository extends PrimaryDocumentRepository<CombatDocument> {
    constructor(transport: DocumentTransport) {
        super(transport, combatStore);
    }

    async dispatchDocument(
        type: string,
        action: ModifyDocumentAction,
        operation: Record<string, unknown> = {},
        parent?: { type: string; id: string },
    ): Promise<any> {
        return super.dispatchDocument(type, action, operation, parent);
    }

    async create(data: Record<string, unknown>): Promise<any> {
        return this.dispatchDocument('Combat', 'create', { data: [data] });
    }

    async update(combatId: string, updates: Record<string, unknown>): Promise<any> {
        return this.dispatchDocument('Combat', 'update', {
            updates: [{ _id: combatId, ...updates }],
        });
    }

    async delete(combatId: string): Promise<void> {
        await this.dispatchDocument('Combat', 'delete', { ids: [combatId] });
    }

    /**
     * Create a Combatant under the given combat. Routes the result through the
     * embedded apply path so the broadcast and the initiator mirror both end up
     * in the combat's `combatants[]` array.
     */
    async createCombatant(combatId: string, data: Record<string, unknown>): Promise<any> {
        return this.dispatchDocument(
            'Combatant',
            'create',
            { data: [data] },
            { type: 'Combat', id: combatId },
        );
    }

    async updateCombatant(combatId: string, combatantId: string, updates: Record<string, unknown>): Promise<any> {
        return this.dispatchDocument(
            'Combatant',
            'update',
            { updates: [{ _id: combatantId, ...updates }] },
            { type: 'Combat', id: combatId },
        );
    }

    async deleteCombatant(combatId: string, combatantId: string): Promise<void> {
        await this.dispatchDocument(
            'Combatant',
            'delete',
            { ids: [combatantId] },
            { type: 'Combat', id: combatId },
        );
    }

    /**
     * CombatantGroup uses the same embedded parent contract as Combatant in
     * both supported Foundry generations; named helpers keep callers on the
     * Repository mirror rather than a raw transport path.
     */
    async createCombatantGroup(combatId: string, data: Record<string, unknown>): Promise<any> {
        return this.dispatchDocument(
            'CombatantGroup',
            'create',
            { data: [data] },
            { type: 'Combat', id: combatId },
        );
    }

    async updateCombatantGroup(combatId: string, groupId: string, updates: Record<string, unknown>): Promise<any> {
        return this.dispatchDocument(
            'CombatantGroup',
            'update',
            { updates: [{ _id: groupId, ...updates }] },
            { type: 'Combat', id: combatId },
        );
    }

    async deleteCombatantGroup(combatId: string, groupId: string): Promise<void> {
        await this.dispatchDocument(
            'CombatantGroup',
            'delete',
            { ids: [groupId] },
            { type: 'Combat', id: combatId },
        );
    }
}
