'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useFoundry } from '@client/ui/context/FoundryContext';
import { ConfirmationModal } from '@client/ui/components/ConfirmationModal';
import * as api from '@client/ui/api/foundryApi';
import type {
    CombatManagerActorChoiceDto,
    CombatManagerEncounterDto,
    CombatManagerPackDto,
    CombatManagerStatDto,
    CombatManagerStatPreferencesDto,
} from '@shared/contracts/combatManager';
import type { ModuleCombatStatAttribute } from '@shared/sdk';

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'The request failed';
}

function statChoiceContext(choice: ModuleCombatStatAttribute & { observedActorTypes?: string[] }): string {
    if (choice.actorTypes?.length) return choice.actorTypes.join(', ');
    if (choice.observedActorTypes?.length) return `seen on ${choice.observedActorTypes.join(', ')}`;
    return 'all Actor types';
}

function compactStatValue(stat: CombatManagerStatDto): string {
    return `${stat.value}${stat.subValue === undefined ? '' : String(stat.subValue).replace(/^\/\s*/, '/')}`;
}

type PendingConfirmation =
    | { kind: 'begin'; combatId: string; activeOtherCount: number }
    | { kind: 'complete'; combatId: string; keepHistory: boolean; status: CombatManagerEncounterDto['status'] }
    | { kind: 'remove'; combatId: string; combatantId: string; actorName: string };

export default function CombatManagerPage() {
    const { currentUser, step, appSocket, worldId, token, system } = useFoundry();
    // This Core tool retains world artwork, but not the system module's fallback theme or background.
    const worldBackground = step === 'dashboard' && system?.status === 'active' ? system.worldBackground : null;
    const bgStyle = worldBackground ? {
        backgroundImage: `linear-gradient(var(--sd-ui-image-scrim), var(--sd-ui-image-scrim)), url(${worldBackground})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
    } : { backgroundImage: 'none' };
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
    const [statPreferences, setStatPreferences] = useState<CombatManagerStatPreferencesDto | null>(null);
    const [editingStats, setEditingStats] = useState(false);
    const [statDraft, setStatDraft] = useState<ModuleCombatStatAttribute[]>([]);
    const [statChoice, setStatChoice] = useState('');
    const [statSearch, setStatSearch] = useState('');
    const [loadingStatCatalog, setLoadingStatCatalog] = useState(false);
    const [customPath, setCustomPath] = useState('');
    const [customLabel, setCustomLabel] = useState('');
    const [customKind, setCustomKind] = useState<ModuleCombatStatAttribute['kind']>('number');
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
        setStatPreferences(null);
        setEditingStats(false);
        setStatDraft([]);
        setStatSearch('');
        setLoadingStatCatalog(false);
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
    const statChoices = [...(statPreferences?.suggestions || []), ...(statPreferences?.available || [])]
        .filter((choice, index, all) => all.findIndex(row => row.path === choice.path && row.kind === choice.kind) === index);
    const filteredStatChoices = statChoices.map((choice, index) => ({ choice, index }))
        .filter(({ choice }) => `${choice.label} ${choice.path} ${choice.actorTypes?.join(' ') || ''}`
            .toLocaleLowerCase().includes(statSearch.trim().toLocaleLowerCase()));
    const unrolledCount = encounter?.participants.filter(row => row.initiative == null && row.actorId).length ?? 0;
    const unrolledNpcCount = encounter?.participants.filter(row => row.initiative == null && row.actorId && row.isNpc).length ?? 0;

    useEffect(() => {
        setInitiative(selected?.initiative === null || selected?.initiative === undefined ? '' : String(selected.initiative));
        setResourceValue(selected?.resource ? String(selected.resource.value) : '');
    }, [selected]);

    useEffect(() => {
        if (!allowed) return;
        let active = true;
        let lastSelection = '';
        const load = async () => {
            const { preferences } = await api.fetchManagedStatPreferences();
            if (!active) return;
            const selection = JSON.stringify({ source: preferences.source, attributes: preferences.attributes });
            if (lastSelection && lastSelection !== selection) void refresh().catch(cause => setError(errorMessage(cause)));
            lastSelection = selection;
            setStatPreferences(previous => ({ ...preferences, available: previous?.available || [] }));
        };
        void load().catch(cause => { if (active) setError(errorMessage(cause)); });
        const timer = window.setInterval(() => {
            void load().catch(cause => { if (active) setError(errorMessage(cause)); });
        }, 15000);
        window.addEventListener('focus', load);
        return () => { active = false; window.clearInterval(timer); window.removeEventListener('focus', load); };
    }, [allowed, worldId, refresh]);

    useEffect(() => {
        if (!allowed || !editingStats) return;
        let active = true;
        setLoadingStatCatalog(true);
        void api.fetchManagedStatPreferences(selected?.actorId, true).then(({ preferences }) => {
            if (active) setStatPreferences(preferences);
        }).catch(cause => {
            if (active) setError(errorMessage(cause));
        }).finally(() => { if (active) setLoadingStatCatalog(false); });
        return () => { active = false; };
    }, [allowed, editingStats, selected?.actorId, worldId]);

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

    const addStat = (choice: ModuleCombatStatAttribute) => {
        if (statDraft.length >= 8) return;
        let key = choice.key;
        let suffix = 2;
        while (statDraft.some(row => row.key === key)) key = `${choice.key.slice(0, 28)}_${suffix++}`;
        setStatDraft(current => [...current, { key, label: choice.label, path: choice.path,
            kind: choice.kind, ...(choice.actorTypes ? { actorTypes: choice.actorTypes } : {}),
            ...(choice.showInRoster === true ? { showInRoster: true } : {}) }]);
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

    const pageClass = 'sd-ui-page p-4 pb-24 font-sans md:p-8';
    const panelClass = 'sd-ui-panel-raised rounded-xl p-4 shadow-lg backdrop-blur-md';
    const inputClass = 'sd-ui-control px-3 py-2 text-sm outline-none';
    const primaryButtonClass = 'sd-ui-button sd-ui-button-primary px-4 py-2 font-bold';
    const secondaryButtonClass = 'sd-ui-button px-3 py-2 text-sm font-semibold';

    if (step !== 'dashboard') return <main className={pageClass} style={bgStyle}>Connecting to the world…</main>;
    if (!allowed) return (
        <main className={pageClass} style={bgStyle}>
            <div className="sd-ui-panel-raised mx-auto max-w-3xl rounded-xl p-6 backdrop-blur-md">
                <h1 className="sd-ui-accent text-2xl font-bold">Combat Manager</h1>
                <p className="mt-3">This tool is available to Gamemasters only.</p>
                <Link href="/" className="sd-ui-accent mt-6 inline-block text-sm hover:underline">Back to Dashboard</Link>
            </div>
        </main>
    );

    return (
        <main className={pageClass} style={bgStyle}>
          <div className="sd-ui-panel mx-auto max-w-7xl space-y-8 rounded-xl p-4 shadow-2xl backdrop-blur-md md:p-6">
            <header className="sd-ui-inset flex flex-wrap items-center justify-between gap-4 rounded-lg p-4">
                <div>
                    <Link href="/" className="sd-ui-accent text-sm hover:underline">← Back to Dashboard</Link>
                    <h1 className="sd-ui-accent mt-2 text-3xl font-bold">Combat Manager</h1>
                    <p className="sd-ui-muted mt-1 text-sm">GM-only · tokenless Foundry encounters</p>
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

            {error && <div role="alert" className="sd-ui-panel-raised sd-ui-danger rounded p-3 text-sm">{error}</div>}
            {loading && <p>Loading encounters…</p>}

            <section className={panelClass}>
                <div className="mb-4 flex items-center gap-3">
                    <h2 className="sd-ui-accent text-lg font-bold uppercase tracking-widest">New encounter</h2>
                    <div className="sd-ui-divider h-px flex-1 border-t" />
                </div>
                <div className="flex flex-wrap items-center gap-3">
                    <input aria-label="Encounter name" value={label} maxLength={100} onChange={event => setLabel(event.target.value)}
                        placeholder="Encounter name" className={`min-w-56 ${inputClass}`} />
                    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={keepHistory} onChange={event => setKeepHistory(event.target.checked)} style={{ accentColor: 'var(--sd-ui-accent)' }} /> Keep for history</label>
                    <button disabled={busy || !label.trim()} onClick={() => void mutate(async () => {
                        const created = await api.createManagedCombat(label, keepHistory);
                        setSelectedId(created.encounter.id); setLabel(''); setKeepHistory(false);
                    })} className={primaryButtonClass}>Create</button>
                </div>
            </section>

            <section className={panelClass}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                        <h2 className="sd-ui-accent text-lg font-bold uppercase tracking-widest">Combat stat display</h2>
                        <p className="sd-ui-muted mt-1 text-xs">Shared by GMs in this world · {statPreferences?.source === 'saved' ? 'customized' : statPreferences?.source === 'module' ? 'module suggestions' : 'no defaults'}</p>
                    </div>
                    <button disabled={!statPreferences || busy} onClick={() => { setStatDraft(statPreferences?.attributes || []); setEditingStats(value => !value); }}
                        className={secondaryButtonClass}>{editingStats ? 'Close configuration' : 'Configure stats'}</button>
                </div>
                {editingStats && <div className="sd-ui-divider mt-4 space-y-3 border-t pt-4">
                    <p className="sd-ui-muted text-xs">Choose fields found on Actors in this world or suggested by the system module. Missing values are hidden; tracked-resource editing is separate.</p>
                    {statDraft.map((field, index) => <div key={`${field.key}:${index}`} className="sd-ui-inset flex flex-wrap items-center gap-2 rounded-lg p-2">
                        <input aria-label={`Stat ${index + 1} label`} value={field.label} maxLength={32} onChange={event => setStatDraft(current => current.map((row, at) => at === index ? { ...row, label: event.target.value } : row))}
                            className={`w-32 ${inputClass}`} />
                        <span className="sd-ui-muted min-w-0 flex-1 truncate text-xs" title={field.path}>{field.actorTypes?.join(', ') || 'All Actor types'} · {field.kind}</span>
                        <label className="flex items-center gap-1.5 text-xs">
                            <input type="checkbox" aria-label={`Show ${field.label} beside names`} checked={field.showInRoster === true}
                                onChange={event => setStatDraft(current => current.map((row, at) => at === index ? { ...row, showInRoster: event.target.checked } : row))}
                                style={{ accentColor: 'var(--sd-ui-accent)' }} /> Beside names
                        </label>
                        <button disabled={index === 0} onClick={() => setStatDraft(current => { const next = [...current]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; return next; })} className={secondaryButtonClass} aria-label={`Move ${field.label} up`}>↑</button>
                        <button disabled={index === statDraft.length - 1} onClick={() => setStatDraft(current => { const next = [...current]; [next[index + 1], next[index]] = [next[index], next[index + 1]]; return next; })} className={secondaryButtonClass} aria-label={`Move ${field.label} down`}>↓</button>
                        <button onClick={() => setStatDraft(current => current.filter((_, at) => at !== index))} className={secondaryButtonClass} aria-label={`Remove ${field.label}`}>Remove</button>
                    </div>)}
                    <div className="flex flex-wrap items-center gap-2">
                        <input aria-label="Find an Actor field" placeholder="Search Actor fields" value={statSearch}
                            onChange={event => { setStatSearch(event.target.value); setStatChoice(''); }} className={`min-w-48 ${inputClass}`} />
                        <select aria-label="Suggested or available stat" value={statChoice} onChange={event => setStatChoice(event.target.value)} className={`min-w-56 ${inputClass}`}>
                            <option value="">Choose a field</option>
                            {filteredStatChoices.map(({ choice, index }) => <option key={`${choice.path}:${choice.kind}`} value={index}>
                                {choice.label} ({statChoiceContext(choice)})
                            </option>)}
                        </select>
                        <button disabled={statDraft.length >= 8 || statChoice === ''} onClick={() => { addStat(statChoices[Number(statChoice)]); setStatChoice(''); }} className={secondaryButtonClass}>Add field</button>
                    </div>
                    {loadingStatCatalog && <p className="sd-ui-muted text-xs">Finding Actor fields…</p>}
                    {!loadingStatCatalog && statChoices.length === 0 && <p className="sd-ui-muted text-xs">No Actor fields are available yet. Add a world or compendium Actor, then reopen this configuration.</p>}
                    <details className="sd-ui-inset rounded-lg p-3 text-xs">
                        <summary className="cursor-pointer">Advanced: enter an attribute path manually</summary>
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                        <input aria-label="Custom stat label" placeholder="Label" value={customLabel} maxLength={32} onChange={event => setCustomLabel(event.target.value)} className={`w-32 ${inputClass}`} />
                        <input aria-label="Custom Actor path" placeholder="system.attributes.example" value={customPath} maxLength={128} onChange={event => setCustomPath(event.target.value)} className={`min-w-64 flex-1 font-mono ${inputClass}`} />
                        <select aria-label="Custom stat kind" value={customKind} onChange={event => setCustomKind(event.target.value as ModuleCombatStatAttribute['kind'])} className={inputClass}>
                            <option value="number">Number</option><option value="resource">Value / max</option><option value="text">Text</option>
                        </select>
                        <button disabled={statDraft.length >= 8 || !customLabel.trim() || !customPath.trim()} onClick={() => {
                            addStat({ key: 'custom', label: customLabel.trim(), path: customPath.trim(), kind: customKind });
                            setCustomLabel(''); setCustomPath('');
                        }} className={secondaryButtonClass}>Add custom</button>
                        </div>
                    </details>
                    <div className="flex flex-wrap gap-2">
                        <button disabled={busy} onClick={() => void mutate(async () => {
                            const { preferences } = await api.saveManagedStatPreferences(statDraft);
                            setStatPreferences(preferences); setEditingStats(false);
                            await refresh();
                        })} className={primaryButtonClass}>Save</button>
                        <button disabled={busy || statPreferences?.source !== 'saved'} onClick={() => void mutate(async () => {
                            const { preferences } = await api.resetManagedStatPreferences();
                            setStatPreferences(preferences); setStatDraft(preferences.attributes); setEditingStats(false);
                            await refresh();
                        })} className={secondaryButtonClass}>Reset to module suggestions</button>
                    </div>
                </div>}
            </section>

            {encounter && <>
                <section className={`${panelClass} flex flex-wrap items-center justify-between gap-4`}>
                    <div>
                        <h2 className="sd-ui-accent text-xl font-bold">{encounter.label}</h2>
                        <p className="sd-ui-muted text-sm">{encounter.status} · round {encounter.round} · {encounter.participants.length} participants · {encounter.keepHistory ? 'retain on completion' : 'delete on completion'}</p>
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
                        })} className="sd-ui-button sd-ui-button-danger px-3 py-2 text-sm font-semibold">{encounter.status === 'cleaning' ? 'Retry cleanup' : 'Complete'}</button>}
                    </div>
                </section>

                {encounter.status === 'active' && <p className="sd-ui-muted text-xs">Begin activates this Combat in Foundry. Turn controls persist document state; native client hooks, system overrides, world-time and effect timing are not guaranteed.</p>}

                <div className="grid gap-5 lg:grid-cols-[minmax(17rem,1fr)_minmax(20rem,2fr)]">
                    {encounter.status === 'active' && <section className={panelClass}>
                        <div className="mb-4 flex items-center gap-3">
                            <h2 className="sd-ui-accent text-lg font-bold uppercase tracking-widest">Add participant</h2>
                            <div className="sd-ui-divider h-px flex-1 border-t" />
                        </div>
                        <div className="mb-3 flex gap-2">
                            <button aria-pressed={picker === 'world'} onClick={() => { setPicker('world'); setQuery(''); }} className={picker === 'world' ? primaryButtonClass : secondaryButtonClass}>World Actors (link)</button>
                            <button aria-pressed={picker === 'compendium'} onClick={() => { setPicker('compendium'); setQuery(''); }} className={picker === 'compendium' ? primaryButtonClass : secondaryButtonClass}>Compendium (copy)</button>
                        </div>
                        {picker === 'compendium' && <select aria-label="Actor compendium" value={packId} onChange={event => setPackId(event.target.value)}
                            className={`mb-3 w-full ${inputClass}`}>
                            <option value="">Choose Actor pack</option>
                            {packs.map(pack => <option key={pack.id} value={pack.id}>{pack.label}</option>)}
                        </select>}
                        <input aria-label="Search participants" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search Actors"
                            className={`mb-3 w-full ${inputClass}`} />
                        <div className="max-h-80 space-y-2 overflow-y-auto">
                            {choices.map(choice => <div key={`${choice.packId || 'world'}:${choice.id}`} className="sd-ui-inset flex items-center justify-between gap-2 rounded-lg p-2 text-sm">
                                <span className="truncate">{choice.name}<span className="sd-ui-muted ml-2 text-xs">{choice.type}</span></span>
                                <button disabled={busy} onClick={() => void mutate(() => choice.source === 'world'
                                    ? api.addManagedWorldActor(encounter.id, choice.id)
                                    : api.addManagedPackActor(encounter.id, choice.packId || '', choice.id))}
                                    className={secondaryButtonClass}>Add</button>
                            </div>)}
                            {choices.length === 0 && <p className="sd-ui-muted text-sm">No matching Actors.</p>}
                        </div>
                    </section>}

                    <section className={panelClass}>
                        <div className="mb-4 flex items-center gap-3">
                            <h2 className="sd-ui-accent text-lg font-bold uppercase tracking-widest">Initiative order</h2>
                            <div className="sd-ui-divider h-px flex-1 border-t" />
                        </div>
                        {encounter.status === 'active' && <div className="mb-4 flex flex-wrap items-center gap-2">
                            <button disabled={busy || unrolledCount === 0} onClick={() => void mutate(() => api.postManagedInitiativeBatch(encounter.id, 'all'))}
                                className={secondaryButtonClass}>Roll All ({unrolledCount})</button>
                            <button disabled={busy || unrolledNpcCount === 0} onClick={() => void mutate(() => api.postManagedInitiativeBatch(encounter.id, 'npc'))}
                                className={secondaryButtonClass}>Roll NPCs ({unrolledNpcCount})</button>
                            <span className="sd-ui-muted text-xs">Only unrolled combatants; NPCs have no player owner.</span>
                        </div>}
                        <div className="space-y-2">
                            {encounter.participants.map(row => <button key={row.id} onClick={() => setSelectedCombatantId(row.id)}
                                className={`${selected?.id === row.id ? 'sd-ui-inset' : 'sd-ui-panel-raised'} flex w-full items-center gap-3 rounded-lg p-3 text-left transition-colors ${row.isCurrent ? 'ring-2 ring-[var(--sd-ui-accent)]' : ''}`}>
                                <span className="w-10 text-center font-mono text-lg">{row.initiative ?? '—'}</span>
                                <span className="min-w-0 flex-1">
                                    <span className="flex flex-wrap items-center gap-1.5">
                                        <span className="truncate font-semibold">{row.name}</span>
                                        {row.stats.filter(stat => stat.showInRoster).map((stat, index) => <span
                                            key={`${stat.title}:${index}`} title={`${stat.title}: ${compactStatValue(stat)}`}
                                            className="sd-ui-inset sd-ui-accent max-w-40 truncate rounded-full px-2 py-0.5 text-[11px] font-medium">
                                            {stat.title}: {compactStatValue(stat)}
                                        </span>)}
                                    </span>
                                    <span className="sd-ui-muted mt-0.5 block text-xs">{row.source === 'world' ? 'world link' : 'pack copy'}</span>
                                </span>
                                {row.resource && <span className="text-sm">{row.resource.value}{row.resource.max !== null ? `/${row.resource.max}` : ''}</span>}
                                {row.hidden && <span className="sd-ui-muted text-xs">hidden</span>}
                                {row.defeated && <span className="sd-ui-danger text-xs">defeated</span>}
                                {row.isCurrent && <span className="sd-ui-inset sd-ui-accent shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider">Current</span>}
                            </button>)}
                            {encounter.participants.length === 0 && <p className="sd-ui-muted text-sm">Add a world Actor or a compendium copy to begin.</p>}
                        </div>

                        {selected && <div className="sd-ui-divider mt-5 space-y-3 border-t pt-4">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <h3 className="sd-ui-accent font-bold">{selected.name}</h3>
                                <Link href={`/actors/${encodeURIComponent(selected.actorId)}`} target="_blank" rel="noopener noreferrer"
                                    className="sd-ui-accent text-sm underline">Open Actor sheet ↗</Link>
                            </div>
                            <p className="sd-ui-muted text-xs">{selected.source === 'world' ? 'Linked world Actor — edits affect ongoing world state.' : 'Encounter-owned copy from a compendium.'}</p>
                            {selected.stats.length > 0 && <div aria-label="Basic stats" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                                <span className="sd-ui-muted col-span-full text-xs font-semibold uppercase tracking-wider">Basic stats · read-only</span>
                                {selected.stats.map((stat, index) => <div key={`${stat.title}:${index}`} className="sd-ui-inset min-w-0 rounded-lg px-3 py-2">
                                    <span className="sd-ui-muted block truncate text-[10px] font-bold uppercase tracking-wider" title={stat.title}>{stat.title}</span>
                                    <span className="block truncate text-sm font-semibold" title={`${stat.value}${stat.subValue ?? ''}`}>{stat.value}{stat.subValue !== undefined && <span className="sd-ui-muted ml-1 font-normal">{stat.subValue}</span>}</span>
                                </div>)}
                            </div>}
                            {selected.effects.length > 0 && <p className="text-sm opacity-80">Effects: {selected.effects.join(', ')}</p>}
                            <div className="flex flex-wrap items-end gap-3">
                                <label className="text-sm">Initiative<input type="number" value={initiative} onChange={event => setInitiative(event.target.value)} disabled={busy || encounter.status !== 'active'}
                                    className={`mt-1 block w-24 ${inputClass}`} /></label>
                                <button disabled={busy || encounter.status !== 'active'} onClick={() => void mutate(() => api.updateManagedCombatant(encounter.id, selected.id,
                                    { initiative: initiative.trim() === '' ? null : Number(initiative) }))}
                                    className={secondaryButtonClass}>Save initiative</button>
                                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={selected.hidden} disabled={busy || encounter.status !== 'active'} style={{ accentColor: 'var(--sd-ui-accent)' }}
                                    onChange={event => void mutate(() => api.updateManagedCombatant(encounter.id, selected.id, { hidden: event.target.checked }))} /> Hidden</label>
                                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={selected.defeated} disabled={busy || encounter.status !== 'active'} style={{ accentColor: 'var(--sd-ui-accent)' }}
                                    onChange={event => void mutate(() => api.updateManagedCombatant(encounter.id, selected.id, { defeated: event.target.checked }))} /> Defeated</label>
                            </div>
                            {selected.resource && <div className="flex flex-wrap items-end gap-3">
                                <label className="text-sm">Tracked resource <span className="sd-ui-muted">({selected.resource.path})</span>
                                    <input type="number" value={resourceValue} onChange={event => setResourceValue(event.target.value)} disabled={busy || encounter.status !== 'active'}
                                        className={`mt-1 block w-28 ${inputClass}`} /></label>
                                <button disabled={busy || encounter.status !== 'active' || resourceValue.trim() === ''}
                                    onClick={() => void mutate(() => api.updateManagedResource(encounter.id, selected.id, Number(resourceValue)))}
                                    className={secondaryButtonClass}>Save resource</button>
                                {selected.resource.max !== null && <span className="sd-ui-muted pb-2 text-sm">Max {selected.resource.max}</span>}
                            </div>}
                            {encounter.status === 'active' && <button disabled={busy} onClick={() => {
                                setPendingConfirmation({ kind: 'remove', combatId: encounter.id,
                                    combatantId: selected.id, actorName: selected.name });
                            }} className="sd-ui-danger text-sm underline disabled:opacity-40">Remove participant</button>}
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
            />
          </div>
        </main>
    );
}
