'use client';

import React, { Suspense } from 'react';
import { SDKProvider } from '@client/ui/providers/SDKProvider';
import LoadingModal from '@client/ui/components/LoadingModal';

/**
 * SurfaceHost — the single host-owned boundary for every dynamically loaded module
 * surface (ADR-0027 decision 18): actor page, `tools`, `dashboardTools`, and `rollModal`.
 *
 * It composes, in one place:
 *  - an error boundary (modules can't crash the platform shell),
 *  - a Suspense loading boundary (for lazily-imported module components),
 *  - the SDK context + host-provided identity (`moduleId`) via SDKProvider (decision 19),
 *  - a style-scope root element that decision 28 (Phase 4) hangs runtime CSS scoping off.
 */

interface SurfaceErrorBoundaryProps {
    surface?: string;
    fallback?: React.ReactNode;
    children: React.ReactNode;
}

interface SurfaceErrorBoundaryState {
    hasError: boolean;
    message?: string;
}

class SurfaceErrorBoundary extends React.Component<SurfaceErrorBoundaryProps, SurfaceErrorBoundaryState> {
    state: SurfaceErrorBoundaryState = { hasError: false };

    static getDerivedStateFromError(error: Error): SurfaceErrorBoundaryState {
        return { hasError: true, message: error.message };
    }

    componentDidCatch(error: Error, info: React.ErrorInfo) {
        const label = this.props.surface ? `:${this.props.surface}` : '';
        console.error(`[SurfaceHost${label}] module surface crashed:`, error, info);
    }

    render() {
        if (this.state.hasError) {
            return this.props.fallback ?? <DefaultSurfaceError surface={this.props.surface} message={this.state.message} />;
        }
        return this.props.children;
    }
}

function DefaultSurfaceError({ surface, message }: { surface?: string; message?: string }) {
    return (
        <div className="min-h-[200px] flex items-center justify-center p-8 text-center text-white">
            <div className="bg-black/40 rounded border border-red-900/40 p-6 max-w-md">
                <h2 className="text-lg font-bold text-red-400 mb-2">
                    {surface ? `This ${surface} could not be displayed.` : 'This module surface could not be displayed.'}
                </h2>
                {message && <p className="text-sm text-neutral-400 font-mono break-words">{message}</p>}
            </div>
        </div>
    );
}

export interface SurfaceHostProps {
    /** Host-resolved module id for identity injection (decision 19). */
    moduleId?: string;
    /** Diagnostic label for the surface (e.g. 'actorPage', 'tools', 'dashboardTools', 'rollModal'). */
    surface?: string;
    /** Custom loading fallback (defaults to the platform LoadingModal). */
    loading?: React.ReactNode;
    /** Custom error fallback (defaults to a platform error panel). */
    fallback?: React.ReactNode;
    children: React.ReactNode;
}

export function SurfaceHost({ moduleId, surface, loading, fallback, children }: SurfaceHostProps) {
    // Style-scope root (ADR-0027 decision 28): the module's own CSS is authored scoped
    // under `.sdk-module--<id>`; the platform Tailwind utility layer stays global. The
    // class is applied here at runtime — identical in dev and packaged (no build-time
    // CSS rewrite), enforced by the `module:check` global-leak lint.
    const scopeClass = moduleId ? `sdk-module--${moduleId}` : undefined;
    return (
        <SurfaceErrorBoundary surface={surface} fallback={fallback}>
            <SDKProvider moduleId={moduleId}>
                <div
                    className={['sd-surface-root', scopeClass].filter(Boolean).join(' ')}
                    data-sd-surface={surface}
                    data-sd-module={moduleId}
                >
                    <Suspense fallback={loading ?? <LoadingModal message="Loading..." />}>
                        {children}
                    </Suspense>
                </div>
            </SDKProvider>
        </SurfaceErrorBoundary>
    );
}

export default SurfaceHost;
