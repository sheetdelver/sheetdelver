import { userStore } from '@server/core/documents/primary/users/UserStore';
import type { FoundryUserLike } from '@server/shared/types/foundry';

export interface FoundryUserIdentityResolverDeps {
    getUsers?: () => Promise<FoundryUserLike[]>;
}

export class FoundryUserIdentityResolver {
    private readonly getUsers?: () => Promise<FoundryUserLike[]>;

    public constructor(deps: FoundryUserIdentityResolverDeps = {}) {
        this.getUsers = deps.getUsers;
    }

    public async resolveUserId(username: string): Promise<string | null> {
        const normalized = username.trim();
        if (!normalized) return null;

        const storeUser = userStore.isReady() ? userStore.findByName(normalized) : null;
        if (storeUser) return storeUser._id || storeUser.id || null;

        const users = this.getUsers ? await this.getUsers() : [];
        const discoveredUser = users.find((user) => user.name === normalized);
        return discoveredUser?._id || discoveredUser?.id || null;
    }
}
