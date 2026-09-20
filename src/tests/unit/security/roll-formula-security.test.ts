import { strict as assert } from 'node:assert';
import { NumberGenerator } from '@dice-roller/rpg-dice-roller';
import { Roll, RollFormulaError } from '@server/core/foundry/Roll';
import { toDicePresentation } from '@client/ui/components/Dice/presentation';

export async function run() {
    const cases: [string, number, number][] = [
        ['2d6 + 3', 5, 15], ['2d20kh1', 1, 20], ['2d20kl', 1, 20],
        ['2 + 3 * 4', 14, 14], ['(1d6+2)*2', 6, 16],
        ['{2d6}kh', 2, 12], ['{2d6+2}kl', 4, 14], ['{2d6,1d8}kh', 2, 12],
        ['{1d4,1d6}kh', 1, 6], ['{1d4,1d6}kl', 1, 4],
        ['max(1d8,1d10)', 1, 10], ['min(1d8,1d10)', 1, 8],
        ['max((1d6+2)*2,{1d4,1d6}kh)', 6, 16],
        ['{1d4+2,1d6*2}kh1', 3, 12], ['floor(1d6/2)', 0, 3],
        ['ceil(1d6/2)', 1, 3], ['abs(1d6-3)', 2, 3], ['1.5+2.25', 3.75, 3.75],
        ['1d100', 1, 100], ['1d7', 1, 7], ['100d6', 100, 600],
        ['+1d6', 1, 6], ['-1d6', -1, -6], ['-2+3', 1, 1], ['2 * -3', -6, -6], ['1 / 4', 0.25, 0.25],
    ];
    const engine = NumberGenerator.generator.engine;
    for (const [formula, min, max] of cases) {
        assert.equal((await new Roll(formula).evaluate({ minimize: true })).total, min, formula);
        const roll = await new Roll(formula).evaluate({ maximize: true });
        assert.equal(roll.total, max, formula);
        const before = JSON.stringify(roll.toJSON());
        await roll.evaluate({ minimize: true });
        assert.equal(JSON.stringify(roll.toJSON()), before, 'evaluation is idempotent');
        assert.equal(NumberGenerator.generator.engine, engine, 'RNG state restored');
    }
    for (const formula of [
        '', ' '.repeat(257), '1'.repeat(257), '999999999d6', '101d6', '0d6', '1d0', '1d1000001',
        '1000000001', '2d6kh3', '2d6kh0', '1d6 + process.exit()', '1d6 junk', '1/0',
        'max(1/0,1d6)', '1e999', '2^9999', 'sqrt(4)', '1d6!', '1d6r1', '2d6dh1', '1dF',
        '1d6[secret]', '1d6//secret', '1d6;1d8', 'max()', 'round(1.5)', 'max(1d6,1d8,1d10)', '{1d6,}', '((1d6)', '1d6)+1(',
        '('.repeat(17)+'1d6'+')'.repeat(17), Array(11).fill('100d6').join('+'),
    ]) {
        const roll = new Roll(formula);
        await assert.rejects(roll.evaluate(), RollFormulaError, formula);
        assert.equal(roll.total, undefined, 'rejection is not a successful zero');
        assert.equal(roll.toJSON().evaluated, false);
        assert.deepEqual(roll.toJSON().terms, []);
        assert.equal(NumberGenerator.generator.engine, engine);
    }
    for (const [formula, faces] of [
        ['(1d6+2)*2', '1d6@6'], ['max(1d8,1d10)', '1d8+1d10@8,10'],
        ['{1d4,1d6}kh', '1d4+1d6@4,6'],
        ['max((1d6+2)*2,{1d4,1d6}kh)', '1d6+1d6+1d4@6,6,4'],
    ]) {
        const roll = await new Roll(formula).evaluate({ maximize: true });
        const message = { _id: 'test', author: 'player', rolls: [JSON.parse(JSON.stringify(roll.toJSON()))] };
        assert.equal(toDicePresentation(message)?.notation, faces, 'one recorded face per physical die');
    }
    const pool = (await new Roll('{1d4,1d6}kh').evaluate({ maximize: true })).toJSON();
    assert.deepEqual(pool.terms[0].results.map((r: any) => r.active), [false, true]);
    const keep = (await new Roll('2d20kh').evaluate({ maximize: true })).toJSON();
    assert.equal(keep.terms[0].results.filter((r: any) => r.active).length, 1);
    assert.equal((await new Roll('1-1').evaluate()).total, 0, 'a legitimate zero remains valid');
    console.log('  - bounded shared roll evaluator: all checks passed');
}

if (import.meta.url === `file://${process.argv[1]}`) await run();
