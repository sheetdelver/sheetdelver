import { run as runFoundryStateHelpers } from './foundry-state-helpers.test';
import { run as runRuntimeSurface } from './runtime-surface.test';
import { run as runSharedContentRealtime } from './shared-content-realtime.test';

export function run() {
    runFoundryStateHelpers();
    runRuntimeSurface();
    runSharedContentRealtime();
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run();
    console.log('client unit tests passed');
}
