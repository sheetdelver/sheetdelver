import fs from 'node:fs';
import path from 'node:path';
import { initDataDir, resolveDataDir } from '@server/core/paths';
import { run as runModuleLifecycleDependencies } from './module-lifecycle-dependencies.test';

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
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('integration test suite passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
