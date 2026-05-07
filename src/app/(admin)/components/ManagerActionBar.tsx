'use client';

/**
 * ManagerActionBar
 *
 * Contextual action buttons for module manager operations (install, uninstall,
 * upgrade, validate). Shows available actions based on current lifecycle status,
 * with confirmation dialogs and optional dry-run previews before execution.
 */

import React, { useState } from 'react';
import { logger } from '@shared/utils/logger';
import {
    postManagerAction,
    postDryRun,
    type ModuleLifecycleInfo,
    type DryRunPreviewResult,
} from '../lib/adminApi';
import DryRunPreview from './DryRunPreview';

interface ManagerActionBarProps {
    module: ModuleLifecycleInfo;
    /** Which source this bar belongs to (set by the split-card layout). */
    cardSource?: 'local' | 'data';
    /** Callback after a successful operation — parent should refresh module list. */
    onOperationComplete: () => void;
    /** Callback when session expires — parent should redirect to login. */
    onSessionExpired: () => void;
    /** Called after install / upgrade / uninstall — signals a restart is needed. */
    onRestartRequired?: (operation?: string) => void;
}

/** Determines which manager actions are available based on lifecycle status and card context. */
function getAvailableActions(
    status: string,
    managed: boolean,
    activeSource?: string,
    localDirectory?: string,
    cardSource?: string,
): Array<'install' | 'uninstall' | 'upgrade' | 'validate'> {
    // Manager operations only apply to managed installs (data/modules/).
    if (!managed) return [];

    // In the split-card layout, cardSource tells us exactly which card we're on.
    // 'data' card always shows managed operations regardless of activeSource.
    // 'local' card never shows them (ModuleDetailPanel already hides this bar for local cards).
    // When no cardSource (legacy single-card), fall back to the activeSource heuristic.
    if (cardSource === 'data') {
        // Explicit managed card — always show operations.
    } else if (!cardSource && localDirectory && activeSource === 'local') {
        // Single-card mode: local dev is active, hide managed operations.
        return [];
    }

    switch (status) {
        case 'discovered':
            return ['install'];
        case 'validated':
        case 'enabled':
            return ['upgrade', 'validate', 'uninstall'];
        case 'disabled':
            return ['upgrade', 'validate', 'uninstall'];
        case 'errored':
        case 'incompatible':
            return ['validate', 'uninstall'];
        case 'installed':
            return ['validate', 'uninstall'];
        default:
            return [];
    }
}

/** Maps action names to display labels. */
const ACTION_LABELS: Record<string, string> = {
    install: 'Install',
    uninstall: 'Uninstall',
    upgrade: 'Upgrade',
    validate: 'Re-validate',
};

/** Maps action names to button styling. */
const ACTION_STYLES: Record<string, string> = {
    install: 'bg-[var(--admin-accent)] text-white hover:bg-[var(--admin-accent-strong)]',
    uninstall: 'bg-[var(--admin-danger-button)] text-white hover:bg-[var(--admin-danger-button-strong)]',
    upgrade: 'bg-[var(--admin-accent)] text-white hover:bg-[var(--admin-accent-strong)]',
    validate: 'border border-[var(--admin-border)] bg-[var(--admin-surface)] text-[var(--admin-text-primary)] hover:bg-[var(--admin-surface-hover)]',
};

export default function ManagerActionBar({ module, cardSource, onOperationComplete, onSessionExpired, onRestartRequired }: ManagerActionBarProps) {
    const [confirmAction, setConfirmAction] = useState<string | null>(null);
    const [dryRunResult, setDryRunResult] = useState<DryRunPreviewResult | null>(null);
    const [dryRunLoading, setDryRunLoading] = useState(false);
    const [executing, setExecuting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [escalationApproved, setEscalationApproved] = useState(false);

    const actions = getAvailableActions(module.status, module.managed, module.activeSource, module.localDirectory, cardSource);

    if (actions.length === 0) return null;

    /** Handles clicking an action button — opens confirmation. */
    const handleActionClick = (action: string) => {
        setConfirmAction(action);
        setDryRunResult(null);
        setError(null);
        setEscalationApproved(false);
    };

    /** Runs a dry-run preview for install/upgrade. */
    const handleDryRun = async () => {
        if (confirmAction !== 'install' && confirmAction !== 'upgrade') return;

        try {
            setDryRunLoading(true);
            setError(null);

            const result = await postDryRun(module.moduleId, confirmAction as 'install' | 'upgrade');

            if (result.sessionExpired) {
                onSessionExpired();
                return;
            }

            if (!result.ok || !result.data) {
                throw new Error(result.error || 'Dry-run failed');
            }

            setDryRunResult(result.data);
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Unknown error';
            setError(message);
        } finally {
            setDryRunLoading(false);
        }
    };

    /** Executes the confirmed manager operation. */
    const handleConfirm = async () => {
        if (!confirmAction) return;

        try {
            setExecuting(true);
            setError(null);

            const body: Record<string, unknown> = {};

            // For upgrade, include escalation approval if the dry-run requested it
            if (confirmAction === 'upgrade' && escalationApproved) {
                body.approvePermissionEscalation = true;
            }

            const result = await postManagerAction(
                module.moduleId,
                confirmAction as 'install' | 'uninstall' | 'upgrade' | 'validate',
                body
            );

            if (result.sessionExpired) {
                onSessionExpired();
                return;
            }

            if (!result.ok) {
                throw new Error(result.error || `Failed to ${confirmAction} module`);
            }

            logger.info(`Module ${module.moduleId} ${confirmAction} completed successfully`);
            setConfirmAction(null);
            setDryRunResult(null);
            onOperationComplete();
            // install / upgrade / uninstall all change code on disk — a Core
            // Service restart is required for the new adapter to be loaded.
            if (confirmAction !== 'validate') {
                onRestartRequired?.(confirmAction);
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Unknown error';
            logger.error(`Failed to ${confirmAction} module:`, err);
            setError(message);
        } finally {
            setExecuting(false);
        }
    };

    /** Closes the confirmation dialog. */
    const handleCancel = () => {
        setConfirmAction(null);
        setDryRunResult(null);
        setError(null);
        setEscalationApproved(false);
    };

    return (
        <div className="mt-3 border-t border-[var(--admin-border)] pt-3">
            <h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-[var(--admin-text-muted)]">
                Manager Operations
            </h4>

            {/* Action buttons */}
            {!confirmAction && (
                <div className="flex flex-wrap gap-2">
                    {actions.map(action => (
                        <button
                            key={action}
                            onClick={() => handleActionClick(action)}
                            className={`rounded-xl px-3 py-1.5 text-sm font-semibold transition ${ACTION_STYLES[action]}`}
                        >
                            {ACTION_LABELS[action]}
                        </button>
                    ))}
                </div>
            )}

            {/* Confirmation dialog */}
            {confirmAction && (
                <div className="rounded-xl border border-[var(--admin-border-strong)] bg-[var(--admin-surface-strong)] p-4 space-y-3">
                    <div className="flex items-center justify-between">
                        <h5 className="font-semibold text-[var(--admin-text-primary)]">
                            {ACTION_LABELS[confirmAction]} — {module.title}
                        </h5>
                        <span className="text-xs text-[var(--admin-text-muted)]">
                            Current: {module.status}
                        </span>
                    </div>

                    {/* Error display */}
                    {error && (
                        <div className="rounded-xl border border-[var(--admin-danger-border)] bg-[var(--admin-danger-bg)] p-3 text-sm text-[var(--admin-danger-text)]">
                            {error}
                        </div>
                    )}

                    {/* Dry-run preview (for install/upgrade only) */}
                    {(confirmAction === 'install' || confirmAction === 'upgrade') && (
                        <>
                            {!dryRunResult && (
                                <button
                                    onClick={handleDryRun}
                                    disabled={dryRunLoading}
                                    className="rounded-xl border border-[var(--admin-border)] bg-[var(--admin-surface)] px-3 py-1.5 text-sm text-[var(--admin-text-secondary)] transition hover:bg-[var(--admin-surface-hover)] disabled:opacity-50"
                                >
                                    {dryRunLoading ? 'Analyzing...' : '🔍 Preview Impact'}
                                </button>
                            )}
                            {dryRunResult && (
                                <DryRunPreview
                                    preview={dryRunResult}
                                    onApproveEscalation={setEscalationApproved}
                                    escalationApproved={escalationApproved}
                                />
                            )}
                        </>
                    )}

                    {/* Action buttons */}
                    <div className="flex items-center gap-2 pt-1">
                        <button
                            onClick={handleConfirm}
                            disabled={executing || !!(dryRunResult && !dryRunResult.allowed && !escalationApproved)}
                            className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${
                                confirmAction === 'uninstall'
                                    ? 'bg-[var(--admin-danger-button)] text-white hover:bg-[var(--admin-danger-button-strong)]'
                                    : 'bg-[var(--admin-accent)] text-white hover:bg-[var(--admin-accent-strong)]'
                            } disabled:opacity-50`}
                        >
                            {executing ? 'Processing...' : `Confirm ${ACTION_LABELS[confirmAction]}`}
                        </button>
                        <button
                            onClick={handleCancel}
                            disabled={executing}
                            className="rounded-xl border border-[var(--admin-border)] bg-[var(--admin-surface)] px-4 py-2 text-sm text-[var(--admin-text-secondary)] transition hover:bg-[var(--admin-surface-hover)] disabled:opacity-50"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
