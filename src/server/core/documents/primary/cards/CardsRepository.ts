import type { CardsDocument } from '@server/shared/types/documents';
import { PrimaryDocumentRepository, type DocumentTransport } from '../base/PrimaryDocumentRepository';
import type { ModifyDocumentAction } from '../base/PrimaryDocumentStore';
import { cardsStore } from './CardsStore';

/**
 * Cards primary-document Repository. Per-request transport binds writes
 * to the requesting user's authenticated socket. Foundry's broadcast lands
 * through `modifyDocumentRouter` into `CardsStore.applyModifyDocument`
 * (direct-type) or `CardsStore.applyEmbeddedChange` (`Card` with
 * `parentUuid: Cards.<id>`).
 *
 * Cross-Cards-doc transfers (`Cards#pass`) arrive as paired embedded
 * operations across two parents: create/update on draw and update/delete on
 * return. Both legs flow through this Repository.
 */
export class CardsRepository extends PrimaryDocumentRepository<CardsDocument> {
    constructor(transport: DocumentTransport) {
        super(transport, cardsStore);
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
        return this.dispatchDocument('Cards', 'create', { data: [data] });
    }

    async update(cardsId: string, updates: Record<string, unknown>): Promise<any> {
        return this.dispatchDocument('Cards', 'update', {
            updates: [{ _id: cardsId, ...updates }],
        });
    }

    async delete(cardsId: string): Promise<void> {
        await this.dispatchDocument('Cards', 'delete', { ids: [cardsId] });
    }

    async createCard(cardsId: string, data: Record<string, unknown>): Promise<any> {
        return this.dispatchDocument(
            'Card',
            'create',
            { data: [data] },
            { type: 'Cards', id: cardsId },
        );
    }

    async updateCard(cardsId: string, cardId: string, updates: Record<string, unknown>): Promise<any> {
        return this.dispatchDocument(
            'Card',
            'update',
            { updates: [{ _id: cardId, ...updates }] },
            { type: 'Cards', id: cardsId },
        );
    }

    async deleteCard(cardsId: string, cardId: string): Promise<void> {
        await this.dispatchDocument(
            'Card',
            'delete',
            { ids: [cardId] },
            { type: 'Cards', id: cardsId },
        );
    }
}
