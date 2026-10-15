'use client';

import { useEffect, useRef, useState, lazy, type ComponentType } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronLeft, ChevronRight, Shield, Swords } from 'lucide-react';
import { useFoundry } from '@client/ui/context/FoundryContext';
import { useActorCombat } from '@client/ui/context/ActorCombatContext';
import { useSession } from '@client/ui/context/SessionContext';
import { useNotifications } from '@client/ui/components/NotificationSystem';
import type { CombatTrackerCombatantDto } from '@shared/contracts/combats';
import type { InitiativeRollChoice, InitiativeRollModalProps } from '@shared/sdk/ui';
import * as foundryApi from '@client/ui/api/foundryApi';
import { resolveSelectedCombat, selectActiveCombats, ownedCombatants, ownedInitiativeCandidates, selectOwnedCombatant } from './combatHudState';
import InitiativeChooser from './InitiativeChooser';
import { runInitiativeSequence, type InitiativeOutcome } from './initiativeSequence';
import { getUIModule } from '@modules/registry/client';
import { SurfaceHost } from '@client/ui/components/SurfaceHost';
import { logger } from '@shared/utils/logger';
import RollDialog from '../RollDialog';

type PendingAction = 'next-turn' | 'previous-turn' | 'initiative' | null;
type RollTarget = { combatId: string; row: CombatTrackerCombatantDto; phaseGeneration?: string; scope: string };
const snapshotRollTarget = (target: RollTarget): RollTarget => ({ ...target,
    row: { ...target.row, initiativeRoll: target.row.initiativeRoll ? { ...target.row.initiativeRoll } : null } });
const button = 'sd-ui-button min-h-11 rounded-lg px-3 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2';

function Portrait({ row }: { row: CombatTrackerCombatantDto }) {
    return <span className="sd-ui-inset flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg">
        {row.img
            ? <img src={row.img} alt="" loading="lazy" className="h-full w-full object-cover" />
            : <Shield aria-hidden="true" className="sd-ui-muted h-6 w-6" />}
    </span>;
}

function StatChips({ row, compact }: { row: CombatTrackerCombatantDto; compact: boolean }) {
    if (!row.isOwned) return null;
    if (row.statSource === 'unlinked-token') return <span className="sd-ui-muted text-xs">Token-local stats unavailable</span>;
    return <div className="flex flex-wrap gap-1.5" aria-label={`Tracked stats for ${row.name || 'your character'}`}>
        {(compact ? row.stats.slice(0, 3) : row.stats).map((stat, index) =>
            <span key={`${stat.title}-${index}`} className="sd-ui-inset rounded-full px-2.5 py-1 text-xs">
                <span className="sd-ui-muted">{stat.title}: </span>{stat.value}{stat.subValue ?? ''}
            </span>)}
    </div>;
}

export default function CombatHUDView() {
    const pathname = usePathname();
    const { step, system, currentUser, worldId } = useFoundry();
    const { combats, fetchCombats } = useActorCombat();
    const { token } = useSession();
    const { addNotification } = useNotifications();
    const [selectedCombatId, setSelectedCombatId] = useState<string | null>(null);
    const [manualOwned, setManualOwned] = useState<{ context: string; id: string; actorId: string | null } | null>(null);
    const [expanded, setExpanded] = useState(false);
    const [pendingAction, setPendingAction] = useState<PendingAction>(null);
    const [rollTarget, setRollTarget] = useState<RollTarget | null>(null);
    const [ModuleRollModal, setModuleRollModal] = useState<ComponentType<InitiativeRollModalProps> | null>(null);
    const [modalLoading, setModalLoading] = useState(false);
    const [modalError, setModalError] = useState(false);
    const [modalRetry, setModalRetry] = useState(0);
    const [announcement, setAnnouncement] = useState('');
    const lastAnnouncement = useRef('');
    const [chooser, setChooser] = useState<RollTarget[] | null>(null);
    const [outcomes, setOutcomes] = useState<InitiativeOutcome[]>([]);
    const [batchStarted, setBatchStarted] = useState(false);
    const actionRef = useRef<{ cancelled: boolean } | null>(null);
    const mounted = useRef(true);
    useEffect(() => { mounted.current = true; return () => {
        mounted.current = false;
        if (actionRef.current) actionRef.current.cancelled = true;
    }; }, []);

    useEffect(() => {
        let live = true;
        setModuleRollModal(null);
        setModalLoading(true);
        setModalError(false);
        void getUIModule(system?.id || 'generic').then(manifest => {
            if (!live) return;
            setModuleRollModal(() => manifest?.rollModal ? lazy(manifest.rollModal) : null);
            setModalLoading(false);
        }).catch(error => {
            if (!live) return;
            logger.error('CombatHUD | Initiative modal failed to load:', error);
            setModalError(true);
            setModalLoading(false);
        });
        return () => { live = false; };
    }, [system?.id, modalRetry]);

    const activeCombats = selectActiveCombats(combats);
    const selection = resolveSelectedCombat(activeCombats, selectedCombatId);
    const combat = selection?.combat ?? null;
    const viewScope = JSON.stringify([worldId, system?.id, currentUser?._id || currentUser?.id,
        currentUser?.role, token, step, pathname === '/tools/combat', combat?.id, combat?.playerInitiative?.generation]);
    const scopeRef = useRef(viewScope);
    scopeRef.current = viewScope;
    useEffect(() => {
        setRollTarget(null); setChooser(null); setOutcomes([]); setBatchStarted(false);
        if (actionRef.current) actionRef.current.cancelled = true;
    }, [viewScope]);
    const rollCombat = rollTarget && activeCombats.find(item => item.id === rollTarget.combatId);
    const rollRow = rollTarget && [...(rollCombat?.combatants ?? []), ...(rollCombat?.initiativeCandidates ?? [])]
        .find(row => row.id === rollTarget.row.id);
    const rollStillValid = rollTarget?.scope === viewScope && !!rollRow && rollRow.canRollInitiative && rollRow.initiative === rollTarget?.row.initiative
        && rollRow.actorId === rollTarget?.row.actorId
        && rollRow.initiativeRoll?.formula === rollTarget?.row.initiativeRoll?.formula
        && rollCombat?.playerInitiative?.generation === rollTarget?.phaseGeneration;
    useEffect(() => { if (rollTarget && !rollStillValid) setRollTarget(null); }, [rollTarget, rollStillValid]);

    const current = combat?.combatants.find(row => row.isCurrent) ?? null;
    const pendingInitiative = ownedInitiativeCandidates(combat);
    const owned = ownedCombatants(combat);
    const selectionContext = `${viewScope}:${combat?.round}:${combat?.currentCombatantId}`;
    useEffect(() => { setManualOwned(null); }, [selectionContext]);
    const manualStillOwned = !!manualOwned && owned.some(row => row.id === manualOwned.id && row.actorId === manualOwned.actorId);
    useEffect(() => { if (manualOwned && !manualStillOwned) setManualOwned(null); }, [manualOwned, manualStillOwned]);
    const mine = selectOwnedCombatant(combat, manualOwned?.context === selectionContext && manualStillOwned ? manualOwned.id : null);
    useEffect(() => {
        const key = combat && current?.isOwned ? `${combat.id}:${combat.round}:${current.id}` : '';
        if (key && key !== lastAnnouncement.current) setAnnouncement(`Your turn: ${current?.name || 'your character'}`);
        else if (!key) setAnnouncement('');
        lastAnnouncement.current = key;
    }, [combat, current?.id, current?.isOwned, current?.name]);

    if (step !== 'dashboard' || pathname === '/tools/combat' || !selection || !combat) return null;
    const gm = (currentUser?.role ?? 0) >= 3;
    const next = combat.combatants.find(row => row.id === combat.nextShownCombatantId) ?? null;
    const observed = { active: combat.active, started: combat.started, round: combat.round,
        currentCombatantId: combat.currentCombatantId };
    const runAction = async (action: Exclude<PendingAction, null>, request: () => Promise<unknown>) => {
        if (actionRef.current) return;
        const job = { cancelled: false };
        actionRef.current = job;
        const scope = viewScope;
        setPendingAction(action);
        try { await request(); void fetchCombats(); }
        catch (error) {
            if (!mounted.current || scopeRef.current !== scope) return;
            const message = error instanceof Error ? error.message : 'Request failed';
            logger.error(`CombatHUD | ${action} failed:`, error);
            addNotification(`Combat action failed: ${message}`, 'error');
            void fetchCombats();
        } finally {
            if (actionRef.current === job) actionRef.current = null;
            if (mounted.current) setPendingAction(null);
        }
    };
    const turn = (direction: 'next' | 'previous') => void runAction(direction === 'next' ? 'next-turn' : 'previous-turn',
        () => direction === 'next' ? foundryApi.postCombatNextTurn(token, combat.id, observed)
            : foundryApi.postCombatPreviousTurn(token, combat.id, observed));
    const confirmRoll = (choice: InitiativeRollChoice) => {
        const target = rollTarget;
        setRollTarget(null);
        if (!rollStillValid || !target?.row.initiativeRoll) return;
        void runAction('initiative', () => foundryApi.postCombatRollInitiative(token, target.combatId, target.row.id, {
            observed: { initiative: target.row.initiative, formula: target.row.initiativeRoll!.formula,
                ...(target.phaseGeneration ? { phaseGeneration: target.phaseGeneration } : {}) },
            ...(choice.kind === 'manual' ? { manualTotal: choice.total } : { advantageMode: choice.advantageMode }),
        }));
    };
    const openInitiative = () => {
        if (pendingInitiative.length === 1) {
            setRollTarget(snapshotRollTarget({ combatId: combat.id, row: pendingInitiative[0], phaseGeneration: combat.playerInitiative?.generation, scope: viewScope }));
        } else if (pendingInitiative.length > 1) {
            setChooser(pendingInitiative.map(row => snapshotRollTarget({ combatId: combat.id, row, phaseGeneration: combat.playerInitiative?.generation, scope: viewScope })));
            setOutcomes([]); setBatchStarted(false);
        }
    };
    const closeChooser = () => {
        if (actionRef.current) actionRef.current.cancelled = true;
        setChooser(null);
    };
    const rollAll = async () => {
        if (actionRef.current || !chooser || batchStarted) return;
        const job = { cancelled: false };
        actionRef.current = job;
        const scope = viewScope;
        const isCurrent = () => mounted.current && !job.cancelled && scopeRef.current === scope;
        setPendingAction('initiative'); setBatchStarted(true);
        setOutcomes(chooser.map(target => ({ id: target.row.id, state: 'unattempted' })));
        try {
            await runInitiativeSequence(chooser.map(target => target.row), combat.playerInitiative?.generation, {
                isCurrent,
                readCombat: async () => {
                    const snapshot = await fetchCombats();
                    if (!snapshot) throw new Error('Tracker temporarily unavailable');
                    return snapshot.combats.find(item => item.id === combat.id) ?? null;
                },
                submit: row => foundryApi.postCombatRollInitiative(token, combat.id, row.id, {
                    observed: { initiative: row.initiative, formula: row.initiativeRoll!.formula,
                        ...(combat.playerInitiative?.generation ? { phaseGeneration: combat.playerInitiative.generation } : {}) },
                }),
                report: outcome => { if (isCurrent()) setOutcomes(previous => previous.map(item => item.id === outcome.id ? outcome : item)); },
            });
        } finally {
            if (actionRef.current === job) actionRef.current = null;
            if (mounted.current) setPendingAction(null);
            if (scopeRef.current === scope && mounted.current) void fetchCombats();
        }
    };
    const modalProps: InitiativeRollModalProps | null = rollTarget?.row.initiativeRoll ? {
        isOpen: rollStillValid, type: 'initiative', title: 'Roll Initiative',
        combatantName: rollTarget.row.name || 'Combatant', ...rollTarget.row.initiativeRoll,
        manualAvailable: true, audience: rollTarget.row.hidden ? 'gm' : 'public',
        theme: system?.config?.componentStyles?.rollDialog,
        onConfirm: confirmRoll, onClose: () => setRollTarget(null),
    } : null;

    return <><section data-combat-hud className="sd-ui-panel-raised sticky top-0 z-[140] w-full rounded-none border-x-0 border-t-0 pt-[env(safe-area-inset-top)]" aria-label="Combat tracker">
        <div className="mx-auto w-full max-w-7xl px-3 py-2 sm:px-4">
            <div className="flex flex-wrap items-center gap-2">
                <div className="flex h-10 shrink-0 items-center gap-1.5">
                    <Swords aria-hidden="true" className="sd-ui-accent h-4 w-4" />
                    <span className="whitespace-nowrap text-sm font-bold">{combat.started ? `Round ${combat.round}` : 'Forming'}</span>
                </div>
                {activeCombats.length > 1 && <div className="flex items-center gap-1" aria-label="Encounter selection">
                    <button type="button" className={button} disabled={selection.index === 0} aria-label="Previous encounter"
                        onClick={() => setSelectedCombatId(activeCombats[selection.index - 1].id)}><ChevronLeft aria-hidden="true" className="h-4 w-4" /></button>
                    <span className="sd-ui-muted text-xs">{selection.index + 1}/{activeCombats.length}</span>
                    <button type="button" className={button} disabled={selection.index === activeCombats.length - 1} aria-label="Next encounter"
                        onClick={() => setSelectedCombatId(activeCombats[selection.index + 1].id)}><ChevronRight aria-hidden="true" className="h-4 w-4" /></button>
                </div>}
                {!combat.started && combat.playerInitiative?.open ? <div className="sd-combat-hud-region flex min-h-11 min-w-0 flex-[1_1_9rem] flex-wrap items-center gap-2 px-2">
                    <span className="sd-ui-accent text-sm font-semibold">Initiative open</span>
                </div> : <><div data-own-turn={current?.isOwned ? 'true' : undefined}
                    className={`sd-combat-hud-region flex min-h-11 min-w-0 flex-[1_1_9rem] items-center gap-2 px-2 lg:max-w-40 ${current?.isOwned ? 'sd-combat-own-turn' : ''}`}
                    aria-label={current?.isOwned ? 'Your turn' : 'Current turn'}>
                    {current && <Portrait row={current} />}
                    <span className="min-w-0"><span className={current?.isOwned
                        ? 'sd-combat-own-turn-label block text-[11px] font-bold leading-tight uppercase tracking-wide'
                        : 'sd-ui-accent block text-[11px] font-semibold leading-tight'}>{current?.isOwned ? 'Your turn' : 'Current turn'}</span>
                        <span className="block truncate text-sm font-semibold">{current?.name || '—'}</span></span>
                </div>
                <div className="sd-combat-hud-region flex min-h-11 min-w-0 flex-[1_1_9rem] items-center gap-2 px-2 lg:max-w-40" aria-label={gm ? 'Up next' : 'Next shown'}>
                    {next && <Portrait row={next} />}
                    <span className="min-w-0"><span className="sd-ui-muted block text-[11px] font-semibold leading-tight">{gm ? 'Up next' : 'Next shown'}</span>
                        <span className="block truncate text-sm font-semibold">{next?.name || '—'}</span></span>
                </div></>}
                <div className="sd-combat-hud-region flex min-h-11 min-w-0 flex-[2_1_15rem] flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1" aria-label="My character">
                    {mine && <Portrait row={mine} />}
                    <span className="min-w-0"><span className="sd-ui-muted block text-[11px] font-semibold leading-tight">My character</span>
                        {owned.length > 1 ? <select aria-label="My combatant" className="sd-ui-control max-w-36 text-sm" value={mine?.id ?? ''}
                            onChange={event => setManualOwned({ context: selectionContext, id: event.target.value,
                                actorId: owned.find(row => row.id === event.target.value)?.actorId ?? null })}>{owned.map(row => <option key={row.id} value={row.id}>
                                {row.name || 'Combatant'}{pendingInitiative.some(candidate => candidate.id === row.id) ? ' · unrolled' : ''}
                            </option>)}</select>
                            : <span className="block truncate text-sm font-semibold">{mine?.name || 'None shown'}</span>}</span>
                    {mine && <StatChips row={mine} compact />}
                    {mine?.actorId && mine.canOpenActor && <Link className="sd-ui-accent text-xs underline" href={`/actors/${encodeURIComponent(mine.actorId)}`}
                        target="_blank" rel="noopener noreferrer">{mine.statSource === 'unlinked-token' ? 'Base sheet' : 'Sheet'}</Link>}
                {pendingInitiative.length > 0 && <div className="flex min-w-0 flex-wrap items-center gap-2"
                    aria-label="Player initiative is open">
                    <button type="button" className={`${button} sd-ui-button-primary`} disabled={pendingAction !== null}
                        onClick={openInitiative}>Roll initiative
                    </button>
                </div>}
                </div>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                {combat.canRewindTurn && <button type="button" className={button} disabled={pendingAction !== null}
                    onClick={() => turn('previous')}>Previous turn</button>}
                {combat.canAdvanceTurn && <button type="button" className={`${button} sd-ui-button-primary`} disabled={pendingAction !== null}
                    onClick={() => turn('next')}>{!combat.started ? 'Begin encounter' : current?.isOwned && !gm ? 'End my turn' : 'Next turn'}</button>}
                {combat.canManage && <Link className={button} href={`/tools/combat?combat=${encodeURIComponent(combat.id)}`}>Open Combat Manager</Link>}
                <button type="button" className={button} aria-expanded={expanded} aria-controls="combat-hud-roster"
                    onClick={() => setExpanded(value => !value)}>{expanded ? 'Hide roster' : 'Show roster'}</button>
                </div>
            </div>
        </div>
        {expanded && <div id="combat-hud-roster" className="sd-ui-panel-raised absolute inset-x-0 top-full max-h-[min(65dvh,36rem)] overflow-y-auto rounded-none border-x-0 border-t-0 p-3 shadow-xl">
            <ol className="mx-auto max-w-7xl space-y-2" aria-label="Visible combatants">{combat.combatants.map(row => <li key={row.id}
                aria-current={row.isCurrent ? 'step' : undefined}
                className={`sd-ui-inset flex flex-wrap items-center gap-2 rounded-xl p-2 ${row.isCurrent && row.isOwned ? 'sd-combat-own-turn' : ''}`}>
                <Portrait row={row} />
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5 text-sm"><span className="break-words font-semibold">{row.name || 'Combatant'}</span>
                        {row.isCurrent && <span className="sd-ui-accent text-xs font-semibold">{row.isOwned ? 'Your turn' : 'Current'}</span>}
                        {row.isOwned && !row.isCurrent && <span className="sd-ui-muted text-xs">Yours</span>}
                        {row.defeated && <span className="sd-ui-danger text-xs">Defeated</span>}
                        {row.skip && <span className="sd-ui-muted text-xs">Skipped</span>}
                        {row.hidden && <span className="sd-ui-muted text-xs">Hidden from players</span>}
                    </div>
                    <p className="sd-ui-muted text-xs">Initiative: {row.initiative ?? '—'}</p>
                    <StatChips row={row} compact={false} />
                </div>
                {row.canRollInitiative && <button type="button" className={`${button} sd-ui-button-primary`} disabled={pendingAction !== null}
                    onClick={() => setRollTarget(snapshotRollTarget({ combatId: combat.id, row,
                        phaseGeneration: combat.playerInitiative?.generation, scope: viewScope }))}>Roll initiative</button>}
            </li>)}</ol>
        </div>}
        <span className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</span>
    </section>
        {chooser && !rollTarget && <InitiativeChooser rows={chooser.map(target => target.row)} currentRows={owned.filter(row => !row.hidden)}
            outcomes={outcomes} busy={pendingAction !== null} started={batchStarted}
            onAll={() => void rollAll()} onClose={closeChooser}
            onIndividual={row => { setChooser(null); setRollTarget(snapshotRollTarget({ combatId: combat.id, row,
                phaseGeneration: combat.playerInitiative?.generation, scope: viewScope })); }} />}
        {rollTarget && modalProps && (modalLoading ? <div role="status" className="sd-ui-panel-raised fixed inset-x-4 top-1/3 z-[210] mx-auto max-w-sm rounded-xl p-4">Loading initiative dialog…</div>
            : modalError ? <div role="alert" className="sd-ui-panel-raised fixed inset-x-4 top-1/3 z-[210] mx-auto max-w-sm rounded-xl p-4">
                <p>Initiative dialog unavailable.</p><div className="mt-2 flex gap-2">
                    <button type="button" className={button} onClick={() => setModalRetry(value => value + 1)}>Retry</button>
                    <button type="button" className={button} onClick={() => setRollTarget(null)}>Close</button>
                </div></div> : ModuleRollModal ? <SurfaceHost key={`${system?.id}-${modalRetry}`} moduleId={system?.id ?? undefined} surface="rollModal"
                loading={<div role="status" className="sd-ui-panel-raised fixed inset-x-4 top-1/3 z-[210] mx-auto max-w-sm rounded-xl p-4">Loading initiative dialog…</div>}
                fallback={<div role="alert" className="sd-ui-panel-raised fixed inset-x-4 top-1/3 z-[210] mx-auto max-w-sm rounded-xl p-4">
                    <p>Initiative dialog unavailable.</p><button type="button" className={button} onClick={() => setModalRetry(value => value + 1)}>Retry</button>
                    <button type="button" className={button} onClick={() => setRollTarget(null)}>Close</button>
                </div>}><ModuleRollModal {...modalProps} /></SurfaceHost> : <RollDialog {...modalProps} />)}
    </>;
}
