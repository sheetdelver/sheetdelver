import { strict as assert } from 'node:assert';
import {
    FULL_STACK_RESTART_EXIT_CODE,
    FULL_STACK_RESTART_SIGNAL,
    requestFullStackRestart,
} from '@shared/runtime/fullStackRestart';

export function run() {
    let signalled: { pid: number; signal: NodeJS.Signals } | null = null;
    let exitCode: number | null = null;
    const managedOutcome = requestFullStackRestart({
        managerPid: '42',
        currentPid: 10,
        sendSignal: (pid, signal) => {
            signalled = { pid, signal };
        },
        exitProcess: (code) => { exitCode = code; },
    });
    assert.equal(managedOutcome, 'manager-signal');
    assert.deepEqual(signalled, { pid: 42, signal: FULL_STACK_RESTART_SIGNAL });
    assert.equal(exitCode, null);

    const directOutcome = requestFullStackRestart({
        managerPid: 'not-a-pid',
        currentPid: 10,
        sendSignal: () => {
            throw new Error('invalid manager PID must not be signalled');
        },
        exitProcess: (code) => { exitCode = code; },
    });
    assert.equal(directOutcome, 'exit-code');
    assert.equal(exitCode, FULL_STACK_RESTART_EXIT_CODE);

    exitCode = null;
    const staleManagerOutcome = requestFullStackRestart({
        managerPid: '42',
        currentPid: 10,
        sendSignal: () => {
            throw new Error('manager unavailable');
        },
        exitProcess: (code) => { exitCode = code; },
    });
    assert.equal(staleManagerOutcome, 'exit-code');
    assert.equal(exitCode, FULL_STACK_RESTART_EXIT_CODE);

    console.log('  - full stack restart: all checks passed');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run();
}
