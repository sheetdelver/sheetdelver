import type DiceBox from '@3d-dice/dice-box-threejs';
import type { DiceBehavior } from './behavior';

export const diceForces = { soft: 0.65, normal: 1, strong: 1.35 } as const;
const maxRenderPixels = 4_000_000;

export function dicePixelRatio(width: number, height: number, deviceRatio: number, highDpi = false): number {
    const pixels = Math.max(1, width * height);
    const desired = highDpi && Number.isFinite(deviceRatio) ? Math.max(1, Math.min(2, deviceRatio)) : 1;
    return Math.min(desired, Math.sqrt(maxRenderPixels / pixels));
}

/** The pinned renderer mutates texture registry entries during theme loading. */
export function prepareDiceRenderer(box: DiceBox, behavior: DiceBehavior, width: number, height: number, deviceRatio: number) {
    const getTexture = box.DiceColors.getTexture.bind(box.DiceColors);
    box.DiceColors.getTexture = name => ({ ...getTexture(name) });
    box.DiceFactory.setBumpMapping(behavior.engravedLabels !== false);
    // Set the budget before upstream allocates a viewport-sized canvas on initialization.
    const setDimensions = box.setDimensions.bind(box);
    box.setDimensions = dimensions => {
        box.renderer?.setPixelRatio(dicePixelRatio(width, height, deviceRatio, behavior.highDpi));
        setDimensions(dimensions);
    };
}

export function configureDiceQuality(box: DiceBox, behavior: DiceBehavior) {
    // Leave room for perspective at region walls, especially with stacked dice.
    if (box.camera && behavior.region && behavior.region !== 'full') {
        box.camera.zoom = 0.9;
        box.camera.updateProjectionMatrix();
    }
    if (box.light) {
        const size = behavior.shadowQuality === 'low' ? 512 : 1024;
        box.light.shadow.map?.dispose();
        box.light.shadow.map = null;
        box.light.shadow.mapSize.width = size;
        box.light.shadow.mapSize.height = size;
    }
}

/** Optional canvas-only polish; it never holds results or extends the throw lifetime. */
export function playDiceSettlementEffect(canvas: HTMLCanvasElement | undefined, behavior: DiceBehavior): Animation | undefined {
    const effect = behavior.settlementEffect;
    if ((effect !== 'highlight' && effect !== 'breathing' && effect !== 'crescendo')
        || !canvas?.isConnected || typeof canvas.animate !== 'function') return;
    try {
        const document = canvas.ownerDocument;
        if (document.visibilityState !== 'visible' || document.defaultView?.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        // Fit complete breaths to the linger window; even 500ms gets one full pulse.
        const iterations = effect === 'breathing' ? Math.max(1, Math.round(behavior.displayDurationMs / 1600)) : 1;
        const frames: Keyframe[] = effect === 'crescendo' ? [
            { filter: 'brightness(1)' }, { filter: 'brightness(1.35)' },
        ] : effect === 'breathing' ? [
            { filter: 'brightness(1)', offset: 0, easing: 'ease-in-out' },
            { filter: 'brightness(1.35)', offset: 0.5, easing: 'ease-in-out' },
            { filter: 'brightness(1)', offset: 1 },
        ] : [
            { filter: 'brightness(1)', offset: 0 },
            { filter: 'brightness(1.35)', offset: 0.35 },
            { filter: 'brightness(1)', offset: 1 },
        ];
        return canvas.animate(frames, {
            id: 'sd-dice-settlement', iterations,
            duration: effect === 'highlight' ? 400 : behavior.displayDurationMs / iterations,
            easing: effect === 'highlight' ? 'ease-out' : effect === 'crescendo' ? 'ease-in-out' : 'linear',
            // Hold the crescendo through optional fade-out; throw cleanup cancels it.
            fill: effect === 'crescendo' ? 'forwards' : 'none',
        });
    } catch {
        // An unavailable compositor effect must not turn a successful roll into a failure.
        return;
    }
}
