'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { logger } from '@shared/utils/logger';
import { createCollisionAudio, type DiceSoundSettings } from './collisionAudio';
import { diceAppearanceOptions, normalizeDiceAppearance, type DiceAppearance } from './appearance';
import { normalizeDiceBehavior, type DiceBehavior } from './behavior';
import { createRendererDisposer } from './disposeRenderer';
import { configureDiceQuality, diceForces, prepareDiceRenderer, playDiceSettlementEffect } from './rendering';
import type { QueuedDice } from './presentationQueue';
import { trackDiceViewport } from './viewport';
import { appendRecordedDice, completeRecordedDieFace, isolateThrowCollisions, type SceneBox, type SceneDie }
    from './sharedRendererAdapter';

type Callbacks = { onSettled(sequence: number): void; onDone(sequence: number): void; onError(error: unknown): void };
type Group = {
    sequence: number;
    dice: SceneDie[];
    faces: number[];
    forced: Set<SceneDie>;
    behavior: DiceBehavior;
    settled: boolean;
    timeout?: ReturnType<typeof setTimeout>;
    linger?: ReturnType<typeof setTimeout>;
    fade?: number;
    effect?: Animation;
};

/** One pinned 0.0.12 DiceBox/Three scene for every live chat-message throw. */
class SharedDiceScene {
    private box?: SceneBox;
    private releaseBox?: () => void;
    private audio?: ReturnType<typeof createCollisionAudio>;
    private initializing?: Promise<void>;
    private groups = new Map<number, Group>();
    private completed = new Set<number>();
    private mutedBodies = new WeakSet<object>();
    private bodyGroups = new WeakMap<object, number>();
    private desired: readonly QueuedDice[] = [];
    private appearance: DiceAppearance;
    private behavior: DiceBehavior;
    private sound: DiceSoundSettings;
    private settingsKey = '';
    private monitorFrame?: number;
    private stopViewport?: () => void;
    private disposed = false;
    private failed = false;

    constructor(private readonly element: HTMLDivElement, private readonly id: string,
        private readonly callbacks: () => Callbacks,
        appearance: DiceAppearance, behavior: DiceBehavior, sound: DiceSoundSettings) {
        this.appearance = normalizeDiceAppearance(appearance);
        this.behavior = normalizeDiceBehavior(behavior);
        this.sound = sound;
    }

    update(rolls: readonly QueuedDice[], appearance: DiceAppearance, behavior: DiceBehavior, sound: DiceSoundSettings) {
        if (this.disposed || this.failed) return;
        this.desired = rolls;
        this.appearance = normalizeDiceAppearance(appearance);
        this.behavior = normalizeDiceBehavior(behavior);
        this.sound = sound;
        this.audio?.update(sound);
        const wanted = new Set(rolls.map(roll => roll.sequence));
        for (const sequence of this.completed) if (!wanted.has(sequence)) this.completed.delete(sequence);
        for (const group of this.groups.values()) if (!wanted.has(group.sequence)) this.removeGroup(group, false);
        if (this.box && !this.groups.size && this.settingsKey !== this.currentSettingsKey()) this.releaseRenderer();
        if (!rolls.length) {
            if (!this.groups.size) this.hide();
            return;
        }
        if (this.box) this.sync();
        else if (!this.initializing) {
            this.initializing = this.initialize().then(() => this.sync()).catch(error => this.fail(error))
                .finally(() => {
                    this.initializing = undefined;
                    if (!this.disposed && !this.failed && !this.box && this.desired.length)
                        this.update(this.desired, this.appearance, this.behavior, this.sound);
                });
        }
    }

    private currentSettingsKey() {
        const behavior = this.behavior;
        return JSON.stringify({ appearance: this.appearance, surface: this.sound.surface, behavior: {
            lowEffects: behavior.lowEffects, throwForce: behavior.throwForce, shadowQuality: behavior.shadowQuality,
            engravedLabels: behavior.engravedLabels, highDpi: behavior.highDpi, region: behavior.region,
        } });
    }

    private async initialize() {
        const { default: Renderer } = await import('@3d-dice/dice-box-threejs');
        if (this.disposed || !this.element.isConnected || !this.desired.length) return;
        const appearance = this.appearance, behavior = this.behavior;
        this.settingsKey = this.currentSettingsKey();
        this.stopViewport = trackDiceViewport(this.element, window, () => {
            this.finishAll();
            this.releaseRenderer();
        }, behavior.region);
        this.element.showPopover?.();
        const initialDice = Math.min(24, Math.max(8,
            this.desired.reduce((total, roll) => total + (roll.physicalDiceCount ?? 0), 0)));
        const box = new Renderer(`#${this.id}`, {
            sounds: false, shadows: !behavior.lowEffects,
            strength: diceForces[behavior.throwForce ?? 'normal'],
            ...diceAppearanceOptions(appearance, this.element.clientWidth, this.element.clientHeight, initialDice),
        }) as SceneBox;
        this.box = box;
        const release = createRendererDisposer(box);
        this.releaseBox = release;
        prepareDiceRenderer(box, behavior, this.element.clientWidth, this.element.clientHeight, window.devicePixelRatio);
        box.resizeWorld = () => {};
        const swapFace = box.swapDiceFace.bind(box);
        box.swapDiceFace = (die, value) => {
            const mesh = die as SceneDie;
            const previous = mesh.material;
            const previousGeometry = mesh.geometry;
            swapFace(die, value);
            // The library clones geometry to swap labels but drops its custom
            // Cannon shape. Replay needs that shape to collide with the tray.
            if (mesh.geometry !== previousGeometry) mesh.geometry.cannon_shape = previousGeometry.cannon_shape;
            if (previous !== mesh.material) {
                for (const material of Array.isArray(previous) ? previous : [previous]) material.dispose();
            }
            // Upstream 0.0.12 leaves a d4's pre-swap face cached.
            die.result = [];
        };
        await box.initialize();
        if (this.disposed || this.box !== box) { release(); return; }
        isolateThrowCollisions(box, this.bodyGroups);
        configureDiceQuality(box, behavior);
        const collide = box.eventCollide.bind(box);
        box.eventCollide = event => {
            if (this.behavior.mutePrivateRolls && event.target && this.mutedBodies.has(event.target)) return;
            collide(event);
        };
        this.audio = createCollisionAudio(box, undefined, appearance.material);
        this.audio.update(this.sound);
        logger.debug('DicePresentation | Shared renderer initialized', {
            width: box.renderer?.domElement.width, height: box.renderer?.domElement.height,
        });
    }

    private sync() {
        const box = this.box;
        if (!box || !box.initialized || this.disposed) return;
        const wanted = new Set(this.desired.map(roll => roll.sequence));
        for (const group of this.groups.values()) if (!wanted.has(group.sequence)) this.removeGroup(group, false);
        for (const roll of this.desired) {
            if (this.groups.has(roll.sequence) || this.completed.has(roll.sequence)) continue;
            try { this.append(roll); } catch (error) { this.fail(error); return; }
        }
    }

    private append(roll: QueuedDice) {
        const box = this.box!;
        const { dice, faces, wasRolling } = appendRecordedDice(box, roll.notation, roll.physicalDiceCount ?? 0);
        const group: Group = { sequence: roll.sequence, dice, faces, forced: new Set(),
            behavior: this.behavior, settled: false };
        for (const die of dice) this.bodyGroups.set(die.body, roll.sequence);
        if (roll.privateRoll) for (const die of dice) this.mutedBodies.add(die.body);
        this.groups.set(roll.sequence, group);
        group.timeout = setTimeout(() => {
            logger.warn('DicePresentation | Shared throw timed out before settling.');
            this.removeGroup(group, true);
        }, 12_000);
        this.element.showPopover?.();
        if (!wasRolling) {
            box.rolling = true;
            box.running = Date.now();
            box.last_time = 0;
            box.iteration = 0;
            box.animateThrow(box.running, () => {});
        }
        this.monitor();
    }

    private monitor() {
        if (this.monitorFrame !== undefined || this.disposed) return;
        const tick = () => {
            this.monitorFrame = undefined;
            const box = this.box;
            if (!box || this.disposed) return;
            let pending = false;
            for (const group of this.groups.values()) {
                if (group.settled) continue;
                let mismatched = false;
                for (let i = 0; i < group.dice.length; i++) {
                    const die = group.dice[i];
                    if (group.forced.has(die)) continue;
                    if (die.body.sleepState !== 2 && die.body.type !== 4) continue;
                    if (!completeRecordedDieFace(die, group.faces[i])) {
                        mismatched = true;
                        break;
                    }
                    group.forced.add(die);
                }
                if (mismatched) {
                    // A visual mismatch must never be silently repainted into a
                    // different result after landing. Chat remains authoritative.
                    logger.warn('DicePresentation | Replayed face diverged; skipping this visual throw.');
                    this.removeGroup(group, true);
                } else if (group.forced.size === group.dice.length) this.settle(group);
                else pending = true;
            }
            if (pending) this.monitorFrame = requestAnimationFrame(() => {
                try { tick(); } catch (error) { this.fail(error); }
            });
        };
        this.monitorFrame = requestAnimationFrame(() => {
            try { tick(); } catch (error) { this.fail(error); }
        });
    }

    private settle(group: Group) {
        group.settled = true;
        clearTimeout(group.timeout);
        this.callbacks().onSettled(group.sequence);
        group.effect = playDiceSettlementEffect(this.box?.renderer?.domElement, group.behavior);
        group.linger = setTimeout(() => {
            if (group.behavior.hideEffect !== 'fade') { this.removeGroup(group, true); return; }
            const started = performance.now();
            const materials = group.dice.flatMap(die => Array.isArray(die.material) ? die.material : [die.material]);
            const fade = (now: number) => {
                const opacity = Math.max(0, 1 - (now - started) / 200);
                for (const material of materials) material.opacity = opacity;
                if (opacity > 0) group.fade = requestAnimationFrame(fade);
                else this.removeGroup(group, true);
            };
            group.fade = requestAnimationFrame(fade);
        }, group.behavior.displayDurationMs);
    }

    private removeGroup(group: Group, notify: boolean) {
        if (!this.groups.delete(group.sequence)) return;
        clearTimeout(group.timeout);
        clearTimeout(group.linger);
        if (group.fade !== undefined) cancelAnimationFrame(group.fade);
        group.effect?.cancel();
        const box = this.box;
        if (box) {
            const cached = new Set(Object.values(box.DiceFactory.geometries));
            for (const die of group.dice) {
                box.world.removeBody(die.body);
                box.scene.remove(die);
                for (const material of Array.isArray(die.material) ? die.material : [die.material]) material.dispose();
                if (!cached.has(die.geometry)) die.geometry.dispose();
            }
            const removed = new Set(group.dice);
            box.diceList = box.diceList.filter(die => !removed.has(die));
        }
        if (notify) {
            this.completed.add(group.sequence);
            this.callbacks().onDone(group.sequence);
        }
        if (!this.groups.size) this.hide();
    }

    private hide() {
        this.element.hidePopover?.();
        if (this.box) { this.box.running = false; this.box.rolling = false; }
    }

    private releaseRenderer() {
        this.stopViewport?.();
        this.stopViewport = undefined;
        this.audio?.dispose();
        this.audio = undefined;
        this.releaseBox?.();
        this.releaseBox = undefined;
        this.box = undefined;
        this.settingsKey = '';
        this.element.hidePopover?.();
    }

    private finishAll() {
        for (const group of [...this.groups.values()]) this.removeGroup(group, true);
    }

    private fail(error: unknown) {
        if (this.disposed || this.failed) return;
        this.failed = true;
        this.finishAll();
        this.callbacks().onError(error);
    }

    dispose() {
        this.disposed = true;
        if (this.monitorFrame !== undefined) cancelAnimationFrame(this.monitorFrame);
        for (const group of [...this.groups.values()]) this.removeGroup(group, false);
        this.releaseRenderer();
    }
}

export function SharedDiceAnimation({ rolls, sound, appearance, behavior, onSettled, onDone, onError }: {
    rolls: readonly QueuedDice[];
    sound: DiceSoundSettings;
    appearance: DiceAppearance;
    behavior: DiceBehavior;
    onSettled(sequence: number): void;
    onDone(sequence: number): void;
    onError(error: unknown): void;
}) {
    const id = `sd-dice-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
    const overlay = useRef<HTMLDivElement>(null);
    const scene = useRef<SharedDiceScene | null>(null);
    const callbacks = useRef({ onSettled, onDone, onError });
    callbacks.current = { onSettled, onDone, onError };
    const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
    useEffect(() => { setPortalHost(document.body); }, []);
    useEffect(() => {
        if (!portalHost || !overlay.current) return;
        const current = new SharedDiceScene(overlay.current, id, () => callbacks.current, appearance, behavior, sound);
        scene.current = current;
        current.update(rolls, appearance, behavior, sound);
        return () => { current.dispose(); if (scene.current === current) scene.current = null; };
        // A single scene lives until the provider unmounts; settings updates flow through update().
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id, portalHost]);
    useEffect(() => { scene.current?.update(rolls, appearance, behavior, sound); }, [rolls, appearance, behavior, sound]);
    return portalHost ? createPortal(<div ref={overlay} id={id} popover="manual" aria-hidden="true" data-dice-overlay=""
        data-dice-shared="" data-dice-style={appearance.style} data-dice-region={behavior.region ?? 'full'}
        style={{ position: 'fixed', inset: 'auto', margin: 0, padding: 0, border: 0, background: 'transparent',
            zIndex: 10000, pointerEvents: 'none', overflow: 'hidden' }} />, portalHost) : null;
}
