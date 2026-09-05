import type { FoundryUserConnectionLike } from '@server/shared/types/foundry';
import type { RouteFoundryClient } from '@server/shared/types/requestContext';

export type RequestFoundryClient = RouteFoundryClient;

declare global {
    namespace Express {
        interface Request {
            /** Server-generated correlation ID returned in X-Request-ID. */
            requestId?: string;
            foundryClient: RequestFoundryClient;
            userSession?: FoundryUserConnectionLike;
            isSystem?: boolean;
        }
    }
}

export {};
