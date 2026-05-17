import type { RawUser, UserWithPresence } from '@server/shared/types/users';

function getUserId(user: RawUser): string | null {
    return user._id || user.id || null;
}

/**
 * Runtime-only user presence. This is deliberately separate from UserStore:
 * `active` is socket state, not a Foundry User document field.
 */
export class UserPresence {
    private activeByUserId = new Map<string, boolean>();

    public clear(): void {
        this.activeByUserId.clear();
    }

    public setActive(userId: string | null | undefined, active: boolean): boolean {
        if (!userId) return false;
        const previous = this.activeByUserId.get(userId) ?? false;
        if (previous === active) return false;
        this.activeByUserId.set(userId, active);
        return true;
    }

    public setActiveUsers(userIds: unknown[]): void {
        this.clear();
        for (const userId of userIds) {
            if (typeof userId === 'string') this.setActive(userId, true);
        }
    }

    public delete(userId: string | null | undefined): boolean {
        if (!userId) return false;
        return this.activeByUserId.delete(userId);
    }

    public isActive(userId: string | null | undefined): boolean {
        return userId ? this.activeByUserId.get(userId) ?? false : false;
    }

    public compose<TUser extends RawUser>(user: TUser): TUser & UserWithPresence {
        return {
            ...user,
            active: this.isActive(getUserId(user)),
        };
    }
}

export const userPresence = new UserPresence();
