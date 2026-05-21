import path from 'node:path';
import { resolveDataDir, initDataDir } from '../../server/core/paths';

// ── utils ────────────────────────────────────────────────────────────────────
import { run as runFoundryUrl } from './utils/foundry-url.test';

// ── services ──────────────────────────────────────────────────────────────────
import { run as runStatusSanitize } from './services/status-sanitize.test';
import { run as runLocalhostPolicy } from './services/localhost-policy.test';
import { run as runAuthStatusSmoke } from './services/auth-status-smoke.test';
import { run as runChatService } from './services/chat-service.test';
import { run as runSyncTokenService } from './services/sync-token-service.test';
import { run as runEngagementService } from './services/engagement-service.test';

// ── sockets ───────────────────────────────────────────────────────────────────
import { run as runRealtimeBroadcaster } from './sockets/realtime-broadcaster.test';
import { run as runAppSocketGateway } from './sockets/app-socket-gateway.test';
import { run as runClientSocketTransport } from './sockets/client-socket-transport.test';

// ── actors ────────────────────────────────────────────────────────────────────
import { run as runActorCombatSmoke } from './actors/actor-combat-smoke.test';
import { run as runActorStore } from './actors/actor-store.test';
import { run as runActorNormalization } from './actors/actor-normalization.test';

// ── combat ────────────────────────────────────────────────────────────────────
import { run as runCombatSort } from './combat/combat-sort.test';
import { run as runCombatStore } from './combat/combat-store.test';

// ── documents ─────────────────────────────────────────────────────────────────
import { run as runPrimaryDocumentBase } from './documents/primary-document-base.test';
import { run as runChatMessageStore } from './documents/chat-message-store.test';
import { run as runFolderStore } from './documents/folder-store.test';
import { run as runUserStore } from './documents/user-store.test';
import { run as runJournalSmoke } from './documents/journal-smoke.test';
import { run as runJournalStore } from './documents/journal-store.test';
import { run as runItemStore } from './documents/item-store.test';
import { run as runRollTableStore } from './documents/roll-table-store.test';
import { run as runMacroStore } from './documents/macro-store.test';
import { run as runPlaylistStore } from './documents/playlist-store.test';
import { run as runCardsStore } from './documents/cards-store.test';
import { run as runStubStores } from './documents/stub-stores.test';
import { run as runSharedContentStore } from './documents/shared-content-store.test';
import { run as runDocumentResolver } from './documents/document-resolver.test';

// ── routing ───────────────────────────────────────────────────────────────────
import { run as runModifyDocumentRouter } from './routing/modify-document-router.test';
import { run as runOwnershipHelpers } from './routing/ownership.test';
import { run as runRouteOwnershipThresholds } from './routing/route-ownership-thresholds.test';

// ── compendium ────────────────────────────────────────────────────────────────
import { run as runCompendiumStore } from './compendium/compendium-store.test';
import { run as runCompendiumService } from './compendium/compendium-service.test';
import { run as runDiscoveryShardStore } from './compendium/discovery-shard-store.test';
import { run as runDiscoveryService } from './compendium/discovery-service.test';
import { run as runModuleContextDiscovery } from './compendium/module-context-discovery.test';

// ── world ─────────────────────────────────────────────────────────────────────
import { run as runWorldStateStore } from './world/world-state-store.test';
import { run as runWorldLifecycleStore } from './world/world-lifecycle-store.test';
import { run as runWorldBootstrapper } from './world/world-bootstrapper.test';

// ── admin ─────────────────────────────────────────────────────────────────────
import { run as runAdminCredentialStore } from './admin/admin-credential-store.test';
import { run as runAdminSessionService } from './admin/admin-session-service.test';
import { run as runAdminAuthMiddleware } from './admin/admin-auth-middleware.test';
import { run as runAdminCsrfMiddleware } from './admin/admin-csrf-middleware.test';
import { run as runAdminRateLimiter } from './admin/admin-rate-limiter.test';
import { run as runAdminAuditLog } from './admin/admin-audit-log.test';

// ── modules ───────────────────────────────────────────────────────────────────
import { run as runModuleProxyMatcher } from './modules/module-proxy-matcher.test';
import { run as runModuleLifecycleState } from './modules/module-lifecycle-state.test';
import { run as runModuleManifestValidation } from './modules/module-manifest-validation.test';
import { run as runModuleRegistryManager } from './modules/module-registry-manager.test';
import { run as runModuleLifecycleTransitions } from './modules/module-lifecycle-transitions.test';
import { run as runModuleManagerOperations } from './modules/module-manager-operations.test';
import { run as runModuleManagerGovernance } from './modules/module-manager-governance.test';
import { run as runModulePolicyConfig } from './modules/module-policy-config.test';
import { run as runModuleTrustPolicy } from './modules/module-trust-policy.test';
import { run as runModuleArtifactVerification } from './modules/module-artifact-verification.test';
import { run as runModulePermissionPolicy } from './modules/module-permission-policy.test';
import { run as runModuleCompatibilityResolver } from './modules/module-compatibility-resolver.test';
import { run as runModuleCompatibilityMatrix } from './modules/module-compatibility-matrix.test';
import { run as runModuleCompatibilityLifecycleIntegration } from './modules/module-compatibility-lifecycle-integration.test';
import { run as runModuleIndexModel } from './modules/module-index-model.test';
import { run as runModuleSourceAdapters } from './modules/module-source-adapters.test';
import { run as runModuleManagerDryRun } from './modules/module-manager-dry-run.test';
import { run as runModuleManagerTelemetry } from './modules/module-manager-telemetry.test';
import { run as runModuleInitScaffold } from './modules/module-init-scaffold.test';

// ── sdk ───────────────────────────────────────────────────────────────────────
import { run as runSdkIntegrity } from './sdk/sdk-integrity.test';

async function runAllUnitTests() {
    // Initialize test data directory before running any tests
    const fs = await import('node:fs');
    const testDataDir = path.join(process.cwd(), 'temp', 'test-data');
    if (fs.existsSync(testDataDir)) {
        fs.rmSync(testDataDir, { recursive: true, force: true });
    }
    initDataDir(resolveDataDir(['--data-dir', testDataDir]));

    runFoundryUrl();
    runStatusSanitize();
    runLocalhostPolicy();
    runSyncTokenService();
    await runEngagementService();
    await runAuthStatusSmoke();
    await runActorCombatSmoke();
    await runActorStore();
    await runPrimaryDocumentBase();
    await runChatMessageStore();
    await runFolderStore();
    await runChatService();
    await runModifyDocumentRouter();
    await runUserStore();
    runCombatSort();
    runModuleProxyMatcher();
    runModuleLifecycleState();
    runModuleManifestValidation();
    await runModuleRegistryManager();
    await runActorNormalization();
    await runJournalStore();
    await runJournalSmoke();
    await runCombatStore();
    await runItemStore();
    await runOwnershipHelpers();
    await runRouteOwnershipThresholds();
    await runRollTableStore();
    await runMacroStore();
    await runPlaylistStore();
    await runCardsStore();
    await runStubStores();
    await runWorldStateStore();
    await runWorldLifecycleStore();
    await runWorldBootstrapper();
    await runSharedContentStore();
    await runDocumentResolver();
    await runCompendiumStore();
    await runCompendiumService();
    await runDiscoveryShardStore();
    await runDiscoveryService();
    await runModuleContextDiscovery();
    await runClientSocketTransport();
    await runRealtimeBroadcaster();
    await runAppSocketGateway();
    await runAdminCredentialStore();
    await runAdminSessionService();
    await runAdminAuthMiddleware();
    await runAdminCsrfMiddleware();
    await runAdminRateLimiter();
    await runAdminAuditLog();
    runModuleLifecycleTransitions();
    await runModuleManagerOperations();
    await runModuleManagerGovernance();
    runModulePolicyConfig();
    runModuleTrustPolicy();
    runModuleArtifactVerification();
    runModulePermissionPolicy();
    runModuleCompatibilityResolver();
    runModuleCompatibilityMatrix();
    await runModuleCompatibilityLifecycleIntegration();
    runModuleIndexModel();
    runModuleSourceAdapters();
    await runModuleManagerDryRun();
    await runModuleManagerTelemetry();
    await runSdkIntegrity();
    await runModuleInitScaffold();
}

runAllUnitTests()
    .then(() => {
        console.log('unit test suite passed');
    })
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
