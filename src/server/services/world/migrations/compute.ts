import { Worker } from 'node:worker_threads';
import type { ResolvedMigrationCatalog } from '@modules/registry/migrations/catalog';
import type { MigrationTarget } from '@shared/sdk/migrations';
import type { ModuleWorldSnapshot } from '@shared/sdk/world';
import type { MigrationWorldPlan } from './planner';
import { getMaintenanceComputationSignal } from '@server/core/world/MaintenanceMode';

export interface MigrationComputeProgress { checked: number; total: number; planned: number; stepId: string; phase?: string; confirmed?: number; uncertain?: number; discovered?: number; remaining?: number }
/** No whole-job deadline. CPU work and per-hook VMs run outside the HTTP loop. */
export async function computeWorldMigrations(root: string, catalog: ResolvedMigrationCatalog, world: Readonly<ModuleWorldSnapshot>,
    sources: MigrationTarget[], checkOnly = false, exclusions: string[] = [], onProgress?: (progress: MigrationComputeProgress) => void): Promise<MigrationWorldPlan> {
    const entry = new URL('./computeWorker.ts', import.meta.url).href;
    const worker = new Worker(`const {workerData,parentPort}=require('node:worker_threads');
        import('tsx/esm/api').then(async ({tsImport})=>{await tsImport(workerData.entry,${JSON.stringify(import.meta.url)});}).catch(error=>{parentPort.postMessage({error:String(error.stack||error)})});`,
    { eval: true, workerData: { entry, root, catalog, world, sources, checkOnly, exclusions } });
    try { return await new Promise<MigrationWorldPlan>((resolve, reject) => {
        let settled = false;
        const signal = getMaintenanceComputationSignal();
        const abort = () => { settled = true; void worker.terminate(); reject(new Error('Maintenance computation stopped; no partial plan is approved')); };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        worker.on('message', message => {
            if (settled) return;
            if (message.progress) { onProgress?.(message.progress); return; }
            settled = true;
            signal?.removeEventListener('abort', abort);
            if (message.error) reject(new Error(message.error)); else resolve(message.plan);
        });
        worker.on('error', reject);
        worker.on('exit', code => { signal?.removeEventListener('abort', abort); if (!settled) reject(new Error(`Migration computation worker exited (${code}); no partial plan is approved`)); });
    }); } finally { await worker.terminate(); }
}
