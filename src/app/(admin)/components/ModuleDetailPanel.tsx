'use client';

/**
 * ModuleDetailPanel
 *
 * Expandable detail view for an individual module within the lifecycle dashboard.
 * Shows manifest metadata, validation diagnostics, artifact info, and health data.
 */

import React, { useState } from 'react';
import { ModuleSourceCategory } from '@shared/types/modules';
import { adminFetch } from '../lib/adminApi';
import type { ModuleLifecycleInfo } from '../lib/adminApi';
import ManagerActionBar from './ManagerActionBar';

interface ModuleDetailPanelProps {
    entry: {
        mod: ModuleLifecycleInfo;
        cardSource?: ModuleSourceCategory;
        status: string;
        reason?: string;
        health?: { errorCount: number; lastError: string; lastErrorAt: number };
        validation?: ModuleLifecycleInfo['validation'];
    };
    /** Callback after a manager operation completes — parent should refresh. */
    onOperationComplete: () => void;
    /** Callback when session expires — parent should redirect to login. */
    onSessionExpired: () => void;
}

/** Formats a unix timestamp to a locale-friendly date string. */
function formatTimestamp(ts?: number): string {
    if (!ts) return '—';
    return new Date(ts).toLocaleString();
}

export default function ModuleDetailPanel({ entry, onOperationComplete, onSessionExpired }: ModuleDetailPanelProps) {
    const { mod: module, cardSource, status, reason, health, validation } = entry;
    const { artifact } = module;
    const [verifying, setVerifying] = useState(false);

    const handleReverify = async () => {
        setVerifying(true);
        try {
            const res = await adminFetch(`/manager/${module.moduleId}/validate`, {
                method: 'POST',
                body: JSON.stringify({ source: cardSource || module.activeSource || ModuleSourceCategory.Managed })
            });
            if (res.sessionExpired) {
                onSessionExpired();
                return;
            }
            onOperationComplete();
        } finally {
            setVerifying(false);
        }
    };

    const hasBothSources = !!module.localDirectory;
    const localIsActive = module.activeSource === ModuleSourceCategory.Local;
    // A card is "local" if it was explicitly rendered as the local split card,
    // OR if it's a single-source module whose only source is local dev.
    const isLocalCard = cardSource === ModuleSourceCategory.Local || (!cardSource && localIsActive && !module.managed);

    return (
        <div className="mt-3 space-y-4 border-t border-[var(--admin-border)] pt-4">

            {/* ── Local Dev card detail ──────────────────────────────────── */}
            {isLocalCard && (
                <>
                    <DetailSection title="Location" action={<ReverifyButton verifying={verifying} onClick={handleReverify} />}>
                        <code className="block rounded-xl bg-[var(--admin-surface)] p-3 text-xs text-[var(--admin-text-secondary)] break-all font-mono">
                            {module.localDirectory ?? module.directory}
                        </code>
                    </DetailSection>
                    {validation && (
                        <DetailSection title="Validation">
                            <div className="flex items-center gap-2 mb-2">
                                <span className={`inline-block h-2 w-2 rounded-full ${validation.manifestValid ? 'bg-[var(--admin-success)]' : 'bg-[var(--admin-danger-button)]'}`} />
                                <span className="text-sm text-[var(--admin-text-secondary)]">
                                    Manifest: {validation.manifestValid ? 'Valid' : 'Invalid'}
                                </span>
                            </div>
                            {validation.diagnostics && validation.diagnostics.length > 0 && (
                                <div className="space-y-1">
                                    {validation.diagnostics.map((diag, i) => (
                                        <div key={`diag-${i}`} className={`rounded-xl px-3 py-2 text-xs ${
                                            diag.severity === 'error' ? 'bg-[var(--admin-danger-bg)] text-[var(--admin-danger-text)]'
                                            : diag.severity === 'warning' ? 'bg-[var(--admin-warning-bg)] text-[var(--admin-warning-text)]'
                                            : 'bg-[var(--admin-surface)] text-[var(--admin-text-secondary)]'}`}>
                                            <span className="font-mono font-semibold">{diag.code}</span>
                                            <span className="ml-2">{diag.message}</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </DetailSection>
                    )}
                    {reason && (
                        <DetailSection title="Status Reason">
                            <p className="text-sm text-[var(--admin-text-secondary)]">{reason}</p>
                        </DetailSection>
                    )}
                    {health && health.errorCount > 0 && (
                        <DetailSection title="Health">
                            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
                                <DetailRow label="Error Count" value={health.errorCount.toString()} />
                                <DetailRow label="Last Error At" value={formatTimestamp(health.lastErrorAt)} />
                            </div>
                            {health.lastError && (
                                <div className="mt-2 rounded-xl bg-[var(--admin-danger-bg)] px-3 py-2 text-xs text-[var(--admin-danger-text)] font-mono">
                                    {health.lastError}
                                </div>
                            )}
                        </DetailSection>
                    )}
                    {hasBothSources && (
                        <p className="text-xs text-[var(--admin-text-muted)]">
                            Manager operations (upgrade, uninstall, validate) are on the Managed card.
                        </p>
                    )}
                </>
            )}

            {/* ── Managed / single-source card detail ───────────────────── */}
            {!isLocalCard && (
            <div className="space-y-4">
                {/* Location — managed install path, fixed regardless of active source (ADR-0030 UX-6). */}
                <DetailSection title="Location" action={<ReverifyButton verifying={verifying} onClick={handleReverify} />}>
                    <code className="block rounded-xl bg-[var(--admin-surface)] p-3 text-xs text-[var(--admin-text-secondary)] break-all font-mono">
                        {module.managedDirectory ?? module.directory}
                    </code>
                </DetailSection>

                {/* Reason */}
                {reason && (
                    <DetailSection title="Status Reason">
                        <p className="text-sm text-[var(--admin-text-secondary)]">{reason}</p>
                    </DetailSection>
                )}

                {/* Artifact Metadata */}
                {artifact && (
                    <DetailSection title="Artifact">
                        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
                            <DetailRow label="Version" value={artifact.version} />
                            <DetailRow label="Source" value={artifact.source} />
                            <DetailRow label="Installed" value={formatTimestamp(artifact.installedAt)} />
                            {artifact.integrity && <DetailRow label="Integrity" value={artifact.integrity} mono />}
                            {artifact.signature && <DetailRow label="Signature" value={artifact.signature} mono />}
                        </div>
                    </DetailSection>
                )}

                {/* Validation Diagnostics */}
                {validation && (
                    <DetailSection title="Validation">
                        <div className="flex items-center gap-2 mb-2">
                            <span className={`inline-block h-2 w-2 rounded-full ${validation.manifestValid ? 'bg-[var(--admin-success)]' : 'bg-[var(--admin-danger-button)]'}`} />
                            <span className="text-sm text-[var(--admin-text-secondary)]">
                                Manifest: {validation.manifestValid ? 'Valid' : 'Invalid'}
                            </span>
                        </div>
                        {validation.diagnostics && validation.diagnostics.length > 0 && (
                            <div className="space-y-1">
                                {validation.diagnostics.map((diag, i) => (
                                    <div
                                        key={`diag-${i}`}
                                        className={`rounded-xl px-3 py-2 text-xs ${
                                            diag.severity === 'error'
                                                ? 'bg-[var(--admin-danger-bg)] text-[var(--admin-danger-text)]'
                                                : diag.severity === 'warning'
                                                    ? 'bg-[var(--admin-warning-bg)] text-[var(--admin-warning-text)]'
                                                    : 'bg-[var(--admin-surface)] text-[var(--admin-text-secondary)]'
                                        }`}
                                    >
                                        <span className="font-mono font-semibold">{diag.code}</span>
                                        <span className="ml-2">{diag.message}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                        {(!validation.diagnostics || validation.diagnostics.length === 0) && validation.manifestValid && (
                            <p className="text-xs text-[var(--admin-text-muted)]">No diagnostic issues found.</p>
                        )}
                    </DetailSection>
                )}

                {/* Health */}
                {health && health.errorCount > 0 && (
                    <DetailSection title="Health">
                        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
                            <DetailRow label="Error Count" value={health.errorCount.toString()} />
                            <DetailRow label="Last Error At" value={formatTimestamp(health.lastErrorAt)} />
                        </div>
                        {health.lastError && (
                            <div className="mt-2 rounded-xl bg-[var(--admin-danger-bg)] px-3 py-2 text-xs text-[var(--admin-danger-text)] font-mono">
                                {health.lastError}
                            </div>
                        )}
                    </DetailSection>
                )}

                {/* No managed details available */}
                {!validation && !artifact && !health && !reason && (
                    <p className="text-sm text-[var(--admin-text-muted)] italic">No additional details available.</p>
                )}

                {/* Manager Operations */}
                <ManagerActionBar
                    module={module}
                    cardSource={cardSource}
                    onOperationComplete={onOperationComplete}
                    onSessionExpired={onSessionExpired}
                />
            </div>
            )}
        </div>
    );
}

// ─── Sub-components ────────────────────────────────────────────────

/** Section wrapper with a heading label. */
function DetailSection({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
    return (
        <div>
            <div className="flex justify-between items-center mb-2">
                <h4 className="text-xs font-bold uppercase tracking-wider text-[var(--admin-text-muted)]">{title}</h4>
                {action && <div>{action}</div>}
            </div>
            {children}
        </div>
    );
}

function ReverifyButton({ verifying, onClick }: { verifying: boolean; onClick: () => void }) {
    return (
        <button
            onClick={onClick}
            disabled={verifying}
            className="rounded px-2 py-1 text-xs font-medium text-[var(--admin-text-secondary)] border border-[var(--admin-border)] hover:bg-[var(--admin-surface-hover)] transition disabled:opacity-50"
        >
            {verifying ? 'Verifying...' : 'Re-verify'}
        </button>
    );
}

/** Key-value row for structured data display. */
function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
    return (
        <>
            <span className="text-[var(--admin-text-muted)]">{label}</span>
            <span className={`text-[var(--admin-text-primary)] ${mono ? 'font-mono text-xs break-all' : ''}`}>{value}</span>
        </>
    );
}
