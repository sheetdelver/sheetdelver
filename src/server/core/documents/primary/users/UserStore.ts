import type { RawUser } from '@server/shared/types/users';
import {
    PrimaryDocumentStore,
    type PrimaryDocumentType,
} from '../base/PrimaryDocumentStore';
import {
    DocumentOwnershipLevel,
    FoundryUserRole,
    type DocumentAccessSubject,
    type ResolvedDocumentOwnershipLevel,
} from '../base/ownership';

/**
 * User primary-document Store. Full hydration + bootstrap seed: mirrors
 * Foundry's `game.data.users` roster.
 *
 * Visibility (per ADR-0013): User documents carry no per-user ownership map.
 * Users are *subjects* of ownership, not targets. All authenticated callers
 * see the roster (OBSERVER); GMs see it as OWNER.
 *
 * UserStore is foundational: every other Store's subject construction reads
 * role information from here via {@link getRole}. Don't introduce cross-store
 * subscriptions back into UserStore — it sits below the other Stores.
 *
 * Presence (`active: boolean`) is **not** in the User document. It's runtime
 * state delivered through `userConnected` / `userDisconnected` / `userActivity`
 * socket events and lives in a separate presence map on `CoreSocket`.
 */
export class UserStore extends PrimaryDocumentStore<RawUser> {
    public readonly documentType: PrimaryDocumentType = 'User';

    protected resolveOwnership(
        _user: RawUser,
        subject: DocumentAccessSubject,
    ): ResolvedDocumentOwnershipLevel {
        if (subject.role >= FoundryUserRole.GAMEMASTER) return DocumentOwnershipLevel.OWNER;
        return DocumentOwnershipLevel.OBSERVER;
    }

    /**
     * Convenience accessor for role lookups. Returns the user's role number
     * if known, otherwise `FoundryUserRole.NONE`. Used by every Store's
     * `DocumentAccessSubject` construction.
     */
    public getRole(userId: string): FoundryUserRole {
        const user = this.documents.get(userId);
        const role = typeof user?.role === 'number' ? user.role : null;
        return role !== null ? (role as FoundryUserRole) : FoundryUserRole.NONE;
    }

    /**
     * Lookup a user by name. Used during connection to resolve the service
     * account's id from its configured username.
     */
    public findByName(name: string): RawUser | null {
        for (const user of this.documents.values()) {
            if (user.name === name) return user;
        }
        return null;
    }
}

export const userStore = new UserStore();
