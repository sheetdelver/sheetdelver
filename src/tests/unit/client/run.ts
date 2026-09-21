import { run as runModulePresentation } from './module-presentation.test';
import { run as runDiceViewport } from './dice-viewport.test';
import { run as runDiceTrayLifecycle } from './dice-tray-lifecycle.test';
import { run as runDiceFollowups } from './dice-followups.test';
import { run as runDiceDisposal } from './dice-disposal.test';
import { run as runChatToast } from './chat-toast.test';
import { run as runUiContextStability } from './ui-context-stability.test';
import { run as runDiceBehavior } from './dice-behavior.test';
import { run as runDiceAppearance } from './dice-appearance.test';
import { run as runDiceAudio } from './dice-audio.test';
import { run as runDicePresentation } from './dice-presentation.test';
import { run as runFoundryStateHelpers } from './foundry-state-helpers.test';
import { run as runRuntimeSurface } from './runtime-surface.test';
import { run as runSharedContentRealtime } from './shared-content-realtime.test';
import { run as runDocumentSource } from './document-source.test';
import { run as runSdkEventBus } from './sdk-event-bus.test';
import { run as runCoalescedFetch } from './coalesced-fetch.test';
import { run as runCombatHudState } from './combat-hud-state.test';
import { run as runJournalOrdering } from './journal-ordering.test';
import { run as runGenericSheetFieldState } from './generic-sheet-field-state.test';
import { run as runGenericSheet } from './generic-sheet.test';
import { run as runCatalogReleaseState } from './catalog-release-state.test';

import { run as runNotifications } from './notification-store.test';
import { run as runChatPresentation } from './chat-presentation.test';

export async function run() {
    runModulePresentation();
    runDiceViewport();
    runNotifications();
    runChatPresentation();
    runDiceDisposal();
    runChatToast();
    runUiContextStability();
    runFoundryStateHelpers();
    runRuntimeSurface();
    runSharedContentRealtime();
    await runDocumentSource();
    runSdkEventBus();
    await runCoalescedFetch();
    runCombatHudState();
    runJournalOrdering();
    runGenericSheetFieldState();
    runGenericSheet();
    runCatalogReleaseState();
    runDicePresentation();
    runDiceFollowups();
    runDiceTrayLifecycle();
    runDiceAppearance();
    runDiceBehavior();
    await runDiceAudio();
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('client unit tests passed'))
        .catch((error) => { console.error(error); process.exit(1); });
}
