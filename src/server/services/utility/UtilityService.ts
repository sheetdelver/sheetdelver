import { UserRole } from '@shared/constants';
import { logger } from '@shared/utils/logger';
import type { UtilityClientLike } from '@server/shared/types/utility';
import type { RouteFoundryClient } from '@server/shared/types/requestContext';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import { sharedContentStore } from '@server/core/world/SharedContentStore';

interface UtilityServiceDeps {
    getFallbackSharedContentClient: () => RouteFoundryClient;
}

export function createUtilityService(deps: UtilityServiceDeps) {
    // Generic Foundry document fetch used by dashboard links and drill-in flows.
    const getFoundryDocument = async (client: UtilityClientLike, uuid?: string) => {
        if (!uuid) return { error: 'Missing uuid', status: 400 };

        const data = await client.fetchByUuid(uuid);
        if (!data) return { error: 'Document not found', status: 404 };

        return data;
    };

    // Session user projection mirrors the public status user shape for dashboard consumers.
    const getSessionUsers = async (client: UtilityClientLike) => {
        const users = userStore.isReady() ? userStore.listWithPresence() : [];
        logger.debug(`[API] /session/users: Found ${users.length} users via UserStore`);

        const sanitizedUsers = users.map((u) => ({
            _id: u._id || u.id,
            name: u.name,
            role: u.role,
            isGM: (u.role || 0) >= UserRole.ASSISTANT,
            active: u.active,
            color: u.color,
            characterId: u.character,
            img: client.resolveUrl(u.avatar || u.img)
        }));

        return { users: sanitizedUsers };
    };

    // Shared content projection reads the canonical snapshot from the Store
    // and resolves image URLs against the requesting client's Foundry base
    // URL. The Store returns a defensive copy, so mutating `data.url` here is
    // safe and does not leak back into the canonical state.
    const getSharedContent = async (client?: UtilityClientLike) => {
        const resolvedClient = client || deps.getFallbackSharedContentClient();
        const content = sharedContentStore.getCurrent();

        if (content && content.type === 'image' && content.data?.url) {
            content.data.url = resolvedClient.resolveUrl(content.data.url);
        }

        return content || { type: null };
    };

    return {
        getFoundryDocument,
        getSessionUsers,
        getSharedContent
    };
}
