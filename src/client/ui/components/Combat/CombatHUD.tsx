'use client';

import React, { useState, useEffect } from 'react';
import { useFoundry } from '@client/ui/context/FoundryContext';
import { useActorCombat } from '@client/ui/context/ActorCombatContext';
import { useSession } from '@client/ui/context/SessionContext';
import { useNotifications } from '@client/ui/components/NotificationSystem';
import type { CombatTrackerDto, CombatTrackerCombatantDto } from '@shared/contracts/combats';
import * as foundryApi from '@client/ui/api/foundryApi';
import { getUIModule } from '@modules/registry/client';
import { SurfaceHost } from '@client/ui/components/SurfaceHost';
import { logger } from '@shared/utils/logger';
import { Skull, Shield, ChevronLeft, ChevronRight, ChevronUp, ChevronDown, SkipForward, SkipBack } from 'lucide-react';
import RollDialog from '../RollDialog';

type PendingAction = 'next-turn' | 'previous-turn' | 'initiative' | null;

interface RollCommand {
    combatId: string;
    combatantId: string;
    actor: CombatTrackerCombatantDto['actor'];
    title: string;
}

/**
 * Combat tracker HUD — a render-only consumer of the server tracker
 * projection (ADR-0028 §7 / Phase 6). Ordering, current-turn identity,
 * hidden-row redaction, and action capabilities all arrive server-computed
 * in `CombatTrackerDto`; this component owns only presentation state
 * (selected encounter id, minimized state, dialog state, pending mutations).
 */
export default function CombatHUD() {
    const { step, system } = useFoundry();
    const { combats, fetchCombats } = useActorCombat();
    const { token } = useSession();
    const { addNotification } = useNotifications();
    const [selectedCombatId, setSelectedCombatId] = useState<string | null>(null);
    const [isMinimized, setIsMinimized] = useState(false);
    const [pendingAction, setPendingAction] = useState<PendingAction>(null);

    // Roll Dialog State
    const [isRollDialogOpen, setIsRollDialogOpen] = useState(false);
    const [rollCommand, setRollCommand] = useState<RollCommand | null>(null);

    const [DynamicRollModal, setDynamicRollModal] = useState<React.ComponentType<any> | null>(null);

    useEffect(() => {
        let isMounted = true;
        async function resolveRollModal() {
            const manifest = await getUIModule(system?.id || 'generic');
            if (!isMounted) return;

            if (manifest?.rollModal) {
                const modalEntry = manifest.rollModal;
                const Component = typeof modalEntry === 'function'
                    ? React.lazy(modalEntry as any)
                    : modalEntry;
                setDynamicRollModal(() => Component as any);
            } else {
                setDynamicRollModal(() => RollDialog as any);
            }
        }
        resolveRollModal();
        return () => { isMounted = false; };
    }, [system?.id]);

    // Render only during the dashboard step — reconnecting/world-closed and
    // every pre-game step must not show (possibly stale) combat state (ADR-0028).
    if (step !== 'dashboard') return null;

    // Started encounters render the full tracker. Unstarted active encounters
    // surface only when the server projection returned rows for this viewer —
    // for players that's exactly their own rollable combatants (pre-combat
    // initiative), for GMs the forming roster (ADR-0028 QoL addendum).
    const activeCombats = combats?.filter(c => c.active && (c.started || c.combatants.length > 0)) || [];

    if (activeCombats.length === 0) return null;

    // Stable-id selection: keep the chosen encounter when the list reorders;
    // fall back to the first active encounter when it disappears.
    const selectedIndex = selectedCombatId
        ? activeCombats.findIndex(c => c.id === selectedCombatId)
        : -1;
    const activeCombat: CombatTrackerDto = selectedIndex >= 0 ? activeCombats[selectedIndex] : activeCombats[0];
    const displayIndex = selectedIndex >= 0 ? selectedIndex : 0;

    const selectByOffset = (offset: number) => {
        const next = activeCombats[Math.min(Math.max(displayIndex + offset, 0), activeCombats.length - 1)];
        if (next) setSelectedCombatId(next.id);
    };

    const runAction = async (action: Exclude<PendingAction, null>, request: () => Promise<unknown>) => {
        if (pendingAction) return;
        setPendingAction(action);
        try {
            await request();
            // Refresh promptly; the realtime invalidation will also land, and
            // the trailing-refetch guarantee dedupes the burst.
            void fetchCombats();
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Request failed';
            logger.error(`CombatHUD | ${action} failed:`, error);
            addNotification(`Combat action failed: ${message}`, 'error');
        } finally {
            setPendingAction(null);
        }
    };

    const handleInitiativeClick = (combatant: CombatTrackerCombatantDto) => {
        setRollCommand({
            combatId: activeCombat.id,
            combatantId: combatant.id,
            actor: combatant.actor,
            title: `Roll Initiative: ${combatant.name ?? 'Combatant'}`,
        });
        setIsRollDialogOpen(true);
    };

    const handleConfirmRoll = async (options: any) => {
        setIsRollDialogOpen(false);
        if (!rollCommand) return;
        const { combatId, combatantId } = rollCommand;
        setRollCommand(null);

        // Manual-value rolls carry edited bonuses; formula-less rolls defer
        // to the server's adapter initiative formula.
        const totalBonus = (options.abilityBonus || 0) + (options.itemBonus || 0) + (options.talentBonus || 0);
        const suffix = totalBonus > 0 ? `+${totalBonus}` : totalBonus < 0 ? `${totalBonus}` : '';
        const formula = options.manualValue !== undefined
            ? `${options.manualValue}${suffix}`
            : undefined;

        await runAction('initiative', () => foundryApi.postCombatRollInitiative(token, combatId, combatantId, {
            formula,
            advantageMode: options.advantageMode,
        }));
    };

    const handleNextTurn = () => runAction('next-turn', () => foundryApi.postCombatNextTurn(token, activeCombat.id));
    const handlePreviousTurn = () => runAction('previous-turn', () => foundryApi.postCombatPreviousTurn(token, activeCombat.id));

    // Server-ordered rows; the current row splits acted from upcoming.
    const rows = activeCombat.combatants;
    const currentIndex = rows.findIndex(r => r.isCurrent);
    const splitIndex = currentIndex >= 0 ? currentIndex : 0;
    const unacted = rows.slice(splitIndex);
    const acted = rows.slice(0, splitIndex);

    const currentName = currentIndex >= 0
        ? rows[currentIndex].name ?? 'Unknown'
        : activeCombat.hasHiddenCurrentCombatant ? 'Hidden combatant' : 'Unknown';

    const carouselItems: Array<CombatTrackerCombatantDto | { isDivider: true; id: string }> = [
        ...unacted,
        { isDivider: true, id: 'round-divider' },
        ...acted,
    ];

    return (
        <>
            <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[150] pointer-events-auto flex flex-col items-center gap-2">

                {/* Multiple Combats Selector */}
                {activeCombats.length > 1 && !isMinimized && (
                    <div className="flex items-center gap-2 bg-black/80 backdrop-blur-md px-3 py-1 rounded-full border border-white/10 shadow-lg text-xs font-medium text-white/70">
                        <button
                            onClick={() => selectByOffset(-1)}
                            disabled={displayIndex === 0}
                            className="p-1 hover:text-white disabled:opacity-30 disabled:hover:text-white/70 transition-colors"
                        >
                            <ChevronLeft className="w-4 h-4" />
                        </button>
                        <span>Encounter {displayIndex + 1} of {activeCombats.length}</span>
                        <button
                            onClick={() => selectByOffset(1)}
                            disabled={displayIndex === activeCombats.length - 1}
                            className="p-1 hover:text-white disabled:opacity-30 disabled:hover:text-white/70 transition-colors"
                        >
                            <ChevronRight className="w-4 h-4" />
                        </button>
                    </div>
                )}

                {/* Pre-combat: encounter is forming — initiative pre-roll only.
                    The server projection already redacted the roster down to
                    this viewer's rollable rows (full roster for GMs). */}
                {!activeCombat.started ? (
                    <div className="flex flex-col items-center gap-3 bg-black/80 backdrop-blur-2xl px-5 py-3 rounded-3xl border border-white/20 shadow-[0_10px_40px_-10px_rgba(0,0,0,0.8)]">
                        <div className="text-xs font-semibold uppercase tracking-widest text-rose-400/90">
                            Encounter Forming
                        </div>
                        <div className="flex items-center gap-3 overflow-x-auto scrollbar-hide max-w-[85vw] px-1">
                            {rows.map(combatant => {
                                const showImage = !combatant.hidden
                                    && combatant.img
                                    && !combatant.img.endsWith('icons/svg/mystery-man.svg');
                                return (
                                    <div key={combatant.id} className="flex flex-col items-center gap-1 flex-shrink-0 w-16">
                                        <div className="relative w-14 h-14 rounded-full overflow-hidden border-2 border-neutral-700 bg-neutral-900 flex items-center justify-center">
                                            {showImage ? (
                                                <img src={combatant.img!} alt={combatant.name || 'Combatant'} className="w-full h-full object-cover" />
                                            ) : (
                                                <Shield className="w-6 h-6 text-neutral-600" />
                                            )}
                                            {combatant.canRollInitiative && combatant.initiative == null && (
                                                <button
                                                    onClick={() => handleInitiativeClick(combatant)}
                                                    disabled={pendingAction !== null}
                                                    className="absolute inset-0 bg-black/60 flex items-center justify-center hover:bg-rose-950/70 transition-colors disabled:opacity-50"
                                                    title="Roll Initiative"
                                                >
                                                    <img src="/icons/dice-d20.svg" alt="Roll Initiative" className="w-7 h-7 invert" />
                                                </button>
                                            )}
                                            {combatant.initiative != null && (
                                                <div className="absolute bottom-0 inset-x-0 bg-rose-900/90 text-center">
                                                    <span className="text-[11px] font-black font-mono text-white">{combatant.initiative}</span>
                                                </div>
                                            )}
                                        </div>
                                        <span className="text-[10px] font-medium text-white/70 truncate max-w-full">
                                            {combatant.hidden ? 'Hidden' : combatant.name?.split(' ')[0] || 'Unknown'}
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
                        {activeCombat.canAdvanceTurn ? (
                            /* Round-0 advance starts the encounter — GM-only per projection. */
                            <button
                                onClick={handleNextTurn}
                                disabled={pendingAction !== null}
                                className="text-xs font-semibold bg-rose-950/80 border border-rose-800/50 rounded-full px-4 py-1.5 text-rose-300 hover:text-rose-100 hover:bg-rose-900 hover:border-rose-600 shadow-lg transition-all disabled:opacity-40"
                            >
                                Begin Encounter
                            </button>
                        ) : (
                            <div className="text-[10px] text-white/40">
                                Waiting for the encounter to begin…
                            </div>
                        )}
                    </div>
                ) : isMinimized ? (
                    <button
                        onClick={() => setIsMinimized(false)}
                        className="flex flex-col items-center gap-1 bg-black/90 backdrop-blur-2xl px-4 py-2 rounded-2xl border border-white/20 shadow-2xl hover:bg-neutral-900 transition-all duration-300 group"
                    >
                        <div className="text-xs font-medium text-white/80">
                            <span className="text-maroon-400 font-bold">Round {activeCombat.round}</span> - {currentName}
                        </div>
                        <ChevronDown className="w-6 h-6 text-white group-hover:text-white transition-transform" />
                    </button>
                ) : (
                    /* Main Initiative Queue */
                    <div className="relative flex flex-col items-center group">
                        <button
                            onClick={() => setIsMinimized(true)}
                            className="absolute top-1 left-1/2 -translate-x-1/2 z-10 w-10 h-5 flex items-center justify-center bg-black/90 rounded-full hover:bg-neutral-800 "
                        >
                            <ChevronUp className="w-15 h-15 text-white/60" />
                        </button>
                        <div className="flex items-center gap-1 sm:gap-2 px-2 sm:px-4 pt-6 pb-4 rounded-3xl bg-black/25 backdrop-blur-2xl border border-white/20 shadow-[0_10px_40px_-10px_rgba(0,0,0,0.8)] transition-all duration-500">

                            {/* Queue Container */}
                            <div className="flex items-center gap-x-2 overflow-x-auto scrollbar-hide max-w-[85vw] pt-3 px-1">
                                {carouselItems.map((item) => {
                                    // Render the Round Divider
                                    if ('isDivider' in item) {
                                        return (
                                            <div key={item.id} className="flex flex-col items-center justify-center mx-1 px-1 h-20 sm:h-24 relative">
                                                <div className="w-[2px] h-full bg-white/20 rounded-full"></div>
                                                <div className="absolute top-1/2 left-1 -translate-y-1/2 -translate-x-1/2 w-6 h-6 rounded-full bg-black/90 border border-white/20 flex items-center justify-center shadow-md">
                                                    <span className="text-[10px] font-bold text-white/40">
                                                        {activeCombat.round + 1}
                                                    </span>
                                                </div>
                                            </div>
                                        );
                                    }

                                    const combatant = item;
                                    const isCurrentTurn = combatant.isCurrent;
                                    const hasActed = currentIndex >= 0 && rows.indexOf(combatant) < currentIndex;
                                    const isDefeated = combatant.defeated;
                                    const displayName = combatant.hidden
                                        ? 'Hidden'
                                        : combatant.name?.split(' ')[0] || 'Unknown';
                                    const showImage = !combatant.hidden
                                        && combatant.img
                                        && !combatant.img.endsWith('icons/svg/mystery-man.svg');

                                    return (
                                        <div
                                            key={combatant.id}
                                            className={`relative flex flex-col items-center flex-shrink-0 transition-all duration-500 origin-bottom
                                            ${isCurrentTurn ? 'scale-110 z-10 mx-2 w-20 sm:w-24' : 'scale-95 opacity-80 hover:opacity-100 w-14 sm:w-16'}
                                            ${hasActed ? 'opacity-40 grayscale-[70%]' : ''}
                                        `}
                                        >
                                            {/* Portrait Container */}
                                            <div className={`
                                            w-full h-20 sm:h-24 rounded-t-full overflow-hidden border-[3px] shadow-lg relative bg-neutral-900 flex items-center justify-center transition-all duration-300
                                            ${isCurrentTurn ? 'border-rose-800 shadow-[0_0_20px_rgba(159,18,57,0.7)] ring-2 ring-rose-900/50' : 'border-neutral-700 hover:border-neutral-500'}
                                            ${isDefeated ? 'border-red-950/50 grayscale opacity-60' : ''}
                                        `}>
                                                {showImage ? (
                                                    <img
                                                        src={combatant.img!}
                                                        alt={combatant.name || 'Combatant'}
                                                        className="w-full h-full object-cover"
                                                    />
                                                ) : (
                                                    <Shield className="w-10 h-10 text-neutral-600" />
                                                )}

                                                {/* Defeated Overlay */}
                                                {isDefeated && (
                                                    <>
                                                        <div className="absolute inset-0 bg-red-950/40 backdrop-blur-[1px]"></div>
                                                        <div className="absolute bottom-1 right-1 z-10 bg-black/60 rounded-full p-0.5 border border-red-900/50">
                                                            <Skull className="w-3 h-3 sm:w-4 sm:h-4 text-red-700 drop-shadow-[0_0_5px_rgba(0,0,0,1)]" />
                                                        </div>
                                                    </>
                                                )}

                                                <div className={
                                                    `absolute bottom-0 flex items-center justify-center w-full h-auto
                                                ${isCurrentTurn ? 'bg-rose-800 text-white border-rose-600' : 'bg-neutral-800 text-white border-neutral-600'}
                                            `}>
                                                    <span className={`text-[11px] font-black font-mono shadow-md ${isDefeated ? 'line-through decoration-red-600 decoration-2' : ''}`}>
                                                        {displayName}
                                                    </span>
                                                </div>

                                                {/* Initiative Overlay — server-computed capability */}
                                                {combatant.canRollInitiative && combatant.initiative == null && (
                                                    <div className="absolute inset-0 bg-black/60 flex items-center justify-center z-30">
                                                        <button
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                handleInitiativeClick(combatant);
                                                            }}
                                                            disabled={pendingAction !== null}
                                                            className="bg-rose-800 text-white p-2 rounded-full hover:bg-rose-600 transition-colors shadow-lg flex items-center justify-center w-12 h-12 disabled:opacity-50"
                                                            title="Roll Initiative"
                                                        >
                                                            <img src="/icons/dice-d20.svg" alt="Roll Initiative" className="w-8 h-8 invert" />
                                                        </button>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>

                        </div>

                        {/* Floating Round Indicator Pill with Navigation */}
                        <div className="absolute -bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-3 z-[160] w-max">
                            {/* Previous Turn Button Slot */}
                            <div className="w-8 h-8 flex items-center justify-center">
                                {activeCombat.canRewindTurn && (
                                    <button
                                        onClick={handlePreviousTurn}
                                        disabled={pendingAction !== null}
                                        className="bg-black/90 border border-white/20 rounded-full w-8 h-8 flex items-center justify-center text-white/40 hover:text-white hover:border-white/40 shadow-lg transition-all disabled:opacity-40"
                                        title="Previous Turn"
                                    >
                                        <SkipBack className="w-4 h-4" />
                                    </button>
                                )}
                            </div>

                            {/* Round Indicator */}
                            <div className="bg-black/95 border border-white/20 rounded-full w-12 h-12 flex items-center justify-center shadow-2xl relative overflow-hidden group/round">
                                <div className="absolute inset-0 bg-gradient-to-b from-rose-900/20 to-transparent"></div>
                                <span className="text-3xl font-serif text-rose-600 drop-shadow-[0_2px_4px_rgba(0,0,0,0.5)] -translate-y-1 z-10">
                                    {activeCombat.round}
                                </span>
                            </div>

                            {/* Next Turn Button Slot */}
                            <div className="w-8 h-8 flex items-center justify-center">
                                {activeCombat.canAdvanceTurn && (
                                    <button
                                        onClick={handleNextTurn}
                                        disabled={pendingAction !== null}
                                        className="bg-rose-950/80 border border-rose-800/50 rounded-full w-8 h-8 flex items-center justify-center text-rose-400 hover:text-rose-100 hover:bg-rose-900 hover:border-rose-600 shadow-lg transition-all disabled:opacity-40"
                                        title="Next Turn"
                                    >
                                        <SkipForward className="w-4 h-4" />
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {DynamicRollModal && (
                <SurfaceHost moduleId={system?.id ?? undefined} surface="rollModal" loading={null}>
                    <DynamicRollModal
                        isOpen={isRollDialogOpen}
                        title={rollCommand?.title || 'Roll Initiative'}
                        type="ability"
                        actor={rollCommand?.actor}
                        defaults={{
                            abilityBonus: (rollCommand?.actor?.system as any)?.abilities?.dex?.mod || 0,
                            showItemBonus: false
                        }}
                        theme={system?.config?.componentStyles?.rollDialog}
                        onConfirm={handleConfirmRoll}
                        onClose={() => setIsRollDialogOpen(false)}
                    />
                </SurfaceHost>
            )}
        </>
    );
}
