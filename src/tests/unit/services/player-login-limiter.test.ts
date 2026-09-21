import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { AppConfig } from '../../../shared/interfaces';
import { createLoginLimiter } from '../../../server/middleware/rateLimiters';

export async function run() {
    const env: Record<string, string | undefined> = process.env;
    const previousMode = env.NODE_ENV;
    try {
        for (const mode of ['production', 'development', undefined]) {
            if (mode === undefined) delete env.NODE_ENV;
            else env.NODE_ENV = mode;
            const config = { security: { rateLimit: { enabled: true, windowMinutes: 1, maxAttempts: 2 } } } as AppConfig;
            const app = express();
            app.post('/login', createLoginLimiter(config), (req, res) => {
                res.status(req.query.fail ? 401 : 200).json({ success: !req.query.fail });
            });
            const server = app.listen(0, '127.0.0.1');
            try {
                await new Promise<void>(resolve => server.once('listening', resolve));
                const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/login`;
                const login = (failure = false) => fetch(url + (failure ? '?fail=1' : ''), { method: 'POST' });
                for (let i = 0; i < 6; i++) assert.equal((await login()).status, 200, 'Success must not exhaust attempts');
                assert.equal((await login(true)).status, 401);
                assert.equal((await login(true)).status, 401);
                const blocked = await login(true);
                assert.equal(blocked.status, mode === 'development' ? 401 : 429);
                if (mode !== 'development') {
                    assert.ok(Number(blocked.headers.get('retry-after')) <= 60);
                    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
                }
                config.security.rateLimit.enabled = false;
                assert.equal((await login(true)).status, 401, 'Explicit disable bypasses throttling');
            } finally {
                server.closeAllConnections();
                await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
            }
        }
    } finally {
        if (previousMode === undefined) delete env.NODE_ENV;
        else env.NODE_ENV = previousMode;
    }
    console.log('Player login limiter tests passed');
}

if (import.meta.url === `file://${process.argv[1]}`) run().catch(error => { console.error(error); process.exitCode = 1; });
