import assert from 'node:assert/strict';
import { Dice, NumberGenerator, Results } from '@dice-roller/rpg-dice-roller';
import { Roll, RollFormulaError } from '@server/core/foundry/Roll';
import { toDicePresentation } from '@client/ui/components/Dice/presentation';

async function withFaces<T>(faces: number[], test: () => Promise<T>): Promise<T> {
    const original = Dice.StandardDice.prototype.rollOnce;
    let index = 0;
    Dice.StandardDice.prototype.rollOnce = function () {
        assert.ok(index < faces.length, 'no unexpected extra roll');
        return new Results.RollResult(faces[index++]);
    };
    try {
        const result = await test();
        assert.equal(index, faces.length, 'every planned face was used');
        return result;
    } finally {
        Dice.StandardDice.prototype.rollOnce = original;
    }
}

async function evaluate(formula: string, faces: number[]) {
    return withFaces(faces, async () => (await new Roll(formula).evaluate()).toJSON());
}

export async function run() {
    const dropped = await evaluate('4d6dl1', [1, 3, 4, 6]);
    assert.equal(dropped.total, 13);
    assert.deepEqual(dropped.terms[0].results[0], { result: 1, active: false, discarded: true });
    assert.equal((await evaluate('4d6dh1', [1, 3, 4, 6])).total, 8);
    assert.equal((await evaluate('4d6kh2', [1, 3, 4, 6])).total, 10);
    assert.equal((await evaluate('4d6k', [1, 3, 4, 6])).total, 6);
    const ties = await evaluate('3d6dl1', [2, 2, 3]);
    assert.deepEqual(ties.terms[0].results.map((r: any) => !!r.discarded), [true, false, false]);

    const constrained = await evaluate('4d6min2max5', [1, 2, 5, 6]);
    assert.equal(constrained.total, 14);
    assert.deepEqual(constrained.terms[0].results.map((r: any) => r.result), [1, 2, 5, 6],
        'actual physical faces stay recorded when min/max changes contribution');
    assert.deepEqual(constrained.terms[0].results.map((r: any) => r.count ?? r.result), [2, 2, 5, 5]);
    assert.deepEqual(constrained.terms[0].results.map((r: any) => !!r.rerolled), [true, false, false, true]);
    assert.equal((await evaluate('4d6cs>=5', [1, 3, 5, 6])).total, 2);
    assert.equal((await evaluate('4d6cf<=2', [1, 3, 5, 6])).total, 1);
    assert.equal((await evaluate('4d6even', [1, 2, 3, 4])).total, 2);
    assert.equal((await evaluate('4d6odd', [1, 2, 3, 4])).total, 2);
    assert.equal((await evaluate('4d6cs>=4df<=2', [1, 2, 4, 6])).total, 0);
    assert.equal((await evaluate('4d6cs>=4sf<=2', [1, 2, 4, 6])).total, -1);
    assert.equal((await evaluate('3d6ms10', [1, 2, 3])).total, -4);
    assert.equal((await evaluate('3d6ms<10', [1, 2, 3])).total, 4);

    const rerolled = await evaluate('2d6r=1', [1, 4, 5]);
    assert.equal(rerolled.total, 9);
    assert.deepEqual(rerolled.terms[0].results.map((r: any) => [r.result, r.active, !!r.rerolled]),
        [[1, false, true], [4, true, false], [5, true, false]]);
    const recursive = await evaluate('1d6rr<3', [1, 2, 5]);
    assert.equal(recursive.total, 5);
    assert.deepEqual(recursive.terms[0].results.map((r: any) => !!r.rerolled), [true, true, false]);
    const exploded = await evaluate('2d6x6', [6, 2, 4]);
    assert.equal(exploded.total, 12);
    assert.deepEqual(exploded.terms[0].results.map((r: any) => !!r.exploded), [true, false, false]);
    const once = await evaluate('2d6xo6', [6, 6, 6, 5]);
    assert.equal(once.total, 23);
    assert.deepEqual(once.terms[0].results.map((r: any) => !!r.exploded), [true, true, false, false]);
    assert.equal((await evaluate('1d6x2=6', [6, 6, 6])).total, 18);

    const nested = await evaluate('{1d6cs>=5,1d8+1}kh', [6, 2]);
    assert.equal(nested.total, 3);
    assert.deepEqual(nested.terms[0].results.map((r: any) => [r.result, r.active]), [[1, false], [3, true]]);
    const poolCount = await evaluate('{1d6,1d8,1d10}cs>=5', [6, 2, 8]);
    assert.equal(poolCount.total, 2);
    assert.deepEqual(poolCount.terms[0].results.map((r: any) => [r.result, r.count, r.success]),
        [[6, 1, true], [2, 0, false], [8, 1, true]]);
    assert.equal((await evaluate('{1d6,1d8}cf<=2', [6, 2])).total, 1);
    const poolOrder = await evaluate('{1d6,1d8}cs>=5kh1', [6, 4]);
    assert.equal(poolOrder.total, 1);
    assert.deepEqual(poolOrder.terms[0].modifiers, ['cs>=5', 'kh1'], 'Foundry pool rule order is preserved');
    assert.equal((await evaluate('{1d6,1d8}kh3', [6, 8])).total, 14,
        'keeping more entries than exist clamps to the pool size');
    assert.equal((await evaluate('{1d6,1d8}d', [6, 8])).total, 8);
    const functionRoll = await evaluate('max(1d6cs>=5,1d8)', [6, 2]);
    assert.equal(functionRoll.total, 2);
    assert.equal(functionRoll.dice.length, 2, 'reduced functions retain the physical dice');
    assert.equal(toDicePresentation({ _id: 'rules', author: 'player', rolls: [exploded] })?.notation,
        '1d6+1d6+1d6@6,2,4', 'recorded explosion faces remain animatable');

    const originalEngine = NumberGenerator.generator.engine;
    const repeated = new Roll('1d1x1');
    await assert.rejects(repeated.evaluate(), RollFormulaError, 'unbounded explosions fail at the result budget');
    assert.equal(repeated.total, undefined);
    assert.equal(repeated.toJSON().evaluated, false);
    assert.equal(NumberGenerator.generator.engine, originalEngine);
    for (const formula of ['1d6r>=', '1d6x10000000000=6', '1d6foo', '1d6!', '1d6min', '1d6ms']) {
        await assert.rejects(new Roll(formula).evaluate(), RollFormulaError, formula);
    }
    for (const formula of ['4d6cs', '4d6cf', '{1d6,1d8}cs', '{1d6,1d8}cf',
        '1d6csdf<=2', '{1d6,1d8}kh1cf']) {
        const roll = new Roll(formula);
        await assert.rejects(roll.evaluate(), error => error instanceof RollFormulaError
            && /requires an explicit target/.test(error.message), formula);
        assert.equal(roll.toJSON().evaluated, false, 'targetless counts never become successful rolls');
    }
    console.log('  - Foundry numeric die rules: all checks passed');
}

if (import.meta.url === `file://${process.argv[1]}`) await run();
