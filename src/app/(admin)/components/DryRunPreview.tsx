'use client';

/**
 * DryRunPreview
 *
 * Displays a structured preview of a dry-run install/upgrade impact analysis.
 * Shows trust policy, permission analysis, compatibility, and dependency results
 * with color-coded outcomes (green/safe, yellow/approval needed, red/blocked).
 */

import React from 'react';
import type { DryRunPreviewResult } from '../lib/adminApi';

interface DryRunPreviewProps {
    preview: DryRunPreviewResult;
    /** Callback when the admin approves permission escalation. */
    onApproveEscalation?: (approved: boolean) => void;
    /** Whether permission escalation has been approved. */
    escalationApproved?: boolean;
}

export default function DryRunPreview({ preview, onApproveEscalation, escalationApproved }: DryRunPreviewProps) {
    const isBlocked = !preview.allowed;

    return (
        <div className="space-y-3">
            {/* Overall result banner */}
            <div
                className={`rounded-xl px-4 py-3 text-sm font-semibold ${
                    isBlocked
                        ? 'bg-[var(--admin-danger-bg)] text-[var(--admin-danger-text)] border border-[var(--admin-danger-border)]'
                        : preview.permissions?.escalationRequired
                            ? 'bg-[var(--admin-warning-bg)] text-[var(--admin-warning-text)] border border-[var(--admin-warning-border)]'
                            : 'bg-[var(--admin-success-bg)] text-[var(--admin-success)] border border-[var(--admin-success-border)]'
                }`}
            >
                {isBlocked
                    ? '⛔ Operation blocked by policy'
                    : preview.permissions?.escalationRequired
                        ? '⚠️ Requires permission escalation approval'
                        : '✓ Operation is safe to proceed'}
            </div>

            {/* Trust Policy */}
            {preview.trustPolicy && (
                <PreviewSection title="Trust Policy">
                    <div className="flex items-center gap-2 text-sm">
                        <StatusDot ok={preview.trustPolicy.allowed} />
                        <span className="text-[var(--admin-text-secondary)]">
                            Tier: <span className="font-semibold text-[var(--admin-text-primary)]">{preview.trustPolicy.tier}</span>
                            {' — '}
                            {preview.trustPolicy.allowed ? 'Allowed' : 'Blocked'}
                        </span>
                    </div>
                    {preview.trustPolicy.reason && (
                        <p className="mt-1 text-xs text-[var(--admin-text-muted)]">{preview.trustPolicy.reason}</p>
                    )}
                </PreviewSection>
            )}

            {/* Permissions */}
            {preview.permissions && (
                <PreviewSection title="Permissions">
                    <div className="flex items-center gap-2 text-sm">
                        <StatusDot ok={!preview.permissions.escalationRequired} warn={preview.permissions.escalationRequired} />
                        <span className="text-[var(--admin-text-secondary)]">
                            {preview.permissions.escalationRequired
                                ? 'Permission escalation required'
                                : 'No permission changes needed'}
                        </span>
                    </div>
                    {preview.permissions.escalationRequired && onApproveEscalation && (
                        <label className="mt-2 flex items-center gap-2 text-sm cursor-pointer">
                            <input
                                type="checkbox"
                                checked={escalationApproved || false}
                                onChange={(e) => onApproveEscalation(e.target.checked)}
                                className="rounded border-[var(--admin-border)]"
                            />
                            <span className="text-[var(--admin-text-primary)]">
                                I approve the permission escalation
                            </span>
                        </label>
                    )}
                </PreviewSection>
            )}

            {/* Compatibility */}
            {preview.compatibility && (
                <PreviewSection title="Compatibility">
                    <div className="flex items-center gap-2 text-sm">
                        <StatusDot ok={preview.compatibility.compatible} />
                        <span className="text-[var(--admin-text-secondary)]">
                            {preview.compatibility.compatible ? 'Compatible' : 'Incompatible'}
                        </span>
                    </div>
                    {preview.compatibility.diagnostics && preview.compatibility.diagnostics.length > 0 && (
                        <div className="mt-2 space-y-1">
                            {preview.compatibility.diagnostics.map((diag, i) => (
                                <div
                                    key={`compat-${i}`}
                                    className={`rounded-lg px-3 py-1.5 text-xs ${
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
                </PreviewSection>
            )}

            {/* Dependencies */}
            {preview.dependencies && (
                <PreviewSection title="Dependencies">
                    <div className="flex items-center gap-2 text-sm">
                        <StatusDot ok={preview.dependencies.satisfied} />
                        <span className="text-[var(--admin-text-secondary)]">
                            {preview.dependencies.satisfied ? 'All dependencies satisfied' : 'Missing dependencies'}
                        </span>
                    </div>
                    {preview.dependencies.missing && preview.dependencies.missing.length > 0 && (
                        <div className="mt-1 text-xs text-[var(--admin-danger-text)]">
                            Missing: {preview.dependencies.missing.join(', ')}
                        </div>
                    )}
                    {preview.dependencies.conflicts && preview.dependencies.conflicts.length > 0 && (
                        <div className="mt-1 text-xs text-[var(--admin-warning-text)]">
                            Conflicts: {preview.dependencies.conflicts.join(', ')}
                        </div>
                    )}
                </PreviewSection>
            )}
        </div>
    );
}

// ─── Sub-components ────────────────────────────────────────────────

/** Section wrapper for dry-run result categories. */
function PreviewSection({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div className="rounded-xl border border-[var(--admin-border)] bg-[var(--admin-surface)] p-3">
            <h5 className="mb-2 text-xs font-bold uppercase tracking-wider text-[var(--admin-text-muted)]">{title}</h5>
            {children}
        </div>
    );
}

/** Small colored dot indicating status (green/yellow/red). */
function StatusDot({ ok, warn }: { ok: boolean; warn?: boolean }) {
    const color = ok
        ? 'bg-[var(--admin-success)]'
        : warn
            ? 'bg-amber-400'
            : 'bg-[var(--admin-danger-button)]';
    return <span className={`inline-block h-2 w-2 rounded-full ${color}`} />;
}
