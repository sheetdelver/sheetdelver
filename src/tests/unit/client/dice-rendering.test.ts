import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import type DiceBox from '@3d-dice/dice-box-threejs';
import { diceStyles, dicePalettes, presetColors, diceAppearanceOptions, normalizeDiceAppearance, diceColorContrast } from '../../../client/ui/components/Dice/appearance';
import { defaultDiceBehavior, normalizeDiceBehavior } from '../../../client/ui/components/Dice/behavior';
import { configureDiceQuality, dicePixelRatio, prepareDiceRenderer, diceForces, playDiceSettlementEffect } from '../../../client/ui/components/Dice/rendering';
import { diceRegions, trackDiceViewport, type DiceRegion } from '../../../client/ui/components/Dice/viewport';

export function run() {
    for (const invalid of ['__proto__', 'constructor', '../wood', 'https://example.com/skin']) {
        assert.deepEqual(normalizeDiceAppearance({ texture: invalid, material: invalid }), { style: 'teal', size: 100 });
        assert.deepEqual(normalizeDiceBehavior({ region: invalid, throwForce: invalid, highDpi: 'true', engravedLabels: 0, shadowQuality: invalid, settlementEffect: invalid }), defaultDiceBehavior);
    }
    assert.deepEqual(normalizeDiceBehavior({ region: 'full', throwForce: 'normal', engravedLabels: true, shadowQuality: 'standard', highDpi: false }), defaultDiceBehavior);
    assert.equal(normalizeDiceBehavior({ lowEffects: true, shadowQuality: 'low' }).lowEffects, true);
    assert.deepEqual(normalizeDiceBehavior({ settlementEffect: 'none' }), defaultDiceBehavior);
    assert.equal(normalizeDiceBehavior(JSON.parse(JSON.stringify({ settlementEffect: 'highlight' }))).settlementEffect, 'highlight');
    assert.equal(diceForces.normal, 1);
    assert.ok(diceForces.soft < 1 && diceForces.strong > 1 && diceForces.strong < 1.5);
    const styleIds = [...diceStyles, ...dicePalettes].map(style => style.id);
    assert.equal(new Set(styleIds).size, styleIds.length, 'style and palette IDs must be unique');
    for (const style of diceStyles) {
        assert.equal(normalizeDiceAppearance(JSON.parse(JSON.stringify({ style: style.id }))).style, style.id);
        assert.ok(diceColorContrast(presetColors(style.id)) >= 4.5, `${style.id} has readable labels`);
        const options = diceAppearanceOptions({ style: style.id, size: 100 }, 390).theme_customColorset;
        assert.equal(options.background, style.background);
        assert.equal(options.foreground, style.foreground);
    }
    for (const palette of dicePalettes) {
        assert.equal(normalizeDiceAppearance(JSON.parse(JSON.stringify({ style: palette.id }))).style, palette.id);
        const appearance = normalizeDiceAppearance({ style: palette.id, texture: 'speckles', material: 'wood' });
        const options = diceAppearanceOptions(appearance, 390).theme_customColorset;
        assert.deepEqual(options.background, [...palette.bodies]);
        assert.deepEqual(options.foreground, palette.bodies.map(() => palette.labelColor));
        assert.deepEqual(options.edge, palette.bodies.map(() => palette.edge));
        assert.deepEqual(options.outline, palette.bodies.map(() => 'none'));
        assert.equal(options.texture, 'speckles'); assert.equal(options.material, 'wood');
        for (const body of palette.bodies) assert.ok(diceColorContrast({ body, label: palette.labelColor, edge: palette.edge, outline: null }) >= 4.5);
    }
    for (const name of ['marble', 'wood', 'metal', 'metal-bump', 'speckles', 'stars']) assert.ok(existsSync(`public/dice/textures/${name}.webp`));
    assert.equal(diceAppearanceOptions({ style: 'marble', size: 100 }, 1000).theme_customColorset.texture, 'marble');
    assert.equal(diceAppearanceOptions({ style: 'marble', size: 100, texture: 'none' }, 1000).theme_customColorset.texture, 'none');
    assert.ok(diceAppearanceOptions({ style: 'teal', size: 100 }, 1000, 200).baseScale < 90);
    assert.ok(diceAppearanceOptions({ style: 'teal', size: 150 }, 350, 380, 24).baseScale < 60);
    assert.ok(diceAppearanceOptions({ style: 'teal', size: 150 }, 144, 380, 6).baseScale < 50, 'mixed dice fit narrow phone quadrants');
    assert.equal(diceAppearanceOptions({ style: 'teal', size: 150 }, 390, 844, 6).baseScale, 97.5, 'full phone viewport keeps its established scale');
    assert.equal(diceAppearanceOptions({ style: 'teal', size: 100 }, 1000).light_intensity, 0.7);
    assert.equal(dicePixelRatio(1000, 800, 3, true), 2);
    assert.equal(dicePixelRatio(1000, 800, 3, false), 1);
    assert.equal(dicePixelRatio(1000, 800, NaN, true), 1);
    for (const highDpi of [false, true]) {
        const ratio = dicePixelRatio(3840, 2160, 3, highDpi);
        assert.ok(3840 * 2160 * ratio ** 2 <= 4_000_001);
    }

    const original = { material: 'none' };
    let bumped = true, pixelRatio = 0, disposed = 0, sized = false;
    const box = { DiceColors: { getTexture: (_name: string) => original },
        setDimensions() { assert.equal(pixelRatio, 2, 'budget applied before canvas sizing'); sized = true; },
        DiceFactory: { setBumpMapping(value: boolean) { bumped = value; } },
        renderer: { setPixelRatio(value: number) { pixelRatio = value; } },
        camera: { zoom: 1, updateProjectionMatrix() {} },
        light: { shadow: { map: { dispose() { disposed++; } }, mapSize: { width: 1024, height: 1024 } } } };
    prepareDiceRenderer(box as unknown as DiceBox, { ...defaultDiceBehavior, engravedLabels: false, highDpi: true }, 1000, 800, 2);
    box.setDimensions(); assert.equal(sized, true);
    box.DiceColors.getTexture('none').material = 'metal';
    assert.equal(original.material, 'none', 'per-throw material does not mutate upstream registry');
    assert.equal(box.DiceColors.getTexture('none').material, 'none');
    assert.equal(bumped, false);
    configureDiceQuality(box as unknown as DiceBox, { ...defaultDiceBehavior, highDpi: true, shadowQuality: 'low', region: 'upper' });
    assert.equal(box.camera.zoom, 0.9);
    assert.equal(pixelRatio, 2); assert.equal(disposed, 1); assert.equal(box.light.shadow.map, null);
    assert.deepEqual(box.light.shadow.mapSize, { width: 512, height: 512 });

    let effectCalls = 0, effectCancelled = 0;
    const media = { matches: false };
    const canvas = { isConnected: true,
        ownerDocument: { visibilityState: 'visible', defaultView: { matchMedia: () => media } },
        animate(frames: Keyframe[], options: KeyframeAnimationOptions) {
            effectCalls++;
            assert.deepEqual(frames.map(frame => frame.filter), ['brightness(1)', 'brightness(1.35)', 'brightness(1)']);
            assert.equal(options.duration, 400);
            assert.ok(Number(options.duration) < normalizeDiceBehavior({ displayDurationMs: 0 }).displayDurationMs);
            assert.equal(options.iterations, 1); assert.equal(options.fill, 'none');
            return { cancel() { effectCancelled++; } };
        } };
    const highlight = normalizeDiceBehavior({ settlementEffect: 'highlight' });
    assert.equal(playDiceSettlementEffect(canvas as unknown as HTMLCanvasElement, defaultDiceBehavior), undefined);
    const animation = playDiceSettlementEffect(canvas as unknown as HTMLCanvasElement, highlight);
    assert.equal(effectCalls, 1); animation?.cancel(); assert.equal(effectCancelled, 1);
    media.matches = true;
    assert.equal(playDiceSettlementEffect(canvas as unknown as HTMLCanvasElement, highlight), undefined);
    media.matches = false; canvas.ownerDocument.visibilityState = 'hidden';
    assert.equal(playDiceSettlementEffect(canvas as unknown as HTMLCanvasElement, highlight), undefined);
    canvas.ownerDocument.visibilityState = 'visible'; canvas.isConnected = false;
    assert.equal(playDiceSettlementEffect(canvas as unknown as HTMLCanvasElement, highlight), undefined);
    assert.equal(playDiceSettlementEffect(undefined, highlight), undefined);
    canvas.isConnected = true;
    assert.equal(playDiceSettlementEffect({ ...canvas, animate: undefined } as unknown as HTMLCanvasElement, highlight), undefined);
    assert.equal(playDiceSettlementEffect({ ...canvas, animate() { throw new Error('unsupported effect'); } } as unknown as HTMLCanvasElement, highlight), undefined);
    assert.equal(effectCalls, 1, 'disabled, inaccessible and unsupported effects never animate');

    for (const effect of ['breathing', 'crescendo'] as const) {
        for (const displayDurationMs of [500, 1800, 3200, 5000]) {
            const behavior = normalizeDiceBehavior(JSON.parse(JSON.stringify({ settlementEffect: effect, displayDurationMs })));
            assert.equal(behavior.settlementEffect, effect);
            let calls = 0;
            const patternedCanvas = { ...canvas, animate(frames: Keyframe[], options: KeyframeAnimationOptions) {
                calls++;
                assert.equal(Number(options.duration) * Number(options.iterations), displayDurationMs);
                assert.equal(options.id, 'sd-dice-settlement');
                assert.ok(Number(options.duration) >= 500);
                assert.equal(frames[0].filter, 'brightness(1)');
                if (effect === 'breathing') {
                    assert.equal(options.iterations, Math.max(1, Math.round(displayDurationMs / 1600)));
                    assert.equal(options.easing, 'linear'); assert.equal(options.fill, 'none');
                    assert.deepEqual(frames.map(frame => frame.offset), [0, 0.5, 1]);
                    assert.equal(frames[1].filter, 'brightness(1.35)');
                    assert.equal(frames[2].filter, 'brightness(1)');
                    assert.equal(frames[0].easing, 'ease-in-out'); assert.equal(frames[1].easing, 'ease-in-out');
                } else {
                    assert.equal(options.iterations, 1); assert.equal(options.fill, 'forwards');
                    assert.equal(options.easing, 'ease-in-out');
                    assert.equal(frames.length, 2); assert.equal(frames[1].filter, 'brightness(1.35)');
                }
                return { cancel() {} };
            } };
            assert.ok(playDiceSettlementEffect(patternedCanvas as unknown as HTMLCanvasElement, behavior));
            media.matches = true;
            assert.equal(playDiceSettlementEffect(patternedCanvas as unknown as HTMLCanvasElement, behavior), undefined);
            media.matches = false;
            assert.equal(calls, 1);
        }
    }

    for (const region of Object.keys(diceRegions) as DiceRegion[]) {
        assert.equal(normalizeDiceBehavior(JSON.parse(JSON.stringify({ region }))).region ?? 'full', region);
        for (const [width, height] of [[390, 844], [844, 390], [320, 240]]) {
            const viewport = Object.assign(new EventTarget(), { width, height, offsetTop: 100, offsetLeft: 12 });
            const host = Object.assign(new EventTarget(), { visualViewport: viewport });
            const element = { style: {} } as HTMLElement;
            let cancelled = 0;
            const stop = trackDiceViewport(element, host as unknown as Window, () => cancelled++, region);
            const left = parseFloat(element.style.left), top = parseFloat(element.style.top);
            const w = parseFloat(element.style.width), h = parseFloat(element.style.height);
            assert.ok(left >= 12 && top >= 100 && left + w <= 12 + width + 0.01 && top + h <= 100 + height + 0.01);
            if (region.endsWith('Left')) assert.ok(left + w <= 12 + width / 2 + 0.01);
            if (region.endsWith('Right')) assert.ok(left >= 12 + width / 2);
            if (region.startsWith('upper')) assert.ok(top + h <= 100 + height / 2 + 0.01);
            if (region.startsWith('lower')) assert.ok(top >= 100 + height / 2);
            viewport.offsetTop += 20; viewport.dispatchEvent(new Event('scroll'));
            assert.equal(cancelled, 0); assert.equal(parseFloat(element.style.top), top + 20);
            viewport.height /= 2; viewport.dispatchEvent(new Event('resize'));
            assert.equal(cancelled, 1);
            stop(); viewport.dispatchEvent(new Event('resize')); assert.equal(cancelled, 1);
        }
    }
}
