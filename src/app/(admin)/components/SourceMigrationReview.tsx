'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { adminFetch, type CatalogDryRunResult } from '../lib/adminApi';
import { useAdminRuntimeRestart } from '../context/AdminRuntimeRestartContext';
import { useAdminMigration } from '../context/AdminMigrationContext';
import type { AdminMigrationStatus } from '@shared/types/adminMigration';
import Button from './ui/Button';
import MigrationPlanDetails from './MigrationPlanDetails';
import { MigrationSourceStatus } from './MigrationAttentionNotice';

type Preview = NonNullable<CatalogDryRunResult['migration']> & { plan: { blockers: string[] } };
/** Inspection is read-only. Exact Core source/world evidence retires stale dialogs. */
export default function SourceMigrationReview({ moduleId, source, expectedScope, status: suppliedStatus, onSessionExpired }: {
    moduleId: string; source: 'local' | 'managed'; expectedScope?: string; status?: AdminMigrationStatus; onSessionExpired: () => void;
}) {
    const { data, refresh } = useAdminMigration();
    const status = suppliedStatus ?? data?.sources.find(row => row.moduleId === moduleId && row.source === source);
    const [preview, setPreview] = useState<Preview | null>(null); const [loadedScope, setLoadedScope] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
    const sequence = useRef(0); const { beginRuntimeRestart } = useAdminRuntimeRestart();
    const retire = useCallback(() => { ++sequence.current; }, []);
    const staleLink = !!expectedScope && !!status && expectedScope !== status.scopeKey;
    const scope = status?.scopeKey;
    const base = `/module-upgrades/source/${encodeURIComponent(moduleId)}`;
    useEffect(() => { ++sequence.current; setPreview(null); setLoadedScope(null); setBusy(false); setError(null);
        return retire; }, [moduleId, source, scope, expectedScope, retire]);
    const inspect = async (cached = false) => {
        if (!scope || staleLink) return;
        const id = ++sequence.current; setBusy(true); setError(null); setPreview(null);
        const result = cached ? await adminFetch<Preview>(`${base}/review?${new URLSearchParams({ source, scopeKey: scope })}`)
            : await adminFetch<Preview>(`${base}/preview`, { method: 'POST', body: JSON.stringify({ source, scopeKey: scope }) });
        if (sequence.current !== id) return;
        if (result.sessionExpired) onSessionExpired();
        else if (result.ok && result.data) { setPreview(result.data); setLoadedScope(scope); }
        else setError(result.error ?? 'Source world checks unavailable');
        setBusy(false); void refresh();
    };
    const apply = async () => {
        if (!preview || !loadedScope || staleLink) return;
        if (preview.expiresAt <= Date.now()) { setPreview(null); setError('Review expired. Check world data again.'); return; }
        const id = ++sequence.current; setBusy(true);
        const current = await refresh(); if (sequence.current !== id) return;
        const selected = current?.sources.find(row => row.moduleId === moduleId && row.source === source);
        if (!selected || selected.scopeKey !== loadedScope) { setPreview(null); setBusy(false); setError('Source or world changed. Reopen its current review.'); return; }
        const result = await adminFetch<{ accepted: boolean }>('/module-maintenance/enter', { method: 'POST', body: JSON.stringify({ planId: preview.id }) });
        if (sequence.current !== id) return;
        if (result.sessionExpired) onSessionExpired();
        else if (!result.ok) setError(result.error ?? 'Review changed; run checks again');
        else if (result.data?.accepted) beginRuntimeRestart();
        setBusy(false);
    };
    return <section aria-label="Source migration review" className="space-y-3 rounded-lg border border-[var(--admin-border)] p-3 text-sm">
        <h3 className="font-semibold">World data review · {source}</h3>
        {status ? <MigrationSourceStatus status={status} showAction={false} collapsible={false} /> : <p>Retrieving this exact source/world status…</p>}
        <p>Checks do not initialize the candidate, switch sources or write Foundry data.</p>
        {staleLink && <p role="alert">This review link names an older source/world revision. No alternative was selected. {status?.action.href && <Link className="underline" prefetch={false} href={status.action.href}>Open the current source review</Link>}</p>}
        <div className="flex flex-wrap gap-2"><Button disabled={busy || !scope || staleLink || !status?.action.href} onClick={() => void inspect()}>Check world data</Button>
            {status?.previewId && <Button disabled={busy || staleLink} onClick={() => void inspect(true)}>Review migration plan</Button>}</div>
        {error && <p role="alert" className="break-words text-[var(--admin-warning-text)]">{error}</p>}
        {preview && <div className="space-y-2">
            <MigrationPlanDetails preview={preview} />
            {preview.plan.blockers.map((reason, index) => <p key={index} role="alert">{reason}</p>)}
            <p>SheetDelver cannot back up or restore the world or undo migration writes. Interrupted changes may be partial. Back up through Foundry before continuing.</p>
            <p>This is advisory. Entering maintenance stops normal services but authorizes no writes. Review and approve the authoritative plan after isolation.</p>
            {!status?.selectedSource && <p className="font-semibold">This is an inactive {source} source. Inspecting it has not changed the selected source.</p>}
            <Button disabled={busy || staleLink || loadedScope !== scope} onClick={() => void apply()}>Enter maintenance</Button>
        </div>}
    </section>;
}
