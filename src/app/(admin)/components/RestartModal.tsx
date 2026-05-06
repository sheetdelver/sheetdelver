'use client';

import React, { useState, useEffect } from 'react';
import { postServerRestart } from '../lib/adminApi';

interface RestartModalProps {
    /** Which operation triggered the prompt, e.g. "install", "upgrade", "uninstall". */
    operation?: string;
    /** Called when the user dismisses without restarting. */
    onDismiss: () => void;
}

type Phase = 'prompt' | 'restarting' | 'reconnecting' | 'done';

export default function RestartModal({ operation = 'operation', onDismiss }: RestartModalProps) {
    const [phase, setPhase] = useState<Phase>('prompt');
    const [error, setError] = useState<string | null>(null);

    // Once the restart request is sent, poll /api/status until the server
    // responds, then reload so the fresh build and new adapters are in effect.
    useEffect(() => {
        if (phase !== 'restarting') return;

        let cancelled = false;
        const poll = async () => {
            await new Promise(r => setTimeout(r, 2000));
            while (!cancelled) {
                try {
                    const res = await fetch('/api/status');
                    if (res.ok && !cancelled) {
                        setPhase('done');
                        setTimeout(() => window.location.reload(), 800);
                        return;
                    }
                } catch {
                    // not yet up — keep polling
                }
                await new Promise(r => setTimeout(r, 1500));
            }
        };

        setPhase('reconnecting');
        poll();
        return () => { cancelled = true; };
    }, [phase]);

    const handleRestart = async () => {
        setError(null);
        try {
            await postServerRestart();
            setPhase('restarting');
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to send restart request');
        }
    };

    const isInProgress = phase === 'restarting' || phase === 'reconnecting' || phase === 'done';

    return (
        /* Backdrop */
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="w-full max-w-md rounded-[28px] border border-[var(--admin-border)] bg-[var(--admin-bg)] shadow-[0_32px_96px_rgba(0,0,0,0.5)] p-8">

                {/* Icon */}
                <div className="mb-5 flex items-center justify-center">
                    {isInProgress ? (
                        <svg className="h-12 w-12 animate-spin text-amber-400" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-80" fill="currentColor"
                                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                    ) : (
                        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/15 ring-1 ring-amber-500/30">
                            <svg className="h-6 w-6 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                            </svg>
                        </div>
                    )}
                </div>

                {/* Content */}
                {phase === 'prompt' && (
                    <>
                        <h2 className="mb-2 text-center text-xl font-bold text-[var(--admin-text-primary)]">
                            Restart Required
                        </h2>
                        <p className="mb-1 text-center text-sm text-[var(--admin-text-secondary)]">
                            The <span className="font-medium text-[var(--admin-text-primary)] capitalize">{operation}</span> completed
                            successfully. A server restart is required to load the updated module.
                        </p>
                        <p className="mb-6 text-center text-xs text-[var(--admin-text-muted)]">
                            In production, also run <code className="rounded bg-[var(--admin-surface)] px-1 py-0.5">npm run build</code> before
                            restarting for new module UI to take effect.
                        </p>

                        {error && (
                            <p className="mb-4 rounded-xl bg-[var(--admin-danger-bg)] border border-[var(--admin-danger-border)] px-3 py-2 text-center text-xs text-[var(--admin-danger-text)]">
                                {error}
                            </p>
                        )}

                        <div className="flex gap-3">
                            <button
                                onClick={onDismiss}
                                className="flex-1 rounded-2xl border border-[var(--admin-border)] bg-[var(--admin-surface)] px-4 py-2.5 text-sm font-medium text-[var(--admin-text-secondary)] transition hover:bg-[var(--admin-surface-hover)]"
                            >
                                Restart Later
                            </button>
                            <button
                                onClick={handleRestart}
                                className="flex-1 rounded-2xl bg-amber-500 px-4 py-2.5 text-sm font-semibold text-black transition hover:bg-amber-400"
                            >
                                Restart Now
                            </button>
                        </div>
                    </>
                )}

                {phase === 'reconnecting' && (
                    <>
                        <h2 className="mb-2 text-center text-xl font-bold text-[var(--admin-text-primary)]">
                            Restarting…
                        </h2>
                        <p className="text-center text-sm text-[var(--admin-text-secondary)]">
                            Waiting for the server to come back online.
                        </p>
                    </>
                )}

                {phase === 'done' && (
                    <>
                        <h2 className="mb-2 text-center text-xl font-bold text-green-400">
                            Back Online
                        </h2>
                        <p className="text-center text-sm text-[var(--admin-text-secondary)]">
                            Reloading…
                        </p>
                    </>
                )}
            </div>
        </div>
    );
}
