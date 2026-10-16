'use client';

import { useCallback, useEffect, useState } from 'react';
import { adminFetch } from '../lib/adminApi';
import { useAdminAuth } from '../context/AdminAuthContext';
import Drawer from './ui/Drawer';
import Button from './ui/Button';

interface Job {
    jobId: string; moduleId: string; phase: string; possibleWrite: boolean; candidateVersion: string; failure?: string;
    outcomes: Record<string, { state: string }>;
    retainedFiles?: string;
    installedVersion?: string; servingVersion?: string; worldDataStatus?: string;
}
interface Diagnostic { account: string; observedRole: number | null; requiredRole: number; remediation: string }

/** Admin-only progress survives a new browser/session; the server journal is authoritative. */
export default function ModuleUpgradeStatus() {
    const { logout } = useAdminAuth();
    const [jobs, setJobs] = useState<Job[]>([]);
    const [diagnostic, setDiagnostic] = useState<Diagnostic | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [cancel, setCancel] = useState<Job | null>(null);
    const [review, setReview] = useState<{ job: Job; id: string; plan: { operations: unknown[]; blockers: string[]; checked: number } } | null>(null);
    const [acknowledged, setAcknowledged] = useState(false);
    const [compatibility, setCompatibility] = useState<{ moduleId: string; blockers: string[] } | null>(null);
    const load = useCallback(async () => {
        const result = await adminFetch<{ jobs: Job[]; serviceAccountDiagnostic: Diagnostic | null; compatibilityDiagnostic: typeof compatibility }>('/module-upgrades');
        if (result.sessionExpired) { logout(); return; }
        if (!result.ok || !result.data) { setError(result.error ?? 'Upgrade status unavailable'); return; }
        setJobs(result.data.jobs); setDiagnostic(result.data.serviceAccountDiagnostic); setError(null);
        setCompatibility(result.data.compatibilityDiagnostic);
    }, [logout]);
    useEffect(() => { void load(); }, [load]);
    const running = jobs.some(job => !['completed', 'cancelled', 'recovery-required'].includes(job.phase));
    useEffect(() => {
        if (!running) return;
        let checks = 0;
        const timer = setInterval(() => { if (++checks <= 60) void load(); else clearInterval(timer); }, 5000);
        return () => clearInterval(timer);
    }, [running, load]);
    const action = async (job: Job, action: 'resume' | 'cancel' | 'cleanup') => {
        setBusy(true);
        const result = await adminFetch(`/module-upgrades/${encodeURIComponent(job.jobId)}/${action}`, { method: 'POST', body: '{}' });
        if (result.sessionExpired) logout();
        else if (!result.ok) setError(result.error ?? 'Recovery action failed');
        else await load();
        setBusy(false);
    };
    const freshReview = async (job: Job) => {
        setBusy(true); setAcknowledged(false);
        const result = await adminFetch<{ id: string; plan: { operations: unknown[]; blockers: string[]; checked: number } }>(`/module-upgrades/${encodeURIComponent(job.jobId)}/review`, { method: 'POST', body: '{}' });
        if (result.ok && result.data) setReview({ job, ...result.data });
        else setError(result.error ?? 'Fresh review unavailable');
        setBusy(false);
    };
    const approveReview = async () => {
        if (!review || !acknowledged) return;
        setBusy(true);
        const result = await adminFetch(`/module-upgrades/${encodeURIComponent(review.job.jobId)}/reapprove`, { method: 'POST', body: JSON.stringify({ planId: review.id, backupAcknowledged: true }) });
        if (result.ok) { setReview(null); await load(); } else setError(result.error ?? 'Recovery approval failed');
        setBusy(false);
    };
    return <section className="admin-panel my-4 space-y-3 rounded-xl p-4" aria-label="Module upgrade status">
        <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold">World maintenance</h2>
            <Button onClick={() => void load()} disabled={busy}>Refresh status</Button></div>
        {diagnostic && <div role="alert" className="break-words text-sm text-[var(--admin-warning-text)]">
            <p>Service account: {diagnostic.account}; observed role: {diagnostic.observedRole ?? 'unknown'}; required: Gamemaster ({diagnostic.requiredRole}).</p>
            <p>{diagnostic.remediation}</p>
        </div>}
        {error && <p role="alert" className="text-sm text-[var(--admin-danger-text)]">{error}</p>}
        {compatibility && <div role="alert" className="break-words text-sm"><p>{compatibility.moduleId}: source maintenance required.</p><ul>{compatibility.blockers.map((reason, i) => <li key={i}>{reason}</li>)}</ul></div>}
        {!jobs.length && <p className="text-sm text-[var(--admin-text-muted)]">No recorded module upgrade jobs.</p>}
        {jobs.map(job => <div key={job.jobId} className="rounded-lg border border-[var(--admin-border)] p-3 text-sm">
            <p className="break-words font-semibold">{job.moduleId} {job.candidateVersion}: {job.phase}</p>
            <p>Installed candidate: {job.installedVersion ?? 'not promoted'}; activated by this job: {job.servingVersion ?? 'not activated'}; world data: {job.worldDataStatus ?? 'unverified'}.</p>
            <p>{Object.values(job.outcomes).filter(row => row.state === 'confirmed').length} confirmed target writes.</p>
            {job.failure && <p className="break-words text-[var(--admin-warning-text)]">{job.failure}</p>}
            {job.phase === 'recovery-required' && <div className="mt-2 flex flex-wrap gap-2">
                <Button disabled={busy} onClick={() => void action(job, 'resume')}>Reconcile and resume</Button>
                <Button disabled={busy} onClick={() => void freshReview(job)}>Review changed source</Button>
                <Button disabled={busy} onClick={() => setCancel(job)}>{job.possibleWrite ? 'Stop further writes' : 'Cancel before writes'}</Button>
            </div>}
            {job.phase === 'completed' && job.retainedFiles !== 'cleaned' && <Button disabled={busy} onClick={() => void action(job, 'cleanup')}>Clean retained package files</Button>}
        </div>)}
        <Drawer open={Boolean(cancel)} title="Stop module upgrade?" onClose={() => setCancel(null)}>
            <p>{cancel?.possibleWrite
                ? 'Stop scheduling further writes. SheetDelver cannot undo changes already sent; the world will remain in maintenance.'
                : 'Cancel before world writes. Only verified retained-package recovery may reopen access.'}</p>
            <div className="mt-4 flex gap-2"><Button onClick={() => setCancel(null)}>Keep running</Button>
                <Button variant="danger" onClick={() => { if (!cancel) return; const job = cancel; setCancel(null); void action(job, 'cancel'); }}>Confirm stop</Button></div>
        </Drawer>
        <Drawer open={Boolean(review)} title="Fresh recovery approval" onClose={() => { if (!busy) setReview(null); }}>
            <p>This replaces the stopped plan, not its historical write ledger. {review?.plan.checked} checked; {review?.plan.operations.length} proposed writes.</p>
            {review?.plan.blockers.map((reason, i) => <p key={i} role="alert">{reason}</p>)}
            <p>SheetDelver cannot back up or restore your Foundry world. Changes cannot be undone here and may be partly applied. Back up the world with Foundry before continuing.</p>
            <label className="my-3 flex gap-2"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />I acknowledge these backup and recovery limits for this plan.</label>
            <Button disabled={busy || !acknowledged || Boolean(review?.plan.blockers.length)} onClick={() => void approveReview()}>Approve revised plan</Button>
        </Drawer>
    </section>;
}
