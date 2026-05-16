import type { RawUser } from '@server/shared/types/users';
import { PrimaryDocumentRepository, type DocumentTransport } from '../base/PrimaryDocumentRepository';
import { userStore } from './UserStore';

/**
 * User primary-document Repository. User CRUD in Sheet Delver is rare — most
 * worlds manage user accounts entirely within Foundry's setup UI — but the
 * Repository surface stays uniform with the other primary docs for shape
 * consistency (ADR-0011) and so future admin tooling has a typed entry point.
 *
 * Writes dispatch over a request-scoped transport so Foundry enforces
 * permissions against the requesting user (typically a GM). Results mirror
 * into {@link UserStore} via the base.
 */
export class UserRepository extends PrimaryDocumentRepository<RawUser> {
    constructor(transport: DocumentTransport) {
        super(transport, userStore);
    }

    async create(userData: Record<string, unknown>): Promise<any> {
        return this.dispatchDocument('User', 'create', { data: [userData] });
    }

    async update(userId: string, updates: Record<string, unknown>): Promise<any> {
        return this.dispatchDocument('User', 'update', { updates: [{ _id: userId, ...updates }] });
    }

    async delete(userId: string): Promise<void> {
        await this.dispatchDocument('User', 'delete', { ids: [userId] });
    }
}
