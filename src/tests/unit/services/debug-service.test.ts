import { strict as assert } from 'node:assert';
import { createDebugService } from '@server/services/debug/DebugService';

async function assertRejectsWithStatus(
    operation: () => Promise<unknown>,
    status: number,
    message: string,
) {
    try {
        await operation();
        assert.fail('Expected operation to reject');
    } catch (error) {
        assert.equal((error as { status?: number }).status, status);
        assert.equal((error as Error).message, message);
    }
}

export async function run() {
    let restoreCalls = 0;
    const debugService = createDebugService({
        getOrRestoreSession: async () => {
            restoreCalls += 1;
            return undefined;
        },
    });

    await assertRejectsWithStatus(
        () => debugService.getActor('actor-1', ''),
        401,
        'Unauthorized: Missing Session Token',
    );
    assert.equal(restoreCalls, 0);

    await assertRejectsWithStatus(
        () => debugService.getActor('actor-1', 'Bearer missing-session'),
        401,
        'Unauthorized: Invalid or Expired Session',
    );
    assert.equal(restoreCalls, 1);

    console.log('  - DebugService: all checks passed');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('debug-service.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
