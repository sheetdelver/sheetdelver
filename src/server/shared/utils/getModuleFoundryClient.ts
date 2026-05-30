import type { RouteFoundryClient } from '@server/shared/types/requestContext';
import type { FoundryUserConnectionLike } from '@server/shared/types/foundry';

type ModuleRequestLike = Request & {
    foundryClient?: RouteFoundryClient;
    userSession?: FoundryUserConnectionLike;
};

export function getModuleFoundryClient(request: Request): RouteFoundryClient | null {
    return (request as ModuleRequestLike).foundryClient || null;
}

export function getModuleUserSession(request: Request): FoundryUserConnectionLike | undefined {
    return (request as ModuleRequestLike).userSession;
}
