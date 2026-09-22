'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { trackDiceViewport } from './viewport';
import { logger } from '@shared/utils/logger';
import { createRendererDisposer } from './disposeRenderer';
import type DiceBox from '@3d-dice/dice-box-threejs';
import { createCollisionAudio, defaultDiceSound, type DiceSoundSettings } from './collisionAudio';
import { defaultDiceAppearance, normalizeDiceAppearance, diceAppearanceOptions, type DiceAppearance } from './appearance';
import type { DicePresentation } from './presentation';
import { defaultDiceBehavior, normalizeDiceBehavior, type DiceBehavior } from './behavior';
import { configureDiceQuality, diceForces, prepareDiceRenderer, playDiceSettlementEffect } from './rendering';

export function DiceAnimation({ roll, sound = defaultDiceSound, appearance = defaultDiceAppearance, behavior = defaultDiceBehavior, onSettled, onDone, onError }: {
    sound?: DiceSoundSettings;
    appearance?: DiceAppearance;
    behavior?: DiceBehavior;
    roll: DicePresentation;
    onDone: () => void;
    onSettled?: () => void;
    onError: (error: unknown) => void;
}) {
    const id = `sd-dice-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
    const overlay = useRef<HTMLDivElement>(null);
    const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
    useEffect(() => { setPortalHost(document.body); }, []);
    // The component is keyed by roll ID: appearance is fixed for each throw, unlike live volume.
    const [throwAppearance] = useState(() => normalizeDiceAppearance(appearance));
    const [throwBehavior] = useState(() => normalizeDiceBehavior(behavior));
    const [throwSurface] = useState(sound.surface);
    const audio = useRef<ReturnType<typeof createCollisionAudio> | null>(null);
    const latestSound = useRef(sound);
    useEffect(() => {
        latestSound.current = sound;
        audio.current?.update({ ...sound, surface: throwSurface });
    }, [sound, throwSurface]);
    const callbacks = useRef({ onSettled, onDone, onError });
    useEffect(() => { callbacks.current = { onSettled, onDone, onError }; }, [onSettled, onDone, onError]);

    useEffect(() => {
        if (!portalHost || !overlay.current) return;
        const element = overlay.current;
        let cancelled = false;
        let box: DiceBox | undefined;
        let dispose: (() => void) | undefined;
        let linger: ReturnType<typeof setTimeout> | undefined;
        let fade: ReturnType<typeof setTimeout> | undefined;
        let settlementAnimation: Animation | undefined;
        let finished = false;
        const finish = () => {
            if (!cancelled && !finished) { finished = true; callbacks.current.onDone(); }
        };
        const timeout = setTimeout(() => {
            logger.warn('DicePresentation | Renderer timed out before completing the throw.');
            finish();
        }, 12_000);
        // End the current throw on a size change instead of retaining upstream resize listeners/resources.
        const stopTracking = trackDiceViewport(element, window, finish, throwBehavior.region);
        // A manual, non-modal popover sits above native dialogs without taking focus or clicks.
        element.showPopover?.();
        void (async () => {
            logger.debug('DicePresentation | Loading renderer');
            const { default: Renderer } = await import('@3d-dice/dice-box-threejs');
            if (cancelled) return;
            box = new Renderer(`#${id}`, {
                sounds: false, shadows: !throwBehavior.lowEffects,
                strength: diceForces[throwBehavior.throwForce ?? 'normal'],
                ...diceAppearanceOptions(throwAppearance, element.clientWidth, element.clientHeight, roll.physicalDiceCount),
            });
            dispose = createRendererDisposer(box);
            prepareDiceRenderer(box, throwBehavior, element.clientWidth, element.clientHeight, window.devicePixelRatio);
            box.resizeWorld = () => {};
            const swapFace = box.swapDiceFace.bind(box);
            box.swapDiceFace = (die, value) => {
                swapFace(die, value);
                // Upstream 0.0.12 leaves the simulated d4 result cached after relabeling its faces.
                die.result = [];
            };
            try {
                await box.initialize();
            } finally {
                if (cancelled) dispose();
            }
            if (cancelled) return;
            configureDiceQuality(box, throwBehavior);
            audio.current = createCollisionAudio(box, undefined, throwAppearance.material);
            audio.current.update({ ...latestSound.current, surface: throwSurface });
            logger.debug('DicePresentation | Renderer initialized', {
                width: box.renderer?.domElement.width, height: box.renderer?.domElement.height,
            });
            await box.roll(roll.notation);
            logger.debug('DicePresentation | Throw settled');
            if (!cancelled && !finished) {
                clearTimeout(timeout);
                callbacks.current.onSettled?.();
                settlementAnimation = playDiceSettlementEffect(box.renderer?.domElement, throwBehavior);
                linger = setTimeout(() => {
                    if (throwBehavior.hideEffect !== 'fade') { finish(); return; }
                    element.style.transition = 'opacity 200ms ease-out';
                    element.style.opacity = '0';
                    fade = setTimeout(finish, 200);
                }, throwBehavior.displayDurationMs);
            }
        })().catch(error => { if (!cancelled) callbacks.current.onError(error); });
        return () => {
            cancelled = true;
            clearTimeout(timeout);
            clearTimeout(linger);
            clearTimeout(fade);
            stopTracking();
            settlementAnimation?.cancel();
            element.hidePopover?.();
            audio.current?.dispose();
            audio.current = null;
            dispose?.();
        };
    }, [id, roll, throwAppearance, throwBehavior, throwSurface, portalHost]);

    return portalHost ? createPortal(<div ref={overlay} id={id} popover="manual" aria-hidden="true" data-dice-overlay="" data-dice-style={throwAppearance.style} data-dice-size={throwAppearance.size}
        data-dice-low-effects={throwBehavior.lowEffects} data-dice-duration={throwBehavior.displayDurationMs}
        data-dice-region={throwBehavior.region ?? 'full'} data-dice-material={throwAppearance.material ?? 'plastic'}
        style={{ position: 'fixed', inset: 'auto', margin: 0, padding: 0, border: 0, background: 'transparent',
            zIndex: 10000, pointerEvents: 'none', overflow: 'hidden' }} />, portalHost) : null;
}
