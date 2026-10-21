import { logger } from '@shared/utils/logger';

/** Monotonic wall time, including awaited IO. Segments do not overlap. */
export function bootstrapTimings(operation: 'Bootstrap' | 'Recovery', initialPhase: string,
    now = () => performance.now(), report = (message: string) => logger.info(message)) {
    const started = now(); let last = started; let phase = initialPhase; let finished = false;
    const segments: string[] = [];
    const record = (at: number) => {
        const elapsed = Math.max(0, at - last);
        segments.push(`${phase}=${elapsed.toFixed(1)}ms`);
        report(`WorldBootstrapper | ${operation} phase ${phase}: ${elapsed.toFixed(1)}ms`);
        last = at;
    };
    return {
        phase(next: string) { if (!finished && next !== phase) { record(now()); phase = next; } return next; },
        finish(outcome: 'complete' | 'failed' | 'discarded' | 'replaced') {
            if (finished) return;
            const at = now(); record(at); finished = true;
            report(`WorldBootstrapper | ${operation} ${outcome} in ${Math.max(0, at - started).toFixed(1)}ms (${segments.join(', ')})`);
        },
    };
}
