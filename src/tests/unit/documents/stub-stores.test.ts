import { strict as assert } from 'node:assert';
import { sceneStore } from '@server/core/documents/primary/scenes/SceneStore';
import { fogExplorationStore } from '@server/core/documents/primary/fog-explorations/FogExplorationStore';
import { adventureStore } from '@server/core/documents/primary/adventures/AdventureStore';
import { settingStore } from '@server/core/documents/primary/settings/SettingStore';
import { modifyDocumentRouter } from '@server/core/documents/primary/base/modifyDocumentRouter';
import {
    DOCUMENT_VISIBILITY,
    DocumentOwnershipLevel,
    FoundryUserRole,
    type DocumentAccessSubject,
} from '@server/core/documents/primary/base/ownership';

const player: DocumentAccessSubject = { userId: 'p-1', role: FoundryUserRole.PLAYER };
const gm: DocumentAccessSubject = { userId: 'gm-1', role: FoundryUserRole.GAMEMASTER };

export async function run() {
    runDocumentTypeSet();
    await runSceneOwnershipMapPolicy();
    await runFogExplorationPerUserPolicy();
    await runAdventureAndSettingGmOnly();
    runStubsNotRegisteredWithRouter();
    console.log('  - StubStores: all checks passed');
}

function runDocumentTypeSet() {
    assert.equal(sceneStore.documentType, 'Scene');
    assert.equal(fogExplorationStore.documentType, 'FogExploration');
    assert.equal(adventureStore.documentType, 'Adventure');
    assert.equal(settingStore.documentType, 'Setting');
}

async function runSceneOwnershipMapPolicy() {
    await sceneStore.seed(async () => [
        { _id: 's-public', ownership: { default: DocumentOwnershipLevel.OBSERVER } },
        { _id: 's-hidden', ownership: { default: DocumentOwnershipLevel.NONE } },
    ]);
    assert.equal(sceneStore.canReadDocument('s-public', player, DOCUMENT_VISIBILITY.LIST_VISIBLE), true);
    assert.equal(sceneStore.canReadDocument('s-hidden', player, DOCUMENT_VISIBILITY.LIST_VISIBLE), false);
    assert.equal(sceneStore.canReadDocument('s-hidden', gm, DOCUMENT_VISIBILITY.WRITEABLE), true);
    sceneStore.clear('stub-test');
}

async function runFogExplorationPerUserPolicy() {
    await fogExplorationStore.seed(async () => [
        { _id: 'fog-1', user: 'p-1', scene: 'scene-a' },
        { _id: 'fog-2', user: 'p-2', scene: 'scene-a' },
    ]);
    assert.equal(fogExplorationStore.canReadDocument('fog-1', player, DOCUMENT_VISIBILITY.LIST_VISIBLE), true);
    assert.equal(fogExplorationStore.canReadDocument('fog-2', player, DOCUMENT_VISIBILITY.LIST_VISIBLE), false);
    assert.equal(fogExplorationStore.canReadDocument('fog-2', gm, DOCUMENT_VISIBILITY.WRITEABLE), true);
    fogExplorationStore.clear('stub-test');
}

async function runAdventureAndSettingGmOnly() {
    await adventureStore.seed(async () => [{ _id: 'adv-1', name: 'Lost Mine' }]);
    await settingStore.seed(async () => [{ _id: 'set-1', key: 'core.theme', value: 'dark' }]);

    assert.equal(adventureStore.canReadDocument('adv-1', player, DOCUMENT_VISIBILITY.LIST_VISIBLE), false);
    assert.equal(adventureStore.canReadDocument('adv-1', gm, DOCUMENT_VISIBILITY.WRITEABLE), true);
    assert.equal(settingStore.canReadDocument('set-1', player, DOCUMENT_VISIBILITY.LIST_VISIBLE), false);
    assert.equal(settingStore.canReadDocument('set-1', gm, DOCUMENT_VISIBILITY.WRITEABLE), true);

    adventureStore.clear('stub-test');
    settingStore.clear('stub-test');
}

function runStubsNotRegisteredWithRouter() {
    // Stub stores are NOT registered with `modifyDocumentRouter`. A direct-type
    // payload for any of the stub types should drop silently (no throw, no
    // mutation). We assert via a "would-route" probe: routing a Scene event
    // with no parent should NOT land on any registered store. There's no
    // public introspection API on the router; the silent-drop behavior is
    // already covered by the router unit test for unknown types — here we
    // just confirm `route()` accepts these types without throwing, which
    // matches the silent-drop contract.
    // Scene and Setting are no longer stubs — both were wired to the
    // coordinator + router by ADR-0028 Phase 7 and have their own test files.
    let threw = false;
    try {
        modifyDocumentRouter.route({
            type: 'FogExploration',
            action: 'create',
            result: [{ _id: 'never-applied' }],
        });
        modifyDocumentRouter.route({
            type: 'Adventure',
            action: 'create',
            result: [{ _id: 'never-applied' }],
        });
    } catch {
        threw = true;
    }
    assert.equal(threw, false, 'stub-type events should silently drop, not throw');
    // None of the stub stores hold the unrouted doc.
    assert.equal(fogExplorationStore.get('never-applied'), null);
    assert.equal(adventureStore.get('never-applied'), null);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('stub-stores.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
