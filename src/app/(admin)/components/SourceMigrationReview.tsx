'use client';

import { useState } from 'react';
import { adminFetch, type CatalogDryRunResult } from '../lib/adminApi';
import { useAdminRuntimeRestart } from '../context/AdminRuntimeRestartContext';
import Button from './ui/Button';
import MigrationPlanDetails from './MigrationPlanDetails';

type Preview = NonNullable<CatalogDryRunResult['migration']> & { plan: { blockers: string[] } };
/** Same-version repair and source selection use the same Core-owned approval, not a module tool. */
export default function SourceMigrationReview({ moduleId, source, onSessionExpired }: {
    moduleId: string; source: 'local' | 'managed'; onSessionExpired: () => void;
}) {
    const [preview, setPreview] = useState<Preview | null>(null);
    const [acknowledged, setAcknowledged] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const { beginRuntimeRestart } = useAdminRuntimeRestart();
    const inspect = async () => {
        setBusy(true); setError(null); setPreview(null); setAcknowledged(null);
        const result = await adminFetch<Preview>(`/module-upgrades/source/${encodeURIComponent(moduleId)}/preview`, {
            method: 'POST', body: JSON.stringify({ source }),
        });
        if (result.sessionExpired) onSessionExpired();
        else if (result.ok) setPreview(result.data);
        else setError(result.error ?? 'Source world checks unavailable');
        setBusy(false);
    };
    const apply = async () => {
        if (!preview || acknowledged !== preview.id || preview.plan.blockers.length) return;
        if (preview.expiresAt <= Date.now()) { setPreview(null); setAcknowledged(null); setError('Preview expired. Run world checks again.'); return; }
        setBusy(true);
        const result = await adminFetch<{ restartScheduled: boolean }>('/module-upgrades/source/apply', {
            method: 'POST', body: JSON.stringify({ planId: preview.id, backupAcknowledged: true }),
        });
        if (result.sessionExpired) onSessionExpired();
        else if (!result.ok) setError(result.error ?? 'Approval changed; run checks again');
        else if (result.data?.restartScheduled) beginRuntimeRestart();
        setBusy(false);
    };
    return <details className="rounded-lg border border-[var(--admin-border)] p-3 text-sm">
        <summary>World data checks / same-version repair ({source})</summary>
        <p className="my-2 text-[var(--admin-text-secondary)]">For migration-bearing sources only. Checks do not initialize the candidate or write Foundry data.</p>
        <Button disabled={busy} onClick={() => void inspect()}>Preview world maintenance</Button>
        {error && <p role="alert" className="mt-2 text-[var(--admin-warning-text)]">{error}</p>}
        {preview && <div className="mt-3 space-y-2">
            <MigrationPlanDetails preview={preview} />
            {preview.plan.blockers.map((reason, index) => <p key={index} role="alert">{reason}</p>)}
            <p>SheetDelver cannot back up or restore the world or undo migration writes. Interrupted changes may be partly applied. Back up through Foundry before continuing; external restore may lose later changes.</p>
            <label className="flex items-start gap-2"><input type="checkbox" checked={acknowledged === preview.id}
                onChange={event => setAcknowledged(event.target.checked ? preview.id : null)} />I acknowledge the backup and recovery limits for this exact plan.</label>
            <Button disabled={busy || acknowledged !== preview.id || preview.plan.blockers.length > 0} onClick={() => void apply()}>Approve maintenance and restart</Button>
        </div>}
    </details>;
}
