'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { OrphanTokenReview, OrphanTokenCleanupResponse, OrphanTokenCleanupResult } from '@shared/types/adminWorldCleanup';
import { adminFetch } from '../lib/adminApi';
import { useAdminAuth } from '../context/AdminAuthContext';
import { useAdminMigration } from '../context/AdminMigrationContext';
import Button from './ui/Button';
import Drawer from './ui/Drawer';

export default function OrphanTokenCleanup() {
    const { logout, sessionRevision, isCurrentSession } = useAdminAuth();
    const { data } = useAdminMigration();
    const sequence = useRef(0);
    const inFlight = useRef(false);
    const mounted = useRef(false);
    const worldScope = JSON.stringify([data?.active?.world?.instanceId, data?.active?.world?.worldId, data?.active?.world?.systemId]);
    const scope = useRef(worldScope);
    const [tokens, setTokens] = useState<OrphanTokenReview[]>([]);
    const [checked, setChecked] = useState<Set<string>>(new Set());
    const [selected, setSelected] = useState<OrphanTokenReview[] | null>(null);
    const [outcomes, setOutcomes] = useState<Array<OrphanTokenCleanupResult & { tokenName: string; sceneName: string }>>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const retire = useCallback(() => { ++sequence.current; }, []);
    const load = useCallback(async () => {
        const request = ++sequence.current;
        setSelected(null); setChecked(new Set());
        const result = await adminFetch<{ tokens: OrphanTokenReview[] }>('/world-cleanup/orphan-tokens');
        if (request !== sequence.current || !isCurrentSession(sessionRevision)) return;
        if (result.sessionExpired) { logout(); return; }
        // Optional cleanup never adds a readiness diagnostic while starting.
        setTokens(result.ok ? result.data?.tokens ?? [] : []);
        setSelected(null);
    }, [logout, sessionRevision, isCurrentSession]);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    useEffect(() => {
        scope.current = worldScope;
        setTokens([]); setSelected(null); setChecked(new Set()); setOutcomes([]); setError(null);
        return retire;
    }, [load, worldScope, retire]);
    useEffect(() => {
        // Our own confirmed deletes advance source revisions. Finish reporting
        // the submitted selection, then reload; never resubmit it on refresh.
        if (inFlight.current) return;
        setTokens([]); setSelected(null); setChecked(new Set()); void load();
        return retire;
    }, [load, data?.revision, retire]);
    if (!tokens.length && !error && !outcomes.length && !busy) return null;
    const remove = async () => {
        if (!selected?.length || inFlight.current) return;
        inFlight.current = true;
        const reviewed = selected;
        const submittedScope = scope.current;
        setBusy(true); setError(null); setOutcomes([]);
        const result = await adminFetch<OrphanTokenCleanupResponse>('/world-cleanup/orphan-tokens/delete', {
            method: 'POST', body: JSON.stringify({ tokens: reviewed.map(({ sceneId, tokenId, review }) => ({ sceneId, tokenId, review })), confirmed: true }),
        });
        inFlight.current = false;
        if (!mounted.current) return;
        if (!isCurrentSession(sessionRevision) || scope.current !== submittedScope) { setBusy(false); void load(); return; }
        setSelected(null); setChecked(new Set()); setBusy(false);
        if (result.sessionExpired) { logout(); return; }
        if (result.ok && result.data?.results) {
            setOutcomes(result.data.results.map(outcome => {
                const row = reviewed.find(row => row.sceneId === outcome.sceneId && row.tokenId === outcome.tokenId)!;
                return { ...outcome, tokenName: row.tokenName, sceneName: row.sceneName };
            }));
        } else setError(result.error ?? 'Cleanup was not confirmed. Refresh and review the remaining tokens; no automatic retry was sent.');
        await load();
    };
    const selectedRows = tokens.filter(row => checked.has(row.review));
    const deleted = outcomes.filter(row => row.state === 'deleted').length;
    const remaining = outcomes.filter(row => row.state !== 'deleted');
    return <section className="admin-panel my-4 rounded-xl p-4" aria-label="Optional scene cleanup">
        {error && <p role="alert" className="mb-3 break-words text-sm text-[var(--admin-danger-text)]">{error}</p>}
        {outcomes.length > 0 && <div className="mb-3 space-y-2 text-sm">
            <p role="status">Deleted {deleted} of {outcomes.length} selected tokens.</p>
            {remaining.length > 0 && <div role="alert"><p>Cleanup stopped. Review the remaining tokens before trying again.</p>
                <ul className="mt-2 space-y-2">{remaining.map(row => <li key={`${row.sceneId}:${row.tokenId}`} className="break-words">
                    <strong>{row.tokenName}</strong> · {row.sceneName}: {row.state === 'unconfirmed' ? 'Deletion unconfirmed' : row.state === 'not-attempted' ? 'Not attempted' : 'Not deleted'}. {row.reason}
                </li>)}</ul></div>}
        </div>}
        <details>
            <summary className="cursor-pointer font-semibold">Optional scene cleanup ({tokens.length} orphaned token{tokens.length === 1 ? '' : 's'})</summary>
            <p className="my-3 text-sm">These tokens no longer have Actors. They are left unchanged and do not block startup or migration.</p>
            <div className="flex flex-wrap items-center gap-2">
                <Button disabled={busy} onClick={() => { setError(null); void load(); }}>Refresh cleanup list</Button>
                <Button disabled={busy || !tokens.length} onClick={() => setChecked(new Set(tokens.map(row => row.review)))}>Select all</Button>
                <Button disabled={busy || !checked.size} onClick={() => setChecked(new Set())}>Clear selection</Button>
                <Button disabled={busy || !selectedRows.length} onClick={() => setSelected(selectedRows)}>Review selected ({selectedRows.length})</Button>
            </div>
            <ul className="mt-3 space-y-3">{tokens.map(row => <li key={row.review} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--admin-border)] p-3">
                <label className="flex min-w-0 items-start gap-3 break-words"><input type="checkbox" className="mt-1 shrink-0" checked={checked.has(row.review)} disabled={busy}
                    aria-label={`Select ${row.tokenName} in ${row.sceneName}`} onChange={event => setChecked(current => {
                        const next = new Set(current); if (event.target.checked) next.add(row.review); else next.delete(row.review); return next;
                    })}/><span><span className="block font-semibold">{row.tokenName}</span><span className="block text-sm text-[var(--admin-text-muted)]">Scene: {row.sceneName}</span></span></label>
                <Button disabled={busy} onClick={() => setSelected([row])}>Review deletion</Button>
            </li>)}</ul>
        </details>
        <Drawer open={Boolean(selected)} title={selected?.length === 1 ? 'Delete orphaned token?' : `Delete ${selected?.length ?? 0} orphaned tokens?`} onClose={() => { if (!busy) setSelected(null); }}>
            <p>Delete the following {selected?.length === 1 ? 'token' : 'tokens'}?</p>
            <ul className="my-3 space-y-2">{selected?.map(row => <li key={row.review} className="break-words"><strong>{row.tokenName}</strong> · Scene: {row.sceneName}</li>)}</ul>
            <p>This permanently removes the selected tokens and their stored data. Keeping them does not block SheetDelver.</p>
            {(selected?.length ?? 0) > 1 && <p className="mt-3 text-sm">Each token is checked before deletion. If cleanup stops, completed deletions remain and the remaining tokens are reported.</p>}
            <div className="mt-4 flex flex-wrap gap-2"><Button disabled={busy} onClick={() => setSelected(null)}>{selected?.length === 1 ? 'Keep token' : 'Keep tokens'}</Button>
                <Button variant="danger" disabled={busy} onClick={() => void remove()}>{busy ? 'Deleting…' : selected?.length === 1 ? 'Delete token' : `Delete ${selected?.length ?? 0} tokens`}</Button></div>
        </Drawer>
    </section>;
}
