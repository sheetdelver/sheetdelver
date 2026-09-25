'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useFoundry } from '@client/ui/context/FoundryContext';
import { ConfirmationModal } from '@client/ui/components/ConfirmationModal';
import { useTheme } from '@client/ui/main/hooks/useTheme';
import * as api from '@client/ui/api/foundryApi';
import type {
    CombatManagerActorChoiceDto,
    CombatManagerEncounterDto,
    CombatManagerPackDto,
} from '@shared/contracts/combatManager';

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'The request failed';
}

type PendingConfirmation =
    | { kind: 'begin'; combatId: string; activeOtherCount: number }
    | { kind: 'complete'; combatId: string; keepHistory: boolean; status: CombatManagerEncounterDto['status'] }
    | { kind: 'remove'; combatId: string; combatantId: string; actorName: string };

export default function CombatManagerPage() {
    const { currentUser, step, appSocket, worldId, token, system } = useFoundry();
    const { theme, bgStyle } = useTheme();
    const allowed = step === 'dashboard' && (currentUser?.role ?? 0) >= 4;
    const [encounters, setEncounters] = useState<CombatManagerEncounterDto[]>([]);
    const [selectedId, setSelectedId] = useState('');
    const [selectedCombatantId, setSelectedCombatantId] = useState('');
    const [label, setLabel] = useState('');
    const [keepHistory, setKeepHistory] = useState(false);
    const [picker, setPicker] = useState<'world' | 'compendium'>('world');
    const [query, setQuery] = useState('');
    const [packId, setPackId] = useState('');
    const [packs, setPacks] = useState<CombatManagerPackDto[]>([]);
    const [choices, setChoices] = useState<CombatManagerActorChoiceDto[]>([]);
    const [initiative, setInitiative] = useState('');
    const [resourceValue, setResourceValue] = useState('');
    const [busy, setBusy] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null);
    const refreshVersion = useRef(0);

    useEffect(() => {
        // No manager projection survives a logout or world change.
        refreshVersion.current += 1;
        setEncounters([]);
        setSelectedId('');
        setSelectedCombatantId('');
        setChoices([]);
        setPacks([]);
        setPicker('world');
        setQuery('');
        setPackId('');
        setLabel('');
        setKeepHistory(false);
        setError('');
        setPendingConfirmation(null);
        setLoading(true);
    }, [allowed, worldId]);

    const refresh = useCallback(async () => {
        const version = ++refreshVersion.current;
        let payload: Awaited<ReturnType<typeof api.fetchManagedCombats>>;
        try { payload = await api.fetchManagedCombats(); }
        catch (cause) {
            if (version === refreshVersion.current) setLoading(false);
            throw cause;
        }
        if (version !== refreshVersion.current) return;
        setEncounters(payload.encounters);
        setSelectedId(previous => payload.encounters.some(row => row.id === previous)
            ? previous : payload.encounters[0]?.id || '');
        setLoading(false);
    }, []);

    useEffect(() => {
        if (!allowed) return;
        let active = true;
        void refresh().catch(cause => { if (active) { setError(errorMessage(cause)); setLoading(false); } });
        void api.fetchManagedActorPacks().then(payload => {
            if (active) setPacks(payload.packs);
        }).catch(cause => { if (active) setError(errorMessage(cause)); });
        return () => { active = false; };
    }, [allowed, refresh]);

    useEffect(() => {
        if (!allowed || !appSocket) return;
        const changed = () => { void refresh().catch(cause => setError(errorMessage(cause))); };
        appSocket.on('combatChanged', changed);
        appSocket.on('combatListInvalidated', changed);
        appSocket.on('actorChanged', changed);
        appSocket.on('actorListInvalidated', changed);
        return () => {
            appSocket.off('combatChanged', changed);
            appSocket.off('combatListInvalidated', changed);
            appSocket.off('actorChanged', changed);
            appSocket.off('actorListInvalidated', changed);
        };
    }, [allowed, appSocket, refresh]);

    useEffect(() => {
        if (!allowed) return;
        if (picker === 'compendium' && !packId) { setChoices([]); return; }
        let active = true;
        const timer = setTimeout(() => {
            const search = picker === 'world'
                ? api.searchManagedWorldActors(query)
                : api.searchManagedPackActors(packId, query);
            void search.then(payload => { if (active) setChoices(payload.actors); })
                .catch(cause => { if (active) setError(errorMessage(cause)); });
        }, 180);
        return () => { active = false; clearTimeout(timer); };
    }, [allowed, picker, packId, query]);

    const encounter = useMemo(() => encounters.find(row => row.id === selectedId) || null, [encounters, selectedId]);
    const selected = encounter?.participants.find(row => row.id === selectedCombatantId)
        || encounter?.participants[0] || null;
    const unrolledCount = encounter?.participants.filter(row => row.initiative == null && row.actorId).length ?? 0;
    const unrolledNpcCount = encounter?.participants.filter(row => row.initiative == null && row.actorId && row.isNpc).length ?? 0;

    useEffect(() => {
        setInitiative(selected?.initiative === null || selected?.initiative === undefined ? '' : String(selected.initiative));
        setResourceValue(selected?.resource ? String(selected.resource.value) : '');
    }, [selected]);

    const mutate = async (action: () => Promise<unknown>) => {
        setBusy(true);
        setError('');
        try { await action(); await refresh(); }
        catch (cause) {
            setError(errorMessage(cause));
            // A Foundry write may have partially succeeded before the error.
            // Refresh to expose provisioning/cleaning state and safe retry.
            try { await refresh(); } catch { /* Preserve the original error. */ }
        }
        finally { setBusy(false); }
    };

    const confirmPending = () => {
        const pending = pendingConfirmation;
        setPendingConfirmation(null);
        if (!pending || busy) return;
        if (pending.kind === 'begin') {
            void mutate(() => api.postManagedNextTurn(pending.combatId));
        } else if (pending.kind === 'complete') {
            void mutate(() => api.completeManagedCombat(pending.combatId));
        } else {
            setSelectedCombatantId('');
            void mutate(() => api.removeManagedCombatant(pending.combatId, pending.combatantId));
        }
    };

    const confirmationTitle = pendingConfirmation?.kind === 'begin' ? 'Begin encounter'
        : pendingConfirmation?.kind === 'complete' ? 'Complete encounter' : 'Remove participant';
    const confirmationMessage = pendingConfirmation?.kind === 'begin'
        ? `${pendingConfirmation.activeOtherCount} other ${pendingConfirmation.activeOtherCount === 1 ? 'Combat is' : 'Combats are'} currently active in Foundry. Beginning this encounter will deactivate ${pendingConfirmation.activeOtherCount === 1 ? 'it' : 'them'}, including any scene encounter. Continue?`
        : pendingConfirmation?.kind === 'complete'
            ? pendingConfirmation.keepHistory && pendingConfirmation.status === 'active'
                ? 'Complete this encounter and retain its Combat, Folder and compendium copies as read-only history?'
                : 'Complete and delete this Combat, its verified compendium copies and its Actor Folder? Linked world Actors will remain untouched.'
            : pendingConfirmation?.kind === 'remove'
                ? `Remove ${pendingConfirmation.actorName} from this encounter? Its world Actor will not be deleted.`
                : '';

    const pageClass = `min-h-screen ${theme.bg} ${theme.text} p-4 pb-24 font-sans transition-colors duration-500 md:p-8`;
    const panelClass = `${theme.panelBg}/40 rounded-xl border border-white/5 p-4 shadow-lg backdrop-blur-md`;
    const inputClass = `rounded border p-2 text-sm outline-none ${theme.input}`;
    const primaryButtonClass = `${theme.button} rounded-lg px-4 py-2 font-bold text-black transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-40`;
    const secondaryButtonClass = 'rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm font-semibold transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40';

    if (step !== 'dashboard') return <main className={pageClass} style={bgStyle}>Connecting to the world…</main>;
    if (!allowed) return (
        <main className={pageClass} style={bgStyle}>
            <div className="mx-auto max-w-3xl rounded-xl border border-white/10 bg-black/60 p-6 backdrop-blur-md">
                <h1 className={`text-2xl ${theme.headerFont} ${theme.accent}`}>Combat Manager</h1>
                <p className="mt-3">This tool is available to Gamemasters only.</p>
                <Link href="/" className={`mt-6 inline-block text-sm hover:underline ${theme.accent}`}>Back to Dashboard</Link>
            </div>
        </main>
    );

    return (
        <main className={pageClass} style={bgStyle}>
          <div className="mx-auto max-w-7xl space-y-8 rounded-xl border border-white/10 bg-black/60 p-4 shadow-2xl backdrop-blur-md md:p-6">
            <header className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-white/5 bg-black/40 p-4">
                <div>
                    <Link href="/" className={`text-sm hover:underline ${theme.accent}`}>← Back to Dashboard</Link>
                    <h1 className={`mt-2 text-3xl ${theme.headerFont} ${theme.accent}`}>Combat Manager</h1>
                    <p className="mt-1 text-sm opacity-60">GM-only · tokenless Foundry encounters</p>
                </div>
                <label className="flex items-center gap-2 text-sm">
                    Encounter
                    <select aria-label="Encounter" value={selectedId} onChange={event => { setSelectedId(event.target.value); setSelectedCombatantId(''); }}
                        className={`min-w-48 ${inputClass}`}>
                        {encounters.length === 0 && <option value="">No encounters</option>}
                        {encounters.map(row => <option key={row.id} value={row.id}>{row.label}{row.status === 'completed' ? ' (completed)' : ''}</option>)}
                    </select>
                </label>
            </header>

            {error && <div role="alert" className="rounded border border-red-500/60 bg-red-950/50 p-3 text-sm text-red-200">{error}</div>}
            {loading && <p>Loading encounters…</p>}

            <section className={panelClass}>
                <div className="mb-4 flex items-center gap-3">
                    <h2 className={`text-lg font-bold uppercase tracking-widest ${theme.accent}`}>New encounter</h2>
                    <div className="h-px flex-1 bg-white/10" />
                </div>
                <div className="flex flex-wrap items-center gap-3">
                    <input aria-label="Encounter name" value={label} maxLength={100} onChange={event => setLabel(event.target.value)}
                        placeholder="Encounter name" className={`min-w-56 ${inputClass}`} />
                    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={keepHistory} onChange={event => setKeepHistory(event.target.checked)} /> Keep for history</label>
                    <button disabled={busy || !label.trim()} onClick={() => void mutate(async () => {
                        const created = await api.createManagedCombat(label, keepHistory);
                        setSelectedId(created.encounter.id); setLabel(''); setKeepHistory(false);
                    })} className={primaryButtonClass}>Create</button>
                </div>
            </section>

            {encounter && <>
                <section className={`${panelClass} flex flex-wrap items-center justify-between gap-4`}>
                    <div>
                        <h2 className={`text-xl ${theme.headerFont} ${theme.accent}`}>{encounter.label}</h2>
                        <p className="text-sm opacity-60">{encounter.status} · round {encounter.round} · {encounter.participants.length} participants · {encounter.keepHistory ? 'retain on completion' : 'delete on completion'}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <button disabled={busy || encounter.status !== 'active' || encounter.round === 0 || encounter.participants.length === 0} onClick={() => void mutate(() => api.postManagedPreviousTurn(encounter.id))}
                            className={secondaryButtonClass}>Previous</button>
                        <button disabled={busy || encounter.status !== 'active' || encounter.participants.length === 0} onClick={() => {
                            if (encounter.round !== 0) {
                                void mutate(() => api.postManagedNextTurn(encounter.id));
                                return;
                            }
                            void mutate(async () => {
                                // Read all GM-visible Combats immediately before Begin. The
                                // manager list excludes ordinary and scene encounters.
                                const { combats } = await api.fetchCombats(token || '');
                                const activeOtherCount = combats.filter(combat => combat.active && combat.id !== encounter.id).length;
                                if (activeOtherCount > 0) {
                                    setPendingConfirmation({ kind: 'begin', combatId: encounter.id, activeOtherCount });
                                    return;
                                }
                                await api.postManagedNextTurn(encounter.id);
                            });
                        }}
                            className={primaryButtonClass}>{encounter.round === 0 ? 'Begin' : 'Next turn'}</button>
                        {encounter.status !== 'completed' && <button disabled={busy} onClick={() => setPendingConfirmation({
                            kind: 'complete', combatId: encounter.id, keepHistory: encounter.keepHistory, status: encounter.status,
                        })} className="rounded-lg border border-red-500/40 bg-red-950/20 px-3 py-2 text-sm font-semibold text-red-200 transition-colors hover:bg-red-950/40 disabled:opacity-40">{encounter.status === 'cleaning' ? 'Retry cleanup' : 'Complete'}</button>}
                    </div>
                </section>

                {encounter.status === 'active' && <p className="text-xs opacity-60">Begin activates this Combat in Foundry. Turn controls persist document state; native client hooks, system overrides, world-time and effect timing are not guaranteed.</p>}

                <div className="grid gap-5 lg:grid-cols-[minmax(17rem,1fr)_minmax(20rem,2fr)]">
                    {encounter.status === 'active' && <section className={panelClass}>
                        <div className="mb-4 flex items-center gap-3">
                            <h2 className={`text-lg font-bold uppercase tracking-widest ${theme.accent}`}>Add participant</h2>
                            <div className="h-px flex-1 bg-white/10" />
                        </div>
                        <div className="mb-3 flex gap-2">
                            <button aria-pressed={picker === 'world'} onClick={() => { setPicker('world'); setQuery(''); }} className={`rounded-lg px-3 py-2 text-sm font-semibold ${picker === 'world' ? `${theme.button} text-black` : 'border border-white/10 bg-black/30 hover:bg-white/10'}`}>World Actors (link)</button>
                            <button aria-pressed={picker === 'compendium'} onClick={() => { setPicker('compendium'); setQuery(''); }} className={`rounded-lg px-3 py-2 text-sm font-semibold ${picker === 'compendium' ? `${theme.button} text-black` : 'border border-white/10 bg-black/30 hover:bg-white/10'}`}>Compendium (copy)</button>
                        </div>
                        {picker === 'compendium' && <select aria-label="Actor compendium" value={packId} onChange={event => setPackId(event.target.value)}
                            className={`mb-3 w-full ${inputClass}`}>
                            <option value="">Choose Actor pack</option>
                            {packs.map(pack => <option key={pack.id} value={pack.id}>{pack.label}</option>)}
                        </select>}
                        <input aria-label="Search participants" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search Actors"
                            className={`mb-3 w-full ${inputClass}`} />
                        <div className="max-h-80 space-y-2 overflow-y-auto">
                            {choices.map(choice => <div key={`${choice.packId || 'world'}:${choice.id}`} className="flex items-center justify-between gap-2 rounded-lg border border-white/5 bg-black/40 p-2 text-sm">
                                <span className="truncate">{choice.name}<span className="ml-2 text-xs opacity-50">{choice.type}</span></span>
                                <button disabled={busy} onClick={() => void mutate(() => choice.source === 'world'
                                    ? api.addManagedWorldActor(encounter.id, choice.id)
                                    : api.addManagedPackActor(encounter.id, choice.packId || '', choice.id))}
                                    className={secondaryButtonClass}>Add</button>
                            </div>)}
                            {choices.length === 0 && <p className="text-sm opacity-50">No matching Actors.</p>}
                        </div>
                    </section>}

                    <section className={panelClass}>
                        <div className="mb-4 flex items-center gap-3">
                            <h2 className={`text-lg font-bold uppercase tracking-widest ${theme.accent}`}>Initiative order</h2>
                            <div className="h-px flex-1 bg-white/10" />
                        </div>
                        {encounter.status === 'active' && <div className="mb-4 flex flex-wrap items-center gap-2">
                            <button disabled={busy || unrolledCount === 0} onClick={() => void mutate(() => api.postManagedInitiativeBatch(encounter.id, 'all'))}
                                className={secondaryButtonClass}>Roll All ({unrolledCount})</button>
                            <button disabled={busy || unrolledNpcCount === 0} onClick={() => void mutate(() => api.postManagedInitiativeBatch(encounter.id, 'npc'))}
                                className={secondaryButtonClass}>Roll NPCs ({unrolledNpcCount})</button>
                            <span className="text-xs opacity-50">Only unrolled combatants; NPCs have no player owner.</span>
                        </div>}
                        <div className="space-y-2">
                            {encounter.participants.map(row => <button key={row.id} onClick={() => setSelectedCombatantId(row.id)}
                                className={`flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors ${selected?.id === row.id ? 'border-amber-500/50 bg-amber-500/10' : 'border-white/5 bg-black/40 hover:border-amber-500/30'} ${row.isCurrent ? 'ring-2 ring-amber-400/60' : ''}`}>
                                <span className="w-10 text-center font-mono text-lg">{row.initiative ?? '—'}</span>
                                <span className="min-w-0 flex-1 truncate">{row.name}<span className="ml-2 text-xs opacity-50">{row.source === 'world' ? 'world link' : 'pack copy'}</span></span>
                                {row.resource && <span className="text-sm">{row.resource.value}{row.resource.max !== null ? `/${row.resource.max}` : ''}</span>}
                                {row.hidden && <span className="text-xs text-violet-300">hidden</span>}
                                {row.defeated && <span className="text-xs text-red-300">defeated</span>}
                                {row.isCurrent && <span className="shrink-0 rounded-full border border-amber-500/50 bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-300">Current</span>}
                            </button>)}
                            {encounter.participants.length === 0 && <p className="text-sm opacity-50">Add a world Actor or a compendium copy to begin.</p>}
                        </div>

                        {selected && <div className="mt-5 space-y-3 border-t border-white/10 pt-4">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <h3 className={`font-bold ${theme.accent}`}>{selected.name}</h3>
                                <Link href={`/actors/${encodeURIComponent(selected.actorId)}`} target="_blank" rel="noopener noreferrer"
                                    className={`text-sm underline ${theme.accent}`}>Open Actor sheet ↗</Link>
                            </div>
                            <p className="text-xs opacity-60">{selected.source === 'world' ? 'Linked world Actor — edits affect ongoing world state.' : 'Encounter-owned copy from a compendium.'}</p>
                            {selected.effects.length > 0 && <p className="text-sm opacity-80">Effects: {selected.effects.join(', ')}</p>}
                            <div className="flex flex-wrap items-end gap-3">
                                <label className="text-sm">Initiative<input type="number" value={initiative} onChange={event => setInitiative(event.target.value)} disabled={busy || encounter.status !== 'active'}
                                    className={`mt-1 block w-24 ${inputClass}`} /></label>
                                <button disabled={busy || encounter.status !== 'active'} onClick={() => void mutate(() => api.updateManagedCombatant(encounter.id, selected.id,
                                    { initiative: initiative.trim() === '' ? null : Number(initiative) }))}
                                    className={secondaryButtonClass}>Save initiative</button>
                                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={selected.hidden} disabled={busy || encounter.status !== 'active'}
                                    onChange={event => void mutate(() => api.updateManagedCombatant(encounter.id, selected.id, { hidden: event.target.checked }))} /> Hidden</label>
                                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={selected.defeated} disabled={busy || encounter.status !== 'active'}
                                    onChange={event => void mutate(() => api.updateManagedCombatant(encounter.id, selected.id, { defeated: event.target.checked }))} /> Defeated</label>
                            </div>
                            {selected.resource && <div className="flex flex-wrap items-end gap-3">
                                <label className="text-sm">Tracked resource <span className="opacity-50">({selected.resource.path})</span>
                                    <input type="number" value={resourceValue} onChange={event => setResourceValue(event.target.value)} disabled={busy || encounter.status !== 'active'}
                                        className={`mt-1 block w-28 ${inputClass}`} /></label>
                                <button disabled={busy || encounter.status !== 'active' || resourceValue.trim() === ''}
                                    onClick={() => void mutate(() => api.updateManagedResource(encounter.id, selected.id, Number(resourceValue)))}
                                    className={secondaryButtonClass}>Save resource</button>
                                {selected.resource.max !== null && <span className="pb-2 text-sm opacity-60">Max {selected.resource.max}</span>}
                            </div>}
                            {encounter.status === 'active' && <button disabled={busy} onClick={() => {
                                setPendingConfirmation({ kind: 'remove', combatId: encounter.id,
                                    combatantId: selected.id, actorName: selected.name });
                            }} className="text-sm text-red-300 underline disabled:opacity-40">Remove participant</button>}
                        </div>}
                    </section>
                </div>
            </>}
            <ConfirmationModal
                isOpen={pendingConfirmation !== null}
                title={confirmationTitle}
                message={confirmationMessage}
                confirmLabel={pendingConfirmation?.kind === 'begin' ? 'Begin' : pendingConfirmation?.kind === 'remove' ? 'Remove' : 'Complete'}
                isDanger={pendingConfirmation?.kind !== 'begin'}
                onConfirm={confirmPending}
                onCancel={() => setPendingConfirmation(null)}
                theme={system?.componentStyles?.modal}
            />
          </div>
        </main>
    );
}
