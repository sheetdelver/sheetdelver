'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { logger } from '@shared/utils/logger';
import type { ChatMessageDto } from '@shared/contracts/chat';
import { useSession } from './SessionContext';
import { useUI } from './UIContext';
import { defaultDiceBehavior, diceSoundForRoll, normalizeDiceBehavior, type DiceBehavior } from '../components/Dice/behavior';
import { defaultDiceAppearance, normalizeDiceAppearance, type DiceAppearance } from '../components/Dice/appearance';
import { defaultDiceSound, normalizeDiceSound, type DiceSoundSettings } from '../components/Dice/collisionAudio';
import { DiceAnimation } from '../components/Dice/DiceAnimation';
import { DicePresentationQueue, type QueuedDice } from '../components/Dice/presentationQueue';
import type { DicePresentation } from '../components/Dice/presentation';

const preferenceKey = 'sheetdelver_3d_dice';
const appearancePreferenceKey = 'sheetdelver_3d_dice_appearance';
const behaviorPreferenceKey = 'sheetdelver_3d_dice_behavior';
const soundPreferenceKey = 'sheetdelver_3d_dice_sound';
const emptyIds: ReadonlySet<string> = new Set();
const Context = createContext({
    resetSettings: () => {},
    behavior: defaultDiceBehavior, setBehavior: (_behavior: DiceBehavior) => {},
    enabled: false, setEnabled: (_enabled: boolean) => {},
    appearance: defaultDiceAppearance, setAppearance: (_appearance: DiceAppearance) => {},
    sound: defaultDiceSound, setSound: (_sound: DiceSoundSettings) => {},
    heldMessageIds: emptyIds,
    recordCreated: (_id: string) => {},
    prepareMessages: (_messages: readonly ChatMessageDto[]) => {},
    invalidateMessage: (_id: string) => {},
    resetPresentation: () => {},
    testDice: () => {},
    cancelTest: () => {},
    canTest: false, testing: false,
});
const sample: DicePresentation = { id: 'local-dice-preview', notation: '1d6+1d20+1d100+1d10@4,17,40,2' };

export function DicePresentationProvider({ children }: { children: ReactNode }) {
    const { token, step, currentUserId } = useSession();
    const { isSettingsOpen } = useUI();
    const [enabled, updateEnabled] = useState(false);
    const [appearance, updateAppearance] = useState(defaultDiceAppearance);
    const [sound, updateSound] = useState(defaultDiceSound);
    const [behavior, updateBehavior] = useState(defaultDiceBehavior);
    const [available, setAvailable] = useState(false);
    const [failed, setFailed] = useState(false);
    const [queue, setQueue] = useState<readonly QueuedDice[]>([]);
    const [testing, setTesting] = useState(false);
    const coordinator = useRef(new DicePresentationQueue());
    const publish = useCallback(() => setQueue(coordinator.current.snapshot()), []);
    const active = enabled && available && !failed && !!token && step === 'dashboard';

    useEffect(() => {
        coordinator.current.configure(active, behavior, currentUserId);
        publish();
    }, [active, behavior, currentUserId, publish]);

    const recordCreated = useCallback((id: string) => { coordinator.current.created(id); }, []);
    const prepareMessages = useCallback((messages: readonly ChatMessageDto[]) => {
        coordinator.current.read(messages);
        publish();
    }, [publish]);
    const invalidateMessage = useCallback((id: string) => {
        coordinator.current.invalidated(id);
        publish();
    }, [publish]);
    const resetPresentation = useCallback(() => {
        coordinator.current.reset();
        publish();
        setTesting(false);
    }, [publish]);

    useEffect(() => { resetPresentation(); }, [token, step, resetPresentation]);
    useEffect(() => {
        if (!available || !isSettingsOpen || queue.length) setTesting(false);
    }, [available, isSettingsOpen, queue.length]);

    const setBehavior = useCallback((value: DiceBehavior) => {
        const normalized = normalizeDiceBehavior(value);
        updateBehavior(normalized);
        try { localStorage.setItem(behaviorPreferenceKey, JSON.stringify(normalized)); } catch { /* Optional preference. */ }
    }, []);
    const setEnabled = useCallback((value: boolean) => {
        updateEnabled(value);
        setFailed(false);
        try { localStorage.setItem(preferenceKey, String(value)); } catch { /* Optional preference. */ }
    }, []);
    const setAppearance = useCallback((value: DiceAppearance) => {
        const normalized = normalizeDiceAppearance(value);
        updateAppearance(normalized);
        try { localStorage.setItem(appearancePreferenceKey, JSON.stringify(normalized)); } catch { /* Optional preference. */ }
    }, []);
    const setSound = useCallback((value: DiceSoundSettings) => {
        const normalized = normalizeDiceSound(value);
        updateSound(normalized);
        try { localStorage.setItem(soundPreferenceKey, JSON.stringify(normalized)); } catch { /* Optional preference. */ }
    }, []);

    useEffect(() => {
        try { updateBehavior(normalizeDiceBehavior(JSON.parse(localStorage.getItem(behaviorPreferenceKey) || 'null'))); } catch { /* Optional preference. */ }
        try { updateAppearance(normalizeDiceAppearance(JSON.parse(localStorage.getItem(appearancePreferenceKey) || 'null'))); } catch { /* Optional preference. */ }
        try { updateSound(normalizeDiceSound(JSON.parse(localStorage.getItem(soundPreferenceKey) || 'null'))); } catch { /* Optional preference. */ }
        try { updateEnabled(localStorage.getItem(preferenceKey) === 'true'); } catch { /* Optional preference. */ }
        const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
        const refresh = () => setAvailable(!motion.matches && document.visibilityState === 'visible');
        refresh();
        motion.addEventListener('change', refresh);
        document.addEventListener('visibilitychange', refresh);
        return () => {
            motion.removeEventListener('change', refresh);
            document.removeEventListener('visibilitychange', refresh);
        };
    }, []);

    const resetSettings = useCallback(() => {
        resetPresentation();
        setEnabled(false); setAppearance(defaultDiceAppearance);
        setSound(defaultDiceSound); setBehavior(defaultDiceBehavior);
    }, [resetPresentation, setEnabled, setAppearance, setSound, setBehavior]);
    const heldMessageIds = useMemo(() => new Set(queue.filter(roll => roll.held).map(roll => roll.id)), [queue]);
    const canTest = available && !!token && step === 'dashboard' && isSettingsOpen && !queue.length && !testing;
    const testDice = useCallback(() => { if (canTest) { setFailed(false); setTesting(true); } }, [canTest]);
    const cancelTest = useCallback(() => setTesting(false), []);
    const current = active ? queue[0] : undefined;
    // Settlement changes queue metadata, not the renderer's immutable roll prop.
    const id = current?.id, notation = current?.notation, authorId = current?.authorId, privateRoll = current?.privateRoll;
    const roll = useMemo(() => id && notation ? { id, notation, authorId, privateRoll } : null,
        [id, notation, authorId, privateRoll]);

    return <Context.Provider value={{ enabled, setEnabled, sound, setSound, appearance, setAppearance, behavior, setBehavior, resetSettings,
        heldMessageIds, recordCreated, prepareMessages, invalidateMessage, resetPresentation, testDice, cancelTest, canTest, testing }}>
        {children}
        {(roll || (testing && available && isSettingsOpen && !queue.length)) && <DiceAnimation
            key={current?.sequence ?? 'preview'} roll={roll ?? sample}
            sound={roll ? diceSoundForRoll(sound, behavior, roll) : sound}
            appearance={appearance} behavior={behavior}
            onSettled={() => { if (current) { coordinator.current.settled(current.sequence); publish(); } }}
            onDone={() => {
                if (current) { coordinator.current.done(current.sequence); publish(); }
                else setTesting(false);
            }}
            onError={error => {
                logger.warn('Dice presentation unavailable; chat remains authoritative.', error);
                setFailed(true);
                coordinator.current.configure(false, behavior, currentUserId);
                publish();
                setTesting(false);
            }} />}
    </Context.Provider>;
}

export function useDicePresentation() { return useContext(Context); }
