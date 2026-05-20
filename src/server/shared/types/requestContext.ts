import type { ActorServiceClientLike } from '@server/shared/types/actors';
import type { ChatClientLike, CombatClientLike, JournalClientLike } from '@server/shared/types/documents';
import type { UtilityClientLike } from '@server/shared/types/utility';

export type RouteFoundryClient = ActorServiceClientLike & ChatClientLike & CombatClientLike & JournalClientLike & UtilityClientLike & {
	isConnected: boolean;
};
