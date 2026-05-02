import express from 'express';
import cors from 'cors';
import { createServer, type Server as HttpServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import type { AppConfig } from '@shared/interfaces';

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
    app.use(express.json({ limit: config.security.bodyLimit }));
    app.use(cors({ origin: corsOriginPolicy }));

    const httpServer = createServer(app);
    const io = new SocketIOServer(httpServer, {
        cors: {
            origin: corsOriginPolicy,
            methods: ['GET', 'POST']
        }
    });

    return { app, httpServer, io };
}
