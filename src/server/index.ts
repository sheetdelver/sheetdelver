import { resolveDataDir, initDataDir, checkLegacyPaths, getDataDir } from '@core/paths';
import { loadConfig } from '@core/config';
import { logger } from '@shared/utils/logger';
import { initializeRegistry } from '@modules/registry/server';
import { systemService } from '@server/services/world';
import { initAdminCredentialStore } from '@server/security/adminCredentialStore';
import { adminSessionManager } from '@server/security/adminSessionService';
import { createApp } from '@server/app/createApp';
import { registerMiddleware } from '@server/app/registerMiddleware';
import { registerSockets } from '@server/app/registerSockets';
import { registerRoutes } from '@server/app/registerRoutes';

async function startServer() {
    // Resolve and initialize the data directory before anything else.
    // All path getters (getCacheDir, getConfigFilePath, etc.) depend on this.
    const dataDir = resolveDataDir(process.argv);
    initDataDir(dataDir);
    logger.info(`Core Service | Data directory: ${getDataDir()}`);

    // Check for legacy data paths and warn the operator
    const legacyWarnings = checkLegacyPaths();
    for (const msg of legacyWarnings) {
        logger.warn(msg);
    }

    const config = await loadConfig();
    if (!config) {
        logger.error('Core Service | Could not load configuration. Exiting.');
        process.exit(1);
    }

    // Initialize Universal Logger with configured level
    logger.setLevel(config.debug.level);
    logger.info(`Core Service | Logger initialized at level: ${config.debug.level}`);

    // Initialize Admin Credential Store with optional pepper
    initAdminCredentialStore(config.security.adminPepper);

    // Initialize Admin Session Manager
    adminSessionManager.initialize();

    // Boot-Time System Discovery
    initializeRegistry();

    // Global Error Handlers (Diagnostic for silent kills/crashes)
    if (config.debug.level >= 4) {
        process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
            logger.error(`\x1b[31m[FATAL] Unhandled Rejection at: ${promise} reason: ${reason?.stack || reason}\x1b[0m`);
            process.exit(1);
        });

        process.on('uncaughtException', (err: Error) => {
            logger.error(`\x1b[31m[FATAL] Uncaught Exception: ${err.stack || err}\x1b[0m`);
            process.exit(1);
        });
    }

    const { apiPort } = config.app;
    const corePort = process.env.PORT ? parseInt(process.env.PORT) : (process.env.API_PORT ? parseInt(process.env.API_PORT) : apiPort);

    // Entrypoint is now orchestration-only: compose transports, sockets, routes, then listen.
    const { app, httpServer, io } = createApp(config);
    registerMiddleware(app);

    // Initialize Session Manager with Service Account
    const { SessionManager } = await import('@core/session/SessionManager');
    const sessionManager = new SessionManager({
        ...config.foundry
    });

    // Start System Provider
    await systemService.initialize(config.foundry);

    // Per ADR-0022 Phase 2, SessionManager (in `core/`) does not import from
    // `services/`. Wire the readiness probe and world-lifecycle listener here
    // from the composition root.
    sessionManager.setSystemReadinessProbe(() => systemService.isReady());
    systemService.on('world:connected', (data: { state: string }) => {
        if (data?.state === 'setup') sessionManager.handleWorldEnteredSetup();
    });

    // Register realtime pipelines before route mounts so lifecycle events are ready at startup.
    const { getSystemStatusPayload } = registerSockets({ io, sessionManager, config });

    // Initialize Session storage in background
    sessionManager.initialize().catch(err => {
        logger.error(`Core Service | SessionManager initialization failed: ${err.message}`);
    });

    // Compose all HTTP route domains (public/protected/debug/module/admin) with preserved mount order.
    registerRoutes({
        app,
        config,
        sessionManager,
        getSystemStatusPayload,
        io,
    });

    const coreHost = '127.0.0.1';
    httpServer.listen(corePort, coreHost, () => {
        logger.info(`Core Service | Silent Daemon running on http://${coreHost}:${corePort}`);
        logger.info(`Core Service | App API: http://${coreHost}:${corePort}/api`);
        logger.info(`Core Service | Admin API: http://${coreHost}:${corePort}/admin (Localhost Only)`);
    });
}

startServer().catch(err => {
    logger.error('Core Service | Unhandled startup error:', err);
    process.exit(1);
});
