import { strict as assert } from 'node:assert';
import { sortCombatants } from '@server/services/combats/CombatService';

function idsOf(list: Array<{ _id?: string; id?: string }>) {
    return list.map((combatant) => String(combatant._id || combatant.id || ''));
}

export function run() {
    const descending = sortCombatants([
        { _id: 'c1', id: 'c1', initiative: 10 } as any,
        { _id: 'c2', id: 'c2', initiative: 20 } as any,
        { _id: 'c3', id: 'c3', initiative: 15 } as any,
    ]);
    assert.deepEqual(idsOf(descending), ['c2', 'c3', 'c1']);

    const tieBreak = sortCombatants([
        { _id: 'b', id: 'b', initiative: 10 } as any,
        { _id: 'a', id: 'a', initiative: 10 } as any,
    ]);
    assert.deepEqual(idsOf(tieBreak), ['a', 'b']);

    const nanFallsLast = sortCombatants([
        { _id: 'good', id: 'good', initiative: 10 } as any,
        { _id: 'nan', id: 'nan', initiative: Number.NaN } as any,
    ]);
    assert.deepEqual(idsOf(nanFallsLast), ['good', 'nan']);

    const undefinedFallsLast = sortCombatants([
        { _id: 'good', id: 'good', initiative: 10 } as any,
        { _id: 'undef', id: 'undef' } as any,
    ]);
    assert.deepEqual(idsOf(undefinedFallsLast), ['good', 'undef']);

    const allEqualUsesId = sortCombatants([
        { _id: 'charlie', id: 'charlie', initiative: 8 } as any,
        { _id: 'alpha', id: 'alpha', initiative: 8 } as any,
        { _id: 'bravo', id: 'bravo', initiative: 8 } as any,
    ]);
    assert.deepEqual(idsOf(allEqualUsesId), ['alpha', 'bravo', 'charlie']);

    const single = sortCombatants([
        { _id: 'only', id: 'only', initiative: 1 } as any,
    ]);
    assert.deepEqual(idsOf(single), ['only']);

    const empty = sortCombatants([]);
    assert.deepEqual(empty, []);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    try {
        run();
        console.log('combat-sort.test.ts passed');
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
}
