import { strict as assert } from 'node:assert';
import { determineConnectionStep } from '@client/ui/context/foundryConnectionStep';
import {
    areJsonLikeEqual,
    areSharedContentEqual,
    areUsersEqual,
} from '@client/ui/context/foundryRealtimeComparisons';
import type { ConnectionStep } from '@shared/interfaces';
import type { SystemStatusPayload } from '@shared/contracts/status';

function statusPayload(overrides: Partial<SystemStatusPayload> = {}): SystemStatusPayload {
    return {
        connected: true,
        worldId: 'world-1',
        initialized: true,
        isConfigured: true,
        foundryCompatibility: null,
        users: [],
        system: {
            id: 'dnd5e',
            title: 'D&D 5e',
            worldTitle: 'Test World',
            status: 'active',
        },
        url: 'http://foundry.test',
        appVersion: '0.0.0-test',
        debug: { enabled: false, level: 1 },
        ...overrides,
    };
}

function determine(
    payload: Partial<SystemStatusPayload>,
    options: {
        currentStep?: ConnectionStep;
        isConfigured?: boolean;
        isAuthenticated?: boolean;
    } = {},
): ConnectionStep {
    return determineConnectionStep(statusPayload(payload), options.currentStep ?? 'init', {
        isConfigured: options.isConfigured ?? true,
        isAuthenticated: options.isAuthenticated ?? false,
    });
}

function runConnectionStepCases() {
    assert.equal(determine({}, { isConfigured: false }), 'setup');
    assert.equal(determine({ system: { id: 'dnd5e', status: 'closed' } }), 'world-closed');
    assert.equal(determine({ system: { id: 'dnd5e', status: 'setup' } }), 'world-closed');
    assert.equal(determine({ system: { id: 'dnd5e', status: 'offline', worldTitle: 'Known World' } }), 'startup');
    assert.equal(determine({ system: { id: 'dnd5e', status: 'offline' } }), 'initializing');
    assert.equal(determine({ system: { id: 'dnd5e', status: 'startup' } }), 'startup');
    assert.equal(determine({ connected: false, system: { id: 'dnd5e', status: 'active', worldTitle: 'Known World' } }), 'startup');
    assert.equal(determine({ connected: false, system: { id: 'dnd5e', status: 'active' } }), 'initializing');
    assert.equal(determine({ initialized: false, system: { id: 'dnd5e', status: 'active', worldTitle: 'Known World' } }), 'startup');
    assert.equal(determine({ initialized: false, system: { id: 'dnd5e', status: 'active' } }), 'initializing');
    assert.equal(determine({}, { currentStep: 'authenticating', isAuthenticated: false }), 'authenticating');
    assert.equal(determine({}, { currentStep: 'authenticating', isAuthenticated: true }), 'dashboard');
    assert.equal(determine({ system: { id: 'dnd5e', status: 'active' } }, { isAuthenticated: true }), 'startup');
    assert.equal(determine({}, { isAuthenticated: false }), 'login');
    assert.equal(determine({}, { isAuthenticated: true }), 'dashboard');
}

function runRealtimeComparisonCases() {
    assert.equal(
        areJsonLikeEqual(
            { id: 'system', details: { title: 'World', flags: ['a', 'b'] } },
            { details: { flags: ['a', 'b'], title: 'World' }, id: 'system' },
        ),
        true,
    );

    assert.equal(areJsonLikeEqual(['a', 'b'], ['b', 'a']), false);
    assert.equal(areUsersEqual([{ id: '1', name: 'Ada', active: true }], [{ active: true, name: 'Ada', id: '1' }]), true);
    assert.equal(areUsersEqual([{ id: '1', name: 'Ada' }], [{ id: '1', name: 'Grace' }]), false);
    assert.equal(
        areSharedContentEqual(
            { type: 'image', data: { title: 'Map', url: '/map.webp' }, timestamp: 10 },
            { timestamp: 10, data: { url: '/map.webp', title: 'Map' }, type: 'image' },
        ),
        true,
    );

    const left: Record<string, unknown> = { id: 'loop' };
    const right: Record<string, unknown> = { id: 'loop' };
    left.self = left;
    right.self = right;
    assert.equal(areJsonLikeEqual(left, right), true);
}

export function run() {
    runConnectionStepCases();
    runRealtimeComparisonCases();
    console.log('  - Client Foundry state helpers: all checks passed');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run();
    console.log('foundry-state-helpers.test.ts passed');
}
