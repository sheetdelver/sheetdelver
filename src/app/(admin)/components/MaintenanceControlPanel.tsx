'use client';

import { useEffect, useRef, useState } from 'react';
import { adminFetch } from '../lib/adminApi';
import { useAdminAuth } from '../context/AdminAuthContext';
import { useAdminRuntimeRestart } from '../context/AdminRuntimeRestartContext';
import Button from './ui/Button';
import Drawer from './ui/Drawer';
import MigrationPlanDetails, { type MigrationPreviewDetails } from './MigrationPlanDetails';

interface MaintenanceStatus {
    mode: {
        id: string; moduleId: string; stage: string; previewId?: string; jobId?: string;
        failure?: string; progress?: { checked: number; total: number; confirmed?: number; uncertain?: number };
    } | null;
    preview?: MigrationPreviewDetails & { plan: MigrationPreviewDetails['plan'] & { blockers: string[]; diagnostics: unknown[] } };
    busy?: boolean;
    failure?: string;
}

/** The restricted Core's existing review/recovery actions, inside normal Admin. */
export default function MaintenanceControlPanel() {
    const { logout, sessionRevision, isCurrentSession } = useAdminAuth();
    const { beginRuntimeRestart } = useAdminRuntimeRestart();
    const [state, setState] = useState<MaintenanceStatus | null>(null);
    const [readError, setReadError] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const [acknowledged, setAcknowledged] = useState(false);
    const [sending, setSending] = useState(false);
    const [reviewExpired, setReviewExpired] = useState(false);
    const [confirmStop, setConfirmStop] = useState(false);
    const identity = useRef('');
    const mounted = useRef(true);
    const current = () => mounted.current && isCurrentSession(sessionRevision);

    useEffect(() => {
        mounted.current = true;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout>;
        const poll = async () => {
            const result = await adminFetch<MaintenanceStatus>('/module-maintenance', { signal: controller.signal, cache: 'no-store' });
            if (controller.signal.aborted || !isCurrentSession(sessionRevision)) return;
            if (result.sessionExpired) { logout(); return; }
            if (!result.ok || !result.data?.mode) {
                setState(null); setAcknowledged(false); identity.current = '';
                setReadError(result.error ?? 'Maintenance status unavailable. Refresh to retrieve the current operation.');
            } else {
                const fresh = result.data;
                const nextIdentity = [fresh.mode!.id, fresh.mode!.stage, fresh.preview?.id, fresh.preview?.artifactDigest, fresh.preview?.plan.digest].join(':');
                if (nextIdentity !== identity.current) { identity.current = nextIdentity; setAcknowledged(false); }
                setState(fresh); setReadError(null);
                setReviewExpired(!!fresh.preview && fresh.preview.expiresAt <= Date.now());
                if (['activating', 'serving'].includes(fresh.mode!.stage)) { beginRuntimeRestart(); return; }
            }
            timer = setTimeout(poll, 1500);
        };
        void poll();
        return () => { mounted.current = false; controller.abort(); clearTimeout(timer); };
    }, [sessionRevision, isCurrentSession, logout, beginRuntimeRestart]);

    const action = async (name: 'plan' | 'resume' | 'approve' | 'cancel') => {
        if (!state || sending) return;
        if (name === 'approve' && (!state.preview || state.preview.expiresAt <= Date.now())) {
            setAcknowledged(false); setReviewExpired(true); setActionError('Review expired. Build or review the authoritative plan again.'); return;
        }
        setSending(true); setActionError(null);
        const body = name === 'approve' ? { planId: state.preview?.id, backupAcknowledged: acknowledged } : {};
        const result = await adminFetch(`/module-maintenance/${name}`, { method: 'POST', body: JSON.stringify(body) });
        if (!current()) return;
        setSending(false); setAcknowledged(false);
        if (result.sessionExpired) { logout(); return; }
        if (!result.ok) setActionError(result.error ?? 'Maintenance action failed.');
        else if (name === 'cancel') setConfirmStop(false);
    };
    const plan = state?.preview?.plan;
    const progress = state?.mode?.progress;
    const canApprove = state?.mode?.stage === 'review' && !!plan && !plan.blockers.length
        && !!state?.preview && !reviewExpired && acknowledged && !state.busy && !sending;
    return <section id="world-maintenance" aria-label="World maintenance controls" className="admin-panel my-4 space-y-4 rounded-xl p-5">
        <h2 className="text-xl font-bold">World maintenance</h2>
        <p>Review the exact plan before approving changes. Entering maintenance does not authorize writes.</p>
        {readError && <p role="alert" className="text-[var(--admin-danger-text)]">{readError}</p>}
        {actionError && <p role="alert" className="text-[var(--admin-danger-text)]">{actionError}</p>}
        {(state?.failure || state?.mode?.failure) && <p role="alert" className="break-words text-[var(--admin-warning-text)]">{state.failure || state.mode?.failure}</p>}
        {state && <>
            <p id="phase" aria-live="polite">Phase: {state.mode?.stage}</p>
            {progress && <p>{progress.checked} of {progress.total} checked{progress.confirmed !== undefined && ` · ${progress.confirmed} confirmed writes`}{!!progress.uncertain && ` · ${progress.uncertain} uncertain outcomes`}</p>}
            {state.preview && <MigrationPlanDetails preview={state.preview} />}
            {!!plan?.blockers.length && <ul className="list-disc space-y-1 pl-5 text-[var(--admin-warning-text)]">{plan.blockers.map((reason, i) => <li key={i}>{reason}</li>)}</ul>}
            <details><summary>Technical plan and recovery details</summary><pre id="detail" tabIndex={0} aria-label="Plan and recovery details" className="max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify({ failure: state.failure || state.mode?.failure, progress, proposed: plan?.operations, blockers: plan?.blockers, diagnostics: plan?.diagnostics }, null, 2)}</pre></details>
            <div className="flex flex-wrap gap-2">
                <Button id="plan" disabled={sending || state.busy} onClick={() => void action('plan')}>Build or review authoritative plan</Button>
                <Button id="resume" disabled={sending || state.busy || !state.mode?.jobId} onClick={() => void action('resume')}>Resume approved work</Button>
                <Button id="cancel" disabled={sending} onClick={() => setConfirmStop(true)}>Stop further work</Button>
            </div>
            <p>SheetDelver cannot back up or restore this world or undo migration writes. Back up through Foundry first; interrupted writes may be partial.</p>
            <label className="flex items-start gap-2"><input id="backup" type="checkbox" className="mt-1 shrink-0" checked={acknowledged} disabled={!plan || state.busy || sending} onChange={event => setAcknowledged(event.target.checked)} />I acknowledge these backup and recovery limits for this plan.</label>
            <Button id="approve" variant="primary" disabled={!canApprove} onClick={() => void action('approve')}>Approve exact plan</Button>
        </>}
        <Drawer open={confirmStop} title="Stop further work?" onClose={() => { if (!sending) setConfirmStop(false); }}>
            <p>This cannot undo world changes. Possible writes remain in maintenance for readback and recovery. Before writes, Core may restore the prior package and must validate it before reopening.</p>
            <div className="mt-4 flex flex-wrap gap-2"><Button disabled={sending} onClick={() => setConfirmStop(false)}>Keep working</Button><Button variant="danger" disabled={sending || !state} onClick={() => void action('cancel')}>Confirm stop</Button></div>
        </Drawer>
    </section>;
}
