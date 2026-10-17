import { Worker } from 'node:worker_threads';
import { getDataDir } from '@core/paths';
import { getConfig } from '@core/config';
import type { CoreSocket } from '@server/core/foundry/sockets/CoreSocket';
import { getMaintenanceComputationSignal } from '@server/core/world/MaintenanceMode';

/** Candidate timers/callbacks never survive this read-only preparation worker. */
export async function prepareIsolated(transport: CoreSocket): Promise<void> {
    const epoch = transport.connectionEpoch;
    const worker = new Worker(`const {workerData,parentPort}=require('node:worker_threads');
        require('tsx/cjs/api').register();
        import('tsx/esm/api').then(async({register})=>{register();await import(workerData.entry)}).catch(e=>parentPort.postMessage({error:String(e.stack||e)}));`,
    { eval: true, execArgv: [], workerData: { entry: new URL('./prepareWorker.ts', import.meta.url).href, dataDir: getDataDir(),
        userId: transport.userId, epoch, config: getConfig().foundry } });
    try {
        await new Promise<void>((resolve, reject) => {
            let done = false;
            const signal = getMaintenanceComputationSignal();
            const abort = () => { done = true; void worker.terminate(); reject(new Error('Candidate preparation stopped; maintenance retained')); };
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) { abort(); return; }
            worker.on('message', async message => {
                if (done) return;
                if (message.rpc) {
                    try {
                        if (!transport.isConnected || transport.connectionEpoch !== epoch) throw new Error('Preparation transport retired');
                        const value = message.rpc === 'bootstrap' ? await transport.getBootstrapSnapshot()
                            : await transport.readDocumentSources(message.type, message.operation);
                        if (!done && worker.threadId !== -1) worker.postMessage({ id: message.id, value });
                    } catch (error) { if (!done && worker.threadId !== -1) worker.postMessage({ id: message.id, error: error instanceof Error ? error.message : 'Preparation source unavailable' }); }
                } else if (message.ready) { done = true; resolve(); }
                else if (message.error) { done = true; reject(new Error(message.error)); }
            });
            worker.on('error', reject);
            worker.on('exit', code => { signal?.removeEventListener('abort', abort); if (!done) reject(new Error(`Preparation worker exited (${code}); maintenance retained`)); });
        });
    } finally { await worker.terminate(); }
}
