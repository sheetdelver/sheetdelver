import type { RawUser, UserWithPresence } from '@server/shared/types/users';
import {
    PrimaryDocumentStore,
    type PrimaryDocumentType,
    cloneDocument,
} from '../base/PrimaryDocumentStore';
import {
    DocumentOwnershipLevel,
    FoundryUserRole,
    createDocumentAccessSubject,
    isGM,
    type DocumentAccessSubject,
    type ResolvedDocumentOwnershipLevel,
} from '../base/ownership';
import { userPresence } from './UserPresence';

function getRawUserId(user: RawUser | null | undefined): string | null {
    return user?._id || user?.id || null;
}

function getRawUserRole(user: RawUser | null | undefined): FoundryUserRole {
    const directRole = user?.role;
    if (typeof directRole === 'number') return directRole as FoundryUserRole;

    const permissionRole = user?.permissions?.role;
    if (typeof permissionRole === 'number') return permissionRole as FoundryUserRole;

    return FoundryUserRole.NONE;
}

/**
 * User primary-document Store. Full hydration + bootstrap seed: mirrors
 * Foundry's `game.data.users` roster.
 *
 * Visibility (per ADR-0013): User documents carry no per-user ownership map.
 * Users are *subjects* of ownership, not targets. All authenticated callers
 * see the roster (OBSERVER); GMs see it as OWNER.
 *
 * Because User docs have no `ownership` field, the base
 * `diffOwnershipAndEmitInvalidation` and `usersWithEffectiveVisibility`
 * never produce a `targetUserIds` list for User events — `documentListInvalidated`
 * for User is always broadcast-wide. Gateways consuming `userListInvalidated`
 * can treat a missing `targetUserIds` as "everyone authenticated."
 *
 * UserStore is foundational: every other Store's subject construction reads
 * role information from here via {@link getRole}. Don't introduce cross-store
 * subscriptions back into UserStore — it sits below the other Stores.
 *
 * Presence (`active: boolean`) is **not** in the User document. It's runtime
 * state delivered through `userConnected` / `userDisconnected` / `userActivity`
 * socket events and lives in `UserPresence`.
 */
export class UserStore extends PrimaryDocumentStore<RawUser> {
    public readonly documentType: PrimaryDocumentType = 'User';

    protected resolveOwnership(
        _user: RawUser,
        subject: DocumentAccessSubject,
    ): ResolvedDocumentOwnershipLevel {
        if (isGM(subject)) return DocumentOwnershipLevel.OWNER;
        return DocumentOwnershipLevel.OBSERVER;
    }

    /**
     * Convenience accessor for role lookups. Returns the user's role number
     * if known, otherwise `FoundryUserRole.NONE`. Used by every Store's
     * `DocumentAccessSubject` construction.
     */
    public getRole(userId: string): FoundryUserRole {
        const user = this.documents.get(userId);
        return getRawUserRole(user);
    }

    public createAccessSubject(userId: string | null | undefined): DocumentAccessSubject | null {
        return createDocumentAccessSubject(userId, userId ? this.getRole(userId) : FoundryUserRole.NONE);
    }

    public getWithPresence(userId: string): UserWithPresence | null {
        const user = this.get(userId);
        return user ? userPresence.compose(user) : null;
    }

    public listWithPresence(): UserWithPresence[] {
        return this.list().map(user => userPresence.compose(user));
    }

    public getGmUserIds(minRole: FoundryUserRole = FoundryUserRole.ASSISTANT): string[] {
        return Array.from(this.documents.values())
            .filter(user => getRawUserRole(user) >= minRole)
            .map(getRawUserId)
            .filter((userId): userId is string => typeof userId === 'string');
    }

    /**
     * Lookup a user by name. Used during connection to resolve the service
     * account's id from its configured username.
     */
    public findByName(name: string): RawUser | null {
        for (const user of this.documents.values()) {
            if (user.name === name) return cloneDocument(user);
        }
        return null;
    }
}

export const userStore = new UserStore();
