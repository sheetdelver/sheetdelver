import type { AuthenticatedStatusPayload } from '@shared/contracts/status';

export const FULL_STACK_RESTART_EXIT_CODE = 75;
export const FULL_STACK_RESTART_SIGNAL: NodeJS.Signals = 'SIGUSR2';
export const MANAGER_PID_ENV = 'SHEET_DELVER_MANAGER_PID';

interface FullStackRestartOptions {
    managerPid?: string;
    currentPid?: number;
    sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
    exitProcess?: (code: number) => void;
}

/**
 * Ask the Sheet Delver process manager to cycle Core and Next together.
 * Exit code 75 remains the fallback for direct/non-managed Core launches.
 */
export function requestFullStackRestart(options: FullStackRestartOptions = {}): 'manager-signal' | 'exit-code' {
    const managerPid = Number.parseInt(options.managerPid ?? process.env[MANAGER_PID_ENV] ?? '', 10);
    const currentPid = options.currentPid ?? process.pid;
    const sendSignal = options.sendSignal ?? ((pid, signal) => process.kill(pid, signal));
    const exitProcess = options.exitProcess ?? ((code) => process.exit(code));

    if (Number.isSafeInteger(managerPid) && managerPid > 1 && managerPid !== currentPid) {
        try {
            sendSignal(managerPid, FULL_STACK_RESTART_SIGNAL);
            return 'manager-signal';
        } catch {
            // The manager may have exited between PID validation and signalling.
        }
    }

    exitProcess(FULL_STACK_RESTART_EXIT_CODE);
    return 'exit-code';
}

export function isRuntimeRestartReady(
    status: Partial<AuthenticatedStatusPayload>,
): boolean {
    return status.connected === true && status.initialized === true;
}
