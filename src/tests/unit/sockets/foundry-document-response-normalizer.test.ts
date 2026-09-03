import { strict as assert } from 'node:assert';
import {
    isPackScopedDocumentResult,
    normalizeFoundryDocumentResponse,
} from '@core/foundry/sockets/FoundryDocumentResponse';
import {
    autosaveFixtures,
    manageCompendiumFixtures,
    terseAcknowledgementFixture,
    v13SingleUpdateFixture,
    v14BatchFixture,
    v14SingleDeleteFixture,
} from '../fixtures/foundry-document-persistence';

function runSingleResponseFixtures() {
    const v13 = normalizeFoundryDocumentResponse(v13SingleUpdateFixture);
    assert.equal(v13.length, 1);
    assert.equal(v13[0].source, 'single');
    assert.equal(v13[0].type, 'Actor');
    assert.equal(v13[0].action, 'update');
    assert.equal(v13[0].sideEffect, false);
    assert.equal(v13[0].malformedReason, undefined);

    const v14 = normalizeFoundryDocumentResponse(v14SingleDeleteFixture);
    assert.equal(v14.length, 1);
    assert.equal(v14[0].type, 'Combat');
    assert.equal(v14[0].action, 'delete');
    assert.deepEqual(v14[0].result, ['combat-1']);
}

function runBatchResponseFixture() {
    const results = normalizeFoundryDocumentResponse(v14BatchFixture);

    assert.equal(results.length, 4);
    assert.deepEqual(results.map((entry) => entry.index), [0, 1, 2, 3]);
    assert.ok(results.every((entry) => entry.source === 'batch'));

    assert.equal(results[0].type, 'Actor');
    assert.equal(results[0].action, 'update');
    assert.equal(results[0].sideEffect, false);

    assert.equal(results[1].type, 'ActiveEffect');
    assert.equal(results[1].operation?.parentUuid, 'Actor.actor-1');
    assert.equal(results[1].sideEffect, true);

    assert.equal(results[2].type, 'Item');
    assert.equal(results[2].sideEffect, true);
    assert.equal(isPackScopedDocumentResult(results[2]), true);

    assert.equal(results[3].action, 'delete');
    assert.deepEqual(results[3].error, { message: 'Synthetic permission failure' });
    assert.equal(results[3].malformedReason, undefined);
}

function runPrimaryFallbackFixture() {
    const [result] = normalizeFoundryDocumentResponse(terseAcknowledgementFixture, {
        type: 'Actor',
        action: 'update',
        operation: {
            parentUuid: 'Actor.actor-1',
        },
    });

    assert.equal(result.type, 'Actor');
    assert.equal(result.action, 'update');
    assert.equal(result.operation?.parentUuid, 'Actor.actor-1');
    assert.deepEqual(result.operation?.updates, [
        { _id: 'actor-1', name: 'Terse response' },
    ]);
}

function runMalformedFixtures() {
    const [nonObject] = normalizeFoundryDocumentResponse(null);
    assert.match(nonObject.malformedReason ?? '', /not an object/);

    const [invalidEnvelope] = normalizeFoundryDocumentResponse({ results: 'not-an-array' });
    assert.equal(invalidEnvelope.source, 'batch');
    assert.match(invalidEnvelope.malformedReason ?? '', /non-array results/);

    const results = normalizeFoundryDocumentResponse({
        results: [
            { result: [] },
            { result: [], sideEffect: true },
        ],
    }, {
        type: 'Actor',
        action: 'update',
    });

    assert.equal(results[0].malformedReason, undefined);
    assert.match(results[1].malformedReason ?? '', /missing document type/);
    assert.match(results[1].malformedReason ?? '', /missing document action/);
}

function runSpecializedPersistenceFixtures() {
    assert.equal(autosaveFixtures.direct.uuid, 'Actor.actor-1#system.biography.value');
    assert.match(autosaveFixtures.embedded.uuid, /^JournalEntry\./);
    assert.match(autosaveFixtures.compendium.uuid, /^Compendium\./);
    assert.equal(autosaveFixtures.malformed.uuid.includes('#'), false);

    assert.equal(manageCompendiumFixtures.create.request.action, 'create');
    assert.equal(manageCompendiumFixtures.delete.request.action, 'delete');
}

export function run() {
    runSingleResponseFixtures();
    runBatchResponseFixture();
    runPrimaryFallbackFixture();
    runMalformedFixtures();
    runSpecializedPersistenceFixtures();
    console.log('  - Foundry document persistence fixtures: all checks passed');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run();
}
