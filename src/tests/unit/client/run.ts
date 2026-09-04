import { run as runFoundryStateHelpers } from './foundry-state-helpers.test';
import { run as runRuntimeSurface } from './runtime-surface.test';
import { run as runSharedContentRealtime } from './shared-content-realtime.test';
import { run as runDocumentSource } from './document-source.test';
import { run as runSdkEventBus } from './sdk-event-bus.test';
import { run as runCoalescedFetch } from './coalesced-fetch.test';
import { run as runCombatHudState } from './combat-hud-state.test';
import { run as runJournalOrdering } from './journal-ordering.test';
import { run as runGenericSheetFieldState } from './generic-sheet-field-state.test';

export async function run() {
    runFoundryStateHelpers();
    runRuntimeSurface();
    runSharedContentRealtime();
    await runDocumentSource();
    runSdkEventBus();
    await runCoalescedFetch();
    runCombatHudState();
    runJournalOrdering();
    runGenericSheetFieldState();
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('client unit tests passed'))
        .catch((error) => { console.error(error); process.exit(1); });
}
