import type { FoundryClientLike } from '@server/shared/types/foundry';
import type { RealtimeSharedContentPayload } from '@shared/contracts/realtime';

export interface UtilityClientLike extends FoundryClientLike {
    fetchByUuid(uuid: string): Promise<unknown>;
    resolveUrl(url?: string): string;
    getSharedContent?(): RealtimeSharedContentPayload | null;
}
