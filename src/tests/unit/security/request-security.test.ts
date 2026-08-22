import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import type { AppConfig } from '@shared/interfaces';
import { createApp } from '@server/app/createApp';
import { registerHttpErrorHandlers } from '@server/security/httpRequestSecurity';

function createTestConfig(): AppConfig {
    return {
        app: {
            host: '127.0.0.1',
            port: 0,
            apiPort: 0,
            adminOrigin: 'http://127.0.0.1',
            protocol: 'http',
            chatHistory: 10,
            version: 'test',
            url: 'http://127.0.0.1',
        },
        foundry: {
            host: '127.0.0.1',
            port: 30000,
            protocol: 'http',
            url: 'http://127.0.0.1:30000',
        },
        debug: { enabled: false, level: 0 },
        security: {
            rateLimit: { enabled: false, windowMinutes: 1, maxAttempts: 10 },
            bodyLimit: '64kb',
            adminAllowedNetworks: ['127.0.0.1/32'],
            modulePolicy: {
                minimumTrustTier: 'first-party',
                allowUnverifiedInDevelopment: false,
                requireAdminOverrideForLowerTrust: true,
                requirePermissionEscalationApproval: true,
            },
            cors: { allowAllOrigins: false, allowedOrigins: ['http://127.0.0.1'] },
        },
    };
}

export async function run() {
    const { app, httpServer, io } = createApp(createTestConfig());
    app.post('/api/login', (_req, res) => res.json({ accepted: true }));
    app.post('/admin/auth/login', (_req, res) => res.json({ accepted: true }));
    app.post('/api/modules/example/ui-error', (_req, res) => res.json({ accepted: true }));
    app.post('/api/documents', (_req, res) => res.json({ accepted: true }));
    app.post('/api/malformed', (_req, res) => res.json({ accepted: true }));
    app.get('/api/failure', (_req, res) => {
        res.status(500).json({
            error: 'token=secret-value at /private/server/path',
            code: 'database/failure',
        });
    });
    registerHttpErrorHandlers(app);

    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const { port } = httpServer.address() as AddressInfo;
    const origin = `http://127.0.0.1:${port}`;

    try {
        assert.equal((io as any).opts.maxHttpBufferSize, 256 * 1024);
        assert.equal((io as any).opts.perMessageDeflate, false);

        // Credential endpoints use their small parser even though document
        // mutation routes retain the configured larger compatibility limit.
        const largeBody = JSON.stringify({ password: 'x'.repeat(9 * 1024) });
        const loginResponse = await fetch(`${origin}/api/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: largeBody,
        });
        assert.equal(loginResponse.status, 413);
        const loginError = await loginResponse.json() as Record<string, unknown>;
        assert.equal(loginError.code, 'request-body-too-large');
        assert.equal(loginError.requestId, loginResponse.headers.get('x-request-id'));

        const adminResponse = await fetch(`${origin}/admin/auth/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ password: 'x'.repeat(17 * 1024) }),
        });
        assert.equal(adminResponse.status, 413);

        const moduleHealthResponse = await fetch(`${origin}/api/modules/example/ui-error`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ message: 'x'.repeat(5 * 1024) }),
        });
        assert.equal(moduleHealthResponse.status, 413);

        const documentResponse = await fetch(`${origin}/api/documents`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: largeBody,
        });
        assert.equal(documentResponse.status, 200);

        const malformedResponse = await fetch(`${origin}/api/malformed`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{',
        });
        assert.equal(malformedResponse.status, 400);
        assert.equal((await malformedResponse.json() as Record<string, unknown>).code, 'invalid-json');

        const failureResponse = await fetch(`${origin}/api/failure`, {
            headers: { 'x-request-id': 'caller-controlled' },
        });
        assert.equal(failureResponse.status, 500);
        const failureBody = await failureResponse.json() as Record<string, unknown>;
        assert.equal(failureBody.error, 'Internal server error');
        assert.equal(failureBody.code, 'internal-error');
        assert.notEqual(failureBody.requestId, 'caller-controlled');
        assert.equal(failureBody.requestId, failureResponse.headers.get('x-request-id'));
        assert.equal(JSON.stringify(failureBody).includes('secret-value'), false);
        assert.equal(JSON.stringify(failureBody).includes('/private/server/path'), false);
    } finally {
        await new Promise<void>((resolve) => io.close(() => resolve()));
    }
}
