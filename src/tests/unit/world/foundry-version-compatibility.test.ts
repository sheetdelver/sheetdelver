import { strict as assert } from 'node:assert';
import type { FoundryRelease } from '@server/core/world/types';
import {
    KNOWN_FOUNDRY_GENERATION_MAX,
    SUPPORTED_FOUNDRY_GENERATION_MIN,
    UnsupportedFoundryVersionError,
    assertFoundryVersionSupported,
    evaluateFoundryVersionCompatibility,
} from '@server/services/world';

function release(generation?: unknown): FoundryRelease {
    return generation === undefined
        ? {}
        : { generation } as unknown as FoundryRelease;
}

function runSupportedGenerationTest() {
    const result = evaluateFoundryVersionCompatibility(release(13));

    assert.equal(SUPPORTED_FOUNDRY_GENERATION_MIN, 13);
    assert.equal(KNOWN_FOUNDRY_GENERATION_MAX, 13);
    assert.equal(result.status, 'supported');
    assert.equal(result.generation, 13);
    assertFoundryVersionSupported(result);
}

function runUnsupportedGenerationTest() {
    const result = evaluateFoundryVersionCompatibility(release(12));

    assert.equal(result.status, 'unsupported');
    assert.equal(result.generation, 12);
    assert.throws(
        () => assertFoundryVersionSupported(result),
        (error) => {
            assert.ok(error instanceof UnsupportedFoundryVersionError);
            assert.equal(error.code, 'UNSUPPORTED_FOUNDRY_VERSION');
            assert.equal(error.compatibility.status, 'unsupported');
            return true;
        },
    );
}

function runNewerUntestedGenerationTest() {
    const result = evaluateFoundryVersionCompatibility(release(14));

    assert.equal(result.status, 'newer-untested');
    assert.equal(result.generation, 14);
    assertFoundryVersionSupported(result);
}

function runMissingGenerationTest() {
    const result = evaluateFoundryVersionCompatibility(release());

    assert.equal(result.status, 'unknown');
    assert.equal(result.generation, null);
    assertFoundryVersionSupported(result);
}

function runNonNumericGenerationTest() {
    // Foundry JSON is untrusted at the boundary; string generations stay
    // diagnostic-only instead of being coerced into a support decision.
    const result = evaluateFoundryVersionCompatibility(release('13'));

    assert.equal(result.status, 'unknown');
    assert.equal(result.generation, null);
    assertFoundryVersionSupported(result);
}

export function run() {
    runSupportedGenerationTest();
    runUnsupportedGenerationTest();
    runNewerUntestedGenerationTest();
    runMissingGenerationTest();
    runNonNumericGenerationTest();
    console.log('  - FoundryVersionCompatibility: all checks passed');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run();
}
