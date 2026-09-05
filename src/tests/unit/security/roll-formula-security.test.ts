import { strict as assert } from 'node:assert';
import { Roll } from '@server/core/foundry/Roll';

export async function run() {
    const normal = await new Roll('2d6 + 3').evaluate({ maximize: true });
    assert.equal(normal.total, 15, 'bounded dice plus modifiers retain normal behavior');

    const keepHighest = await new Roll('2d20kh1').evaluate({ maximize: true });
    assert.equal(keepHighest.total, 20, 'keep-highest remains supported');

    const precedence = await new Roll('2 + 3 * 4').evaluate();
    assert.equal(precedence.total, 14, 'the non-dynamic evaluator preserves operator precedence');

    const excessiveDice = await new Roll('999999999d6').evaluate();
    assert.equal(excessiveDice.total, 0, 'excessive dice counts fail closed before allocation');
    assert.deepEqual(excessiveDice.toJSON().terms, []);

    const excessiveFormula = await new Roll(' '.repeat(257)).evaluate();
    assert.equal(excessiveFormula.total, 0, 'raw formula length is bounded before normalization');

    const unsupportedText = await new Roll('1d20 + process.exit()').evaluate();
    assert.equal(unsupportedText.total, 0, 'unsupported text cannot be skipped into a partial formula');
    assert.deepEqual(unsupportedText.toJSON().terms, []);

    const divideByZero = await new Roll('1 / 0').evaluate();
    assert.equal(divideByZero.total, 0, 'non-finite arithmetic fails closed');

    console.log('  - bounded roll formula evaluator: all checks passed');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    await run();
    console.log('roll-formula-security.test.ts passed');
}
