import { parentPort, workerData } from 'node:worker_threads';
import { planWorldMigrations } from './planner';
if (!parentPort) throw new Error('Migration computation requires an owned worker');
try {
    const { root, catalog, world, sources, checkOnly, exclusions } = workerData;
    const plan = planWorldMigrations(root, catalog, world, sources, checkOnly, exclusions, progress => parentPort!.postMessage({ progress }));
    parentPort.postMessage({ plan });
} catch (error) { parentPort.postMessage({ error: error instanceof Error ? error.message : 'Migration computation failed' }); }
