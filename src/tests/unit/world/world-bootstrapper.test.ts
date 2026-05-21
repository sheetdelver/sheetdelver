import { strict as assert } from 'node:assert';
import {
    UnsupportedFoundryVersionError,
    WorldBootstrapper,
} from '@server/services/world';
import type { SystemAdapter } from '@modules/registry/types';
import type { ModuleContext } from '@shared/sdk';
import { logger } from '@shared/utils/logger';

function adapter(id: string): SystemAdapter {
    return {
        systemId: id,
        normalizeActorData: (actor) => ({ ...actor, systemId: id } as any),
        match: () => true,
        validateUpdate: () => true,
    };
}

const markLifecycleActive = () => undefined;
const MISSING_GENERATION = Symbol('missing-generation');

function createBootstrapSnapshot(generation: unknown = 13): any {
    const release = generation === MISSING_GENERATION ? {} : { generation };

    return {
        gameData: {
            world: { id: 'world-1', title: 'Synthetic World' },
            system: { id: 'SyntheticSystem' },
            release,
            userId: 'gm-user',
            users: [{ _id: 'user-1', name: 'Player', role: 1, active: true }],
            activeUsers: ['user-1'],
        },
        sceneData: {
            scene1: { background: { src: 'worlds/synthetic/scene.webp' } },
        },
    };
}

function createCompatibilityBootstrapper(
    getGeneration: () => unknown,
    events: string[],
): WorldBootstrapper {
    let currentSystem: { id?: string } | null = null;

    return new WorldBootstrapper({
        getBootstrapSnapshot: async () => {
            const generation = getGeneration();
            events.push(`snapshot:${String(generation)}`);
            return createBootstrapSnapshot(generation);
        },
        seedWorldSnapshot: (snapshot) => {
            events.push(`seed-world:${snapshot.gameData.system?.id}`);
            currentSystem = { id: snapshot.gameData.system?.id };
        },
        seedUserSnapshot: async (snapshot) => {
            const count = Array.isArray(snapshot.gameData.users) ? snapshot.gameData.users.length : 0;
            events.push(`seed-users:${count}`);
        },
        createCompendiumService: () => ({
            discoverIndices: async () => {
                events.push('discover');
                return [];
            },
            getPackEntries: async () => [],
        }),
        rebuildCompendiumCache: () => {
            events.push('rebuild');
        },
        getSystem: () => currentSystem,
        getRegisteredModules: () => [],
        loadAdapter: async (systemId) => {
            events.push(`load-adapter:${systemId}`);
            return null;
        },
        seedDocuments: async () => {
            events.push('seed-docs');
        },
        markLifecycleActive: (systemId) => {
            events.push(`active:${systemId}`);
        },
        markLifecycleClosed: (reason) => {
            events.push(`closed:${reason}`);
        },
    });
}

async function runActiveAdapterLoadAndReuse() {
    const calls: string[] = [];
    const shadowdark = adapter('shadowdark');
    const bootstrapper = new WorldBootstrapper({
        loadAdapter: async (systemId) => {
            calls.push(systemId);
            return shadowdark;
        },
    });

    assert.equal(await bootstrapper.loadActiveAdapter(' Shadowdark '), shadowdark);
    assert.equal(await bootstrapper.loadActiveAdapter('shadowdark'), shadowdark);
    assert.deepEqual(calls, ['shadowdark']);
    assert.equal(bootstrapper.getActiveAdapter(), shadowdark);
    assert.equal(bootstrapper.getActiveSystemId(), 'shadowdark');
}

async function runActiveAdapterClearAndReload() {
    const calls: string[] = [];
    const bootstrapper = new WorldBootstrapper({
        loadAdapter: async (systemId) => {
            calls.push(systemId);
            return adapter(systemId);
        },
    });

    const first = await bootstrapper.loadActiveAdapter('system-a');
    bootstrapper.clearActiveAdapter('test-clear');
    const second = await bootstrapper.loadActiveAdapter('system-a');

    assert.notEqual(first, second);
    assert.deepEqual(calls, ['system-a', 'system-a']);
}

async function runLoadFailureLeavesNoActiveAdapter() {
    const bootstrapper = new WorldBootstrapper({
        loadAdapter: async () => {
            throw new Error('adapter load failed');
        },
    });

    assert.equal(await bootstrapper.loadActiveAdapter('broken-system'), null);
    assert.equal(bootstrapper.getActiveAdapter(), null);
    assert.equal(bootstrapper.getActiveSystemId(), 'broken-system');

    bootstrapper.clearActiveAdapter('test-cleanup');
    assert.equal(bootstrapper.getActiveSystemId(), null);
}

async function runBootstrapOrderingAndReadyCallback() {
    const order: string[] = [];
    const initializingAdapter: SystemAdapter = {
        ...adapter('syntheticsystem'),
        initialize: async () => {
            order.push('adapter-initialize');
        },
    };

    const bootstrapper = new WorldBootstrapper({
        createCompendiumService: () => ({
            discoverIndices: async () => {
                order.push('discover');
                return [];
            },
            getPackEntries: async () => [],
        }),
        rebuildCompendiumCache: () => {
            order.push('rebuild');
        },
        getSystem: () => ({ id: 'SyntheticSystem' }),
        getRegisteredModules: () => [{
            id: 'syntheticsystem',
            discovery: { packs: [] },
        } as any],
        loadAdapter: async (systemId) => {
            order.push(`load-adapter:${systemId}`);
            return initializingAdapter;
        },
        syncDiscovery: async (_transport, systemId) => {
            order.push(`sync:${systemId}`);
        },
        seedDocuments: async () => {
            order.push('seed');
        },
        createModuleContext: async (systemId) => {
            order.push(`context:${systemId}`);
            return {} as ModuleContext;
        },
        markLifecycleActive,
    });

    const result = await bootstrapper.bootstrap({} as any, {
        onReady: ({ systemId }) => {
            order.push(`ready:${systemId}`);
        },
    });

    assert.deepEqual(order, [
        'discover',
        'rebuild',
        'load-adapter:syntheticsystem',
        'sync:syntheticsystem',
        'seed',
        'context:syntheticsystem',
        'adapter-initialize',
        'ready:SyntheticSystem',
    ]);
    assert.deepEqual(result, { ready: true, systemId: 'SyntheticSystem' });
    assert.equal(bootstrapper.isReady(), true);
    assert.equal(bootstrapper.getActiveAdapter(), initializingAdapter);

    const repeatedResult = await bootstrapper.bootstrap({} as any);
    assert.deepEqual(repeatedResult, { ready: true, systemId: 'SyntheticSystem' });
}

async function runBootstrapAcceptsSnapshotBeforeServiceWork() {
    const order: string[] = [];
    let currentSystem: { id?: string } | null = null;

    const bootstrapper = new WorldBootstrapper({
        getBootstrapSnapshot: async () => {
            order.push('snapshot');
            return createBootstrapSnapshot(13);
        },
        seedWorldSnapshot: (snapshot) => {
            order.push(`seed-world:${snapshot.gameData.system?.id}`);
            currentSystem = { id: snapshot.gameData.system?.id };
        },
        seedUserSnapshot: async (snapshot) => {
            const count = Array.isArray(snapshot.gameData.users) ? snapshot.gameData.users.length : 0;
            order.push(`seed-users:${count}`);
        },
        createCompendiumService: () => ({
            discoverIndices: async () => {
                order.push('discover');
                return [];
            },
            getPackEntries: async () => [],
        }),
        rebuildCompendiumCache: () => {
            order.push('rebuild');
        },
        getSystem: () => currentSystem,
        getRegisteredModules: () => [],
        loadAdapter: async (systemId) => {
            order.push(`load-adapter:${systemId}`);
            return null;
        },
        seedDocuments: async () => {
            order.push('seed-docs');
        },
        markLifecycleActive: (systemId) => {
            order.push(`active:${systemId}`);
        },
    });

    await bootstrapper.bootstrap({} as any, {
        onReady: ({ systemId }) => {
            order.push(`ready:${systemId}`);
        },
    });

    assert.deepEqual(order, [
        'snapshot',
        'seed-world:SyntheticSystem',
        'seed-users:1',
        'discover',
        'rebuild',
        'load-adapter:syntheticsystem',
        'seed-docs',
        'active:SyntheticSystem',
        'ready:SyntheticSystem',
    ]);
}

async function runBootstrapRejectsUnsupportedGenerationBeforeStoreSeeding() {
    let generation: unknown = 12;
    const order: string[] = [];
    const bootstrapper = createCompatibilityBootstrapper(() => generation, order);

    await assert.rejects(
        () => bootstrapper.bootstrap({} as any),
        (error) => {
            assert.ok(error instanceof UnsupportedFoundryVersionError);
            assert.equal(error.compatibility.status, 'unsupported');
            assert.equal(error.compatibility.generation, 12);
            return true;
        },
    );

    assert.deepEqual(order, [
        'snapshot:12',
        'closed:unsupported-foundry-generation:12:min-13',
    ]);
    assert.equal(bootstrapper.isReady(), false);

    // The rejected run must not poison later retries.
    order.length = 0;
    generation = 13;
    await bootstrapper.bootstrap({} as any);

    assert.deepEqual(order, [
        'snapshot:13',
        'seed-world:SyntheticSystem',
        'seed-users:1',
        'discover',
        'rebuild',
        'load-adapter:syntheticsystem',
        'seed-docs',
        'active:SyntheticSystem',
    ]);
    assert.equal(bootstrapper.isReady(), true);
}

async function runBootstrapWarnsAndProceedsForNewerAndUnknownGeneration() {
    const warnings: string[] = [];
    const originalWarn = logger.warn;

    try {
        logger.warn = ((message: string, ...args: unknown[]) => {
            warnings.push([message, ...args.map(String)].join(' '));
        }) as typeof logger.warn;

        const newerOrder: string[] = [];
        const newer = createCompatibilityBootstrapper(() => 14, newerOrder);
        await newer.bootstrap({} as any);

        assert.equal(newer.isReady(), true);
        assert.deepEqual(newerOrder.slice(0, 3), [
            'snapshot:14',
            'seed-world:SyntheticSystem',
            'seed-users:1',
        ]);
        assert.equal(
            warnings.some((entry) => entry.includes('generation 14') && entry.includes('newer than known maximum')),
            true,
        );

        const unknownOrder: string[] = [];
        const unknown = createCompatibilityBootstrapper(() => MISSING_GENERATION, unknownOrder);
        await unknown.bootstrap({} as any);

        assert.equal(unknown.isReady(), true);
        assert.deepEqual(unknownOrder.slice(0, 3), [
            `snapshot:${String(MISSING_GENERATION)}`,
            'seed-world:SyntheticSystem',
            'seed-users:1',
        ]);
        assert.equal(
            warnings.some((entry) => entry.includes('generation is unavailable or invalid')),
            true,
        );
    } finally {
        logger.warn = originalWarn;
    }
}

async function runBootstrapSharesConcurrentPromise() {
    let releaseDiscover: (() => void) | undefined;
    const discoverGate = new Promise<void>((resolve) => {
        releaseDiscover = resolve;
    });
    let discoverCalls = 0;
    let readyCalls = 0;

    const bootstrapper = new WorldBootstrapper({
        createCompendiumService: () => ({
            discoverIndices: async () => {
                discoverCalls += 1;
                await discoverGate;
                return [];
            },
            getPackEntries: async () => [],
        }),
        rebuildCompendiumCache: () => undefined,
        getSystem: () => ({ id: 'synthetic' }),
        getRegisteredModules: () => [],
        loadAdapter: async () => null,
        seedDocuments: async () => undefined,
        markLifecycleActive,
    });

    const options = {
        onReady: () => {
            readyCalls += 1;
        },
    };
    const firstBootstrap = bootstrapper.bootstrap({} as any, options);
    const secondBootstrap = bootstrapper.bootstrap({} as any, options);

    assert.equal(firstBootstrap, secondBootstrap);
    await Promise.resolve();
    assert.equal(discoverCalls, 1);
    releaseDiscover?.();

    await firstBootstrap;
    assert.equal(readyCalls, 1);
    assert.equal(bootstrapper.isReady(), true);

    await bootstrapper.bootstrap({} as any, options);
    assert.equal(readyCalls, 1);
    assert.equal(discoverCalls, 1);
}

async function runBootstrapFailureResetsForRetry() {
    let seedAttempts = 0;
    let readyCalls = 0;
    const bootstrapper = new WorldBootstrapper({
        createCompendiumService: () => ({
            discoverIndices: async () => [],
            getPackEntries: async () => [],
        }),
        rebuildCompendiumCache: () => undefined,
        getSystem: () => ({ id: 'synthetic' }),
        getRegisteredModules: () => [],
        loadAdapter: async () => null,
        seedDocuments: async () => {
            seedAttempts += 1;
            if (seedAttempts === 1) throw new Error('seed failed');
        },
        markLifecycleActive,
    });

    await assert.rejects(
        () => bootstrapper.bootstrap({} as any, {
            onReady: () => {
                readyCalls += 1;
            },
        }),
        /seed failed/,
    );

    assert.equal(bootstrapper.isReady(), false);
    assert.equal(readyCalls, 0);

    await bootstrapper.bootstrap({} as any, {
        onReady: () => {
            readyCalls += 1;
        },
    });

    assert.equal(seedAttempts, 2);
    assert.equal(readyCalls, 1);
    assert.equal(bootstrapper.isReady(), true);
}

async function runResetClearsReadinessAndAdapter() {
    const activeAdapter = adapter('synthetic');
    const bootstrapper = new WorldBootstrapper({
        createCompendiumService: () => ({
            discoverIndices: async () => [],
            getPackEntries: async () => [],
        }),
        rebuildCompendiumCache: () => undefined,
        getSystem: () => ({ id: 'synthetic' }),
        getRegisteredModules: () => [],
        loadAdapter: async () => activeAdapter,
        seedDocuments: async () => undefined,
        markLifecycleActive,
    });

    await bootstrapper.bootstrap({} as any);

    assert.equal(bootstrapper.isReady(), true);
    assert.equal(bootstrapper.getActiveAdapter(), activeAdapter);

    bootstrapper.reset('unit-test-reset');

    assert.equal(bootstrapper.isReady(), false);
    assert.equal(bootstrapper.getActiveAdapter(), null);
    assert.equal(bootstrapper.getActiveSystemId(), null);
}

export async function run() {
    await runActiveAdapterLoadAndReuse();
    await runActiveAdapterClearAndReload();
    await runLoadFailureLeavesNoActiveAdapter();
    await runBootstrapOrderingAndReadyCallback();
    await runBootstrapAcceptsSnapshotBeforeServiceWork();
    await runBootstrapRejectsUnsupportedGenerationBeforeStoreSeeding();
    await runBootstrapWarnsAndProceedsForNewerAndUnknownGeneration();
    await runBootstrapSharesConcurrentPromise();
    await runBootstrapFailureResetsForRetry();
    await runResetClearsReadinessAndAdapter();
    console.log('  - WorldBootstrapper: all checks passed');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('world-bootstrapper.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
