'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useFoundry } from '@client/ui/context/FoundryContext';
import { useRealtime } from '@client/ui/context/RealtimeContext';
import { useSession } from '@client/ui/context/SessionContext';
import { useUI } from '@client/ui/context/UIContext';
import { useWorldBackground } from '@client/ui/main/hooks/useWorldBackground';
import { LoadingScreen } from '@client/ui/main/components/LoadingScreen';
import { LoginView } from '@client/ui/main/views/LoginView';
import { SetupView } from '@client/ui/main/views/SetupView';
import { WorldClosedView } from '@client/ui/main/views/WorldClosedView';
import LoadingModal from '@client/ui/components/LoadingModal';
import { decidePlayerBoundary } from './playerWorldBoundaryPolicy';

/** One presentation owner for every player route; server routes still authorize every action. */
export function PlayerWorldBoundary({ children }: { children: ReactNode }) {
    const { step, users, system, worldId, appVersion, handleLogin } = useFoundry();
    const { token, currentUserId, sessionEpoch } = useSession();
    const { linkState } = useRealtime();
    const { resetUI } = useUI();
    const bgStyle = useWorldBackground();
    const [mountedScope, setMountedScope] = useState<string | null>(null);
    const [loginLoading, setLoginLoading] = useState(false);
    const [prolonged, setProlonged] = useState(false);
    const overlayRef = useRef<HTMLDivElement>(null);

    const currentScope = worldId && currentUserId
        ? JSON.stringify([worldId, currentUserId, sessionEpoch]) : null;
    const { ready, terminal, retainPage, blocked } = decidePlayerBoundary({
        step, linkState, hasSessionMarker: !!token, currentScope, mountedScope,
    });

    useEffect(() => {
        if (terminal || (currentScope && mountedScope && currentScope !== mountedScope)) {
            setMountedScope(null);
        } else if (ready && currentScope) {
            setMountedScope(currentScope);
        }
    }, [terminal, ready, currentScope, mountedScope]);

    useEffect(() => {
        if (terminal) resetUI();
    }, [terminal, resetUI]);

    useEffect(() => {
        if (!blocked) {
            setProlonged(false);
            return;
        }
        const timer = setTimeout(() => setProlonged(true), 15_000);
        return () => clearTimeout(timer);
    }, [blocked]);

    useEffect(() => {
        if (blocked || linkState === 'unavailable') overlayRef.current?.focus();
    }, [blocked, linkState]);

    const onLogin = async (username: string, password: string) => {
        setLoginLoading(true);
        try {
            await handleLogin(username, password);
        } catch {
            // SessionProvider already reports the login error.
        } finally {
            setLoginLoading(false);
        }
    };

    const stateView = () => {
        if (step === 'setup') return <SetupView appVersion={appVersion || ''} />;
        if (step === 'world-closed') return <WorldClosedView system={system} appVersion={appVersion || ''} />;
        if (step === 'login' && (linkState === 'guest' || linkState === 'ready')) {
            return <LoginView users={users} system={system} onLogin={onLogin} loading={loginLoading} />;
        }
        if (ready) return <LoadingModal message="Opening world..." theme={system?.componentStyles?.loadingModal} />;
        if (step === 'dashboard') return <LoadingModal message="Checking world..." theme={system?.componentStyles?.loadingModal} />;
        return <LoadingScreen step={step} system={system} />;
    };

    return (
        <>
            {retainPage ? (
                <div key={mountedScope} inert={blocked} aria-hidden={blocked} className={blocked ? 'pointer-events-none' : undefined}>
                    {children}
                </div>
            ) : (
                <main className="sd-ui-page p-4 sm:p-8 font-sans flex flex-col" style={bgStyle} data-step={step}>
                    {stateView()}
                    {step === 'login' && loginLoading && (
                        <LoadingModal message="Logging in..." theme={system?.componentStyles?.loadingModal} />
                    )}
                    {step === 'login' && linkState !== 'guest' && linkState !== 'ready' && (
                        <LoadingModal message="Checking session..." theme={system?.componentStyles?.loadingModal} />
                    )}
                </main>
            )}
            {(blocked || linkState === 'unavailable') && step !== 'setup' && step !== 'world-closed' && (
                linkState === 'unavailable' ? (
                    <div ref={overlayRef} tabIndex={-1} className="sd-ui-overlay fixed inset-0 z-[240] flex items-center justify-center p-4" role="alert">
                        <div className="sd-ui-panel-raised max-w-md rounded-2xl p-8 text-center">
                            <h2 className="text-xl font-bold">SheetDelver is unavailable</h2>
                            <p className="sd-ui-muted mt-3">Please try again later by reloading this page.</p>
                        </div>
                    </div>
                ) : (
                    <div ref={overlayRef} tabIndex={-1} className="fixed inset-0 z-[240]" role="status" aria-live="polite">
                        <LoadingModal
                            message={prolonged ? 'World unavailable' : 'Reconnecting to world...'}
                            submessage={prolonged ? 'Please check back later.' : 'Waiting for SheetDelver and Foundry to be ready.'}
                            theme={system?.componentStyles?.loadingModal}
                        />
                    </div>
                )
            )}
        </>
    );
}
