'use client';

/**
 * ModuleLifecycleControl
 *
 * Module lifecycle dashboard. When a module has both a local dev version and a
 * managed install, it is rendered as two separate list items — one per source —
 * so each can be enabled/disabled independently with clear context about what
 * each represents. Manager operations (upgrade, uninstall, etc.) only appear on
 * the managed card.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { logger } from '@shared/utils/logger';
import { ModuleSourceCategory, ModuleLifecycleStatus, ManagerAction } from '@shared/types/modules';
import { useAdminAuth } from '../context/AdminAuthContext';
import {
    fetchModuleLifecycle,
    postLifecycleAction,
    type ModuleLifecycleInfo,
} from '../lib/adminApi';
import { invalidateModuleSourceCache } from '@modules/registry/client';
import ModuleDetailPanel from './ModuleDetailPanel';

// ─── Status styling ────────────────────────────────────────────────

function getStatusColor(status: string): string {
    switch (status) {
        case ModuleLifecycleStatus.Enabled:
        case ModuleLifecycleStatus.Validated:    return 'bg-[var(--admin-success)]';
        case ModuleLifecycleStatus.Disabled:
        case ModuleLifecycleStatus.Discovered:   return 'bg-amber-400';
        case ModuleLifecycleStatus.Errored:
        case ModuleLifecycleStatus.Incompatible: return 'bg-[var(--admin-danger-button)]';
        case ModuleLifecycleStatus.Upgrading:
        case ModuleLifecycleStatus.Uninstalling: return 'bg-[var(--admin-accent)]';
        default:                                 return 'bg-gray-400';
    }
}

function getStatusLabel(status: string): string {
    return status.charAt(0).toUpperCase() + status.slice(1);
}

// ─── Card entry type ───────────────────────────────────────────────

/**
 * (one for ModuleSourceCategory.Local, one for ModuleSourceCategory.Managed) from the same ModuleLifecycleInfo.
 */
interface CardEntry {
    key: string;
    mod: ModuleLifecycleInfo;
    /** Which source this card represents. undefined = single-source module. */
    cardSource: ModuleSourceCategory | undefined;
    /** Whether this specific source is currently enabled. */
    sourceEnabled: boolean;
    /** Whether the OTHER source (if any) is enabled — blocks enable on this card. */
    otherSourceEnabled: boolean;
    
    // Extracted source-specific state
    status: string;
    reason?: string;
    health?: { errorCount: number; lastError: string; lastErrorAt: number };
    validation?: ModuleLifecycleInfo['validation'];
}

function buildCardEntries(modules: ModuleLifecycleInfo[]): CardEntry[] {
    const entries: CardEntry[] = [];

    for (const mod of modules) {
        if (mod.localDirectory && mod.managed) {
            const localEnabled  = mod.localEnabled  ?? (mod.activeSource === ModuleSourceCategory.Local  ? mod.enabled : false);
            const managedEnabled = mod.managedEnabled ?? (mod.activeSource === ModuleSourceCategory.Managed ? mod.enabled : false);

            const localState = mod.sourceStates?.local;
            const managedState = mod.sourceStates?.managed;

            entries.push({
                key: `${mod.moduleId}-local`,
                mod,
                cardSource: ModuleSourceCategory.Local,
                sourceEnabled: localEnabled,
                otherSourceEnabled: managedEnabled,
                status: localState?.status || 'discovered',
                reason: localState?.reason,
                health: localState?.health,
                validation: localState?.validation as ModuleLifecycleInfo['validation'],
            });
            entries.push({
                key: `${mod.moduleId}-managed`,
                mod,
                cardSource: ModuleSourceCategory.Managed,
                sourceEnabled: managedEnabled,
                otherSourceEnabled: localEnabled,
                status: managedState?.status || 'discovered',
                reason: managedState?.reason,
                health: managedState?.health,
                validation: managedState?.validation as ModuleLifecycleInfo['validation'],
            });
        } else {
            // Single-source (only local or only managed)
            entries.push({
                key: mod.moduleId,
                mod,
                cardSource: undefined,
                sourceEnabled: mod.enabled,
                otherSourceEnabled: false,
                status: mod.status,
                reason: mod.reason,
                health: mod.health as { errorCount: number; lastError: string; lastErrorAt: number } | undefined,
                validation: mod.validation,
            });
        }
    }

    return entries;
}

// ─── Component ─────────────────────────────────────────────────────

export default function ModuleLifecycleControl({ onModulesLoaded }: {
    onModulesLoaded?: (modules: ModuleLifecycleInfo[]) => void;
}) {
    const { token, csrfToken, logout } = useAdminAuth();
    const [modules, setModules] = useState<ModuleLifecycleInfo[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [operationInProgress, setOperationInProgress] = useState<string | null>(null);
    const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());

    const loadModules = useCallback(async () => {
        if (!token) { setError('Not authenticated'); setLoading(false); return; }
        try {
            setLoading(true);
            setError(null);
            const result = await fetchModuleLifecycle();
            if (result.sessionExpired) { setError('Session expired. Please log in again.'); logout(); return; }
            if (!result.ok || !result.data) throw new Error(result.error || 'Failed to fetch modules');
            setModules(result.data.modules || []);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
            logger.error('Failed to fetch module lifecycle:', err);
        } finally {
            setLoading(false);
        }
    }, [token, logout]);

    useEffect(() => { loadModules(); }, [loadModules]);
    useEffect(() => {
        if (modules.length > 0 && onModulesLoaded) onModulesLoaded(modules);
    }, [modules, onModulesLoaded]);

    const handleToggle = async (entry: CardEntry) => {
        if (!token || !csrfToken) { setError('Authentication context missing.'); return; }
        try {
            setOperationInProgress(entry.key);
            setError(null);
            const action = entry.sourceEnabled ? ManagerAction.Disable : ManagerAction.Enable;
            const body: Record<string, unknown> = { reason: `Module ${action}d by admin via UI` };
            if (entry.cardSource) body.source = entry.cardSource;

            const result = await postLifecycleAction(entry.mod.moduleId, action, body);
            if (result.sessionExpired) { setError('Session expired. Please log in again.'); logout(); return; }
            if (!result.ok) throw new Error(result.error || `Failed to ${action} module`);

            // Switching source implicitly when enabling a non-active source — bust UI cache.
            if (action === ManagerAction.Enable && entry.cardSource && entry.cardSource !== entry.mod.activeSource) {
                invalidateModuleSourceCache();
            }
            await loadModules();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
            logger.error('Failed to toggle module:', err);
        } finally {
            setOperationInProgress(null);
        }
    };

    const toggleExpanded = (key: string) => {
        setExpandedKeys(prev => {
            const next = new Set(prev);
            if (next.has(key)) {
                next.delete(key);
            } else {
                next.add(key);
            }
            return next;
        });
    };

    // ─── Loading skeleton ──────────────────────────────────────────

    if (loading && modules.length === 0) {
        return (
            <div className="p-4">
                <h2 className="mb-4 text-2xl font-bold tracking-tight text-[var(--admin-text-primary)]">Module Lifecycle</h2>
                <div className="space-y-3">
                    {[1, 2, 3].map(i => <div key={i} className="h-20 animate-pulse rounded-[24px] bg-[var(--admin-surface)]" />)}
                </div>
            </div>
        );
    }

    // ─── Render ────────────────────────────────────────────────────

    const entries = buildCardEntries(modules);

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

            {error && (
                <div className="mb-4 rounded-2xl border border-[var(--admin-danger-border)] bg-[var(--admin-danger-bg)] p-3 text-[var(--admin-danger-text)]">
                    {error}
                </div>
            )}

            <div className="space-y-3">
                {entries.length === 0 ? (
                    <p className="text-[var(--admin-text-muted)]">No modules found</p>
                ) : (
                    entries.map((entry) => (
                        <ModuleCard
                            key={entry.key}
                            entry={entry}
                            expanded={expandedKeys.has(entry.key)}
                            operationInProgress={operationInProgress === entry.key}
                            onToggle={() => handleToggle(entry)}
                            onToggleExpand={() => toggleExpanded(entry.key)}
                            onOperationComplete={loadModules}
                            onSessionExpired={logout}
                        />
                    ))
                )}
            </div>
        </div>
    );
}

// ─── ModuleCard ────────────────────────────────────────────────────

interface ModuleCardProps {
    entry: CardEntry;
    expanded: boolean;
    operationInProgress: boolean;
    onToggle: () => void;
    onToggleExpand: () => void;
    onOperationComplete: () => void;
    onSessionExpired: () => void;
}

function ModuleCard({
    entry, expanded, operationInProgress,
    onToggle, onToggleExpand, onOperationComplete, onSessionExpired,
}: ModuleCardProps) {
    const { mod, cardSource, sourceEnabled, otherSourceEnabled, status, health } = entry;
    const isLocal = cardSource === ModuleSourceCategory.Local;
    const isManaged = cardSource === ModuleSourceCategory.Managed;
    const blockedByOther = !sourceEnabled && otherSourceEnabled;

    // Card border/background reflects this source's enabled state.
    const cardClass = sourceEnabled
        ? 'border-[var(--admin-success-border)] bg-[var(--admin-success-bg)]'
        : status === ModuleLifecycleStatus.Errored || status === ModuleLifecycleStatus.Incompatible
            ? 'border-[var(--admin-danger-border)] bg-[var(--admin-danger-bg)]'
            : isLocal
                ? 'border-purple-500/20 bg-purple-500/5'
                : 'border-[var(--admin-border)] bg-[var(--admin-surface)]';

    return (
        <div className={`rounded-[24px] border p-4 transition-colors ${cardClass}`}>
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
                        {/* Source badge */}
                        {isLocal && (
                            <span className="rounded-full border border-purple-500/30 bg-purple-500/10 px-2 py-0.5 text-xs font-medium text-purple-400">
                                Local Dev
                            </span>
                        )}
                        {isManaged && mod.artifact?.version && (
                            <span className="rounded-full border border-[var(--admin-border)] bg-[var(--admin-surface)] px-2 py-0.5 text-xs font-mono text-[var(--admin-text-muted)]">
                                v{mod.artifact.version}
                            </span>
                        )}
                        {/* Single-source cards: show the active source when it can be inferred. */}
                        {!cardSource && mod.activeSource === ModuleSourceCategory.Local && (
                            <span className="rounded-full border border-purple-500/30 bg-purple-500/10 px-2 py-0.5 text-xs font-medium text-purple-400">Local Dev</span>
                        )}
                        {!cardSource && mod.activeSource === ModuleSourceCategory.Managed && (
                            <span className="rounded-full border border-[var(--admin-border)] bg-[var(--admin-surface)] px-2 py-0.5 text-xs font-medium text-[var(--admin-text-muted)]">Managed</span>
                        )}
                    </div>

                    {/* Module ID + status */}
                    <div className="mt-1 flex items-center gap-3 text-sm text-[var(--admin-text-secondary)]">
                        <span className="font-mono text-xs">{mod.moduleId}</span>
                        <span className="flex items-center gap-1.5">
                            <span className={`inline-block h-2 w-2 rounded-full ${getStatusColor(sourceEnabled ? 'enabled' : status)}`} />
                            {sourceEnabled ? 'Enabled' : getStatusLabel(status)}
                        </span>
                    </div>

                    {/* Health */}
                    {health && health.errorCount > 0 && (
                        <div className="mt-1 flex items-center gap-1 text-xs text-[var(--admin-danger-text)]">
                            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                            </svg>
                            <span>{health.errorCount} error{health.errorCount !== 1 ? 's' : ''}</span>
                        </div>
                    )}
                </div>

                {/* Action buttons */}
                <div className="ml-4 flex flex-col items-end gap-1">
                    <div className="flex items-center gap-2">
                        <button
                            onClick={onToggleExpand}
                            className="rounded-2xl border border-[var(--admin-border)] bg-[var(--admin-surface)] px-3 py-2 text-sm text-[var(--admin-text-secondary)] transition hover:bg-[var(--admin-surface-hover)]"
                        >
                            {expanded ? 'Hide' : 'Details'}
                        </button>

                        <button
                            onClick={onToggle}
                            disabled={operationInProgress || blockedByOther}
                            title={blockedByOther
                                ? `Disable the ${isLocal ? 'Managed' : 'Local Dev'} version first`
                                : undefined}
                            className={`whitespace-nowrap rounded-2xl px-4 py-2 font-semibold transition ${
                                sourceEnabled
                                    ? 'bg-[var(--admin-danger-button)] text-white hover:bg-[var(--admin-danger-button-strong)] disabled:bg-[var(--admin-danger-button-soft)]'
                                    : blockedByOther
                                        ? 'cursor-not-allowed border border-[var(--admin-border)] bg-[var(--admin-surface)] text-[var(--admin-text-muted)] opacity-50'
                                        : 'bg-[var(--admin-success)] text-white hover:bg-[var(--admin-success-strong)] disabled:bg-[var(--admin-success-soft)]'
                            }`}
                        >
                            {operationInProgress ? 'Processing…' : sourceEnabled ? 'Disable' : 'Enable'}
                        </button>
                    </div>

                    {/* Conflict hint */}
                    {blockedByOther && (
                        <span className="text-xs text-[var(--admin-text-muted)]">
                            {isLocal ? 'Managed' : 'Local Dev'} is enabled — disable it first
                        </span>
                    )}
                </div>
            </div>

            {/* Expandable detail panel */}
            {expanded && (
                <div className="mt-4 pt-4 border-t border-[var(--admin-border)]">
                    <ModuleDetailPanel
                        entry={entry}
                        onOperationComplete={onOperationComplete}
                        onSessionExpired={onSessionExpired}
                    />
                </div>
            )}
        </div>
    );
}
