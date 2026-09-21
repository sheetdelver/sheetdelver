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

export function DiceAnimation({ roll, sound = defaultDiceSound, appearance = defaultDiceAppearance, behavior = defaultDiceBehavior, onDone, onError }: {
    sound?: DiceSoundSettings;
    appearance?: DiceAppearance;
    behavior?: DiceBehavior;
    roll: DicePresentation;
    onDone: () => void;
    onError: (error: unknown) => void;
}) {
    const id = `sd-dice-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
    const overlay = useRef<HTMLDivElement>(null);
    const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
    useEffect(() => { setPortalHost(document.body); }, []);
    // The component is keyed by roll ID: appearance is fixed for each throw, unlike live volume.
    const [throwAppearance] = useState(() => normalizeDiceAppearance(appearance));
    const [throwBehavior] = useState(() => normalizeDiceBehavior(behavior));
    const audio = useRef<ReturnType<typeof createCollisionAudio> | null>(null);
    const latestSound = useRef(sound);
    useEffect(() => {
        latestSound.current = sound;
        audio.current?.update(sound);
    }, [sound]);
    const callbacks = useRef({ onDone, onError });
    useEffect(() => { callbacks.current = { onDone, onError }; }, [onDone, onError]);

    useEffect(() => {
        if (!portalHost || !overlay.current) return;
        const element = overlay.current;
        let cancelled = false;
        let box: DiceBox | undefined;
        let dispose: (() => void) | undefined;
        let linger: ReturnType<typeof setTimeout> | undefined;
        let finished = false;
        const finish = () => {
            if (!cancelled && !finished) { finished = true; callbacks.current.onDone(); }
        };
        const timeout = setTimeout(() => {
            logger.warn('DicePresentation | Renderer timed out before completing the throw.');
            finish();
        }, 12_000);
        // End the current throw on a size change instead of retaining upstream resize listeners/resources.
        const stopTracking = trackDiceViewport(element, window, finish);
        // A manual, non-modal popover sits above native dialogs without taking focus or clicks.
        element.showPopover?.();
        void (async () => {
            logger.debug('DicePresentation | Loading renderer');
            const { default: Renderer } = await import('@3d-dice/dice-box-threejs');
            if (cancelled) return;
            box = new Renderer(`#${id}`, {
                sounds: false, shadows: !throwBehavior.lowEffects,
                ...diceAppearanceOptions(throwAppearance, element.clientWidth),
            });
            dispose = createRendererDisposer(box);
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
            audio.current = createCollisionAudio(box);
            audio.current.update(latestSound.current);
            logger.debug('DicePresentation | Renderer initialized', {
                width: box.renderer?.domElement.width, height: box.renderer?.domElement.height,
            });
            await box.roll(roll.notation);
            logger.debug('DicePresentation | Throw settled');
            if (!cancelled && !finished) {
                clearTimeout(timeout);
                linger = setTimeout(finish, throwBehavior.displayDurationMs);
            }
        })().catch(error => { if (!cancelled) callbacks.current.onError(error); });
        return () => {
            cancelled = true;
            clearTimeout(timeout);
            clearTimeout(linger);
            stopTracking();
            element.hidePopover?.();
            audio.current?.dispose();
            audio.current = null;
            dispose?.();
        };
    }, [id, roll, throwAppearance, throwBehavior, portalHost]);

    return portalHost ? createPortal(<div ref={overlay} id={id} popover="manual" aria-hidden="true" data-dice-overlay="" data-dice-style={throwAppearance.style} data-dice-size={throwAppearance.size}
        data-dice-low-effects={throwBehavior.lowEffects} data-dice-duration={throwBehavior.displayDurationMs}
        style={{ position: 'fixed', inset: 'auto', margin: 0, padding: 0, border: 0, background: 'transparent',
            zIndex: 10000, pointerEvents: 'none', overflow: 'hidden' }} />, portalHost) : null;
}
