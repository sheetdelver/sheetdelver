import assert from 'node:assert/strict';
import {
    checkTransition,
    assertTransition,
    getAllowedTransitions,
    isTerminalStatus,
    isTransientStatus,
} from '@modules/registry/transitions';
import type { ModuleLifecycleStatus } from '@modules/registry/lifecycle';

export function run() {
    // checkTransition — permitted paths

    const allowed = checkTransition('validated', 'enabled');
    assert.equal(allowed.allowed, true, 'validated → enabled should be allowed');
    assert.equal(allowed.from, 'validated');
    assert.equal(allowed.to, 'enabled');
    assert.equal(allowed.reason, undefined, 'No reason on success');

    const disabled = checkTransition('enabled', 'disabled');
    assert.equal(disabled.allowed, true, 'enabled → disabled should be allowed');

    const upgrading = checkTransition('enabled', 'upgrading');
    assert.equal(upgrading.allowed, true, 'enabled → upgrading should be allowed');

    const uninstall = checkTransition('disabled', 'uninstalling');
    assert.equal(uninstall.allowed, true, 'disabled → uninstalling should be allowed');

    const removed = checkTransition('uninstalling', 'removed');
    assert.equal(removed.allowed, true, 'uninstalling → removed should be allowed');

    const rollback = checkTransition('upgrading', 'errored');
    assert.equal(rollback.allowed, true, 'upgrading → errored should be allowed (failure rollback)');

    // checkTransition — rejected paths

    const skip = checkTransition('discovered', 'enabled');
    assert.equal(skip.allowed, false, 'discovered → enabled should be rejected (must install first)');
    assert.ok(skip.reason, 'Rejection should include a reason');
    assert.ok(skip.reason!.includes('discovered'), 'Reason should mention the from state');

    const noReturn = checkTransition('removed', 'discovered');
    assert.equal(noReturn.allowed, false, 'removed → discovered should be rejected (terminal)');

    const cycleErr = checkTransition('discovered', 'uninstalling');
    assert.equal(cycleErr.allowed, false, 'discovered → uninstalling should be rejected (must install first)');

    // assertTransition — throws on invalid

    assert.throws(
        () => assertTransition('test-module', 'removed', 'enabled'),
        /Cannot transition module "test-module"/,
        'assertTransition should throw for disallowed transitions'
    );

    // assertTransition — does not throw on valid
    assert.doesNotThrow(
        () => assertTransition('test-module', 'installed', 'validated'),
        'assertTransition should not throw for allowed transitions'
    );

    // getAllowedTransitions

    const fromEnabled = getAllowedTransitions('enabled');
    assert.ok(fromEnabled.includes('disabled'), 'enabled allows → disabled');
    assert.ok(fromEnabled.includes('errored'), 'enabled allows → errored');
    assert.ok(fromEnabled.includes('upgrading'), 'enabled allows → upgrading');
    assert.equal(fromEnabled.includes('removed'), false, 'enabled does not allow → removed');

    const fromRemoved = getAllowedTransitions('removed');
    assert.deepEqual(fromRemoved, ['installed'], 'removed allows → installed');

    // isTerminalStatus

    assert.equal(isTerminalStatus('removed'), false, 'removed is no longer terminal');
    assert.equal(isTerminalStatus('enabled'), false, 'enabled is not terminal');
    assert.equal(isTerminalStatus('errored'), false, 'errored is not terminal');

    // isTransientStatus

    assert.equal(isTransientStatus('upgrading'), true, 'upgrading is transient');
    assert.equal(isTransientStatus('uninstalling'), true, 'uninstalling is transient');
    assert.equal(isTransientStatus('enabled'), false, 'enabled is not transient');
    assert.equal(isTransientStatus('removed'), false, 'removed is not transient');

    // Symmetry check — every valid status in union has an entry in ALLOWED_TRANSITIONS
    // (covered implicitly by getAllowedTransitions not throwing for any known status)
    const allStatuses: ModuleLifecycleStatus[] = [
        'discovered', 'installed', 'validated', 'enabled', 'disabled',
        'errored', 'incompatible', 'upgrading', 'uninstalling', 'removed',
    ];
    for (const status of allStatuses) {
        assert.doesNotThrow(
            () => getAllowedTransitions(status),
            `getAllowedTransitions should not throw for status "${status}"`
        );
    }

    console.log('module-lifecycle-transitions: PASS');
}
