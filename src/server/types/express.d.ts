import type { FoundryUserConnectionLike } from '@server/shared/types/foundry';
import type { RouteFoundryClient } from '@server/shared/types/requestContext';

export type RequestFoundryClient = RouteFoundryClient;

declare global {
    namespace Express {
        interface Request {
            foundryClient: RequestFoundryClient;
            userSession?: FoundryUserConnectionLike;
            isSystem?: boolean;
        }
    }
}

export {};
