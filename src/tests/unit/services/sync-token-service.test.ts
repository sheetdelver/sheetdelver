import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import {
    SyncTokenService,
    type SyncTokenSource,
} from '@server/services/status/SyncTokenService';
import type {
    ChangeAction,
    DocumentChangedEvent,
    PrimaryDocumentType,
} from '@server/core/documents/primary/base/PrimaryDocumentStore';

class SyntheticSyncTokenSource extends EventEmitter implements SyncTokenSource {
    public emitChange(type: PrimaryDocumentType, action: ChangeAction = 'update', id = `${type}.test`): void {
        const event: DocumentChangedEvent = { type, action, id };
        this.emit('documentChanged', event);
    }
}

function createClock(initial: number) {
    let value = initial;

    return {
        now: () => value,
        set: (next: number) => {
            value = next;
        },
    };
}

function runActorItemChangeTests() {
    const clock = createClock(1000);
    const actorSource = new SyntheticSyncTokenSource();
    const itemSource = new SyntheticSyncTokenSource();
    const service = new SyncTokenService({
        sources: [actorSource, itemSource],
        now: clock.now,
        initializeToken: false,
    });

    assert.equal(service.getCurrentToken(), undefined);

    actorSource.emitChange('Actor');
    assert.equal(service.getCurrentToken(), '1000');

    // Same-millisecond Store events still need distinct tokens for polling UI.
    itemSource.emitChange('Item');
    assert.equal(service.getCurrentToken(), '1001');

    clock.set(1500);
    actorSource.emitChange('Actor', 'delete');
    assert.equal(service.getCurrentToken(), '1500');

    service.dispose();
}

function runUntrackedTypeTest() {
    const clock = createClock(2000);
    const source = new SyntheticSyncTokenSource();
    const service = new SyncTokenService({
        sources: [source],
        now: clock.now,
        initializeToken: false,
    });

    source.emitChange('ChatMessage');
    assert.equal(service.getCurrentToken(), undefined);

    source.emitChange('Actor');
    assert.equal(service.getCurrentToken(), '2000');

    clock.set(2100);
    source.emitChange('Folder');
    assert.equal(service.getCurrentToken(), '2000');

    service.dispose();
}

function runDisposeTest() {
    const clock = createClock(3000);
    const source = new SyntheticSyncTokenSource();
    const service = new SyncTokenService({
        sources: [source],
        now: clock.now,
        initializeToken: false,
    });

    source.emitChange('Actor');
    assert.equal(service.getCurrentToken(), '3000');

    service.dispose();
    clock.set(3500);
    source.emitChange('Actor');
    assert.equal(service.getCurrentToken(), '3000');
}

function runInitialTokenTest() {
    const service = new SyncTokenService({
        sources: [],
        now: () => 4000,
    });

    assert.equal(service.getCurrentToken(), '4000');
}

export function run() {
    runActorItemChangeTests();
    runUntrackedTypeTest();
    runDisposeTest();
    runInitialTokenTest();
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run();
    console.log('sync-token-service.test.ts passed');
}
