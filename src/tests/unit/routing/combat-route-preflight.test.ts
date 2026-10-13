import { strict as assert } from 'node:assert';
import { registerCombatRoutes } from '@server/routes/protected/registerCombatRoutes';
import {
    createRouteMap,
    createRouterStub,
    getLastHandler,
    invokeHandler,
} from './route-test-helpers';

/** Invalid ordinary HUD requests must stop at HTTP validation, before service reads or writes. */
export async function run(): Promise<void> {
    const routes = createRouteMap();
    registerCombatRoutes(createRouterStub(routes) as any);

    for (const path of ['/combats/:id/next-turn', '/combats/:id/previous-turn']) {
        const handler = getLastHandler(routes, 'post', path);
        for (const observed of [undefined, {}, { active: true, started: true, round: 1 },
            { active: true, started: true, round: 1.5, currentCombatantId: null }]) {
            const response = await invokeHandler(handler, { body: { observed }, params: { id: 'combat' } } as any);
            assert.equal(response.statusCode, 400);
            assert.deepEqual(response.payload, { error: 'Observed encounter state required' });
        }
    }

    const initiative = getLastHandler(routes, 'post', '/combats/:id/combatants/:combatantId/roll-initiative');
    const observed = { initiative: null, formula: '1d20' };
    for (const body of [undefined, {}, { observed, formula: '100d20' },
        { observed: { initiative: null } }, { observed, manualTotal: Number.POSITIVE_INFINITY },
        { observed: { ...observed, phaseGeneration: 5 } },
        { observed, advantageMode: 'unknown' }]) {
        const response = await invokeHandler(initiative, { body,
            params: { id: 'combat', combatantId: 'row' } } as any);
        assert.equal(response.statusCode, 400);
        assert.deepEqual(response.payload, { error: 'Invalid initiative request' });
    }
    console.log('  - Combat HTTP preflight: observed state and bounded initiative body passed');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    await run();
    console.log('combat-route-preflight.test.ts passed');
}
