import { loadConfig } from '@core/config';
import type { CoreSocket } from '@core/foundry/sockets/CoreSocket';
import { getDataDir, initDataDir, resolveDataDir } from '@core/paths';
import { worldBootstrapper } from '@server/services/world/WorldBootstrapper';
import type { AppConfig } from '@shared/interfaces';

/** Initialize direct socket-test entrypoints without overriding runner-owned paths. */
export async function loadSocketTestConfig(): Promise<AppConfig> {
    try {
        getDataDir();
    } catch {
        initDataDir(resolveDataDir(process.argv));
    }

    const config = await loadConfig();
    if (!config) throw new Error('Failed to load configuration');
    return config;
}

/**
 * Socket tests instantiate CoreSocket without SystemService, so they must invoke
 * the bootstrap owner explicitly before reading application stores.
 */
export async function bootstrapSocketTestWorld(client: CoreSocket): Promise<void> {
    worldBootstrapper.reset('socket-test-before-bootstrap');
    await worldBootstrapper.bootstrap(client);
}

/** Let the next socket case bootstrap its own transport and world snapshot. */
export function resetSocketTestWorld(): void {
    worldBootstrapper.reset('socket-test-complete');
}
