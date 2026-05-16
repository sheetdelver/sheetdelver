import { strict as assert } from 'node:assert';
import { createActorService } from '@server/services/actors/ActorService';
import { createCombatService } from '@server/services/combats/CombatService';
import { userStore } from '@server/core/documents/primary/users/UserStore';

async function runActorReadWriteSmoke() {
    const normalizeCalls: Array<{ ids: string[] }> = [];
    const createActorCalls: Array<Record<string, unknown>> = [];

    const actorService = createActorService({
        normalizeActors: async (actorList) => {
            normalizeCalls.push({ ids: actorList.map((actor) => String(actor._id || actor.id)) });
            return actorList.map((actor) => ({
                _id: actor._id,
                id: actor.id,
                name: actor.name,
                type: actor.type,
            }));
        },
        config: {
            debug: { enabled: false, level: 2 },
        } as any,
    });

    const actorClient = {
        userId: 'user-1',
        url: 'http://localhost:30000',
        getSystem: async () => ({ id: 'generic' }),
        getActors: async () => ([
            {
                _id: 'actor-owned',
                id: 'actor-owned',
                name: 'Owned Hero',
                type: 'character',
                ownership: { 'user-1': 3, default: 0 },
            },
            {
                _id: 'actor-readonly',
                id: 'actor-readonly',
                name: 'Observed Ally',
                type: 'character',
                ownership: { default: 2 },
            },
            {
                _id: 'actor-npc',
                id: 'actor-npc',
                name: 'Hidden Goblin',
                type: 'npc',
                ownership: { default: 2 },
            },
        ]),
        createActor: async (payload: Record<string, unknown>) => {
            createActorCalls.push(payload);
            return { _id: 'new-actor-id', name: payload.name };
        },
    } as any;

    const listPayload = await actorService.listActors(actorClient);
    assert.equal(listPayload.system, 'generic');
    assert.equal(listPayload.ownedActors.length, 1);
    assert.equal(listPayload.readOnlyActors.length, 1);
    assert.equal(listPayload.ownedActors[0].name, 'Owned Hero');
    assert.equal(listPayload.readOnlyActors[0].name, 'Observed Ally');
    // The list endpoint should now carry dashboard cards for the same visible set.
    assert.equal(listPayload.actorCards?.['actor-owned']?.name, 'Owned Hero');
    assert.equal(listPayload.actorCards?.['actor-readonly']?.name, 'Observed Ally');
    assert.equal(listPayload.actorCards?.['actor-npc'], undefined);
    assert.equal(normalizeCalls.length, 3);

    const createPayload = {
        name: 'Smoke Actor',
        type: 'character',
        items: [
            {
                name: 'Bad Effect Item',
                effects: ['invalid-effect-id'],
                system: {
                    removeMe: [],
                    keepMe: [123],
                },
            },
        ],
    } as Record<string, unknown>;

    const createResult = await actorService.createActor(actorClient, createPayload);

    assert.equal(createResult.success, true);
    assert.equal(createResult.id, 'new-actor-id');
    assert.equal(createActorCalls.length, 1);
    const forwarded = createActorCalls[0] as any;
    assert.deepEqual(forwarded.items[0].effects, []);
    assert.equal(Object.prototype.hasOwnProperty.call(forwarded.items[0].system, 'removeMe'), false);
    assert.deepEqual(forwarded.items[0].system.keepMe, [123]);
}

async function runCombatReadActionSmoke() {
    const normalizeCalls: Array<{ ids: string[] }> = [];
    const dispatchCalls: Array<{ collection: string; action: string; payload: unknown }> = [];

    const combatService = createCombatService({
        normalizeActors: async (actorList) => {
            normalizeCalls.push({ ids: actorList.map((actor) => String(actor._id || actor.id)) });
            return actorList.map((actor) => ({ ...actor, normalized: true }));
        },
    });

    await userStore.seed(async () => [
        { _id: 'gm-1', id: 'gm-1', role: 4 },
        { _id: 'player-1', id: 'player-1', role: 1 },
        { _id: 'player-owner', id: 'player-owner', role: 1 },
        { _id: 'gm-wrap', id: 'gm-wrap', role: 4 },
        { _id: 'gm-not-found', id: 'gm-not-found', role: 4 },
        { _id: 'gm-prev-happy', id: 'gm-prev-happy', role: 4 },
        { _id: 'gm-prev-wrap', id: 'gm-prev-wrap', role: 4 },
        { _id: 'gm-prev-start', id: 'gm-prev-start', role: 4 },
    ]);

    const combatClient = {
        userId: 'gm-1',
        getCombats: async () => ([
            {
                _id: 'combat-1',
                id: 'combat-1',
                round: 0,
                turn: -1,
                combatants: [
                    { _id: 'c1', id: 'c1', actorId: 'actor-a', initiative: 15 },
                    { _id: 'c2', id: 'c2', actorId: 'actor-b', initiative: 12 },
                ],
            },
        ]),
        getActor: async (id: string) => ({
            _id: id,
            id,
            name: `Actor ${id}`,
            ownership: { 'gm-1': 3 },
        }),
        dispatchDocumentSocket: async (collection: string, action: string, payload: unknown) => {
            dispatchCalls.push({ collection, action, payload });
        },
    } as any;

    const listPayload = await combatService.listCombats(combatClient);
    assert.equal(listPayload.success, true);
    assert.equal(listPayload.combats.length, 1);
    assert.equal(listPayload.combats[0].combatants?.[0].actor?.name, 'Actor actor-a');
    assert.equal(normalizeCalls.length, 1);

    const turnResult = await combatService.advanceTurn(combatClient, 'combat-1');
    if ('error' in turnResult) {
        assert.fail(`Expected combat turn success, got error: ${turnResult.error}`);
    }

    assert.equal(turnResult.success, true);
    assert.equal(turnResult.round, 1);
    assert.equal(turnResult.turn, 0);
    assert.equal(dispatchCalls.length, 1);
    assert.equal(dispatchCalls[0].collection, 'Combat');
    assert.equal(dispatchCalls[0].action, 'update');
    assert.deepEqual(dispatchCalls[0].payload, {
        updates: [{ _id: 'combat-1', round: 1, turn: 0 }],
    });

    const buildCombatClient = (params: {
        userId: string;
        role: number;
        ownershipByActorId?: Record<string, number>;
        combat: {
            _id: string;
            id: string;
            round: number;
            turn: number;
            combatants: Array<{ _id: string; id: string; actorId: string; initiative: number }>;
        };
    }) => {
        const localDispatchCalls: Array<{ collection: string; action: string; payload: unknown }> = [];
        const client = {
            userId: params.userId,
            getCombats: async () => ([params.combat]),
            getActor: async (id: string) => ({
                _id: id,
                id,
                name: `Actor ${id}`,
                ownership: { [params.userId]: params.ownershipByActorId?.[id] || 0 },
            }),
            dispatchDocumentSocket: async (collection: string, action: string, payload: unknown) => {
                localDispatchCalls.push({ collection, action, payload });
            },
        } as any;

        return { client, localDispatchCalls };
    };

    const unauthorizedCase = buildCombatClient({
        userId: 'player-1',
        role: 1,
        ownershipByActorId: { 'actor-a': 0, 'actor-b': 0 },
        combat: {
            _id: 'combat-auth-deny',
            id: 'combat-auth-deny',
            round: 1,
            turn: 0,
            combatants: [
                { _id: 'c1', id: 'c1', actorId: 'actor-a', initiative: 15 },
                { _id: 'c2', id: 'c2', actorId: 'actor-b', initiative: 12 },
            ],
        },
    });

    const unauthorizedResult = await combatService.advanceTurn(unauthorizedCase.client, 'combat-auth-deny');
    if (!('error' in unauthorizedResult)) {
        assert.fail('Expected unauthorized combat turn error');
    }
    assert.equal(unauthorizedResult.status, 403);
    assert.equal(unauthorizedCase.localDispatchCalls.length, 0);

    const ownerCase = buildCombatClient({
        userId: 'player-owner',
        role: 1,
        ownershipByActorId: { 'actor-a': 3, 'actor-b': 0 },
        combat: {
            _id: 'combat-owner-advance',
            id: 'combat-owner-advance',
            round: 1,
            turn: 0,
            combatants: [
                { _id: 'c1', id: 'c1', actorId: 'actor-a', initiative: 15 },
                { _id: 'c2', id: 'c2', actorId: 'actor-b', initiative: 12 },
            ],
        },
    });

    const ownerResult = await combatService.advanceTurn(ownerCase.client, 'combat-owner-advance');
    if ('error' in ownerResult) {
        assert.fail(`Expected owner authorization success, got error: ${ownerResult.error}`);
    }
    assert.equal(ownerResult.success, true);
    assert.equal(ownerResult.round, 1);
    assert.equal(ownerResult.turn, 1);
    assert.equal(ownerCase.localDispatchCalls.length, 1);
    assert.deepEqual(ownerCase.localDispatchCalls[0].payload, {
        updates: [{ _id: 'combat-owner-advance', round: 1, turn: 1 }],
    });

    const wrapCase = buildCombatClient({
        userId: 'gm-wrap',
        role: 4,
        combat: {
            _id: 'combat-wrap',
            id: 'combat-wrap',
            round: 1,
            turn: 1,
            combatants: [
                { _id: 'c1', id: 'c1', actorId: 'actor-a', initiative: 15 },
                { _id: 'c2', id: 'c2', actorId: 'actor-b', initiative: 12 },
            ],
        },
    });

    const wrapResult = await combatService.advanceTurn(wrapCase.client, 'combat-wrap');
    if ('error' in wrapResult) {
        assert.fail(`Expected round wrap success, got error: ${wrapResult.error}`);
    }
    assert.equal(wrapResult.round, 2);
    assert.equal(wrapResult.turn, 0);
    assert.equal(wrapCase.localDispatchCalls.length, 1);
    assert.deepEqual(wrapCase.localDispatchCalls[0].payload, {
        updates: [{ _id: 'combat-wrap', round: 2, turn: 0 }],
    });

    const notFoundCase = buildCombatClient({
        userId: 'gm-not-found',
        role: 4,
        combat: {
            _id: 'combat-existing',
            id: 'combat-existing',
            round: 1,
            turn: 0,
            combatants: [
                { _id: 'c1', id: 'c1', actorId: 'actor-a', initiative: 15 },
            ],
        },
    });

    const notFoundResult = await combatService.advanceTurn(notFoundCase.client, 'combat-missing');
    if (!('error' in notFoundResult)) {
        assert.fail('Expected combat not found error');
    }
    assert.equal(notFoundResult.status, 404);
    assert.equal(notFoundCase.localDispatchCalls.length, 0);

    const previousHappyCase = buildCombatClient({
        userId: 'gm-prev-happy',
        role: 4,
        combat: {
            _id: 'combat-prev-happy',
            id: 'combat-prev-happy',
            round: 2,
            turn: 1,
            combatants: [
                { _id: 'c1', id: 'c1', actorId: 'actor-a', initiative: 15 },
                { _id: 'c2', id: 'c2', actorId: 'actor-b', initiative: 12 },
            ],
        },
    });

    const previousHappyResult = await combatService.previousTurn(previousHappyCase.client, 'combat-prev-happy');
    if ('error' in previousHappyResult) {
        assert.fail(`Expected previous turn success, got error: ${previousHappyResult.error}`);
    }
    assert.equal(previousHappyResult.round, 2);
    assert.equal(previousHappyResult.turn, 0);
    assert.equal(previousHappyCase.localDispatchCalls.length, 1);
    assert.deepEqual(previousHappyCase.localDispatchCalls[0].payload, {
        updates: [{ _id: 'combat-prev-happy', round: 2, turn: 0 }],
    });

    const previousRoundWrapCase = buildCombatClient({
        userId: 'gm-prev-wrap',
        role: 4,
        combat: {
            _id: 'combat-prev-wrap',
            id: 'combat-prev-wrap',
            round: 2,
            turn: 0,
            combatants: [
                { _id: 'c1', id: 'c1', actorId: 'actor-a', initiative: 15 },
                { _id: 'c2', id: 'c2', actorId: 'actor-b', initiative: 12 },
            ],
        },
    });

    const previousWrapResult = await combatService.previousTurn(previousRoundWrapCase.client, 'combat-prev-wrap');
    if ('error' in previousWrapResult) {
        assert.fail(`Expected previous round wrap success, got error: ${previousWrapResult.error}`);
    }
    assert.equal(previousWrapResult.round, 1);
    assert.equal(previousWrapResult.turn, 1);
    assert.equal(previousRoundWrapCase.localDispatchCalls.length, 1);
    assert.deepEqual(previousRoundWrapCase.localDispatchCalls[0].payload, {
        updates: [{ _id: 'combat-prev-wrap', round: 1, turn: 1 }],
    });

    const previousStartCase = buildCombatClient({
        userId: 'gm-prev-start',
        role: 4,
        combat: {
            _id: 'combat-prev-start',
            id: 'combat-prev-start',
            round: 1,
            turn: 0,
            combatants: [
                { _id: 'c1', id: 'c1', actorId: 'actor-a', initiative: 15 },
                { _id: 'c2', id: 'c2', actorId: 'actor-b', initiative: 12 },
            ],
        },
    });

    const previousStartResult = await combatService.previousTurn(previousStartCase.client, 'combat-prev-start');
    if ('error' in previousStartResult) {
        assert.fail(`Expected previous start boundary success, got error: ${previousStartResult.error}`);
    }
    assert.equal(previousStartResult.round, 0);
    assert.equal(previousStartResult.turn, 0);
    assert.equal(previousStartCase.localDispatchCalls.length, 1);
    assert.deepEqual(previousStartCase.localDispatchCalls[0].payload, {
        updates: [{ _id: 'combat-prev-start', round: 0, turn: 0 }],
    });
}

export async function run() {
    await runActorReadWriteSmoke();
    try {
        await runCombatReadActionSmoke();
    } finally {
        userStore.clear('actor-combat-smoke-test');
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('actor-combat-smoke.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
