'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { logger } from '@shared/utils/logger';
import type { RealtimeChatMessageChangedPayload } from '@shared/contracts/realtime';
import { useChat } from './ChatContext';
import { useSession } from './SessionContext';
import { useRealtime } from './RealtimeContext';
import { useFoundry } from './FoundryContext';
import { allowsDicePresentation, defaultDiceBehavior, diceSoundForRoll, normalizeDiceBehavior, type DiceBehavior } from '../components/Dice/behavior';
import { defaultDiceAppearance, normalizeDiceAppearance, type DiceAppearance } from '../components/Dice/appearance';
import { defaultDiceSound, normalizeDiceSound, type DiceSoundSettings } from '../components/Dice/collisionAudio';
import { DiceAnimation } from '../components/Dice/DiceAnimation';
import { LiveDiceInbox, type DicePresentation } from '../components/Dice/presentation';

const preferenceKey = 'sheetdelver_3d_dice';
const appearancePreferenceKey = 'sheetdelver_3d_dice_appearance';
const behaviorPreferenceKey = 'sheetdelver_3d_dice_behavior';
const soundPreferenceKey = 'sheetdelver_3d_dice_sound';
const Context = createContext({
    resetSettings: () => {},
    behavior: defaultDiceBehavior, setBehavior: (_behavior: DiceBehavior) => {},
    enabled: false, setEnabled: (_enabled: boolean) => {},
    appearance: defaultDiceAppearance, setAppearance: (_appearance: DiceAppearance) => {},
    sound: defaultDiceSound, setSound: (_sound: DiceSoundSettings) => {},
});

export function DicePresentationProvider({ children }: { children: ReactNode }) {
    const { messages } = useChat();
    const { token, step, currentUserId } = useSession();
    const { worldId } = useFoundry();
    const { appSocket } = useRealtime();
    const [enabled, updateEnabled] = useState(false);
    const [appearance, updateAppearance] = useState(defaultDiceAppearance);
    const [sound, updateSound] = useState(defaultDiceSound);
    const [behavior, updateBehavior] = useState(defaultDiceBehavior);
    const latestBehavior = useRef(behavior);
    const [available, setAvailable] = useState(false);
    const [failed, setFailed] = useState(false);
    const [queue, setQueue] = useState<DicePresentation[]>([]);
    const inbox = useRef(new LiveDiceInbox());
    const latestMessages = useRef(messages);
    useEffect(() => { latestMessages.current = messages; }, [messages]);
    const active = enabled && available && !failed && !!token && step === 'dashboard';

    useEffect(() => {
        latestBehavior.current = behavior;
        setQueue(current => current.filter(roll => allowsDicePresentation(roll, behavior, currentUserId)));
    }, [behavior, currentUserId]);

    const enqueue = useCallback((rolls: DicePresentation[]) => {
        if (!rolls.length) return;
        const accepted = rolls.filter(roll => allowsDicePresentation(roll, latestBehavior.current, currentUserId));
        logger.debug('DicePresentation | Queue admission', { supported: rolls.length, accepted: accepted.length });
        if (accepted.length) setQueue(current => [...current, ...accepted].slice(0, 3));
    }, [currentUserId]);

    const setBehavior = useCallback((value: DiceBehavior) => {
        const normalized = normalizeDiceBehavior(value);
        updateBehavior(normalized);
        try { localStorage.setItem(behaviorPreferenceKey, JSON.stringify(normalized)); } catch { /* Optional preference. */ }
    }, []);

    const setEnabled = useCallback((value: boolean) => {
        updateEnabled(value);
        setFailed(false);
        try { localStorage.setItem(preferenceKey, String(value)); } catch { /* Storage can be blocked. */ }
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

    useEffect(() => {
        const liveInbox = inbox.current;
        liveInbox.reset();
        setQueue([]);
        logger.debug('DicePresentation | Subscription state', {
            active, enabled, available, failed, authenticated: !!token, step, hasSocket: !!appSocket,
        });
        if (!active || !appSocket) return;
        const changed = (event: RealtimeChatMessageChangedPayload) => {
            logger.debug('DicePresentation | Chat change received', {
                action: event.action, hasMessageId: !!event.messageId, visible: document.visibilityState === 'visible',
            });
            if (document.visibilityState !== 'visible') return;
            if (event.action === 'create') {
                liveInbox.created(event.messageId);
                const rolls = liveInbox.consume(latestMessages.current);
                enqueue(rolls);
            } else {
                liveInbox.invalidated(event.messageId);
                setQueue(current => current.filter(roll => roll.id !== event.messageId));
            }
        };
        const reset = () => { liveInbox.reset(); setQueue([]); };
        appSocket.on('chatMessageChanged', changed);
        appSocket.on('disconnect', reset);
        appSocket.on('serverRestarting', reset);
        return () => {
            appSocket.off('chatMessageChanged', changed);
            appSocket.off('disconnect', reset);
            appSocket.off('serverRestarting', reset);
            liveInbox.reset();
        };
    }, [active, appSocket, token, worldId, enqueue, enabled, available, failed, step]);

    useEffect(() => {
        if (!active) return;
        const rolls = inbox.current.consume(messages);
        enqueue(rolls);
    }, [active, messages, enqueue]);

    const resetSettings = useCallback(() => {
        setEnabled(false); setAppearance(defaultDiceAppearance);
        setSound(defaultDiceSound); setBehavior(defaultDiceBehavior);
    }, [setEnabled, setAppearance, setSound, setBehavior]);

    return <Context.Provider value={{ enabled, setEnabled, sound, setSound, appearance, setAppearance, behavior, setBehavior, resetSettings }}>
        {children}
        {active && queue[0] && allowsDicePresentation(queue[0], behavior, currentUserId) && <DiceAnimation
            key={queue[0].id} roll={queue[0]} sound={diceSoundForRoll(sound, behavior, queue[0])}
            appearance={appearance} behavior={behavior}
            onDone={() => setQueue(current => current.slice(1))}
            onError={error => {
                logger.warn('Dice presentation unavailable; chat remains authoritative.', error);
                setFailed(true);
                setQueue([]);
            }} />}
    </Context.Provider>;
}

export function useDicePresentation() {
    return useContext(Context);
}
