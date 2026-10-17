'use client';

import Link from 'next/link';
import type { AdminMigrationStatus } from '@shared/types/adminMigration';
import { useAdminMigration } from '../context/AdminMigrationContext';
import Button from './ui/Button';

const linkClass = 'inline-flex max-w-full rounded-md border border-[var(--admin-border-strong)] bg-[var(--admin-surface)] px-3 py-2 text-sm font-semibold text-[var(--admin-text-primary)] underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--admin-accent)]';
const attentionStates = ['required', 'blocked', 'in-progress', 'recovery-required'];

export function MigrationSourceStatus({ status, onReview, showAction = true, collapsible = true }: { status: AdminMigrationStatus; onReview?: () => void; showAction?: boolean; collapsible?: boolean }) {
    const attention = attentionStates.includes(status.state);
    const style = attention ? 'border-[var(--admin-warning-border)] bg-[var(--admin-warning-bg)]' : 'border-[var(--admin-border)] bg-[var(--admin-surface)]';
    const body = <>
        <p className="break-words text-[var(--admin-text-secondary)]">{status.title} · {status.source ?? 'Source not yet identified'}{status.version ? ` v${status.version}` : ''} · World: {status.world?.title ?? 'not identified'}{status.world && status.world.title !== status.world.worldId ? ` (${status.world.worldId})` : ''}</p>
        {status.action.kind !== 'maintenance' && <p className="font-medium">{status.selectedSource ? status.activeWorld ? 'Selected source for this world' : 'Selected source · not the current world' : `Inactive ${status.source ?? ''} source — inspection does not switch sources`}</p>}
        <p className="break-words">{status.reason}</p>
        {status.proposedWrites !== undefined && <p>{status.proposedWrites} proposed writes{status.checked !== undefined ? ` · ${status.checked} checked` : ''}</p>}
        {status.checkedAt && <p className="text-xs text-[var(--admin-text-muted)]">Last verified <time dateTime={new Date(status.checkedAt).toISOString()}>{new Date(status.checkedAt).toLocaleString()}</time>; tied to the observed world and source revisions.</p>}
        {showAction && status.action.href && (onReview ? <Button size="sm" onClick={onReview}>{status.action.label}</Button>
            : status.action.kind === 'maintenance' ? <a className={linkClass} href={status.action.href}>{status.action.label}</a>
                : <Link className={linkClass} prefetch={false} href={status.action.href}>{status.action.label}</Link>)}
    </>;
    if (!collapsible) return <div className={`min-w-0 space-y-2 rounded-lg border p-3 text-sm ${style}`} data-migration-state={status.state}>
        <p className="break-words font-semibold">{status.label}</p>{body}</div>;
    // A native disclosure preserves user toggles on stable polls; new scope or
    // status resets the default, without persisting private state in storage.
    return <details key={`${status.scopeKey}:${status.state}`} open={attention} data-migration-state={status.state}
        className={`min-w-0 rounded-lg border p-3 text-sm ${style}`}>
        <summary className="cursor-pointer break-words rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--admin-accent)]">
            <span className="font-semibold">{status.label}</span><span className="text-[var(--admin-text-secondary)]"> · {status.source ?? 'Source unknown'}{status.version ? ` v${status.version}` : ''} · {status.world?.title ?? 'World unknown'}</span>
        </summary><div className="mt-2 space-y-2">{body}</div>
    </details>;
}
export default function MigrationAttentionNotice() {
    const { data } = useAdminMigration(); const status = data?.maintenance ?? data?.active;
    if (!status || !attentionStates.includes(status.state)) return null;
    return <section aria-label="Migration attention" aria-live="polite" data-migration-notice={status.state}
        className="mb-5 flex min-w-0 flex-col items-start justify-between gap-3 rounded-lg border border-[var(--admin-warning-border)] bg-[var(--admin-warning-bg)] px-4 py-3 text-sm sm:flex-row sm:items-center">
        <p className="min-w-0 w-full flex-1 break-words sm:w-auto"><strong>{status.label}</strong> · {status.title} · {status.source ?? 'Source not yet identified'}{status.version ? ` v${status.version}` : ''} · World: {status.world?.title ?? 'not identified'}{status.world && status.world.title !== status.world.worldId ? ` (${status.world.worldId})` : ''}</p>
        {status.action.href && (status.action.kind === 'maintenance' ? <a className={linkClass} href={status.action.href}>{status.action.label}</a>
            : <Link className={linkClass} prefetch={false} href={status.action.href}>{status.action.label}</Link>)}
    </section>;
}
/** Full readiness/error/checking detail belongs on Installed, not global chrome. */
export function InstalledMigrationStatus() {
    const { data, error, loading, refresh } = useAdminMigration(); const status = data?.maintenance ?? data?.active;
    const attention = !!status && attentionStates.includes(status.state);
    return <section aria-label="Current world migration status" aria-live="polite" data-installed-migration-state={error ? 'unavailable' : status?.state ?? 'unknown'} className="admin-panel mb-5 rounded-xl p-4">
        <details key={`${status?.scopeKey ?? 'unavailable'}:${error ? 'unavailable' : status?.state ?? 'unknown'}`} open={attention}>
        <summary className="cursor-pointer break-words rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--admin-accent)]"><span className="font-semibold">World migration status</span>
            <span className="text-sm text-[var(--admin-text-secondary)]"> · {error ? 'Status unavailable' : status?.label ?? (loading || !data ? 'Retrieving status…' : 'No active source')}</span></summary>
        <div className="mt-3 space-y-3"><div className="flex justify-end"><Button size="sm" disabled={loading} onClick={() => void refresh()}>Refresh migration status</Button></div>
        {error ? <p role="alert" className="break-words text-sm text-[var(--admin-warning-text)]">{error}</p> : status ? <MigrationSourceStatus status={status} collapsible={false} />
            : <p className="text-sm text-[var(--admin-text-secondary)]">{loading || !data ? 'Retrieving authoritative migration status…' : 'No active world/module source identified. Start the intended world to check its data; history does not establish readiness.'}</p>}
        <Link className="inline-block text-sm underline" prefetch={false} href="/admin/audit#module-upgrade-history">View migration job history in Audit</Link>
        </div></details>
    </section>;
}
