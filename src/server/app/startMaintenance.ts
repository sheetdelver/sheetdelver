import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AppConfig } from '@shared/interfaces';
import { createApp } from './createApp';
import { maintenanceShell } from './maintenanceShell';
import { createAdminRouter } from '@server/routes/admin/createAdminRouter';
import { CoreSocket } from '@server/core/foundry/sockets/CoreSocket';
import { FoundryEventIngress } from '@server/services/world/FoundryEventIngress';
import { systemService } from '@server/services/world/SystemService';
import { worldStateStore } from '@server/core/world/WorldStateStore';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import { settingStore } from '@server/core/documents/primary/settings/SettingStore';
import { compendiumStore } from '@server/core/compendium/CompendiumStore';
import { serviceAccountAuthority } from '@server/core/world/ServiceAccountAuthority';
import { dispatchCoreMutation, worldWorkGate } from '@server/core/world/WorldWorkGate';
import { moduleWorldContext } from '@server/services/world/ModuleWorldContextService';
import { readMaintenanceMode, saveMaintenanceMode } from '@server/core/world/MaintenanceMode';
import { MaintenanceController, installMaintenanceController } from '@server/services/world/migrations/MaintenanceController';
import { getUpgradeJournal } from '@server/services/world/migrations/ModuleUpgradeService';
import { requestFullStackRestart } from '@shared/runtime/fullStackRestart';
import { adminSessionManager } from '@server/security/adminSessionService';
import { migrationReason } from '@server/services/world/migrations/planner';
import { logger } from '@shared/utils/logger';
import { registerHttpErrorHandlers } from '@server/security/httpRequestSecurity';

export async function startMaintenance(config: AppConfig, corePort: number): Promise<void> {
    worldWorkGate.block('persistent-maintenance', { phase: 'isolated', message: 'Module upgrade in progress' });
    const client = new CoreSocket(config.foundry);
    client.setOperationGuard(send => {
        if (!client.isConnected || !serviceAccountAuthority.checkCurrent(userStore.get(client.userId ?? ''))) throw new Error('Maintenance authority/transport unavailable');
        return dispatchCoreMutation(send);
    });
    systemService.useMaintenanceTransport(client);
    const detach = new FoundryEventIngress({ observationOnly: true }).attach(client);
    client.on('disconnect', () => serviceAccountAuthority.retire());
    const restart = () => { adminSessionManager.prepareSupervisedRestartHandoff(); setTimeout(() => requestFullStackRestart(), 300); };
    const controller = new MaintenanceController(client, restart); installMaintenanceController(controller);
    const { app, httpServer, io } = createApp(config);
    const status = () => ({ connected: client.isConnected, initialized: false, isConfigured: true,
        isAuthenticated: false, currentUserId: null, users: [], system: { id: null, status: 'startup' },
        appVersion: config.app.version, runtimeToken: worldWorkGate.getServingToken(),
        maintenance: { phase: readMaintenanceMode()?.stage ?? 'recovery-required', message: 'Module upgrade in progress' } });
    app.get(['/api/status', '/api/config'], (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(status()); });
    app.get(['/', '/admin', '/admin/modules'], (_req, res) => {
        const nonce = randomBytes(18).toString('base64');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'`);
        res.type('html').send(maintenanceShell.replace('<script>', `<script nonce="${nonce}">`));
    });
    app.use('/admin', createAdminRouter({ maintenance: true, getSystemStatusPayload: async () => status(), broadcastToClients: () => {} }));
    app.use((_req, res) => res.status(503).json({ error: 'World unavailable — maintenance required', code: 'WORLD_WORK_UNAVAILABLE' }));
    registerHttpErrorHandlers(app);
    // No normal gateway, credential lookup, engagement, or gameplay listeners.
    io.on('connection', socket => { socket.emit('systemStatus', status()); });
    const publish = setInterval(() => io.emit('systemStatus', status()), 4000);
    await new Promise<void>(resolve => httpServer.listen(corePort, '127.0.0.1', resolve));
    const shellServer = createServer(app); io.attach(shellServer);
    await new Promise<void>(resolve => shellServer.listen(config.app.port, config.app.host, resolve));
    logger.info(`Maintenance | Restricted Core pid=${process.pid}; shell=${config.app.port}; API=${corePort}. No Next/player/session/module workers.`);
    let stopped = false; let epoch = -1; let retried = false;
    const stop = () => { stopped = true; clearInterval(publish); detach(); client.disconnect(); io.close(); shellServer.close(); httpServer.close(); };
    process.once('SIGINT', () => { stop(); process.exit(0); });
    process.once('SIGTERM', () => { stop(); process.exit(0); });
    const poll = async () => {
        try {
            if (readMaintenanceMode()?.diagnosticOnly) return;
            if (!client.isConnected) { await client.connect(); epoch = -1; }
            if (client.isConnected && epoch !== client.connectionEpoch) {
                const snapshot = await client.getBootstrapSnapshot();
                if (!snapshot) throw new Error('Maintenance world snapshot unavailable');
                const data = snapshot.gameData;
                serviceAccountAuthority.verify(data, config.foundry.username ?? '', client.userId);
                worldStateStore.seed(data);
                await userStore.seed(async () => data.users);
                const settings = await client.readDocumentSources('Setting', { query: {} }) as { result: never[] };
                await settingStore.seed(async () => settings.result);
                compendiumStore.seedPackMetadataFromGameData(data);
                const candidate = controller.candidate();
                moduleWorldContext.configure(config.foundry.url!, { worldId: data.world.id, systemId: data.system.id,
                    systemVersion: data.system.version, foundryGeneration: data.release.generation, foundryBuild: String(data.release.build), runtimeEpoch: client.connectionEpoch }, candidate.info.worldSettings);
                let mode = readMaintenanceMode()!;
                const identity = moduleWorldContext.snapshot().identity;
                if (mode.world && (mode.world.instanceId !== identity.instanceId || mode.world.worldId !== identity.worldId || mode.world.systemId !== identity.systemId)) throw new Error('Maintenance is pinned to another world/instance; restore the selected world');
                const lease = mode.jobId ? getUpgradeJournal().job(mode.jobId) : { jobId: mode.id, moduleId: mode.moduleId, plan: getUpgradeJournal().preview(mode.candidateId!).plan };
                try { getUpgradeJournal().assertLease({ ...lease, leaseToken: mode.leaseToken ?? '' }); }
                catch { mode.leaseToken = getUpgradeJournal().acquire(lease); saveMaintenanceMode(mode); }
                if (mode.jobId) {
                    const job = getUpgradeJournal().job(mode.jobId);
                    job.leaseToken = mode.leaseToken!; getUpgradeJournal().assertLease(job);
                    getUpgradeJournal().save(job); // transfer verified ownership, never approval/outcomes
                }
                epoch = client.connectionEpoch;
                mode = readMaintenanceMode()!;
                if (!retried && ['entering', 'isolated', 'planning', 'executing'].includes(mode.stage)) {
                    retried = true;
                    void (mode.jobId ? controller.resume() : controller.plan()).catch(() => undefined);
                }
            }
        } catch (error) {
            const mode = readMaintenanceMode()!; mode.stage = 'recovery-required'; mode.failure = migrationReason(error); saveMaintenanceMode(mode);
            logger.warn(`Maintenance | ${mode.failure}`);
        } finally { if (!stopped) setTimeout(() => { void poll(); }, 5000); }
    };
    void poll();
}
