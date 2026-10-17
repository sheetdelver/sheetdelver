import { UserRole } from '@shared/constants';
import { canRoleDeleteActors } from '@shared/security/foundryPermissions';
import { logger } from '@shared/utils/logger';
import type { UtilityClientLike } from '@server/shared/types/utility';
import type { RouteFoundryClient } from '@server/shared/types/requestContext';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import { sharedContentStore } from '@server/core/world/SharedContentStore';
import { createDocumentStore } from '@server/shared/utils/moduleDocumentServices';
import { systemService } from '@server/services/world';
import { parseDocumentUuid } from '@server/services/documents/DocumentResolver';
import { SdkError } from '@shared/sdk/errors';

export function createUtilityService() {
    // Generic Foundry document fetch used by dashboard links and drill-in flows.
    const getFoundryDocument = async (client: UtilityClientLike, uuid?: string) => {
        if (!uuid) return { error: 'Missing uuid', status: 400 };
        if (typeof uuid !== 'string' || uuid.length > 2048 || !parseDocumentUuid(uuid)) throw new SdkError('validation', 'Invalid document UUID');

        // The route client can resolve privileged cache bytes, so generic UUID
        // reads must pass through the same caller-scoped Store gate as modules.
        const documents = createDocumentStore(client as RouteFoundryClient, async () => {});
        const data = await documents.fetchByUuid(uuid);
        if (!data) return { error: 'Document not found', status: 404 };

        return data;
    };

    // Session user projection mirrors the public status user shape for dashboard consumers.
    const getSessionUsers = async (client: UtilityClientLike) => {
        const users = userStore.isReady() ? userStore.listWithPresence() : [];
        let serviceAccountId: string | null = null;
        try { serviceAccountId = systemService.getSystemClient().userId; }
        catch { /* Status-only startup may not have a service transport yet. */ }
        logger.debug(`[API] /session/users: Found ${users.length} users via UserStore`);

        const sanitizedUsers = users.map((u) => ({
            _id: u._id || u.id,
            name: u.name,
            role: u.role,
            isGM: (u.role || 0) >= UserRole.ASSISTANT,
            canDeleteActors: canRoleDeleteActors(u.role),
            active: u.active,
            color: u.color,
            characterId: u.character,
            img: client.resolveUrl(u.avatar || u.img),
            ...(serviceAccountId && (u._id || u.id) === serviceAccountId ? { isServiceAccount: true } : {}),
        }));

        return { users: sanitizedUsers };
    };

    // Shared content projection reads the canonical snapshot from the Store
    // and resolves image URLs against the requesting client's Foundry base
    // URL. The Store returns a defensive copy, so mutating `data.url` here is
    // safe and does not leak back into the canonical state.
    const getSharedContent = async (client: UtilityClientLike, sessionId: string, worldId: string) => {
        const content = sharedContentStore.getCurrent(sessionId, worldId);

        if (content && content.type === 'image' && content.data?.url) {
            content.data.url = client.resolveUrl(content.data.url);
        }

        return content || { type: null };
    };

    return {
        getFoundryDocument,
        getSessionUsers,
        getSharedContent
    };
}
