'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Swords, UserRound } from 'lucide-react';
import { useFoundry } from '@client/ui/context/FoundryContext';
import { ConfirmationModal } from '@client/ui/components/ConfirmationModal';
import { ApiError } from '@client/ui/api/http';
import { CombatHealthModal, type CombatHealthTarget } from './CombatHealthModal';
import { CombatBatchHealthModal } from './CombatBatchHealthModal';
import { CombatBeginModal, type CombatBeginChoice } from './CombatBeginModal';
import * as api from '@client/ui/api/foundryApi';
import { combatManagerNameKey } from '@shared/contracts/combatManager';
import type {
    CombatManagerActorChoiceDto,
    CombatManagerActorSortFieldDto,
    CombatManagerActorSortRequest,
    CombatManagerSortDirection,
    CombatManagerEncounterDto,
    CombatManagerPackDto,
    CombatManagerStatDto,
    CombatManagerStatPreferencesDto,
    CombatManagerSelectedStatDto,
    CombatManagerHealthBatchRequest,
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
    | { kind: 'complete'; combatId: string; keepHistory: boolean; status: CombatManagerEncounterDto['status'] }
    | { kind: 'delete'; combatId: string; label: string; status: CombatManagerEncounterDto['status'] }
    | { kind: 'reset'; combatId: string; scoredCount: number }
    | { kind: 'remove'; combatId: string; combatantId: string; actorName: string };

type ResourceEdit = {
    combatantId: string;
    actorId: string;
    path: string;
    expectedValue: number;
    value: string;
    conflict?: boolean;
};
type StatEdit = ResourceEdit & { key: string };
type InitiativeEdit = { combatantId: string; expectedValue: number | null; value: string; conflict?: boolean };

export default function CombatManagerPage() {
    const { currentUser, step, appSocket, worldId, token, system } = useFoundry();
    // This Core tool retains world artwork, but not the system module's fallback theme or background.
    const worldBackground = system?.worldBackground || null;
    const bgStyle = worldBackground ? {
        backgroundImage: `linear-gradient(var(--sd-ui-image-scrim), var(--sd-ui-image-scrim)), url(${worldBackground})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
    } : { backgroundImage: 'none' };
    const isGamemaster = (currentUser?.role ?? 0) >= 4;
    const allowed = step === 'dashboard' && isGamemaster;
    const [encounters, setEncounters] = useState<CombatManagerEncounterDto[]>([]);
    const [selectedId, setSelectedId] = useState('');
    const [selectedCombatantId, setSelectedCombatantId] = useState('');
    const [label, setLabel] = useState('');
    const [renameDraft, setRenameDraft] = useState<{ combatId: string; label: string } | null>(null);
    const [keepHistory, setKeepHistory] = useState(false);
    const [picker, setPicker] = useState<'world' | 'compendium'>('world');
    const [query, setQuery] = useState('');
    const [packQuantity, setPackQuantity] = useState('1');
    const [packId, setPackId] = useState('');
    const [packs, setPacks] = useState<CombatManagerPackDto[]>([]);
    const [choices, setChoices] = useState<CombatManagerActorChoiceDto[]>([]);
    const [availableSortFields, setAvailableSortFields] = useState<CombatManagerActorSortFieldDto[]>([]);
    const [nameDirection, setNameDirection] = useState<CombatManagerSortDirection>('asc');
    const [actorSortFields, setActorSortFields] = useState<CombatManagerActorSortRequest['fields']>([]);
    const [loadingChoices, setLoadingChoices] = useState(false);
    const [initiativeEdit, setInitiativeEdit] = useState<InitiativeEdit | null>(null);
    const [resourceEdit, setResourceEdit] = useState<ResourceEdit | null>(null);
    const [statEdit, setStatEdit] = useState<StatEdit | null>(null);
    const [healthTarget, setHealthTarget] = useState<CombatHealthTarget | null>(null);
    const [healthConflict, setHealthConflict] = useState(false);
    const [batchSelection, setBatchSelection] = useState<string[]>([]);
    const [batchModal, setBatchModal] = useState<{ targets: CombatManagerHealthBatchRequest['targets']; names: string[] } | null>(null);
    const [statPreferences, setStatPreferences] = useState<CombatManagerStatPreferencesDto | null>(null);
    const [initiativeFallbackDraft, setInitiativeFallbackDraft] = useState('');
    const [editingStats, setEditingStats] = useState(false);
    const [statDraft, setStatDraft] = useState<CombatManagerSelectedStatDto[]>([]);
    const [statChoice, setStatChoice] = useState('');
    const [statSearch, setStatSearch] = useState('');
    const [loadingStatCatalog, setLoadingStatCatalog] = useState(false);
    const [customPath, setCustomPath] = useState('');
    const [customLabel, setCustomLabel] = useState('');
    const [customKind, setCustomKind] = useState<ModuleCombatStatAttribute['kind']>('number');
    const [busy, setBusy] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null);
    const [beginPrompt, setBeginPrompt] = useState<CombatBeginChoice | null>(null);
    const refreshVersion = useRef(0);
    const lastPreferenceSelection = useRef('');
    const initiativeDraftDirty = useRef(false);
    const discardBlurForSelection = useRef(false);
    const beginSelection = () => {
        // Pointer focus blurs the old field before onChange/onClick switches
        // rows. That blur must not commit a draft the GM is discarding.
        discardBlurForSelection.current = true;
        window.setTimeout(() => { discardBlurForSelection.current = false; }, 0);
    };

    useEffect(() => {
        // The shared player boundary unmounts this page on logout or identity
        // change. A transient same-world step must not clear its local state.
        refreshVersion.current += 1;
        setEncounters([]);
        setSelectedId('');
        setSelectedCombatantId('');
        setInitiativeEdit(null);
        setResourceEdit(null);
        setStatEdit(null);
        setHealthTarget(null);
        setHealthConflict(false);
        setBatchSelection([]);
        setBatchModal(null);
        setChoices([]);
        setAvailableSortFields([]);
        setActorSortFields([]);
        setNameDirection('asc');
        setLoadingChoices(false);
        setPacks([]);
        setPicker('world');
        setQuery('');
        setPackQuantity('1');
        setPackId('');
        setLabel('');
        setRenameDraft(null);
        setKeepHistory(false);
        setError('');
        setNotice('');
        setPendingConfirmation(null);
        setBeginPrompt(null);
        setStatPreferences(null);
        setInitiativeFallbackDraft('');
        initiativeDraftDirty.current = false;
        lastPreferenceSelection.current = '';
        setEditingStats(false);
        setStatDraft([]);
        setStatSearch('');
        setLoadingStatCatalog(false);
        setLoading(true);
    }, [worldId]);

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
            ? previous : (payload.encounters.find(row => row.status !== 'completed') || payload.encounters[0])?.id || '');
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
        if (picker === 'compendium' && !packId) {
            setChoices([]); setAvailableSortFields([]); setLoadingChoices(false);
            return;
        }
        let active = true;
        setChoices([]);
        setLoadingChoices(true);
        const timer = setTimeout(() => {
            const sort: CombatManagerActorSortRequest = { nameDirection, fields: actorSortFields };
            const search = picker === 'world'
                ? api.searchManagedWorldActors(query, sort)
                : api.searchManagedPackActors(packId, query, sort);
            void search.then(payload => {
                if (active) { setChoices(payload.actors); setAvailableSortFields(payload.sortFields); }
            }).catch(cause => { if (active) setError(errorMessage(cause)); })
                .finally(() => { if (active) setLoadingChoices(false); });
        }, 180);
        return () => { active = false; clearTimeout(timer); };
    }, [allowed, picker, packId, query, nameDirection, actorSortFields]);

    const resetActorSort = () => {
        setQuery('');
        setNameDirection('asc');
        setActorSortFields([]);
    };

    const changeActorSource = (source: 'world' | 'compendium') => {
        setPicker(source);
        setPackQuantity('1');
        resetActorSort();
        setAvailableSortFields([]);
        setChoices([]);
    };

    const encounter = useMemo(() => encounters.find(row => row.id === selectedId) || null, [encounters, selectedId]);
    const selected = encounter?.participants.find(row => row.id === selectedCombatantId)
        || encounter?.participants[0] || null;
    const nameCollision = label.trim() !== '' && encounters.some(row =>
        combatManagerNameKey(row.label) === combatManagerNameKey(label));
    const renameCollision = renameDraft !== null && encounters.some(row => row.id !== renameDraft.combatId
        && combatManagerNameKey(row.label) === combatManagerNameKey(renameDraft.label));
    const statChoices = [...(statPreferences?.suggestions || []), ...(statPreferences?.available || [])]
        .filter((choice, index, all) => all.findIndex(row => row.path === choice.path && row.kind === choice.kind) === index);
    const filteredStatChoices = statChoices.map((choice, index) => ({ choice, index }))
        .filter(({ choice }) => `${choice.label} ${choice.path} ${choice.actorTypes?.join(' ') || ''}`
            .toLocaleLowerCase().includes(statSearch.trim().toLocaleLowerCase()));
    const unrolledCount = encounter?.participants.filter(row => row.initiative == null && row.actorId).length ?? 0;
    const unrolledNpcCount = encounter?.participants.filter(row => row.initiative == null && row.actorId && row.isNpc).length ?? 0;
    const rollableCount = encounter?.participants.filter(row => row.initiative == null && row.initiativeRoll.rollAvailable).length ?? 0;
    const rollableNpcCount = encounter?.participants.filter(row => row.initiative == null && row.isNpc
        && row.initiativeRoll.rollAvailable).length ?? 0;
    const scoredCount = encounter?.participants.filter(row => row.initiative != null).length ?? 0;
    const quantity = Number(packQuantity);
    const validPackQuantity = Number.isInteger(quantity) && quantity >= 1 && quantity <= 20;
    const eligibleHealthRows = encounter?.participants.filter(row => row.stats.some(stat => stat.health && stat.edit)) || [];
    const selectedHealthRows = eligibleHealthRows.filter(row => batchSelection.includes(row.id));
    const bulkSelectableRows = eligibleHealthRows.slice(0, 100);
    const allBulkRowsSelected = bulkSelectableRows.length > 0
        && bulkSelectableRows.every(row => batchSelection.includes(row.id));

    useEffect(() => {
        if (!notice) return;
        const timer = window.setTimeout(() => setNotice(''), 4000);
        return () => window.clearTimeout(timer);
    }, [notice]);

    useEffect(() => {
        setInitiativeEdit(null);
        setResourceEdit(null);
        setStatEdit(null);
        setHealthTarget(previous => previous?.combatantId === selected?.id ? previous : null);
        setHealthConflict(false);
    }, [encounter?.id, selected?.id]);

    useEffect(() => {
        setBatchSelection([]);
        setBatchModal(null);
    }, [encounter?.id]);

    useEffect(() => {
        setInitiativeEdit(previous => {
            if (!selected) return null;
            if (previous?.combatantId === selected.id
                && (previous.value !== (previous.expectedValue === null ? '' : String(previous.expectedValue)) || previous.conflict)) return previous;
            return { combatantId: selected.id, expectedValue: selected.initiative,
                value: selected.initiative === null ? '' : String(selected.initiative) };
        });
        setResourceEdit(previous => {
            if (!selected?.resource) return null;
            if (previous?.combatantId === selected.id && previous.actorId === selected.actorId
                && previous.path === selected.resource.path
                && (previous.value !== String(previous.expectedValue) || previous.conflict)) {
                // Keep the original observation while the GM has an unsaved draft.
                return previous;
            }
            return { combatantId: selected.id, actorId: selected.actorId,
                path: selected.resource.path, expectedValue: selected.resource.value,
                value: String(selected.resource.value) };
        });
    }, [selected]);

    useEffect(() => {
        if (!allowed) return;
        let active = true;
        const load = async () => {
            const { preferences } = await api.fetchManagedStatPreferences(selected?.actorId);
            if (!active) return;
            const selection = JSON.stringify({ source: preferences.source, attributes: preferences.attributes,
                initiativeFormula: preferences.initiativeFormula });
            if (lastPreferenceSelection.current && lastPreferenceSelection.current !== selection) {
                void refresh().catch(cause => setError(errorMessage(cause)));
            }
            lastPreferenceSelection.current = selection;
            setStatPreferences(previous => ({ ...preferences, available: previous?.available || [] }));
            if (!initiativeDraftDirty.current) setInitiativeFallbackDraft(preferences.initiativeFormula || '');
        };
        const reload = () => { void load().catch(cause => { if (active) setError(errorMessage(cause)); }); };
        reload();
        window.addEventListener('focus', reload);
        appSocket?.on('connect', reload);
        appSocket?.on('combatManagerPreferencesChanged', reload);
        return () => {
            active = false;
            window.removeEventListener('focus', reload);
            appSocket?.off('connect', reload);
            appSocket?.off('combatManagerPreferencesChanged', reload);
        };
    }, [allowed, worldId, selected?.actorId, appSocket, refresh]);

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

    const mutate = async (action: () => Promise<unknown>): Promise<{ ok: true } | { ok: false; cause: unknown }> => {
        setBusy(true);
        setError('');
        setNotice('');
        try { await action(); await refresh(); return { ok: true }; }
        catch (cause) {
            if (cause instanceof ApiError && cause.code === 'ENCOUNTER_BUSY') setNotice('Encounter is changing; refreshed the current state.');
            else setError(errorMessage(cause));
            // A Foundry write may have partially succeeded before the error.
            // Refresh to expose provisioning/cleaning state and safe retry.
            try { await refresh(); } catch { /* Preserve the original error. */ }
            return { ok: false, cause };
        }
        finally { setBusy(false); }
    };

    const commitStatEdit = async (edit: StatEdit, combatId: string) => {
        if (!edit.value.trim() || !Number.isFinite(Number(edit.value))) return;
        if (Number(edit.value) === edit.expectedValue) { setStatEdit(null); return; }
        const result = await mutate(() => api.updateManagedStat(combatId, edit.combatantId, edit.key, {
            value: Number(edit.value),
            expected: { actorId: edit.actorId, path: edit.path, value: edit.expectedValue },
        }));
        setStatEdit(previous => previous?.combatantId === edit.combatantId && previous.key === edit.key
            && previous.value === edit.value ? result.ok ? null
                : { ...previous, conflict: result.cause instanceof ApiError && result.cause.status === 409 } : previous);
    };

    const commitResourceEdit = async (edit: ResourceEdit, combatId: string) => {
        if (!edit.value.trim() || !Number.isFinite(Number(edit.value))
            || Number(edit.value) === edit.expectedValue) return;
        const result = await mutate(() => api.updateManagedResource(combatId, edit.combatantId, {
            value: Number(edit.value),
            expected: { actorId: edit.actorId, path: edit.path, value: edit.expectedValue },
        }));
        setResourceEdit(previous => previous?.combatantId === edit.combatantId && previous.value === edit.value
            ? result.ok ? null : { ...previous, conflict: result.cause instanceof ApiError && result.cause.status === 409 }
            : previous);
    };

    const commitInitiativeEdit = async (edit: InitiativeEdit, combatId: string) => {
        const next = edit.value.trim() === '' ? null : Number(edit.value);
        if (next !== null && !Number.isFinite(next)) return;
        if (next === edit.expectedValue) return;
        const result = await mutate(() => api.updateManagedCombatant(combatId, edit.combatantId,
            { initiative: next, expectedInitiative: edit.expectedValue }));
        setInitiativeEdit(previous => previous?.combatantId === edit.combatantId && previous.value === edit.value
            ? result.ok ? null : { ...previous, conflict: result.cause instanceof ApiError && result.cause.status === 409 }
            : previous);
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
        if (pending.kind === 'complete') {
            void mutate(() => api.completeManagedCombat(pending.combatId));
        } else if (pending.kind === 'delete') {
            void mutate(() => api.deleteManagedCombat(pending.combatId));
        } else if (pending.kind === 'reset') {
            void mutate(() => api.postManagedInitiativeReset(pending.combatId));
        } else {
            setSelectedCombatantId('');
            void mutate(() => api.removeManagedCombatant(pending.combatId, pending.combatantId));
        }
    };

    const confirmationTitle = pendingConfirmation?.kind === 'complete' ? 'Complete encounter'
            : pendingConfirmation?.kind === 'delete' ? 'Delete combat'
            : pendingConfirmation?.kind === 'reset' ? 'Reset initiative' : 'Remove participant';
    const confirmationMessage = pendingConfirmation?.kind === 'complete'
            ? pendingConfirmation.keepHistory && pendingConfirmation.status === 'active'
                ? 'Complete this encounter and retain its Combat, Folder and compendium copies as read-only history?'
                : 'Complete and delete this Combat, its verified compendium copies and its Actor Folder? Linked world Actors will remain untouched.'
            : pendingConfirmation?.kind === 'reset'
                ? `Clear initiative for all ${pendingConfirmation.scoredCount} scored combatants? This will not change the current turn.`
            : pendingConfirmation?.kind === 'delete'
                ? `Permanently delete ${pendingConfirmation.label}${pendingConfirmation.status === 'completed' ? ' from retained history' : ' even though it has not been completed'}? Its verified encounter copies and child Folder will be removed. Linked world Actors and the SheetDelver parent Folder remain untouched.`
            : pendingConfirmation?.kind === 'remove'
                ? `Remove ${pendingConfirmation.actorName} from this encounter? Its world Actor will not be deleted.`
                : '';

    const pageClass = 'sd-ui-page p-4 pb-24 font-sans md:p-8';
    const panelClass = 'sd-ui-panel-raised rounded-xl p-4 shadow-lg backdrop-blur-md';
    const inputClass = 'sd-ui-control px-3 py-2 text-sm outline-none';
    const primaryButtonClass = 'sd-ui-button sd-ui-button-primary px-4 py-2 font-bold';
    const secondaryButtonClass = 'sd-ui-button px-3 py-2 text-sm font-semibold';

    if (!isGamemaster) return (
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
                    <select aria-label="Encounter" value={selectedId} onPointerDownCapture={beginSelection}
                        onChange={event => { setSelectedId(event.target.value); setSelectedCombatantId(''); }}
                        className={`min-w-48 ${inputClass}`}>
                        {encounters.length === 0 && <option value="">No encounters</option>}
                        {encounters.map(row => <option key={row.id} value={row.id}>{row.label}{row.status === 'completed' ? ' (completed)' : ''}</option>)}
                    </select>
                </label>
            </header>

            {error && <div role="alert" className="sd-ui-panel-raised sd-ui-danger rounded p-3 text-sm">{error}</div>}
            {notice && <div role="status" className="sd-ui-inset rounded p-3 text-sm">{notice}</div>}
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
                    <button disabled={busy || loading || !label.trim() || nameCollision} onClick={() => void mutate(async () => {
                        const created = await api.createManagedCombat(label, keepHistory);
                        setSelectedId(created.encounter.id); setLabel(''); setKeepHistory(false);
                    })} className={primaryButtonClass}>Create</button>
                    {nameCollision && <span role="status" className="sd-ui-danger text-sm">A combat already exists with that name</span>}
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
                    <p className="sd-ui-muted text-xs">Choose fields found on Actors in this world or suggested by the system module. Missing values are hidden. Only source-backed numeric and resource values can be made editable; derived and text fields stay read-only. Choose one editable field as default health for the roster action.</p>
                    {statDraft.map((field, index) => <div key={`${field.key}:${index}`} className="sd-ui-inset flex flex-wrap items-center gap-2 rounded-lg p-2">
                        <input aria-label={`Stat ${index + 1} label`} value={field.label} maxLength={32} onChange={event => setStatDraft(current => current.map((row, at) => at === index ? { ...row, label: event.target.value } : row))}
                            className={`w-32 ${inputClass}`} />
                        <span className="sd-ui-muted min-w-0 flex-1 truncate text-xs" title={field.path}>{field.actorTypes?.join(', ') || 'All Actor types'} · {field.kind}</span>
                        <label className="flex items-center gap-1.5 text-xs">
                            <input type="checkbox" aria-label={`Show ${field.label} beside names`} checked={field.showInRoster === true}
                                onChange={event => setStatDraft(current => current.map((row, at) => at === index ? { ...row, showInRoster: event.target.checked } : row))}
                                style={{ accentColor: 'var(--sd-ui-accent)' }} /> Beside names
                        </label>
                        <label className="flex items-center gap-1.5 text-xs">
                            <input type="checkbox" aria-label={`Make ${field.label} editable`} checked={field.editable === true}
                                disabled={!field.path.startsWith('system.') || !['number', 'resource'].includes(field.kind)}
                                onChange={event => setStatDraft(current => current.map((row, at) => at === index
                                    ? { ...row, editable: event.target.checked ? true : undefined,
                                        health: event.target.checked ? row.health : undefined } : row))}
                                style={{ accentColor: 'var(--sd-ui-accent)' }} /> Editable
                        </label>
                        <label className="flex items-center gap-1.5 text-xs">
                            <input type="checkbox" aria-label={`Use ${field.label} as default health`} checked={field.health === true}
                                disabled={!field.path.startsWith('system.') || !['number', 'resource'].includes(field.kind)}
                                onChange={event => setStatDraft(current => current.map((row, at) => at === index
                                    ? { ...row, editable: event.target.checked ? true : row.editable,
                                        health: event.target.checked ? true : undefined }
                                    : event.target.checked ? { ...row, health: undefined } : row))}
                                style={{ accentColor: 'var(--sd-ui-accent)' }} /> Default health
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
                <div className="sd-ui-divider mt-4 border-t pt-4">
                    <h3 className="sd-ui-accent text-sm font-bold">Initiative formula fallback</h3>
                    <p className="sd-ui-muted mt-1 text-xs">Used only when the loaded system module supplies no formula for an Actor. Dice, numbers, +/− and safe @system or @derived numeric paths are supported.</p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                        <input aria-label="GM initiative fallback formula" value={initiativeFallbackDraft}
                            onChange={event => { initiativeDraftDirty.current = true; setInitiativeFallbackDraft(event.target.value); }}
                            placeholder="1d20+@system.attributes.init.value" maxLength={160}
                            className={`min-w-64 flex-1 font-mono ${inputClass}`} />
                        <button disabled={busy || !statPreferences || initiativeFallbackDraft === (statPreferences.initiativeFormula || '')}
                            onClick={() => void mutate(async () => {
                                const { preferences } = await api.saveManagedInitiativeFallback(initiativeFallbackDraft.trim() || null);
                                initiativeDraftDirty.current = false;
                                setInitiativeFallbackDraft(preferences.initiativeFormula || '');
                                setStatPreferences(previous => ({ ...preferences, available: previous?.available || [] }));
                            })} className={secondaryButtonClass}>Save fallback</button>
                    </div>
                    {statPreferences?.initiativePreview && <p className="sd-ui-muted mt-2 text-xs">
                        Selected Actor: {statPreferences.initiativePreview.source === 'module' ? 'system module'
                            : statPreferences.initiativePreview.source === 'gm' ? 'GM fallback' : 'Core default'}
                        {' · '}{statPreferences.initiativePreview.rollAvailable
                            ? statPreferences.initiativePreview.formula : 'unresolved reference; manual initiative required'}
                        {statPreferences.initiativePreview.source === 'core' && ' · Using Core default 1d20; this may not match your system.'}
                        {statPreferences.initiativePreview.source === 'module' && statPreferences.initiativeFormula
                            && ' · The saved GM fallback does not override this formula.'}
                    </p>}
                </div>
            </section>

            {encounter && <>
                <section className={`${panelClass} flex flex-wrap items-center justify-between gap-4`}>
                    <div>
                        <h2 className="sd-ui-accent text-xl font-bold">{encounter.label}</h2>
                        <p className="sd-ui-muted text-sm">{encounter.status} · round {encounter.round} · {encounter.participants.length} participants · {encounter.keepHistory ? 'retain on completion' : 'delete on completion'}</p>
                        {encounter.status === 'active' && encounter.round === 0 && (renameDraft?.combatId === encounter.id
                            ? <div className="mt-2 flex flex-wrap items-center gap-2">
                                <input aria-label="Rename encounter" value={renameDraft.label} maxLength={100}
                                    onChange={event => setRenameDraft({ combatId: encounter.id, label: event.target.value })}
                                    className={inputClass} />
                                <button disabled={busy || !renameDraft.label.trim() || renameCollision}
                                    onClick={() => void mutate(() => api.renameManagedCombat(encounter.id, renameDraft.label)).then(result => {
                                        if (result.ok) setRenameDraft(null);
                                    })} className={primaryButtonClass}>Save name</button>
                                <button disabled={busy} onClick={() => setRenameDraft(null)} className={secondaryButtonClass}>Cancel</button>
                                {renameCollision && <span role="status" className="sd-ui-danger text-sm">A combat already exists with that name</span>}
                            </div>
                            : <button disabled={busy} onClick={() => setRenameDraft({ combatId: encounter.id, label: encounter.label })}
                                className="sd-ui-accent mt-2 text-xs underline">Rename encounter</button>)}
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
                                if (activeOtherCount > 0 || unrolledCount > 0) {
                                    const unrolled = encounter.participants.filter(row => row.initiative == null && row.actorId);
                                    setBeginPrompt({ combatId: encounter.id, activeOtherCount,
                                        unrolledPlayers: unrolled.filter(row => !row.isNpc).length,
                                        unrolledNpcs: unrolled.filter(row => row.isNpc).length,
                                        unavailablePlayers: unrolled.filter(row => !row.isNpc && !row.initiativeRoll.rollAvailable).length,
                                        unavailableNpcs: unrolled.filter(row => row.isNpc && !row.initiativeRoll.rollAvailable).length });
                                    return;
                                }
                                await api.postManagedNextTurn(encounter.id);
                            });
                        }}
                            className={primaryButtonClass}>{encounter.round === 0 ? 'Begin' : 'Next turn'}</button>
                        {encounter.status !== 'completed' && !encounter.deletionRequested && <button disabled={busy} onClick={() => setPendingConfirmation({
                            kind: 'complete', combatId: encounter.id, keepHistory: encounter.keepHistory, status: encounter.status,
                        })} className="sd-ui-button sd-ui-button-danger px-3 py-2 text-sm font-semibold">{encounter.status === 'cleaning' ? 'Retry cleanup' : 'Complete'}</button>}
                        <button disabled={busy} onClick={() => setPendingConfirmation({
                            kind: 'delete', combatId: encounter.id, label: encounter.label, status: encounter.status,
                        })} className="sd-ui-button sd-ui-button-danger px-3 py-2 text-sm font-semibold">
                            {encounter.deletionRequested ? 'Retry delete' : encounter.status === 'completed' ? 'Remove history' : 'Delete combat'}
                        </button>
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
                            <button aria-pressed={picker === 'world'} onClick={() => changeActorSource('world')} className={picker === 'world' ? primaryButtonClass : secondaryButtonClass}>World Actors (link)</button>
                            <button aria-pressed={picker === 'compendium'} onClick={() => changeActorSource('compendium')} className={picker === 'compendium' ? primaryButtonClass : secondaryButtonClass}>Compendium (copy)</button>
                        </div>
                        {picker === 'compendium' && <select aria-label="Actor compendium" value={packId} onChange={event => {
                            setPackId(event.target.value); resetActorSort(); setAvailableSortFields([]); setChoices([]);
                        }}
                            className={`mb-3 w-full ${inputClass}`}>
                            <option value="">Choose Actor pack</option>
                            {packs.map(pack => <option key={pack.id} value={pack.id}>{pack.label}</option>)}
                        </select>}
                        <div className="sd-ui-inset mb-3 space-y-2 rounded-lg p-3 text-sm">
                            <div className="flex flex-wrap items-center gap-2">
                                <label htmlFor="actor-name-direction" className="sd-ui-muted">{actorSortFields.length ? 'Name tie-breaker' : 'Name'}</label>
                                <select id="actor-name-direction" aria-label="Name sort direction" value={nameDirection}
                                    onChange={event => setNameDirection(event.target.value as CombatManagerSortDirection)} className={inputClass}>
                                    <option value="asc">A–Z</option><option value="desc">Z–A</option>
                                </select>
                                <button onClick={resetActorSort} disabled={!query && nameDirection === 'asc' && actorSortFields.length === 0}
                                    className={secondaryButtonClass}>Clear filters</button>
                            </div>
                            {actorSortFields.map((field, index) => <div key={field.path} className="flex flex-wrap items-center gap-2">
                                <span className="min-w-0 flex-1 truncate" title={field.path}>
                                    {index + 1}. {availableSortFields.find(choice => choice.path === field.path)?.label || field.path}
                                </span>
                                <select aria-label={`Sort direction for ${field.path}`} value={field.direction}
                                    onChange={event => setActorSortFields(previous => previous.map((row, position) => position === index
                                        ? { ...row, direction: event.target.value as CombatManagerSortDirection } : row))} className={inputClass}>
                                    <option value="asc">Ascending</option><option value="desc">Descending</option>
                                </select>
                                <button aria-label={`Remove sort field ${field.path}`} onClick={() => setActorSortFields(previous => previous.filter((_, position) => position !== index))}
                                    className={secondaryButtonClass}>Remove</button>
                            </div>)}
                            {actorSortFields.length < 3 && <select aria-label="Add Actor stat sort" value=""
                                onChange={event => {
                                    const path = event.target.value;
                                    if (path) setActorSortFields(previous => [...previous, { path, direction: 'asc' }]);
                                }} disabled={availableSortFields.length === 0} className={`w-full ${inputClass}`}>
                                <option value="">Add sort by Actor stat…</option>
                                {availableSortFields.filter(field => !actorSortFields.some(selectedField => selectedField.path === field.path))
                                    .map(field => <option key={field.path} value={field.path}>{field.label}</option>)}
                            </select>}
                            <p className="sd-ui-muted text-xs">{!loadingChoices && availableSortFields.length === 0
                                ? 'No sortable Actor stats are available from this source. Name sorting still works.'
                                : 'Up to 3 Actor stats. Chosen stats sort first, then Name; missing values sort last.'}</p>
                        </div>
                        <label htmlFor="combat-actor-name-filter" className="sd-ui-muted mb-1 block text-sm">Filter Actors by name</label>
                        <input id="combat-actor-name-filter" type="search" aria-label="Filter Actors by name" value={query}
                            onChange={event => setQuery(event.target.value)} placeholder="Type a name to narrow the list"
                            className={`mb-3 w-full ${inputClass}`} />
                        {picker === 'compendium' && <div className="sd-ui-inset mb-3 rounded-lg p-3 text-sm">
                            <label htmlFor="combat-pack-quantity" className="mb-1 block font-semibold">Copies per Add</label>
                            <input id="combat-pack-quantity" type="number" min="1" max="20" step="1"
                                aria-label="Copies per Add" value={packQuantity}
                                onChange={event => setPackQuantity(event.target.value)} className={`w-24 ${inputClass}`} />
                            <p className="sd-ui-muted mt-1 text-xs">1–20 independent copies per Add; each gets its own Actor and turn.</p>
                        </div>}
                        <div className="max-h-80 space-y-2 overflow-y-auto">
                            {choices.map(choice => {
                                const alreadyAdded = choice.source === 'world' && encounter.participants.some(row => row.actorId === choice.id);
                                return <div key={`${choice.packId || 'world'}:${choice.id}`} className="sd-ui-inset flex items-center justify-between gap-2 rounded-lg p-2 text-sm">
                                <span className="truncate">{choice.name}<span className="sd-ui-muted ml-2 text-xs">{choice.type}</span></span>
                                <button disabled={busy || alreadyAdded || (choice.source === 'compendium' && !validPackQuantity)}
                                    onClick={() => void mutate(() => choice.source === 'world'
                                    ? api.addManagedWorldActor(encounter.id, choice.id)
                                    : api.addManagedPackActor(encounter.id, choice.packId || '', choice.id, quantity))}
                                    className={secondaryButtonClass}>{alreadyAdded ? 'Already added'
                                        : choice.source === 'compendium' && validPackQuantity && quantity > 1 ? `Add ${quantity} copies` : 'Add'}</button>
                            </div>;
                            })}
                            {choices.length === 0 && <p className="sd-ui-muted text-sm">{loadingChoices ? 'Loading Actors…' : 'No matching Actors.'}</p>}
                        </div>
                        {!loadingChoices && choices.length > 0 && <p className="sd-ui-muted mt-3 text-xs">
                            {choices.length} matching Actors, all shown in the scrollable list.
                        </p>}
                    </section>}

                    <section className={panelClass}>
                        <div className="mb-4 flex items-center gap-3">
                            <h2 className="sd-ui-accent text-lg font-bold uppercase tracking-widest">Initiative order</h2>
                            <div className="sd-ui-divider h-px flex-1 border-t" />
                        </div>
                        {encounter.status === 'active' && <div className="mb-4 flex flex-wrap items-center gap-2">
                            <button disabled={busy || rollableCount === 0} onClick={() => void mutate(() => api.postManagedInitiativeBatch(encounter.id, 'all'))}
                                className={secondaryButtonClass}>Roll {rollableCount === unrolledCount ? 'All' : 'Available'} ({rollableCount})</button>
                            <button disabled={busy || rollableNpcCount === 0} onClick={() => void mutate(() => api.postManagedInitiativeBatch(encounter.id, 'npc'))}
                                className={secondaryButtonClass}>Roll {rollableNpcCount === unrolledNpcCount ? 'NPCs' : 'Available NPCs'} ({rollableNpcCount})</button>
                            <button disabled={busy || scoredCount === 0} onClick={() => setPendingConfirmation({
                                kind: 'reset', combatId: encounter.id, scoredCount,
                            })} className={secondaryButtonClass}>Reset all ({scoredCount})</button>
                            <span className="sd-ui-muted text-xs">Only unrolled combatants; NPCs have no player owner.</span>
                        </div>}
                        {encounter.status === 'active' && statPreferences?.attributes.some(field => field.health) && <div className="mb-4 flex flex-wrap items-center gap-2">
                            <button disabled={busy || selectedHealthRows.length === 0} className={secondaryButtonClass}
                                onClick={() => setBatchModal({
                                    targets: selectedHealthRows.map(row => {
                                        const edit = row.stats.find(stat => stat.health && stat.edit)!.edit!;
                                        return { combatantId: row.id, statKey: edit.key,
                                            expected: { actorId: row.actorId, path: edit.path, value: edit.value } };
                                    }),
                                    names: selectedHealthRows.map(row => row.name),
                                })}>Damage / Heal selected ({selectedHealthRows.length})</button>
                            <span className="sd-ui-muted text-xs">Select up to 100 participants with editable Default health.</span>
                        </div>}
                        {encounter.status === 'active' && statPreferences?.attributes.some(field => field.health) && <div className="mb-2 flex items-center gap-2 px-1">
                            <button disabled={busy || bulkSelectableRows.length === 0 || allBulkRowsSelected}
                                onClick={() => setBatchSelection(bulkSelectableRows.map(row => row.id))}
                                className="sd-ui-button ml-2 px-2 py-1 text-xs font-semibold">
                                {eligibleHealthRows.length > 100 ? 'Select first 100' : 'Select all'}
                            </button>
                            <button disabled={busy || selectedHealthRows.length === 0} onClick={() => setBatchSelection([])}
                                className="sd-ui-button px-2 py-1 text-xs font-semibold">Deselect all</button>
                        </div>}
                        <div className="space-y-2">
                            {encounter.participants.map(row => {
                                const health = row.stats.find(stat => stat.health && stat.edit);
                                return <div key={row.id}
                                className={`${selected?.id === row.id ? 'sd-ui-inset' : 'sd-ui-panel-raised'} flex w-full items-center gap-1 rounded-lg p-1 transition-colors ${row.isCurrent ? 'ring-2 ring-[var(--sd-ui-accent)]' : ''}`}>
                                {encounter.status === 'active' && statPreferences?.attributes.some(field => field.health) && <input
                                    type="checkbox" aria-label={`Select ${row.name} for batch health`}
                                    title={health?.edit ? `Select ${row.name}` : 'No editable default health for this Actor'}
                                    checked={!!health?.edit && batchSelection.includes(row.id)}
                                    disabled={busy || !health?.edit || (!batchSelection.includes(row.id) && selectedHealthRows.length >= 100)}
                                    onChange={event => {
                                        const checked = event.target.checked;
                                        setBatchSelection(current => {
                                            const valid = current.filter(id => eligibleHealthRows.some(choice => choice.id === id));
                                            return checked ? [...new Set([...valid, row.id])].slice(0, 100)
                                                : valid.filter(id => id !== row.id);
                                        });
                                    }}
                                    style={{ accentColor: 'var(--sd-ui-accent)' }} className="ml-2 shrink-0" />}
                                <button onPointerDownCapture={beginSelection} onClick={() => setSelectedCombatantId(row.id)}
                                    className="flex min-w-0 flex-1 items-center gap-3 rounded-lg p-2 text-left">
                                <span className="w-10 text-center font-mono text-lg">{row.initiative ?? '—'}</span>
                                <span className="sd-ui-inset flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg"
                                    aria-hidden="true">
                                    {row.img ? <img src={row.img} alt="" className="h-full w-full object-cover" />
                                        : <UserRound className="sd-ui-muted h-5 w-5" />}
                                </span>
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
                                </button>
                                {encounter.status === 'active' && <div className="flex shrink-0 items-center gap-1">
                                    <button disabled={busy} aria-pressed={row.hidden}
                                        aria-label={`${row.hidden ? 'Reveal' : 'Hide'} ${row.name} in player combat HUD`}
                                        onClick={() => void mutate(() => api.updateManagedCombatant(encounter.id, row.id, { hidden: !row.hidden }))}
                                        className="sd-ui-button px-2 py-2 text-xs font-semibold">{row.hidden ? 'Reveal' : 'Hide'}</button>
                                    <button disabled={busy || !row.initiativeRoll.rollAvailable}
                                        title={row.initiativeRoll.rollAvailable ? `Uses ${row.initiativeRoll.source} initiative formula` : 'Formula unavailable; enter initiative manually'}
                                        onClick={() => void mutate(() => api.postManagedInitiativeOne(encounter.id, row.id))}
                                        aria-label={`${row.initiative == null ? 'Roll' : 'Reroll'} initiative for ${row.name}`}
                                        className="sd-ui-button px-2 py-2 text-xs font-semibold">{row.initiative == null ? 'Roll' : 'Reroll'}</button>
                                    <button disabled={busy || row.initiative == null}
                                        onClick={() => void mutate(() => api.updateManagedCombatant(encounter.id, row.id, { initiative: null }))}
                                        aria-label={`Clear initiative for ${row.name}`}
                                        className="sd-ui-button px-2 py-2 text-xs font-semibold">Clear</button>
                                </div>}
                                {encounter.status === 'active' && statPreferences?.attributes.some(field => field.health) && <button disabled={busy || !health?.edit}
                                        title={health?.edit ? `Adjust ${health.title} for ${row.name}` : 'No editable health source for this Actor'}
                                        aria-label={`Damage or heal ${row.name}`}
                                        onPointerDownCapture={beginSelection}
                                        onClick={() => {
                                            if (!health?.edit) return;
                                            setSelectedCombatantId(row.id);
                                            setHealthTarget({ combatantId: row.id, actorId: row.actorId, name: row.name,
                                                label: health.title, key: health.edit.key, path: health.edit.path,
                                                current: health.edit.value, max: health.edit.max });
                                        }} className="sd-ui-button flex shrink-0 items-center gap-1.5 px-2 py-2 text-xs font-semibold">
                                        <Swords aria-hidden="true" className="h-4 w-4" /> Damage
                                    </button>}
                            </div>; })}
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
                                <span className="sd-ui-muted col-span-full text-xs font-semibold uppercase tracking-wider">Basic stats</span>
                                {selected.stats.map((stat, index) => <div key={`${stat.title}:${index}`} className="sd-ui-inset min-w-0 rounded-lg px-3 py-2">
                                    <span className="sd-ui-muted block truncate text-[10px] font-bold uppercase tracking-wider" title={stat.title}>{stat.title}</span>
                                    {stat.edit && encounter.status === 'active' ? <div className="mt-1 flex flex-wrap items-center gap-1">
                                        <input type="number" aria-label={`Edit ${stat.title}`} className={`min-w-0 w-24 ${inputClass}`}
                                            value={statEdit?.combatantId === selected.id && statEdit.key === stat.edit.key
                                                && statEdit.actorId === selected.actorId && statEdit.path === stat.edit.path
                                                && (statEdit.value !== String(statEdit.expectedValue) || statEdit.conflict)
                                                ? statEdit.value : String(stat.edit.value)}
                                            onChange={event => setStatEdit(previous => previous?.combatantId === selected.id
                                                && previous.key === stat.edit?.key && previous.actorId === selected.actorId
                                                && previous.path === stat.edit?.path
                                                && (previous.value !== String(previous.expectedValue) || previous.conflict)
                                                ? { ...previous, value: event.target.value }
                                                : { combatantId: selected.id, actorId: selected.actorId, key: stat.edit!.key,
                                                    path: stat.edit!.path, expectedValue: stat.edit!.value, value: event.target.value })}
                                            onBlur={() => {
                                                if (statEdit?.combatantId === selected.id && statEdit.key === stat.edit?.key
                                                    && statEdit.actorId === selected.actorId && statEdit.path === stat.edit?.path) {
                                                    if (!statEdit.conflict && !discardBlurForSelection.current) void commitStatEdit(statEdit, encounter.id);
                                                }
                                            }}
                                            onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}
                                            disabled={busy} />
                                        {statEdit?.combatantId === selected.id && statEdit.key === stat.edit.key
                                            && statEdit.conflict && <span className="sd-ui-danger text-xs">Now {stat.edit.value}.
                                                <button disabled={busy} className="ml-1 underline" onMouseDown={event => event.preventDefault()}
                                                    onClick={() => void commitStatEdit({ ...statEdit, expectedValue: stat.edit!.value, conflict: false }, encounter.id)}>Retry</button>
                                                <button className="ml-1 underline" onClick={() => setStatEdit(null)}>Cancel</button>
                                            </span>}
                                        {stat.subValue !== undefined && <span className="sd-ui-muted text-xs">{stat.subValue}</span>}
                                    </div> : <span className="block truncate text-sm font-semibold" title={`${stat.value}${stat.subValue ?? ''}`}>{stat.value}{stat.subValue !== undefined && <span className="sd-ui-muted ml-1 font-normal">{stat.subValue}</span>}</span>}
                                </div>)}
                            </div>}
                            {selected.effects.length > 0 && <p className="text-sm opacity-80">Effects: {selected.effects.join(', ')}</p>}
                            <div className="flex flex-wrap items-end gap-3">
                                <label className="text-sm">Initiative<input type="number"
                                    value={initiativeEdit?.combatantId === selected.id ? initiativeEdit.value : selected.initiative ?? ''}
                                    onChange={event => setInitiativeEdit(previous => previous?.combatantId === selected.id
                                        ? { ...previous, value: event.target.value }
                                        : { combatantId: selected.id, expectedValue: selected.initiative, value: event.target.value })}
                                    onBlur={() => {
                                        if (initiativeEdit?.combatantId === selected.id && !initiativeEdit.conflict && !discardBlurForSelection.current)
                                            void commitInitiativeEdit(initiativeEdit, encounter.id);
                                    }}
                                    onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}
                                    disabled={busy || encounter.status !== 'active'}
                                    className={`mt-1 block w-24 ${inputClass}`} /></label>
                                {initiativeEdit?.combatantId === selected.id && initiativeEdit.conflict && <span className="sd-ui-danger text-xs">
                                    Now {selected.initiative ?? 'unrolled'}.
                                    <button disabled={busy} className="ml-1 underline" onMouseDown={event => event.preventDefault()}
                                        onClick={() => void commitInitiativeEdit({ ...initiativeEdit, expectedValue: selected.initiative, conflict: false }, encounter.id)}>Retry</button>
                                    <button className="ml-1 underline" onClick={() => setInitiativeEdit(null)}>Cancel</button>
                                </span>}
                                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={selected.hidden} disabled={busy || encounter.status !== 'active'} style={{ accentColor: 'var(--sd-ui-accent)' }}
                                    onChange={event => void mutate(() => api.updateManagedCombatant(encounter.id, selected.id, { hidden: event.target.checked }))} /> Hidden</label>
                                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={selected.defeated} disabled={busy || encounter.status !== 'active'} style={{ accentColor: 'var(--sd-ui-accent)' }}
                                    onChange={event => void mutate(() => api.updateManagedCombatant(encounter.id, selected.id, { defeated: event.target.checked }))} /> Defeated</label>
                                {encounter.status === 'active' && selected.initiativeRoll.advantageAvailable && <span className="flex flex-wrap gap-1">
                                    <button disabled={busy} className={secondaryButtonClass}
                                        onClick={() => void mutate(() => api.postManagedInitiativeOne(encounter.id, selected.id, 'advantage'))}>Roll advantage</button>
                                    <button disabled={busy} className={secondaryButtonClass}
                                        onClick={() => void mutate(() => api.postManagedInitiativeOne(encounter.id, selected.id, 'disadvantage'))}>Roll disadvantage</button>
                                </span>}
                            </div>
                            {selected.resource && <div className="flex flex-wrap items-end gap-3">
                                <label className="text-sm">Tracked resource <span className="sd-ui-muted">({selected.resource.path})</span>
                                    <input type="number" value={resourceEdit?.combatantId === selected.id ? resourceEdit.value : selected.resource.value}
                                        onChange={event => setResourceEdit(previous => previous?.combatantId === selected.id
                                            ? { ...previous, value: event.target.value }
                                            : { combatantId: selected.id, actorId: selected.actorId, path: selected.resource!.path,
                                                expectedValue: selected.resource!.value, value: event.target.value })}
                                        onBlur={() => { if (resourceEdit?.combatantId === selected.id && !resourceEdit.conflict
                                            && !discardBlurForSelection.current) void commitResourceEdit(resourceEdit, encounter.id); }}
                                        onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}
                                        disabled={busy || encounter.status !== 'active'}
                                        className={`mt-1 block w-28 ${inputClass}`} /></label>
                                {selected.resource.max !== null && <span className="sd-ui-muted pb-2 text-sm">Max {selected.resource.max}</span>}
                                {resourceEdit?.combatantId === selected.id && resourceEdit.conflict && <span className="sd-ui-danger text-xs">
                                    Now {selected.resource.value}.
                                    <button disabled={busy} className="ml-1 underline" onMouseDown={event => event.preventDefault()}
                                        onClick={() => void commitResourceEdit({ ...resourceEdit, expectedValue: selected.resource!.value, conflict: false }, encounter.id)}>Retry</button>
                                    <button className="ml-1 underline" onClick={() => setResourceEdit(null)}>Cancel</button>
                                </span>}
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
                confirmLabel={pendingConfirmation?.kind === 'delete' ? 'Delete'
                    : pendingConfirmation?.kind === 'remove' ? 'Remove'
                    : pendingConfirmation?.kind === 'reset' ? 'Reset all' : 'Complete'}
                isDanger
                onConfirm={confirmPending}
                onCancel={() => setPendingConfirmation(null)}
            />
            <CombatBeginModal prompt={beginPrompt} busy={busy} onCancel={() => setBeginPrompt(null)}
                onChoose={choice => {
                    if (!beginPrompt) return;
                    const combatId = beginPrompt.combatId;
                    setBeginPrompt(null);
                    void mutate(async () => {
                        if (choice !== 'anyway') await api.postManagedInitiativeBatch(combatId, choice);
                        await api.postManagedNextTurn(combatId);
                    });
                }} />
            <CombatHealthModal target={healthTarget} busy={busy} conflict={healthConflict}
                observedCurrent={encounter?.participants.find(row => row.id === healthTarget?.combatantId)
                    ?.stats.find(stat => stat.edit?.key === healthTarget?.key)?.edit?.value}
                onClose={() => { setHealthTarget(null); setHealthConflict(false); }}
                onApply={(target, value, retry) => {
                    if (!encounter || encounter.status !== 'active') return;
                    const observed = encounter.participants.find(row => row.id === target.combatantId)
                        ?.stats.find(stat => stat.edit?.key === target.key)?.edit?.value;
                    if (retry && observed === undefined) return;
                    void mutate(() => api.updateManagedStat(encounter.id, target.combatantId, target.key, {
                        value, expected: { actorId: target.actorId, path: target.path, value: retry ? observed! : target.current },
                    })).then(result => {
                        if (result.ok) { setHealthTarget(null); setHealthConflict(false); }
                        else if (result.cause instanceof ApiError && result.cause.status === 409) setHealthConflict(true);
                    });
                }} />
            <CombatBatchHealthModal targets={batchModal?.targets || null} names={batchModal?.names || []}
                busy={busy} onClose={() => setBatchModal(null)}
                onApply={(operation, amount) => {
                    if (!encounter || !batchModal) return;
                    void mutate(() => api.applyManagedHealthBatch(encounter.id, {
                        operation, amount, targets: batchModal.targets,
                    })).then(result => {
                        setBatchModal(null);
                        if (result.ok) setBatchSelection([]);
                    });
                }} />
          </div>
        </main>
    );
}
