import { strict as assert } from 'node:assert';
import { WorldStateStore } from '@server/core/world/WorldStateStore';
import type { GameData, SceneDataCache } from '@server/core/world/types';
import type { CacheData } from '@core/world/SetupManager';

export async function run() {
    await runSeedAndAccessors();
    await runCloneOnRead();
    await runProbeAndCachedWorlds();
    await runClearSemantics();
    console.log('  - WorldStateStore: all checks passed');
}

// Keep this fixture synthetic. Real audit dumps can inform the shape, but must not
// become tracked test data; ADR-0014 documents the covered example fields.
function createGameDataFixture(overrides: Partial<GameData> = {}): GameData {
    return {
        world: {
            id: 'test-world',
            title: 'Test World',
            description: 'Synthetic world fixture',
            system: 'test-system',
            systemVersion: '1.2.3',
            background: 'worlds/test-world/background.webp',
            nextSession: null,
            playtime: 42,
        },
        system: {
            id: 'test-system',
            title: 'Test System',
            version: '1.2.3',
            background: 'systems/test-system/background.webp',
            documentTypes: {
                Actor: ['character'],
                Item: ['equipment'],
            },
        },
        modules: [
            { id: 'test-module-a', title: 'Test Module A', version: '1.0.0' },
            { id: 'test-module-b', title: 'Test Module B', version: '2.0.0' },
        ],
        release: {
            generation: 13,
            channel: 'stable',
            build: 'synthetic',
        },
        coreUpdate: { type: 'core', version: '13.351' },
        systemUpdate: { type: 'system', version: '1.2.4' },
        options: {
            language: 'en',
            port: 30000,
            routePrefix: '',
            updateChannel: 'stable',
        },
        addresses: {
            local: ['http://127.0.0.1:30000'],
            remote: 'https://example.invalid',
            remoteIsAccessible: false,
        },
        files: {
            storages: {
                data: { active: true },
            },
            s3: null,
        },
        paused: false,
        demoMode: false,
        idleLogout: true,
        packageWarnings: {
            world: [],
            system: [],
            modules: {},
        },
        userId: 'gm-user',
        activeUsers: ['gm-user'],
        model: {
            Actor: { name: 'ActorSchema' },
            Item: { name: 'ItemSchema' },
        },
        scenes: [
            { _id: 'scene-1', background: { src: 'scenes/test-scene.webp' } },
        ],
        users: [
            { _id: 'gm-user', name: 'GM', role: 4 },
        ],
        ...overrides,
    };
}

function sceneMapFromFixture(gameData: GameData): SceneDataCache {
    const sceneMap: SceneDataCache = {};
    const scenes = Array.isArray(gameData.scenes) ? gameData.scenes : [];
    for (const scene of scenes) {
        if (!scene || typeof scene !== 'object') continue;
        const record = scene as Record<string, unknown>;
        const id = record._id || record.id;
        if (typeof id === 'string') sceneMap[id] = record as SceneDataCache[string];
    }
    return sceneMap;
}

async function runSeedAndAccessors() {
    const gameData = createGameDataFixture();
    const sceneData = sceneMapFromFixture(gameData);
    const store = new WorldStateStore();

    store.seed(gameData, { sceneData });

    assert.equal(store.isReady(), true);
    assert.equal(store.getCurrentWorldId(), gameData.world?.id);
    assert.equal(store.getUserId(), gameData.userId);
    assert.equal(store.getWorld()?.title, gameData.world?.title);
    assert.equal(store.getSystem()?.id, gameData.system?.id);
    assert.equal(store.getModules().length, gameData.modules?.length);
    assert.equal(store.getRelease()?.generation, gameData.release?.generation);
    assert.equal(store.isPaused(), gameData.paused === true);
    assert.equal(store.isDemoMode(), gameData.demoMode === true);
    assert.equal(store.isIdleLogout(), gameData.idleLogout === true);
    assert.ok(store.getModelForType('Actor'));
    assert.ok(Object.keys(store.getSceneData() || {}).length > 0);
    assert.equal(store.getGameDataSnapshot()?.world?.id, gameData.world?.id);
}

async function runCloneOnRead() {
    const gameData = createGameDataFixture();
    const store = new WorldStateStore();
    store.seed(gameData, { sceneData: sceneMapFromFixture(gameData) });

    const world = store.getWorld();
    assert.ok(world);
    world.title = 'mutated title';
    assert.equal(store.getWorld()?.title, gameData.world?.title);

    const modules = store.getModules();
    modules.length = 0;
    assert.equal(store.getModules().length, gameData.modules?.length);

    const snapshot = store.getGameDataSnapshot();
    assert.ok(snapshot?.world);
    snapshot.world.title = 'mutated snapshot';
    assert.equal(store.getGameDataSnapshot()?.world?.title, gameData.world?.title);
}

async function runProbeAndCachedWorlds() {
    const store = new WorldStateStore();

    store.setProbeData({ id: 'probe-world', title: 'Probe World', description: 'peek' }, 3);
    const probe = store.getProbeData();
    assert.equal(probe?.title, 'Probe World');
    assert.equal(store.getProbeUserCount(), 3);
    if (probe) probe.title = 'mutated probe';
    assert.equal(store.getProbeData()?.title, 'Probe World');

    const cache: CacheData = {
        currentWorldId: 'cached-world',
        worlds: {
            'cached-world': {
                worldId: 'cached-world',
                worldTitle: 'Cached World',
                worldDescription: null,
                systemId: 'dnd5e',
                backgroundUrl: null,
                users: [],
                lastUpdated: '2026-05-18T00:00:00.000Z',
            },
        },
    };

    store.setCachedWorlds(cache);
    assert.equal(store.getCachedWorldData()?.worldId, 'cached-world');
    assert.equal(store.getCachedWorld('cached-world')?.worldTitle, 'Cached World');

    const worlds = store.listCachedWorlds();
    worlds['cached-world'].worldTitle = 'mutated cache';
    assert.equal(store.getCachedWorld('cached-world')?.worldTitle, 'Cached World');
}

async function runClearSemantics() {
    const gameData = createGameDataFixture({
        world: {
            id: 'other-world',
            title: 'Other Synthetic World',
            system: 'test-system',
        },
    });
    const store = new WorldStateStore();
    store.seed(gameData, { sceneData: sceneMapFromFixture(gameData) });
    store.setProbeData({ title: 'Probe' }, 1);
    store.setCachedWorlds({
        currentWorldId: 'w',
        worlds: {
            w: {
                worldId: 'w',
                worldTitle: 'W',
                worldDescription: null,
                systemId: 'dnd5e',
                backgroundUrl: null,
                users: [],
                lastUpdated: '2026-05-18T00:00:00.000Z',
            },
        },
    });

    store.clearRuntimeState('test-runtime-clear');
    assert.equal(store.isReady(), false);
    assert.equal(store.getWorld(), null);
    assert.equal(store.getSceneData(), null);
    assert.equal(store.getProbeData(), null);
    assert.equal(store.getCachedWorldData()?.worldId, 'w');

    store.clear('test-clear');
    assert.equal(store.getCachedWorldData(), null);
    assert.deepEqual(store.listCachedWorlds(), {});
}
