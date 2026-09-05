/**
 * ADR-0032 Phase 0: characterize actor-delete result reporting.
 *
 * Foundry remains authoritative because the route uses the requesting user's
 * client. These tests audit only whether that upstream result stays truthful.
 */
import { strict as assert } from 'node:assert';
import { registerActorRoutes } from '@server/routes/protected/registerActorRoutes';
import {
    createResponseStub,
    createRouteMap,
    createRouterStub,
    getLastHandler,
    invokeHandler,
} from './route-test-helpers';

interface DeleteActorClient {
    deleteActor(actorId: string): Promise<void>;
}

export async function run() {
    await runSuccessfulDeleteReportsSuccess();
    await runPermissionDenialReportsFailure();
    await runTransportFailureReportsFailure();
    console.log('  - Actor mutation outcomes: all checks passed');
}

function createDeleteHandler() {
    const routeMap = createRouteMap();
    registerActorRoutes(createRouterStub(routeMap) as any, {
        normalizeActors: async actors => actors,
        config: {} as any,
    });
    return getLastHandler(routeMap, 'delete', '/actors/:id');
}

async function invokeDelete(client: DeleteActorClient) {
    return invokeHandler(
        createDeleteHandler(),
        {
            params: { id: 'actor-audit' },
            // This narrow fake cannot expose or provide a system-client fallback.
            foundryClient: client as any,
        },
        createResponseStub(),
    );
}

async function runSuccessfulDeleteReportsSuccess() {
    let dispatchCount = 0;
    const response = await invokeDelete({
        async deleteActor(actorId) {
            dispatchCount++;
            assert.equal(actorId, 'actor-audit');
        },
    });

    assert.equal(dispatchCount, 1, 'actor deletion dispatches exactly once');
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.payload, { success: true });
}

async function runPermissionDenialReportsFailure() {
    const response = await invokeDelete({
        async deleteActor() {
            throw new Error('Permission denied by Foundry');
        },
    });

    assert.equal(response.statusCode, 403, 'Foundry permission denial remains a failed request');
    assert.deepEqual(response.payload, {
        success: false,
        error: 'Permission denied by Foundry',
    });
}

async function runTransportFailureReportsFailure() {
    const response = await invokeDelete({
        async deleteActor() {
            throw new Error('Foundry transport unavailable');
        },
    });

    assert.equal(response.statusCode, 500);
    assert.notEqual(
        (response.payload as { success?: unknown })?.success,
        true,
        'transport rejection must never be converted into success',
    );
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('actor-mutation-outcomes.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
