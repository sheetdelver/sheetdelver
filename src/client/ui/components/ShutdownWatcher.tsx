'use client';

import { useState, useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { logger } from '@shared/utils/logger';

import { useSession } from '../context/SessionContext';

export default function ShutdownWatcher() {
    const pathname = usePathname();
    const { step } = useSession();
    const [shutdownDetected, setShutdownDetected] = useState(false);
    const [countDown, setCountDown] = useState(3);

    const prevStepRef = useRef(step);
    const shutdownTriggeredRef = useRef(false);

    useEffect(() => {
        // Only trigger if we transition FROM a live state TO setup
        const wasLive = prevStepRef.current === 'dashboard' || prevStepRef.current === 'login' || prevStepRef.current === 'startup';
        const isSetup = step === 'world-closed' || step === 'setup';

        if (wasLive && isSetup && !shutdownTriggeredRef.current && pathname !== '/') {
            logger.info(`[ShutdownWatcher] Shutdown detected via global state transition (${prevStepRef.current} -> ${step}). Starting countdown.`);
            shutdownTriggeredRef.current = true;
            setShutdownDetected(true);
            setCountDown(3);
        }

        prevStepRef.current = step;
    }, [step, pathname]);

    // Countdown Effect
    useEffect(() => {
        let timer: NodeJS.Timeout;
        if (shutdownDetected && countDown > 0) {
            timer = setTimeout(() => setCountDown(c => c - 1), 1000);
        } else if (shutdownDetected && countDown === 0) {
            logger.info('[ShutdownWatcher] Countdown complete. Redirecting to home/setup.');
            shutdownTriggeredRef.current = false;
            setShutdownDetected(false);

            // A hard reload is intentional: client navigation would preserve the
            // stale world providers that this shutdown boundary must discard.
            // eslint-disable-next-line @next/next/no-location-assign-relative-destination
            window.location.href = '/';
        }
        return () => clearTimeout(timer);
    }, [shutdownDetected, countDown]);

    if (!shutdownDetected) return null;

    return (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/90 backdrop-blur-sm animate-in fade-in duration-300">
            <div className="text-center space-y-4 p-8 border border-white/10 rounded-xl bg-neutral-900/50 shadow-2xl max-w-md mx-auto">
                <div className={`text-amber-500 text-6xl font-black font-mono animate-pulse`}>
                    {countDown}
                </div>
                <h2 className="text-2xl font-bold text-white tracking-tight">World Shutdown Detected</h2>
                <p className="text-white/60">The Foundry world has been stopped. Returning to start screen...</p>
            </div>
        </div>
    );
}
