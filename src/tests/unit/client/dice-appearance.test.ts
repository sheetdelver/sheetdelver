import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { normalizeDiceAppearance, diceAppearanceOptions, diceStyles, diceColorContrast, presetColors } from '../../../client/ui/components/Dice/appearance';

export function run() {
    for (const value of [null, undefined, [], { style: '__proto__', size: '150' }, { style: '../texture', size: NaN }]) {
        assert.deepEqual(normalizeDiceAppearance(value), { style: 'teal', size: 100 });
    }
    assert.equal(normalizeDiceAppearance({ size: -1 }).size, 75);
    assert.equal(normalizeDiceAppearance({ size: 1000 }).size, 150);
    assert.equal(normalizeDiceAppearance({ size: 111 }).size, 110);
    assert.equal(normalizeDiceAppearance({ size: Infinity }).size, 100);
    for (const style of diceStyles) {
        const settings = { style: style.id, size: 100 };
        assert.deepEqual(normalizeDiceAppearance(settings), settings);
        const desktop = diceAppearanceOptions(settings, 1440);
        const mobile = diceAppearanceOptions(settings, 390);
        assert.equal(desktop.baseScale, 90);
        assert.equal(mobile.baseScale, 65);
        assert.equal(desktop.theme_customColorset.background, style.background);
        assert.equal(desktop.theme_customColorset.texture, style.texture);
        assert.equal(desktop.assetPath, '/dice/');
    }
    assert.equal(diceAppearanceOptions({ style: 'teal', size: 75 }, 1440).baseScale, 67.5);
    assert.equal(diceAppearanceOptions({ style: 'teal', size: 150 }, 390).baseScale, 97.5);
    assert.ok(existsSync('public/dice/textures/marble.webp'));
    const custom = normalizeDiceAppearance({ style: 'custom', size: 150, custom: {
        body: '#ABCDEF', label: '#112233', outline: null, edge: '#445566',
    } });
    assert.deepEqual(custom.custom, { body: '#abcdef', label: '#112233', outline: null, edge: '#445566' });
    const options = diceAppearanceOptions(custom, 390).theme_customColorset;
    assert.equal(options.background, '#abcdef'); assert.equal(options.foreground, '#112233');
    assert.equal(options.outline, 'none'); assert.equal(options.edge, '#445566'); assert.equal(options.texture, 'none');
    assert.deepEqual(normalizeDiceAppearance({ style: 'custom', custom: { body: 'url(https://invalid)', label: '#xyz', outline: 3 } }).custom, presetColors('teal'));
    assert.deepEqual(normalizeDiceAppearance({ ...custom, style: 'white' }).custom, custom.custom, 'presets retain Custom colors');
    assert.equal(diceColorContrast({ body: '#000000', label: '#ffffff', edge: '#000000', outline: null }), 21);
    assert.equal(diceColorContrast({ body: '#ffffff', label: '#ffffff', edge: '#000000', outline: null }), 1);
}
