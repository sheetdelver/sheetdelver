import { parentPort, workerData } from 'node:worker_threads';
import { initDataDir } from '@core/paths';
import { loadConfig } from '@core/config';
import { CoreSocket } from '@server/core/foundry/sockets/CoreSocket';
import { systemService } from '../SystemService';
import { WorldBootstrapper } from '../WorldBootstrapper';
import { checkInstalledWorldCompatibility } from './installedWorldCompatibility';
import { refreshRegistry } from '@modules/registry/server';
import { worldWorkGate } from '@server/core/world/WorldWorkGate';
import type { FoundryBootstrapSnapshot } from '@server/core/foundry/sockets/FoundrySocketEvents';
if (!parentPort) throw new Error('Read-only preparation requires its controller');
const port = parentPort;
let next = 0;
const calls = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
function rpc(rpc: string, type?: string, operation?: unknown) {
    return new Promise<unknown>((resolve, reject) => { const id = ++next; calls.set(id, { resolve, reject }); port.postMessage({ id, rpc, type, operation }); });
}
port.on('message', message => {
    const call = calls.get(message.id); if (!call) return; calls.delete(message.id);
    if (message.error) call.reject(new Error(message.error)); else call.resolve(message.value);
});
class PreparationTransport extends CoreSocket {
    constructor() { super(workerData.config); this.userId = workerData.userId; this.isSocketConnected = true; this.socket = { connected: true } as never; }
    override get connectionEpoch(): number { return workerData.epoch; }
    override async getBootstrapSnapshot(): Promise<FoundryBootstrapSnapshot | null> { return await rpc('bootstrap') as FoundryBootstrapSnapshot; }
    override async emitSocketEvent<T>(event: string, ...args: any[]): Promise<T> {
        if (event !== 'modifyDocument' || args[0]?.action !== 'get') throw new Error('Preparation permits source reads only');
        return await rpc('read', args[0].type, args[0].operation) as T;
    }
    override async connect(): Promise<void> { throw new Error('Preparation cannot create a Foundry transport'); }
}
try {
    initDataDir(workerData.dataDir); await loadConfig(); refreshRegistry();
    const transport = new PreparationTransport(); systemService.useMaintenanceTransport(transport);
    worldWorkGate.block('persistent-maintenance', { phase: 'preparing', message: 'Module upgrade in progress' });
    const bootstrap = new WorldBootstrapper({ checkDataCompatibility: (systemId, prepare) => checkInstalledWorldCompatibility(systemId, prepare, { readOnlyPreparation: true }) });
    await bootstrap.bootstrap(transport);
    if (!bootstrap.isReady()) throw new Error('Candidate preparation did not become ready');
    port.postMessage({ ready: true });
} catch (error) { port.postMessage({ error: error instanceof Error ? error.message : 'Candidate preparation failed' }); }
