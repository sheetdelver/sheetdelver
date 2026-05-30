import { strict as assert } from 'node:assert';
import { systemService } from '@server/services/world';
import { SetupManager } from '@core/world/SetupManager';
import { worldLifecycleStore } from '@server/core/world/WorldLifecycleStore';
import { worldStateStore } from '@server/core/world/WorldStateStore';
import { createAdminService } from '@server/services/admin/AdminService';
import { createStatusService } from '@server/services/status/StatusService';
import type {
    FoundryCompatibilityStatus,
    FoundryCompatibilityStatusPayload,
    SystemStatusPayload,
} from '@shared/contracts/status';

function diagnostic(
    status: FoundryCompatibilityStatus,
    generation: number | null,
): FoundryCompatibilityStatusPayload {
    return {
        status,
        generation,
        minGeneration: 13,
        maxGeneration: 13,
        message: `synthetic ${status}`,
        checkedAt: 123456,
    };
}

function createConfig() {
    return {
        app: {
            host: 'localhost',
            port: 3000,
            apiPort: 3000,
            protocol: 'http',
            chatHistory: 100,
            version: '0.0.0-test',
            url: 'http://localhost:3000',
        },
        foundry: {
            host: 'foundry.test',
            port: 30000,
            protocol: 'http',
            url: 'http://foundry.test',
        },
        debug: { enabled: false, level: 1 },
    };
}

function patchStatusSingletons() {
    const originalGetSystemClient = systemService.getSystemClient;
    const originalLoadCache = SetupManager.loadCache;

    (systemService as any).getSystemClient = () => ({
        isConnected: true,
        url: 'http://foundry.test',
        userId: 'gm-user',
        isExplicitSession: true,
        discoveredUserId: 'gm-user',
        launchWorld: async () => undefined,
        shutdownWorld: async () => undefined,
    });
    SetupManager.loadCache = async () => ({ worlds: {}, currentWorldId: null });

    return () => {
        (systemService as any).getSystemClient = originalGetSystemClient;
        SetupManager.loadCache = originalLoadCache;
        worldStateStore.clear('status-compatibility-test');
        worldLifecycleStore.reset('status-compatibility-test');
    };
}

async function projectCompatibility(
    compatibility: FoundryCompatibilityStatusPayload | null,
): Promise<SystemStatusPayload> {
    const statusService = createStatusService({
        config: createConfig(),
        foundryUserConnections: { isCacheReady: () => true },
        getFoundryCompatibility: () => compatibility,
    });

    return statusService.getSystemStatusPayload();
}

async function runStatusProjectionTests() {
    const restore = patchStatusSingletons();

    try {
        const cases = [
            diagnostic('supported', 13),
            diagnostic('newer-untested', 14),
            diagnostic('unknown', null),
            diagnostic('unsupported', 12),
        ];

        for (const entry of cases) {
            const payload = await projectCompatibility(entry);
            assert.deepEqual(payload.foundryCompatibility, entry);
        }

        const nullPayload = await projectCompatibility(null);
        assert.equal(nullPayload.foundryCompatibility, null);

        const original = diagnostic('newer-untested', 14);
        const payload = await projectCompatibility(original);
        assert.ok(payload.foundryCompatibility);
        payload.foundryCompatibility.status = 'unsupported';

        const freshPayload = await projectCompatibility(original);
        assert.equal(freshPayload.foundryCompatibility?.status, 'newer-untested');
    } finally {
        restore();
    }
}

async function runAdminStatusProjectionTest() {
    const restore = patchStatusSingletons();

    try {
        const foundryCompatibility = diagnostic('unsupported', 12);
        const adminService = createAdminService({
            getSystemStatusPayload: async () => ({
                connected: true,
                worldId: null,
                initialized: true,
                isConfigured: false,
                foundryCompatibility,
                users: [],
                system: { id: null, status: 'closed' },
                url: 'http://foundry.test',
                appVersion: '0.0.0-test',
                debug: { enabled: false, level: 1 },
            } satisfies SystemStatusPayload),
        });

        const adminStatus = await adminService.getStatus();
        assert.deepEqual(adminStatus.foundryCompatibility, foundryCompatibility);
        assert.equal(adminStatus.worldState, worldLifecycleStore.getState());
    } finally {
        restore();
    }
}

export async function run() {
    await runStatusProjectionTests();
    await runAdminStatusProjectionTest();
    console.log('  - Status compatibility diagnostics: all checks passed');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('status-compatibility.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
