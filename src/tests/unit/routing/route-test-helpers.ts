import type { Request, RequestHandler, Response } from 'express';

export type RouteMethod = 'get' | 'post' | 'put' | 'delete' | 'all';

export interface RouteMap {
    get: Map<string | RegExp, RequestHandler[][]>;
    post: Map<string | RegExp, RequestHandler[][]>;
    put: Map<string | RegExp, RequestHandler[][]>;
    delete: Map<string | RegExp, RequestHandler[][]>;
    all: Map<string | RegExp, RequestHandler[][]>;
    use: RequestHandler[][];
}

export type ResponseStub = Response & {
    statusCode: number;
    payload: unknown;
    body: unknown;
    headers: Record<string, string>;
    filePath: string | null;
};

export function createRouteMap(): RouteMap {
    return {
        get: new Map(),
        post: new Map(),
        put: new Map(),
        delete: new Map(),
        all: new Map(),
        use: [],
    };
}

function addRoute(
    map: Map<string | RegExp, RequestHandler[][]>,
    path: string | RegExp,
    handlers: RequestHandler[],
): void {
    const existing = map.get(path) || [];
    existing.push(handlers);
    map.set(path, existing);
}

export function createRouterStub(routeMap: RouteMap = createRouteMap()) {
    return {
        get(path: string | RegExp, ...handlers: RequestHandler[]) {
            addRoute(routeMap.get, path, handlers);
            return this;
        },
        post(path: string | RegExp, ...handlers: RequestHandler[]) {
            addRoute(routeMap.post, path, handlers);
            return this;
        },
        put(path: string | RegExp, ...handlers: RequestHandler[]) {
            addRoute(routeMap.put, path, handlers);
            return this;
        },
        delete(path: string | RegExp, ...handlers: RequestHandler[]) {
            addRoute(routeMap.delete, path, handlers);
            return this;
        },
        all(path: string | RegExp, ...handlers: RequestHandler[]) {
            addRoute(routeMap.all, path, handlers);
            return this;
        },
        use(...handlers: RequestHandler[]) {
            routeMap.use.push(handlers);
            return this;
        },
    };
}

export function getLastHandler(routeMap: RouteMap, method: RouteMethod, path: string | RegExp): RequestHandler {
    const registrations = routeMap[method].get(path);
    if (!registrations?.length) throw new Error(`Missing route ${method.toUpperCase()} ${String(path)}`);
    const handlers = registrations[registrations.length - 1];
    if (!handlers.length) throw new Error(`Route ${method.toUpperCase()} ${String(path)} has no handlers`);
    return handlers[handlers.length - 1];
}

export function createResponseStub(): ResponseStub {
    const state = {
        statusCode: 200,
        payload: undefined as unknown,
        body: undefined as unknown,
        headers: {} as Record<string, string>,
        filePath: null as string | null,
        status(code: number) {
            state.statusCode = code;
            return state;
        },
        json(body: unknown) {
            state.payload = body;
            return state;
        },
        send(body: unknown) {
            state.body = body;
            return state;
        },
        sendFile(filePath: string) {
            state.filePath = filePath;
            return state;
        },
        setHeader(name: string, value: string) {
            state.headers[name] = value;
            return state;
        },
        end() {
            return state;
        },
    };

    return state as unknown as ResponseStub;
}

export async function invokeHandler(
    handler: RequestHandler,
    req: Partial<Request>,
    res: ResponseStub = createResponseStub(),
): Promise<ResponseStub> {
    await handler(req as Request, res as Response, (() => undefined) as any);
    return res;
}
