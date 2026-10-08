import { strict as assert } from 'node:assert';
import { decidePlayerBoundary, type PlayerBoundaryInput } from '@client/ui/components/playerWorldBoundaryPolicy';

const scope = '["world-1","user-1",0]';

function decide(overrides: Partial<PlayerBoundaryInput> = {}) {
    return decidePlayerBoundary({
        step: 'dashboard',
        linkState: 'ready',
        hasSessionMarker: true,
        currentScope: scope,
        mountedScope: scope,
        ...overrides,
    });
}

export function run() {
    assert.equal(decide({ mountedScope: null }).retainPage, false, 'cold page waits for readiness');
    assert.deepEqual(decide(), { terminal: false, ready: true, retainPage: true, blocked: false });
    assert.equal(decide({ step: 'startup' }).blocked, true, 'same-world Foundry outage retains and blocks');
    assert.equal(decide({ linkState: 'disconnected' }).blocked, true, 'browser link loss retains and blocks');
    assert.equal(decide({ linkState: 'checking' }).blocked, true, 'session revalidation remains blocked');
    assert.equal(decide({ step: 'authenticating' }).blocked, true, 'intermediate authenticated step retains page');
    assert.equal(decide({ linkState: 'unavailable' }).blocked, true, 'exhausted connection stays inert');
    assert.equal(decide({ step: 'world-closed' }).retainPage, false, 'definitive close retires the page');
    assert.equal(decide({ step: 'login' }).retainPage, false, 'observed invalidation retires the page');
    assert.equal(decide({ currentScope: '["world-1","user-2",0]' }).retainPage, false, 'different user never sees prior page');
    assert.equal(decide({ currentScope: '["world-2","user-1",0]' }).retainPage, false, 'different world never sees prior page');
    assert.equal(decide({ currentScope: '["world-1","user-1",1]' }).retainPage, false, 'observed same-user login retires prior page');
    console.log('  - Player world boundary policy: all checks passed');
}

if (import.meta.url === `file://${process.argv[1]}`) run();
