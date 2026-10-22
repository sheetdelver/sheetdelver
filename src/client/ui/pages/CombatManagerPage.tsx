'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { CompendiumReferenceLink } from '@client/ui/components/CompendiumReferenceLink';
import { DisplayArtwork } from '@client/ui/components/DisplayArtwork';
import { Swords, UserRound } from 'lucide-react';
import { useWorldBackground } from '@client/ui/main/hooks/useWorldBackground';
import { useFoundry } from '@client/ui/context/FoundryContext';
import { ConfirmationModal } from '@client/ui/components/ConfirmationModal';
import { SafeHtmlContent } from '@client/ui/components/SafeHtmlContent';
import { sanitizeRichHtml } from '@shared/security/safeHtml';
import { ApiError } from '@client/ui/api/http';
import { CombatHealthModal, type CombatHealthTarget } from './CombatHealthModal';
import { CombatBatchHealthModal } from './CombatBatchHealthModal';
import { CombatBeginModal, type CombatBeginChoice } from './CombatBeginModal';
import { CombatStatAttributeEditor } from './CombatStatAttributeEditor';
import * as api from '@client/ui/api/foundryApi';
import { combatManagerNameKey } from '@shared/contracts/combatManager';
import { isSafeCombatStatPath, parseCombatStatSelection } from '@shared/contracts/combatStatAttributes';
import { insertInitiativeAttribute } from './combatInitiativeDraft';
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
    CombatManagerStatKind,
    CombatManagerStatLayout,
} from '@shared/contracts/combatManager';

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'The request failed';
}

function statChoiceContext(choice: CombatManagerSelectedStatDto & { observedActorTypes?: string[] }): string {
    const actorContext = choice.actorTypes?.length ? choice.actorTypes.join(', ')
        : choice.observedActorTypes?.length ? `seen on ${choice.observedActorTypes.join(', ')}`
            : 'all Actor types';
    return `${choice.path} · ${choice.kind} · ${actorContext}`;
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
    const bgStyle = useWorldBackground();
    const isGamemaster = (currentUser?.role ?? 0) >= 3;
    const allowed = step === 'dashboard' && isGamemaster;
    const [encounters, setEncounters] = useState<CombatManagerEncounterDto[]>([]);
    const [selectedId, setSelectedId] = useState('');
    const [selectedCombatantId, setSelectedCombatantId] = useState('');
    const [label, setLabel] = useState('');
    const [renameDraft, setRenameDraft] = useState<{ combatId: string; label: string } | null>(null);
    const [keepHistory, setKeepHistory] = useState(false);
    const [autoSkipDefeatedEnemies, setAutoSkipDefeatedEnemies] = useState(false);
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
    const [initiativeFormulaError, setInitiativeFormulaError] = useState('');
    const [pickingInitiativeAttribute, setPickingInitiativeAttribute] = useState(false);
    const [initiativeAttributeSearch, setInitiativeAttributeSearch] = useState('');
    const [initiativeAttributeChoice, setInitiativeAttributeChoice] = useState('');
    const [editingStats, setEditingStats] = useState(false);
    const [statDraft, setStatDraft] = useState<CombatManagerSelectedStatDto[]>([]);
    const [statChoice, setStatChoice] = useState('');
    const [statSearch, setStatSearch] = useState('');
    const [loadingStatCatalog, setLoadingStatCatalog] = useState(false);
    const [customPath, setCustomPath] = useState('');
    const [customLabel, setCustomLabel] = useState('');
    const [customKind, setCustomKind] = useState<CombatManagerStatKind>('number');
    const [customLayout, setCustomLayout] = useState<CombatManagerStatLayout>({ columnSpan: 1, rowSpan: 1, textRows: 4 });
    const [customContentFormat, setCustomContentFormat] = useState<'plain' | 'html'>('plain');
    const [editingAttributeKey, setEditingAttributeKey] = useState<string | null>(null);
    const [attributeEditorOpen, setAttributeEditorOpen] = useState(false);
    const attributeEditor = useRef<HTMLDetailsElement>(null);
    const [customStatError, setCustomStatError] = useState('');
    const [validatingCustomStat, setValidatingCustomStat] = useState(false);
    const [busy, setBusy] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null);
    const [beginPrompt, setBeginPrompt] = useState<CombatBeginChoice | null>(null);
    const refreshVersion = useRef(0);
    const lastPreferenceSelection = useRef('');
    const initiativeDraftDirty = useRef(false);
    const initiativeInput = useRef<HTMLInputElement>(null);
    const initiativeSelection = useRef<{ start: number; end: number } | null>(null);
    const pendingInitiativeCursor = useRef<number | null>(null);
    const customValidationVersion = useRef(0);
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
        setInitiativeFormulaError('');
        setPickingInitiativeAttribute(false);
        setInitiativeAttributeSearch('');
        setInitiativeAttributeChoice('');
        initiativeSelection.current = null;
        pendingInitiativeCursor.current = null;
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
        setCustomPath('');
        setCustomLabel('');
        setCustomKind('number');
        setCustomStatError('');
        setValidatingCustomStat(false);
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
        setSelectedId(previous => {
            if (payload.encounters.some(row => row.id === previous)) return previous;
            const requested = new URLSearchParams(window.location.search).get('combat');
            if (requested && payload.encounters.some(row => row.id === requested)) return requested;
            return (payload.encounters.find(row => row.status !== 'completed') || payload.encounters[0])?.id || '';
        });
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
    const initiativeAttributes = (statPreferences?.available || []).filter(field =>
        field.kind === 'number' && isSafeCombatStatPath(field.path));
    const filteredInitiativeAttributes = initiativeAttributes.filter(field =>
        `${field.label} ${field.path} ${field.observedActorTypes.join(' ')}`
            .toLocaleLowerCase().includes(initiativeAttributeSearch.trim().toLocaleLowerCase()));
    const customDisabledReason = !customLabel.trim() ? 'Enter a label for the custom stat.'
        : !customPath.trim() ? 'Enter an Actor attribute path.'
        : !isSafeCombatStatPath(customPath.trim()) ? 'Use a safe system.* or derived.* path, without @.' : '';
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
            if (!initiativeDraftDirty.current) {
                setInitiativeFallbackDraft(preferences.initiativeFormula || '');
                initiativeSelection.current = null;
            }
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
    }, [allowed, worldId, selected?.actorId, appSocket, refresh, statPreferences?.initiativeFormula]);

    useEffect(() => {
        if (!allowed || !(editingStats || pickingInitiativeAttribute)) return;
        let active = true;
        setLoadingStatCatalog(true);
        setInitiativeAttributeChoice('');
        setStatPreferences(previous => previous ? { ...previous, available: [] } : previous);
        void api.fetchManagedStatPreferences(selected?.actorId, true).then(({ preferences }) => {
            if (active) setStatPreferences(preferences);
        }).catch(cause => {
            if (active) setError(errorMessage(cause));
        }).finally(() => { if (active) setLoadingStatCatalog(false); });
        return () => { active = false; };
    }, [allowed, editingStats, pickingInitiativeAttribute, selected?.actorId, worldId]);

    useEffect(() => {
        const cursor = pendingInitiativeCursor.current;
        if (cursor === null || !initiativeInput.current) return;
        pendingInitiativeCursor.current = null;
        initiativeInput.current.focus();
        initiativeInput.current.setSelectionRange(cursor, cursor);
    }, [initiativeFallbackDraft]);

    const insertInitiativeField = () => {
        const field = initiativeAttributes.find(row => row.path === initiativeAttributeChoice);
        if (!field || loadingStatCatalog || busy) return;
        try {
            const insertion = insertInitiativeAttribute(initiativeFallbackDraft, field.path, initiativeSelection.current);
            initiativeDraftDirty.current = true;
            pendingInitiativeCursor.current = insertion.cursor;
            initiativeSelection.current = { start: insertion.cursor, end: insertion.cursor };
            setInitiativeFallbackDraft(insertion.value);
            setInitiativeAttributeChoice('');
            setInitiativeFormulaError('');
        } catch (cause) { setInitiativeFormulaError(errorMessage(cause)); }
    };

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

    const addStat = (choice: CombatManagerSelectedStatDto) => {
        setStatDraft(current => {
            const keys = new Set(current.map(row => row.key));
            let key = choice.key, suffix = 2;
            while (keys.has(key)) {
                const tail = `_${suffix++}`;
                key = `${choice.key.slice(0, 32 - tail.length)}${tail}`;
            }
            return [...current, { key, label: choice.label, path: choice.path,
                kind: choice.kind, ...(choice.actorTypes ? { actorTypes: choice.actorTypes } : {}),
                ...(choice.layout ? { layout: choice.layout } : {}),
                ...(choice.contentFormat ? { contentFormat: choice.contentFormat } : {}),
                ...(choice.showInRoster === true ? { showInRoster: true } : {}) }];
        });
    };

    useEffect(() => {
        customValidationVersion.current += 1;
        setValidatingCustomStat(false);
        setCustomStatError('');
        setEditingAttributeKey(null); setCustomLabel(''); setCustomPath('');
        setCustomContentFormat('plain');
        return () => { customValidationVersion.current += 1; };
    }, [allowed, worldId, editingStats]);

    const invalidateCustomValidation = () => {
        customValidationVersion.current += 1;
        setCustomStatError('');
        setValidatingCustomStat(false);
    };

    const addCustomStat = async () => {
        if (customDisabledReason || validatingCustomStat || busy) return;
        const version = ++customValidationVersion.current;
        const label = customLabel.trim();
        setValidatingCustomStat(true);
        setCustomStatError('');
        try {
            const existing = statDraft.find(row => row.key === editingAttributeKey);
            const draft = { ...existing, key: existing?.key ?? 'custom', label, path: customPath.trim(),
                kind: customKind, layout: customLayout,
                contentFormat: customKind === 'textarea' ? customContentFormat : undefined,
                ...(customKind === 'textarea' ? { showInRoster: undefined } : {}),
                ...(!['number', 'resource'].includes(customKind) || !customPath.trim().startsWith('system.')
                    ? { editable: undefined, health: undefined } : {}),
            };
            if (!parseCombatStatSelection([draft])) throw new Error('Invalid stat label, type or detail layout');
            const { attribute } = await api.validateManagedStatPath(customPath.trim(), customKind);
            if (version !== customValidationVersion.current) return;
            if (editingAttributeKey) {
                if (!existing) throw new Error('This stat was removed; choose it again before editing');
                setStatDraft(current => current.map(row => row.key === existing.key ? { ...draft, path: attribute.path } : row));
                setEditingAttributeKey(null);
            } else addStat({ ...draft, path: attribute.path });
            setCustomLabel(''); setCustomPath('');
            setCustomContentFormat('plain');
        } catch (cause) {
            if (version === customValidationVersion.current) setCustomStatError(errorMessage(cause));
        } finally {
            if (version === customValidationVersion.current) setValidatingCustomStat(false);
        }
    };

    const editAttribute = (field: CombatManagerSelectedStatDto) => {
        invalidateCustomValidation();
        setEditingAttributeKey(field.key); setCustomLabel(field.label); setCustomPath(field.path); setCustomKind(field.kind);
        setCustomLayout(field.layout ?? { columnSpan: 1, rowSpan: 1, textRows: 4 }); setAttributeEditorOpen(true);
        setCustomContentFormat(field.contentFormat ?? 'plain');
        window.requestAnimationFrame(() => {
            attributeEditor.current?.scrollIntoView({ block: 'nearest' });
            attributeEditor.current?.querySelector<HTMLInputElement>('input')?.focus();
        });
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
                <p className="mt-3">This tool is available to Gamemasters and Assistants.</p>
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
                    <p className="sd-ui-muted mt-1 text-sm">GM & Assistant · tokenless Foundry encounters</p>
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
                    <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={autoSkipDefeatedEnemies}
                        onChange={event => setAutoSkipDefeatedEnemies(event.target.checked)} style={{ accentColor: 'var(--sd-ui-accent)' }} /> Skip defeated enemies automatically</label>
                    <button disabled={busy || loading || !label.trim() || nameCollision} onClick={() => void mutate(async () => {
                        const created = await api.createManagedCombat(label, keepHistory, autoSkipDefeatedEnemies);
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
                    <button disabled={!statPreferences || busy} onClick={() => { invalidateCustomValidation(); setStatDraft(statPreferences?.attributes || []); setEditingStats(value => !value); }}
                        className={secondaryButtonClass}>{editingStats ? 'Close configuration' : 'Configure stats'}</button>
                </div>
                {editingStats && <div className="sd-ui-divider mt-4 space-y-3 border-t pt-4">
                    <p className="sd-ui-muted text-xs">Choose fields found on Actors in this world or suggested by the system module. Missing values are hidden. Only source-backed numeric and resource values can be made editable; derived and text fields stay read-only. Choose one editable field as default health for the roster action.</p>
                    {statDraft.map((field, index) => <fieldset disabled={busy || validatingCustomStat} key={`${field.key}:${index}`} className="sd-ui-inset flex min-w-0 flex-wrap items-center gap-2 rounded-lg p-2">
                        <input aria-label={`Stat ${index + 1} label`} value={field.label} maxLength={32} onChange={event => setStatDraft(current => current.map((row, at) => at === index ? { ...row, label: event.target.value } : row))}
                            className={`w-32 ${inputClass}`} />
                        <span className="sd-ui-muted min-w-0 flex-1 break-all text-xs">{statChoiceContext(field)}</span>
                        <label className="flex items-center gap-1.5 text-xs">
                            <input type="checkbox" aria-label={`Show ${field.label} beside names`} checked={field.showInRoster === true}
                                disabled={field.kind === 'textarea'}
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
                        <button type="button" onClick={() => editAttribute(field)} className={secondaryButtonClass} aria-label={`Edit ${field.label} presentation`}>Edit</button>
                        <button onClick={() => {
                            if (editingAttributeKey === field.key) { invalidateCustomValidation(); setEditingAttributeKey(null); setCustomLabel(''); setCustomPath(''); }
                            setStatDraft(current => current.filter((_, at) => at !== index));
                        }} className={secondaryButtonClass} aria-label={`Remove ${field.label}`}>Remove</button>
                    </fieldset>)}
                    <div className="flex flex-wrap items-center gap-2">
                        <input aria-label="Find an Actor field" placeholder="Search Actor fields" value={statSearch}
                            onChange={event => { setStatSearch(event.target.value); setStatChoice(''); }} className={`min-w-48 ${inputClass}`} />
                        <select aria-label="Suggested or available stat" value={statChoice} onChange={event => setStatChoice(event.target.value)} className={`min-w-56 ${inputClass}`}>
                            <option value="">Choose a field</option>
                            {filteredStatChoices.map(({ choice, index }) => <option key={`${choice.path}:${choice.kind}`} value={index}>
                                {choice.label} ({statChoiceContext(choice)})
                            </option>)}
                        </select>
                        <button disabled={busy || validatingCustomStat || loadingStatCatalog || statChoice === ''} onClick={() => { addStat(statChoices[Number(statChoice)]); setStatChoice(''); }} className={secondaryButtonClass}>Add field</button>
                    </div>
                    {loadingStatCatalog && <p className="sd-ui-muted text-xs">Finding Actor fields…</p>}
                    {!loadingStatCatalog && statChoices.length === 0 && <p className="sd-ui-muted text-xs">No Actor fields are available yet. Add a world or compendium Actor, then reopen this configuration.</p>}
                    <details ref={attributeEditor} open={attributeEditorOpen} onToggle={event => setAttributeEditorOpen(event.currentTarget.open)} className="sd-ui-inset rounded-lg p-3 text-xs">
                        <summary className="cursor-pointer">{editingAttributeKey ? 'Edit attribute presentation' : 'Advanced: enter an attribute path manually'}</summary>
                        <div className="mt-3"><CombatStatAttributeEditor value={{ label: customLabel, path: customPath, kind: customKind, layout: customLayout, contentFormat: customContentFormat }}
                            onChange={draft => { invalidateCustomValidation(); setCustomLabel(draft.label); setCustomPath(draft.path); setCustomKind(draft.kind); setCustomLayout(draft.layout); setCustomContentFormat(draft.contentFormat ?? 'plain'); }}
                            onApply={() => void addCustomStat()} onCancel={() => { invalidateCustomValidation(); setEditingAttributeKey(null); setCustomLabel(''); setCustomPath(''); setCustomContentFormat('plain'); }}
                            editing={editingAttributeKey !== null} disabled={busy} checking={validatingCustomStat} reason={customDisabledReason}
                            error={customStatError} inputClass={inputClass} buttonClass={secondaryButtonClass} /></div>
                    </details>
                    <div className="flex flex-wrap gap-2">
                        <button disabled={busy || validatingCustomStat || editingAttributeKey !== null} onClick={() => void mutate(async () => {
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
                    <h3 className="sd-ui-accent text-sm font-bold">Initiative formula override</h3>
                    <p id="initiative-formula-help" className="sd-ui-muted mt-1 text-xs">A saved override takes precedence over the system module and Core. Clear and save to use the module, then Core. Save validates dice, numbers, +/− and safe numeric @system or @derived paths against all current encounter participants.</p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                        <input ref={initiativeInput} aria-label="GM initiative override formula" value={initiativeFallbackDraft}
                            aria-invalid={!!initiativeFormulaError}
                            aria-describedby={`initiative-formula-help${initiativeFormulaError ? ' initiative-formula-error' : ''}`}
                            onChange={event => { initiativeDraftDirty.current = true; setInitiativeFormulaError(''); setInitiativeFallbackDraft(event.target.value); }}
                            onSelect={event => { initiativeSelection.current = {
                                start: event.currentTarget.selectionStart ?? event.currentTarget.value.length,
                                end: event.currentTarget.selectionEnd ?? event.currentTarget.value.length,
                            }; }}
                            placeholder="1d20 + …" maxLength={160}
                            className={`min-w-0 flex-1 basis-64 font-mono ${inputClass}`} />
                        <button disabled={busy || !statPreferences || initiativeFallbackDraft === (statPreferences.initiativeFormula || '')}
                            onClick={() => void mutate(async () => {
                                setInitiativeFormulaError('');
                                const { preferences } = await api.saveManagedInitiativeFallback(initiativeFallbackDraft.trim() || null);
                                initiativeDraftDirty.current = false;
                                setInitiativeFallbackDraft(preferences.initiativeFormula || '');
                                setStatPreferences(previous => ({ ...preferences, available: previous?.available || [] }));
                            }).then(result => { if (!result.ok) setInitiativeFormulaError(errorMessage(result.cause)); })}
                            className={secondaryButtonClass}>Save</button>
                        <button disabled={busy || !statPreferences} aria-expanded={pickingInitiativeAttribute}
                            aria-controls="initiative-attribute-picker"
                            onClick={() => setPickingInitiativeAttribute(value => !value)} className={secondaryButtonClass}>
                            {pickingInitiativeAttribute ? 'Close attributes' : 'Insert attribute'}
                        </button>
                    </div>
                    {pickingInitiativeAttribute && <div id="initiative-attribute-picker" className="sd-ui-inset mt-3 space-y-2 rounded-lg p-3">
                        <p className="sd-ui-muted text-xs">Type a dice formula, then choose a numeric Actor field to insert at the cursor or replace selected text. Choosing a field does not save; Save checks all current participants.</p>
                        <div className="flex flex-wrap items-center gap-2">
                            <input aria-label="Find an initiative attribute" placeholder="Search numeric fields" value={initiativeAttributeSearch}
                                onChange={event => { setInitiativeAttributeSearch(event.target.value); setInitiativeAttributeChoice(''); }}
                                className={`min-w-0 flex-1 basis-48 ${inputClass}`} />
                            <select aria-label="Numeric initiative attribute" value={initiativeAttributeChoice} disabled={loadingStatCatalog || busy}
                                onChange={event => setInitiativeAttributeChoice(event.target.value)} className={`min-w-0 max-w-full flex-1 basis-64 ${inputClass}`}>
                                <option value="">Choose a numeric field</option>
                                {filteredInitiativeAttributes.map(field => <option key={field.path} value={field.path}>
                                    {field.label} ({statChoiceContext(field)})
                                </option>)}
                            </select>
                            <button disabled={busy || loadingStatCatalog || !initiativeAttributeChoice} onClick={insertInitiativeField}
                                className={secondaryButtonClass}>Insert into formula</button>
                        </div>
                        {loadingStatCatalog && <p role="status" className="sd-ui-muted text-xs">Finding numeric Actor fields…</p>}
                        {!loadingStatCatalog && !filteredInitiativeAttributes.length && <p className="sd-ui-muted text-xs">
                            {initiativeAttributeSearch.trim() ? 'No numeric fields match your search.' : 'No numeric fields are available yet. Add an Actor and reopen the picker.'}
                        </p>}
                    </div>}
                    {initiativeFormulaError && <p id="initiative-formula-error" role="alert" className="sd-ui-danger mt-2 break-words text-xs">{initiativeFormulaError}</p>}
                    {statPreferences?.initiativePreview && <p className="sd-ui-muted mt-2 text-xs">
                        Selected Actor: {statPreferences.initiativePreview.source === 'module' ? 'system module'
                            : statPreferences.initiativePreview.source === 'gm' ? 'GM override' : 'Core default'}
                        {' · '}{statPreferences.initiativePreview.rollAvailable
                            ? statPreferences.initiativePreview.formula : 'invalid or unresolved formula; manual initiative required'}
                        {statPreferences.initiativePreview.source === 'core' && ' · Using Core default 1d20; this may not match your system.'}
                    </p>}
                </div>
            </section>

            {encounter && <>
                <section className={`${panelClass} flex flex-wrap items-center justify-between gap-4`}>
                    <div>
                        <h2 className="sd-ui-accent text-xl font-bold">{encounter.label}</h2>
                        <p className="sd-ui-muted text-sm">{encounter.status} · round {encounter.round} · {encounter.participants.length} participants · {encounter.keepHistory ? 'retain on completion' : 'delete on completion'}</p>
                        {encounter.awaitingInitiative && <p role="status" className="sd-ui-accent mt-2 text-sm font-semibold">Awaiting initiative · paused until the GM restores the current score or chooses Next.</p>}
                        {encounter.pausedForSkip && <p role="status" className="sd-ui-accent mt-2 text-sm font-semibold">Turn paused · current participant skipped. Unskip, Restore or choose Next to continue.</p>}
                        {encounter.status === 'active' && encounter.participants.length > 0 && encounter.canNavigateTurns === false
                            && !encounter.awaitingInitiative && !encounter.pausedForSkip && <p role="status" className="sd-ui-muted mt-2 text-sm">No scored, unskipped participants. Set initiative or uncheck Skip to begin.</p>}
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
                        <button disabled={busy || encounter.status !== 'active' || encounter.round === 0 || encounter.participants.length === 0 || encounter.canNavigateTurns === false} onClick={() => void mutate(() => api.postManagedPreviousTurn(encounter.id))}
                            className={secondaryButtonClass}>Previous</button>
                        <button disabled={busy || encounter.status !== 'active' || encounter.participants.length === 0 || encounter.canNavigateTurns === false} onClick={() => {
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

                {encounter.status === 'active' && <section className={`${panelClass} flex flex-wrap items-center gap-4`} aria-label="Player participation">
                    <div className="min-w-[13rem] flex-1">
                        <h2 className="sd-ui-accent text-sm font-bold uppercase tracking-widest">Player participation</h2>
                        <p className="sd-ui-muted text-xs">{encounter.playerActions.scored} of {encounter.playerActions.eligible} visible player combatants have initiative.</p>
                        <p className="sd-ui-muted text-xs">Owners may roll their own unrolled characters while the phase is open, including before Begin. Begin closes it.</p>
                    </div>
                    <button type="button" disabled={busy || encounter.deletionRequested}
                        onClick={() => void mutate(() => api.updateManagedPlayerActions(encounter.id,
                            { initiativeOpen: !encounter.playerActions.initiativeOpen }))}
                        className={encounter.playerActions.initiativeOpen ? secondaryButtonClass : primaryButtonClass}>
                        {encounter.playerActions.initiativeOpen ? 'Close player initiative' : 'Open player initiative'}
                    </button>
                    <label className="flex min-h-11 items-center gap-2 text-sm">
                        <input type="checkbox" checked={encounter.playerActions.endTurnEnabled} disabled={busy || encounter.deletionRequested}
                            onChange={event => void mutate(() => api.updateManagedPlayerActions(encounter.id,
                                { endTurnEnabled: event.target.checked }))} />
                        Allow owners to end their turn
                    </label>
                </section>}

                {encounter.status === 'active' && <section className={panelClass} aria-label="Turn settings">
                    <label className="flex min-h-11 items-center gap-2 text-sm">
                        <input type="checkbox" checked={encounter.autoSkipDefeatedEnemies === true} disabled={busy || encounter.deletionRequested}
                            onChange={event => void mutate(() => api.updateManagedTurnPolicy(encounter.id, event.target.checked))} />
                        Skip defeated enemies automatically
                    </label>
                    <p className="sd-ui-muted text-xs">Checks Skip when you mark an NPC defeated here. Players are never skipped automatically. Existing rows and external Foundry changes are unchanged; you can uncheck Skip while defeated. NPC Restore clears Skip.</p>
                </section>}

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
                                className={`${selected?.id === row.id ? 'sd-ui-inset' : 'sd-ui-panel-raised'} flex w-full flex-wrap items-center gap-3 rounded-lg p-2 transition-colors ${row.isCurrent ? 'ring-2 ring-[var(--sd-ui-accent)]' : ''}`}>
                                <div className="flex min-w-0 flex-1 basis-64 items-center gap-1">
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
                                <div className="min-w-0 flex-1">
                                <button onPointerDownCapture={beginSelection} onClick={() => setSelectedCombatantId(row.id)}
                                    className="flex w-full min-w-0 items-center gap-3 rounded-lg p-2 text-left">
                                <span className="w-8 shrink-0 text-center font-mono text-lg">{row.initiative ?? '—'}</span>
                                <span className="sd-ui-inset flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg"
                                    aria-hidden="true">
                                    <DisplayArtwork src={row.img} actorId={row.actorId} combatId={encounter.id} combatantId={row.id}
                                        purpose="combat-portrait" className="h-full w-full object-cover" fallback={<UserRound className="sd-ui-muted h-5 w-5" />} />
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="block break-words font-semibold">{row.name}</span>
                                    <span className="mt-1 flex flex-wrap items-center gap-1.5">
                                        {row.stats.filter(stat => stat.showInRoster).map((stat, index) => <span
                                            key={`${stat.title}:${index}`} title={`${stat.title}: ${compactStatValue(stat)}`}
                                            className="sd-ui-inset sd-ui-accent max-w-40 shrink-0 truncate rounded-full px-2 py-0.5 text-[11px] font-medium">
                                            {stat.title}: {compactStatValue(stat)}
                                        </span>)}
                                    </span>
                                    <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                                {row.resource && <span className="text-sm">{row.resource.value}{row.resource.max !== null ? `/${row.resource.max}` : ''}</span>}
                                {row.hidden && <span className="sd-ui-muted text-xs">hidden</span>}
                                {row.defeated && <span className="sd-ui-danger text-xs">defeated</span>}
                                {row.skip && <span className="sd-ui-muted text-xs">skipped</span>}
                                {row.initiative === null && <span className="sd-ui-muted text-xs">Awaiting initiative</span>}
                                {row.isCurrent && <span className="sd-ui-inset sd-ui-accent shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider">Current</span>}
                                    </span>
                                </span>
                                </button>
                                <CompendiumReferenceLink combatId={encounter.id} combatantId={row.id} actorId={row.actorId} selectionKey={selectedCombatantId} />
                                </div>
                                </div>
                                {encounter.status === 'active' && <div className="grid w-full shrink-0 grid-cols-3 gap-1 sm:w-72">
                                    <button disabled={busy} aria-pressed={row.hidden}
                                        aria-label={`${row.hidden ? 'Reveal' : 'Hide'} ${row.name} in player combat HUD`}
                                        onClick={() => void mutate(() => api.updateManagedCombatant(encounter.id, row.id, { hidden: !row.hidden }))}
                                        className="sd-ui-button px-2 py-2 text-xs font-semibold">{row.hidden ? 'Reveal' : 'Hide'}</button>
                                    <button disabled={busy} aria-pressed={row.defeatedFlag ?? row.defeated}
                                        aria-label={`${(row.defeatedFlag ?? row.defeated) ? 'Restore' : 'Mark defeated'} ${row.name}`}
                                        title={row.defeated && row.defeatedFlag === false ? 'Actor dead status also marks this row defeated; this toggle changes only the Combatant flag.' : 'Toggle the Combatant defeated flag'}
                                        onClick={() => void mutate(() => api.updateManagedCombatant(encounter.id, row.id,
                                            { defeated: !(row.defeatedFlag ?? row.defeated) }))}
                                        className="sd-ui-button px-2 py-2 text-xs font-semibold">{(row.defeatedFlag ?? row.defeated) ? 'Restore' : 'Defeated'}</button>
                                    <button disabled={busy} aria-pressed={row.skip === true} aria-label={`${row.skip ? 'Unskip' : 'Skip'} ${row.name}`}
                                        title="Exclude from turn navigation without changing initiative, defeat or visibility"
                                        onClick={() => void mutate(() => api.updateManagedCombatant(encounter.id, row.id, { skip: !row.skip }))}
                                        className="sd-ui-button px-2 py-2 text-xs font-semibold">{row.skip ? 'Unskip' : 'Skip'}</button>
                                    <button disabled={busy || !row.initiativeRoll.rollAvailable}
                                        title={row.initiativeRoll.rollAvailable ? `Uses ${row.initiativeRoll.source} initiative formula` : 'Formula unavailable; enter initiative manually'}
                                        onClick={() => void mutate(() => api.postManagedInitiativeOne(encounter.id, row.id))}
                                        aria-label={`${row.initiative == null ? 'Roll' : 'Reroll'} initiative for ${row.name}`}
                                        className="sd-ui-button px-2 py-2 text-xs font-semibold">{row.initiative == null ? 'Roll' : 'Reroll'}</button>
                                    <button disabled={busy || row.initiative == null}
                                        onClick={() => void mutate(() => api.updateManagedCombatant(encounter.id, row.id, { initiative: null }))}
                                        aria-label={`Clear initiative for ${row.name}`}
                                        className="sd-ui-button px-2 py-2 text-xs font-semibold">Clear</button>
                                {statPreferences?.attributes.some(field => field.health) && <button disabled={busy || !health?.edit}
                                        title={health?.edit ? `Adjust ${health.title} for ${row.name}` : 'No editable health source for this Actor'}
                                        aria-label={`Damage or heal ${row.name}`}
                                        onPointerDownCapture={beginSelection}
                                        onClick={() => {
                                            if (!health?.edit) return;
                                            setSelectedCombatantId(row.id);
                                            setHealthTarget({ combatantId: row.id, actorId: row.actorId, name: row.name,
                                                label: health.title, key: health.edit.key, path: health.edit.path,
                                                current: health.edit.value, max: health.edit.max });
                                        }} className="sd-ui-button flex items-center justify-center gap-1.5 px-2 py-2 text-xs font-semibold">
                                        <Swords aria-hidden="true" className="h-4 w-4" /> Damage
                                    </button>}
                                </div>}
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
                            {selected.stats.length > 0 && <div aria-label="Basic stats" className="sd-combat-stat-grid grid grid-cols-1 gap-2 sm:grid-cols-3">
                                <span className="sd-ui-muted col-span-full text-xs font-semibold uppercase tracking-wider">Basic stats</span>
                                {selected.stats.map((stat, index) => <div key={`${stat.title}:${index}`} className="sd-combat-stat-field sd-ui-inset flex min-w-0 flex-col rounded-lg px-3 py-2"
                                    style={{ '--sd-stat-columns': stat.layout?.columnSpan ?? 1, '--sd-stat-rows': stat.layout?.rowSpan ?? 1 } as CSSProperties}>
                                    <span className="sd-ui-muted block truncate text-[10px] font-bold uppercase tracking-wider" title={stat.title}>{stat.title}</span>
                                    {stat.multiline ? stat.contentFormat === 'html'
                                        ? <div role="region" aria-label={stat.title} tabIndex={0} className="sd-combat-rich-detail sd-ui-control mt-1 min-h-0 overflow-auto text-sm"
                                            style={{ height: `calc(${stat.layout?.textRows ?? 4} * 1.5em + 0.75rem)` }}>
                                            <SafeHtmlContent className="rich-text-content" html={sanitizeRichHtml(String(stat.value))} />
                                        </div>
                                        : <textarea aria-label={stat.title} readOnly value={String(stat.value)} rows={stat.layout?.textRows ?? 4}
                                            className="sd-ui-control mt-1 min-h-0 w-full resize-none overflow-y-auto whitespace-pre-wrap break-words text-sm" />
                                    : stat.edit && encounter.status === 'active' ? <div className="mt-1 flex flex-wrap items-center gap-1">
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
                                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={selected.defeatedFlag ?? selected.defeated} disabled={busy || encounter.status !== 'active'} style={{ accentColor: 'var(--sd-ui-accent)' }}
                                    onChange={event => void mutate(() => api.updateManagedCombatant(encounter.id, selected.id, { defeated: event.target.checked }))} /> Defeated</label>
                                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={selected.skip === true} disabled={busy || encounter.status !== 'active'} style={{ accentColor: 'var(--sd-ui-accent)' }}
                                    onChange={event => void mutate(() => api.updateManagedCombatant(encounter.id, selected.id, { skip: event.target.checked }))} /> Skip</label>
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
