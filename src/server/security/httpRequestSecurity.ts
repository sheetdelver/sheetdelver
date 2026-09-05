import { randomUUID } from 'node:crypto';
import express from 'express';
import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { logger } from '@shared/utils/logger';

export const JSON_BODY_LIMITS = {
    playerLogin: '8kb',
    adminAuth: '16kb',
    moduleUiHealth: '4kb',
} as const;

function selectJsonBodyLimit(pathname: string, defaultLimit: string): string {
    if (pathname === '/api/login' || pathname === '/api/login/') {
        return JSON_BODY_LIMITS.playerLogin;
    }
    if (/^\/admin\/auth\/(?:setup|login|reset)\/?$/.test(pathname)) {
        return JSON_BODY_LIMITS.adminAuth;
    }
    if (/^\/api\/modules\/[^/]+\/ui-error\/?$/.test(pathname)) {
        return JSON_BODY_LIMITS.moduleUiHealth;
    }
    return defaultLimit;
}

/**
 * Select one JSON parser before routing so security-sensitive credential and
 * telemetry endpoints cannot inherit the much larger document mutation limit.
 */
export function createJsonBodyParser(defaultLimit: string): RequestHandler {
    const parsers = new Map<string, RequestHandler>();
    return (req, res, next) => {
        const limit = selectJsonBodyLimit(req.path, defaultLimit);
        let parser = parsers.get(limit);
        if (!parser) {
            parser = express.json({ limit });
            parsers.set(limit, parser);
        }
        parser(req, res, next);
    };
}

function summarizeInternalBody(body: unknown): string {
    if (!body || typeof body !== 'object') return typeof body;
    const record = body as Record<string, unknown>;
    const code = typeof record.code === 'string' ? record.code.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) : undefined;
    const errorType = record.error instanceof Error
        ? record.error.name
        : typeof record.error;
    return JSON.stringify({ code, errorType }).slice(0, 256);
}

/**
 * Assign a server-owned correlation ID and prevent handled HTTP 500 responses
 * from exposing exception messages, paths, credentials, or upstream payloads.
 */
export function requestSecurityContext(req: Request, res: Response, next: NextFunction): void {
    const requestId = randomUUID();
    req.requestId = requestId;
    res.setHeader('X-Request-ID', requestId);

    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
        if (res.statusCode !== 500) return originalJson(body);

        logger.error(
            `Core Service | HTTP 500 ${req.method} ${req.path} `
            + `(requestId: ${requestId}, response: ${summarizeInternalBody(body)})`,
        );
        return originalJson({
            error: 'Internal server error',
            code: 'internal-error',
            requestId,
        });
    }) as Response['json'];

    next();
}

function isPayloadTooLarge(error: unknown): boolean {
    const candidate = error as { type?: unknown; status?: unknown; statusCode?: unknown };
    return candidate?.type === 'entity.too.large'
        || candidate?.status === 413
        || candidate?.statusCode === 413;
}

function isMalformedJson(error: unknown): boolean {
    const candidate = error as { type?: unknown; status?: unknown; statusCode?: unknown };
    return candidate?.type === 'entity.parse.failed'
        || candidate?.status === 400
        || candidate?.statusCode === 400;
}

/** Terminal parser/error policy installed after all routes. */
export const httpErrorHandler: ErrorRequestHandler = (error, req, res, _next) => {
    if (res.headersSent) {
        _next(error);
        return;
    }

    if (isPayloadTooLarge(error)) {
        res.status(413).json({
            error: 'Request body too large',
            code: 'request-body-too-large',
            requestId: req.requestId,
        });
        return;
    }
    if (isMalformedJson(error)) {
        res.status(400).json({
            error: 'Invalid JSON request body',
            code: 'invalid-json',
            requestId: req.requestId,
        });
        return;
    }

    res.status(500).json({
        error: 'Internal server error',
        code: 'internal-error',
        requestId: req.requestId,
    });
};

export function registerHttpErrorHandlers(app: express.Express): void {
    app.use(httpErrorHandler);
}
