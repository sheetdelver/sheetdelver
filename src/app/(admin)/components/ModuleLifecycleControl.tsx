'use client';

/**
 * ModuleLifecycleControl
 *
 * Enhanced module lifecycle dashboard showing full lifecycle state,
 * color-coded status indicators, trust badges, health summaries,
 * and expandable detail panels per module.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { logger } from '@shared/utils/logger';
import { useAdminAuth } from '../context/AdminAuthContext';
import {
    fetchModuleLifecycle,
    postLifecycleAction,
    postSwitchSource,
    type ModuleLifecycleInfo,
} from '../lib/adminApi';
import { invalidateModuleSourceCache } from '@modules/registry/client';
import ModuleDetailPanel from './ModuleDetailPanel';

// ─── Status styling map ────────────────────────────────────────────

/** Returns CSS classes for the status indicator dot based on lifecycle status. */
function getStatusColor(status: string): string {
    switch (status) {
        case 'enabled':
        case 'validated':
            return 'bg-[var(--admin-success)]';
        case 'disabled':
        case 'discovered':
            return 'bg-amber-400';
        case 'errored':
        case 'incompatible':
            return 'bg-[var(--admin-danger-button)]';
        case 'upgrading':
        case 'uninstalling':
            return 'bg-[var(--admin-accent)]';
        case 'removed':
            return 'bg-gray-400';
        default:
            return 'bg-gray-400';
    }
}

/** Returns a human-readable status label. */
function getStatusLabel(status: string): string {
    return status.charAt(0).toUpperCase() + status.slice(1);
}

export default function ModuleLifecycleControl({ onModulesLoaded }: { onModulesLoaded?: (modules: ModuleLifecycleInfo[]) => void }) {
    const { token, csrfToken, logout } = useAdminAuth();
    const [modules, setModules] = useState<ModuleLifecycleInfo[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [operationInProgress, setOperationInProgress] = useState<string | null>(null);
    const [expandedModules, setExpandedModules] = useState<Set<string>>(new Set());

    /** Fetch the module lifecycle list from the admin API. */
    const loadModules = useCallback(async () => {
        if (!token) {
            setError('Not authenticated');
            setLoading(false);
            return;
        }

        try {
            setLoading(true);
            setError(null);

            const result = await fetchModuleLifecycle();

            if (result.sessionExpired) {
                setError('Your session has expired. Please log in again.');
                logout();
                return;
            }

            if (!result.ok || !result.data) {
                throw new Error(result.error || 'Failed to fetch modules');
            }

            setModules(result.data.modules || []);
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Unknown error';
            logger.error('Failed to fetch module lifecycle:', err);
            setError(message);
        } finally {
            setLoading(false);
        }
    }, [token, logout]);

    // Initial fetch
    useEffect(() => {
        loadModules();
    }, [loadModules]);

    // Notify parent when modules are updated
    useEffect(() => {
        if (modules.length > 0 && onModulesLoaded) {
            onModulesLoaded(modules);
        }
    }, [modules, onModulesLoaded]);

    /** Toggle a module's enabled/disabled state. */
    const handleToggleModule = async (moduleId: string, currentlyEnabled: boolean) => {
        if (!token || !csrfToken) {
            setError('Authentication context missing. Please log in again.');
            return;
        }

        try {
            setOperationInProgress(moduleId);
            setError(null);

            const action = currentlyEnabled ? 'disable' : 'enable';
            const result = await postLifecycleAction(moduleId, action, {
                reason: `Module ${action}d by admin via UI`,
            });

            if (result.sessionExpired) {
                setError('Your session has expired. Please log in again.');
                logout();
                return;
            }

            if (!result.ok) {
                throw new Error(result.error || `Failed to ${action} module`);
            }

            // Refresh the full list to get accurate state
            await loadModules();
            logger.info(`Module ${moduleId} ${action}d successfully`);
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Unknown error';
            logger.error('Failed to toggle module:', err);
            setError(message);
        } finally {
            setOperationInProgress(null);
        }
    };

    /** Switch a module between its local dev version and managed install. */
    const handleSwitchSource = async (moduleId: string, source: 'local' | 'data') => {
        if (!token || !csrfToken) return;
        try {
            setOperationInProgress(moduleId);
            setError(null);
            const result = await postSwitchSource(moduleId, source);
            if (!result.ok) throw new Error(result.error || 'Failed to switch source');
            // Bust the client-side active-source cache so the next module UI load picks the new source.
            invalidateModuleSourceCache();
            await loadModules();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setOperationInProgress(null);
        }
    };

    /** Toggle expand/collapse of a module's detail panel. */
    const toggleExpanded = (moduleId: string) => {
        setExpandedModules(prev => {
            const next = new Set(prev);
            if (next.has(moduleId)) {
                next.delete(moduleId);
            } else {
                next.add(moduleId);
            }
            return next;
        });
    };

    // ─── Loading state ─────────────────────────────────────────────

    if (loading && modules.length === 0) {
        return (
            <div className="p-4">
                <h2 className="mb-4 text-2xl font-bold tracking-tight text-[var(--admin-text-primary)]">Module Lifecycle</h2>
                <div className="space-y-3">
                    {[1, 2, 3].map(i => (
                        <div key={i} className="h-20 animate-pulse rounded-[24px] bg-[var(--admin-surface)]" />
                    ))}
                </div>
            </div>
        );
    }

    // ─── Render ────────────────────────────────────────────────────

    return (
        <div className="p-4">
            <div className="mb-4 flex items-center justify-between">
                <h2 className="text-2xl font-bold tracking-tight text-[var(--admin-text-primary)]">Module Lifecycle</h2>
                <button
                    onClick={loadModules}
                    disabled={loading}
                    className="rounded-2xl border border-[var(--admin-border)] bg-[var(--admin-surface)] px-3 py-1.5 text-sm text-[var(--admin-text-secondary)] transition hover:bg-[var(--admin-surface-hover)] disabled:opacity-50"
                >
                    {loading ? 'Refreshing...' : 'Refresh'}
                </button>
            </div>

            {/* Error banner */}
            {error && (
                <div className="mb-4 rounded-2xl border border-[var(--admin-danger-border)] bg-[var(--admin-danger-bg)] p-3 text-[var(--admin-danger-text)]">
                    {error}
                </div>
            )}

            {/* Module list */}
            <div className="space-y-3">
                {modules.length === 0 ? (
                    <p className="text-[var(--admin-text-muted)]">No modules found</p>
                ) : (
                    modules.map((mod) => (
                        <div
                            key={mod.moduleId}
                            className={`rounded-[24px] border p-4 transition-colors ${
                                mod.enabled
                                    ? 'border-[var(--admin-success-border)] bg-[var(--admin-success-bg)]'
                                    : mod.status === 'errored' || mod.status === 'incompatible'
                                        ? 'border-[var(--admin-danger-border)] bg-[var(--admin-danger-bg)]'
                                        : 'border-[var(--admin-border)] bg-[var(--admin-surface)]'
                            }`}
                        >
                            {/* Module header row */}
                            <div className="flex items-start justify-between">
                                <div className="flex-1 min-w-0">
                                    {/* Title + badges */}
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <h3 className="text-lg font-semibold text-[var(--admin-text-primary)]">
                                            {mod.title}
                                        </h3>
                                        {mod.experimental && (
                                            <span className="rounded-full border border-[var(--admin-warning-border)] bg-[var(--admin-warning-bg)] px-2 py-0.5 text-xs font-medium text-[var(--admin-warning-text)]">
                                                Experimental
                                            </span>
                                        )}
                                        {mod.artifact?.version && (
                                            <span className="rounded-full border border-[var(--admin-border)] bg-[var(--admin-surface)] px-2 py-0.5 text-xs font-mono text-[var(--admin-text-muted)]">
                                                v{mod.artifact.version}
                                            </span>
                                        )}
                                        {mod.activeSource === 'local' ? (
                                            <span className="rounded-full border border-purple-500/30 bg-purple-500/10 px-2 py-0.5 text-xs font-medium text-purple-400">
                                                Local Dev
                                            </span>
                                        ) : !mod.managed && (
                                            <span className="rounded-full border border-blue-500/30 bg-blue-500/10 px-2 py-0.5 text-xs font-medium text-blue-400">
                                                System
                                            </span>
                                        )}
                                    </div>

                                    {/* Module ID + status */}
                                    <div className="mt-1 flex items-center gap-3 text-sm text-[var(--admin-text-secondary)]">
                                        <span className="font-mono text-xs">{mod.moduleId}</span>
                                        <span className="flex items-center gap-1.5">
                                            <span className={`inline-block h-2 w-2 rounded-full ${getStatusColor(mod.status)}`} />
                                            {getStatusLabel(mod.status)}
                                        </span>
                                    </div>

                                    {/* Source toggle — visible when both managed and local dev versions exist */}
                                    {mod.localDirectory && (
                                        <div className="mt-2 flex items-center gap-1.5">
                                            <span className="text-xs text-[var(--admin-text-muted)]">Source:</span>
                                            <button
                                                onClick={() => handleSwitchSource(mod.moduleId, 'data')}
                                                disabled={operationInProgress === mod.moduleId || mod.activeSource === 'data'}
                                                className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition ${
                                                    mod.activeSource === 'data' || !mod.activeSource
                                                        ? 'bg-[var(--admin-accent)] text-white'
                                                        : 'border border-[var(--admin-border)] text-[var(--admin-text-muted)] hover:bg-[var(--admin-surface-hover)]'
                                                }`}
                                            >
                                                Managed
                                            </button>
                                            <button
                                                onClick={() => handleSwitchSource(mod.moduleId, 'local')}
                                                disabled={operationInProgress === mod.moduleId || mod.activeSource === 'local'}
                                                className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition ${
                                                    mod.activeSource === 'local'
                                                        ? 'bg-purple-600 text-white'
                                                        : 'border border-[var(--admin-border)] text-[var(--admin-text-muted)] hover:bg-[var(--admin-surface-hover)]'
                                                }`}
                                            >
                                                Local Dev
                                            </button>
                                        </div>
                                    )}

                                    {/* Health summary (if errors exist) */}
                                    {mod.health && mod.health.errorCount > 0 && (
                                        <div className="mt-1 flex items-center gap-1 text-xs text-[var(--admin-danger-text)]">
                                            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                                            </svg>
                                            <span>{mod.health.errorCount} error{mod.health.errorCount !== 1 ? 's' : ''}</span>
                                        </div>
                                    )}
                                </div>

                                {/* Action buttons */}
                                <div className="ml-4 flex flex-col items-end gap-1">
                                    <div className="flex items-center gap-2">
                                        {/* Details toggle */}
                                        <button
                                            onClick={() => toggleExpanded(mod.moduleId)}
                                            className="rounded-2xl border border-[var(--admin-border)] bg-[var(--admin-surface)] px-3 py-2 text-sm text-[var(--admin-text-secondary)] transition hover:bg-[var(--admin-surface-hover)]"
                                        >
                                            {expandedModules.has(mod.moduleId) ? 'Hide' : 'Details'}
                                        </button>

                                        {/* Enable/Disable toggle */}
                                        {(() => {
                                            // When both local dev and managed exist, only one may be enabled at a time.
                                            const hasBothSources = !!mod.localDirectory;
                                            const otherSourceEnabled = hasBothSources && (
                                                mod.activeSource === 'local'
                                                    ? mod.managedEnabled === true
                                                    : mod.localEnabled === true
                                            );
                                            // Gray out "Enable" when the other source is active+enabled; always allow "Disable".
                                            const blockedByOther = !mod.enabled && otherSourceEnabled;
                                            const isDisabled = operationInProgress === mod.moduleId || blockedByOther;

                                            return (
                                                <button
                                                    onClick={() => handleToggleModule(mod.moduleId, mod.enabled)}
                                                    disabled={isDisabled}
                                                    title={blockedByOther
                                                        ? `Disable the ${mod.activeSource === 'local' ? 'Managed' : 'Local Dev'} source first`
                                                        : undefined}
                                                    className={`whitespace-nowrap rounded-2xl px-4 py-2 font-semibold transition ${
                                                        mod.enabled
                                                            ? 'bg-[var(--admin-danger-button)] text-white hover:bg-[var(--admin-danger-button-strong)] disabled:bg-[var(--admin-danger-button-soft)]'
                                                            : blockedByOther
                                                                ? 'cursor-not-allowed bg-[var(--admin-surface)] text-[var(--admin-text-muted)] opacity-50 border border-[var(--admin-border)]'
                                                                : 'bg-[var(--admin-success)] text-white hover:bg-[var(--admin-success-strong)] disabled:bg-[var(--admin-success-soft)]'
                                                    }`}
                                                >
                                                    {operationInProgress === mod.moduleId
                                                        ? 'Processing...'
                                                        : mod.enabled
                                                            ? 'Disable'
                                                            : 'Enable'}
                                                </button>
                                            );
                                        })()}
                                    </div>
                                    {/* Conflict hint */}
                                    {(() => {
                                        const hasBothSources = !!mod.localDirectory;
                                        const otherSourceEnabled = hasBothSources && (
                                            mod.activeSource === 'local'
                                                ? mod.managedEnabled === true
                                                : mod.localEnabled === true
                                        );
                                        return !mod.enabled && otherSourceEnabled ? (
                                            <span className="text-xs text-[var(--admin-text-muted)]">
                                                {mod.activeSource === 'local' ? 'Managed' : 'Local Dev'} is enabled — disable it first
                                            </span>
                                        ) : null;
                                    })()}
                                </div>
                            </div>

                            {/* Expandable detail panel */}
                            {expandedModules.has(mod.moduleId) && (
                                <ModuleDetailPanel
                                    module={mod}
                                    onOperationComplete={loadModules}
                                    onSessionExpired={logout}
                                />
                            )}
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}
