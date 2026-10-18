import fs from 'node:fs';
import path from 'node:path';
import { initDataDir, resolveDataDir } from '@server/core/paths';
import { run as runModuleLifecycleDependencies } from './module-lifecycle-dependencies.test';
import { run as runModuleUpgradeBoundaries } from './module-upgrade-boundaries.test';
import { run as runAdr0064Corrections } from './adr0064-corrections.test';
import { run as runCompleteMaintenance } from './complete-maintenance.test';
import { run as runMigrationAttention } from './migration-attention.test';
import { run as runG8Corrections } from './adr0064-g8.test';

function initializeIntegrationDataDir() {
    const testDataDir = path.join(process.cwd(), 'temp', 'integration-test-data');
    if (fs.existsSync(testDataDir)) {
        fs.rmSync(testDataDir, { recursive: true, force: true });
    }
    initDataDir(resolveDataDir(['--data-dir', testDataDir]));
}

export async function run() {
    initializeIntegrationDataDir();
    await runModuleLifecycleDependencies();
    await runModuleUpgradeBoundaries();
    await runAdr0064Corrections();
    await runCompleteMaintenance();
    await runMigrationAttention();
    await runG8Corrections();
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('integration test suite passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
