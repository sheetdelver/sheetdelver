import type { FoundryClientLike } from '@server/shared/types/foundry';

export interface UtilityClientLike extends FoundryClientLike {
    fetchByUuid(uuid: string): Promise<unknown>;
    resolveUrl(url?: string): string;
}
