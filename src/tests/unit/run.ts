import path from 'node:path';
import { resolveDataDir, initDataDir } from '../../server/core/paths';
import { run as runStatusSanitize } from './status-sanitize.test';
import { run as runLocalhostPolicy } from './localhost-policy.test';
import { run as runRealtimeBroadcaster } from './realtime-broadcaster.test';
import { run as runAppSocketGateway } from './app-socket-gateway.test';
import { run as runAuthStatusSmoke } from './auth-status-smoke.test';
import { run as runActorCombatSmoke } from './actor-combat-smoke.test';
import { run as runActorStore } from './actor-store.test';
import { run as runPrimaryDocumentBase } from './primary-document-base.test';
import { run as runChatMessageStore } from './chat-message-store.test';
import { run as runModifyDocumentRouter } from './modify-document-router.test';
import { run as runCombatSort } from './combat-sort.test';
import { run as runActorNormalization } from './actor-normalization.test';
import { run as runJournalSmoke } from './journal-smoke.test';
import { run as runModuleProxyMatcher } from './module-proxy-matcher.test';
import { run as runModuleLifecycleState } from './module-lifecycle-state.test';
import { run as runModuleManifestValidation } from './module-manifest-validation.test';
import { run as runModuleRegistryManager } from './module-registry-manager.test';
import { run as runAdminCredentialStore } from './admin-credential-store.test';
import { run as runAdminSessionService } from './admin-session-service.test';
import { run as runAdminAuthMiddleware } from './admin-auth-middleware.test';
import { run as runAdminCsrfMiddleware } from './admin-csrf-middleware.test';
import { run as runAdminRateLimiter } from './admin-rate-limiter.test';
import { run as runAdminAuditLog } from './admin-audit-log.test';
import { run as runModuleLifecycleTransitions } from './module-lifecycle-transitions.test';
import { run as runModuleManagerOperations } from './module-manager-operations.test';
import { run as runModuleManagerGovernance } from './module-manager-governance.test';
import { run as runModulePolicyConfig } from './module-policy-config.test';
import { run as runModuleTrustPolicy } from './module-trust-policy.test';
import { run as runModuleArtifactVerification } from './module-artifact-verification.test';
import { run as runModulePermissionPolicy } from './module-permission-policy.test';
import { run as runModuleCompatibilityResolver } from './module-compatibility-resolver.test';
import { run as runModuleCompatibilityMatrix } from './module-compatibility-matrix.test';
import { run as runModuleCompatibilityLifecycleIntegration } from './module-compatibility-lifecycle-integration.test';
import { run as runModuleIndexModel } from './module-index-model.test';
import { run as runModuleSourceAdapters } from './module-source-adapters.test';
import { run as runModuleManagerDryRun } from './module-manager-dry-run.test';
import { run as runModuleManagerTelemetry } from './module-manager-telemetry.test';
import { run as runSdkIntegrity } from './sdk-integrity.test';
import { run as runModuleInitScaffold } from './module-init-scaffold.test';

async function runAllUnitTests() {
    // Initialize test data directory before running any tests
    const fs = await import('node:fs');
    const testDataDir = path.join(process.cwd(), 'temp', 'test-data');
    if (fs.existsSync(testDataDir)) {
        fs.rmSync(testDataDir, { recursive: true, force: true });
    }
    initDataDir(resolveDataDir(['--data-dir', testDataDir]));

    runStatusSanitize();
    runLocalhostPolicy();
    await runAuthStatusSmoke();
    await runActorCombatSmoke();
    await runActorStore();
    await runPrimaryDocumentBase();
    await runChatMessageStore();
    await runModifyDocumentRouter();
    runCombatSort();
    runModuleProxyMatcher();
    runModuleLifecycleState();
    runModuleManifestValidation();
    await runModuleRegistryManager();
    await runActorNormalization();
    await runJournalSmoke();
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
