import express from 'express';
import cors from 'cors';
import { createServer, type Server as HttpServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import type { AppConfig } from '@shared/interfaces';
import { createJsonBodyParser, requestSecurityContext } from '@server/security/httpRequestSecurity';
import {
    createSocketConnectionLimiter,
    SOCKET_TRANSPORT_LIMITS,
} from '@server/security/socketConnectionPolicy';

interface AppRuntime {
    app: express.Express;
    httpServer: HttpServer;
    io: SocketIOServer;
}

export function createApp(config: AppConfig): AppRuntime {
    // Keep HTTP and socket transports on the same origin policy to avoid drift.
    const corsOriginPolicy = config.security.cors.allowAllOrigins ? true : config.security.cors.allowedOrigins;

    const app = express();
    // Trust proxy headers (safe if always behind a trusted proxy)
    // Trust loopback proxy (e.g. NGINX/Caddy on same host) to securely handle X-Forwarded-For headers
    app.set('trust proxy', 'loopback');
    app.use(requestSecurityContext);
    app.use(createJsonBodyParser(config.security.bodyLimit));
    app.use(cors({ origin: corsOriginPolicy, credentials: true }));

    const httpServer = createServer(app);
    const io = new SocketIOServer(httpServer, {
        cors: {
            origin: corsOriginPolicy,
            methods: ['GET', 'POST'],
            credentials: true,
        },
        ...SOCKET_TRANSPORT_LIMITS,
    });

    // Transport abuse is rejected before the gateway restores any user session.
    io.use(createSocketConnectionLimiter());

    return { app, httpServer, io };
}
