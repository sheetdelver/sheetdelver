'use client';

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useFoundry } from '@client/ui/context/FoundryContext';
import { useActorCombat } from '@client/ui/context/ActorCombatContext';
import { useSession } from '@client/ui/context/SessionContext';
import type { CombatDto } from '@shared/contracts/combats';
import { resolveImage, getUIModule } from '@modules/registry/client';
import { SurfaceHost } from '@client/ui/components/SurfaceHost';
import { logger } from '@shared/utils/logger';
import { Swords, Skull, Shield, ChevronLeft, ChevronRight, ChevronUp, ChevronDown, SkipForward, SkipBack } from 'lucide-react';
import RollDialog from '../RollDialog';

export default function CombatHUD() {
    const { step, currentUser, system } = useFoundry();
    const { combats } = useActorCombat();
    const { token } = useSession();
    const [selectedCombatIndex, setSelectedCombatIndex] = useState(0);
    const [isMinimized, setIsMinimized] = useState(false);

    // Optimistic State
    const [optimisticCombat, setOptimisticCombat] = useState<CombatDto | null>(null);

    // Roll Dialog State
    const [isRollDialogOpen, setIsRollDialogOpen] = useState(false);
    const [rollCommand, setRollCommand] = useState<any>(null); // Type, title, actor, etc.

    // Sync optimistic state with actual state when it arrives
    useEffect(() => {
        setOptimisticCombat(null);
    }, [combats]);

    const [DynamicRollModal, setDynamicRollModal] = useState<React.ComponentType<any> | null>(null);

    useEffect(() => {
        let isMounted = true;
        async function resolveRollModal() {
            // Determine system ID: best source is a combatant's stats, then global system object, then active adapter
            let sId = 'generic';
            if (combats && combats.length > 0 && (combats[selectedCombatIndex] as any)?.combatants?.length > 0) {
                const activeC = combats[selectedCombatIndex];
                const combatantStats = activeC.combatants?.[0]?._stats as Record<string, unknown> | undefined;
                sId = (combatantStats?.systemId as string | undefined) || sId;
            }
            if (sId === 'generic') {
                sId = system?.id || 'generic';
            }

            const manifest = await getUIModule(sId);
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
    }, [combats, selectedCombatIndex, system?.id]);

    // Render only during the dashboard step — reconnecting/world-closed and
    // every pre-game step must not show (possibly stale) combat state (ADR-0028).
    if (step !== 'dashboard') return null;

    // Active + started encounters only (ADR-0028 resolved policy). Scene
    // presence is not an activity signal; `round >= 1` stands in for Foundry's
    // derived `started` until the tracker DTO projects it explicitly.
    const activeCombats = combats?.filter(c => (c as any).active === true && (c.round ?? 0) >= 1) || [];

    if (activeCombats.length === 0) return null;

    // Safety bounds for selected index
    const activeCombat = activeCombats[Math.min(selectedCombatIndex, activeCombats.length - 1)];
    const displayCombat = optimisticCombat || activeCombat;

    const handleInitiativeClick = (combatant: any) => {
        setRollCommand({
            combatId: activeCombat._id || activeCombat.id,
            combatantId: combatant._id || combatant.id,
            actor: combatant.actor,
            title: `Roll Initiative: ${combatant.actor?.name}`
        });
        setIsRollDialogOpen(true);
    };

    const handleConfirmRoll = async (options: any) => {
        setIsRollDialogOpen(false);
        if (!rollCommand) return;

        try {
            if (!token) throw new Error('No session token');

            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            };

            // Calculate formula modification
            let formulaSuffix = '';
            const totalBonus = (options.abilityBonus || 0) + (options.itemBonus || 0) + (options.talentBonus || 0);
            if (totalBonus > 0) formulaSuffix = `+${totalBonus}`;
            else if (totalBonus < 0) formulaSuffix = `${totalBonus}`;

            const formula = options.manualValue !== undefined ? `${options.manualValue}` : undefined;

            await fetch(`/api/combats/${rollCommand.combatId}/combatants/${rollCommand.combatantId}/roll-initiative`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    formula: formula ? `${formula}${formulaSuffix}` : undefined,
                    advantageMode: options.advantageMode
                })
            });
            setRollCommand(null);
        } catch (error) {
            logger.error('Failed to roll initiative:', error);
        }
    };

    const handleNextTurn = async () => {
        try {
            if (!token || !activeCombat) return;

            // Optimistic Update
            const sorted = [...(activeCombat.combatants || [])].sort((a: any, b: any) => {
                const ia = typeof a.initiative === 'number' && !isNaN(a.initiative) ? a.initiative : -Infinity;
                const ib = typeof b.initiative === 'number' && !isNaN(b.initiative) ? b.initiative : -Infinity;
                return (ib - ia) || ((a._id || a.id) > (b._id || b.id) ? 1 : -1);
            });

            let nextRound = activeCombat.round || 0;
            let nextTurn = (activeCombat.turn ?? -1);

            if (nextRound === 0) {
                nextRound = 1;
                nextTurn = 0;
            } else {
                nextTurn += 1;
                if (nextTurn >= sorted.length) {
                    nextRound += 1;
                    nextTurn = 0;
                }
            }

            setOptimisticCombat({ ...activeCombat, round: nextRound, turn: nextTurn });

            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            };
            await fetch(`/api/combats/${activeCombat._id || activeCombat.id}/next-turn`, {
                method: 'POST',
                headers
            });
        } catch (error) {
            setOptimisticCombat(null);
            logger.error('Failed to advance turn:', error);
        }
    };

    const handlePreviousTurn = async () => {
        try {
            if (!token || !activeCombat) return;

            // Optimistic Update
            let prevRound = activeCombat.round || 0;
            let prevTurn = activeCombat.turn ?? 0;

            if (prevRound === 0) {
                // do nothing
            } else if (prevTurn === 0) {
                if (prevRound > 1) {
                    prevRound -= 1;
                    prevTurn = (activeCombat.combatants?.length || 1) - 1;
                } else {
                    prevRound = 0;
                    prevTurn = 0;
                }
            } else {
                prevTurn -= 1;
            }

            setOptimisticCombat({ ...activeCombat, round: prevRound, turn: prevTurn });

            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            };
            await fetch(`/api/combats/${activeCombat._id || activeCombat.id}/previous-turn`, {
                method: 'POST',
                headers
            });
        } catch (error) {
            setOptimisticCombat(null);
            logger.error('Failed to rewind turn:', error);
        }
    };

    // Derive sorted combatants for the queue
    const sortedCombatants = [...(displayCombat?.combatants || [])].sort((a: any, b: any) => {
        const ia = typeof a.initiative === 'number' && !isNaN(a.initiative) ? a.initiative : -Infinity;
        const ib = typeof b.initiative === 'number' && !isNaN(b.initiative) ? b.initiative : -Infinity;
        return (ib - ia) || ((a._id || a.id) > (b._id || b.id) ? 1 : -1);
    });

    const currentTurnIndex = displayCombat?.turn ?? 0;

    // Get the name of current actor
    const currentActorName = sortedCombatants[currentTurnIndex]?.actor?.name || 'Unknown';

    const unacted = sortedCombatants.slice(currentTurnIndex);
    const acted = sortedCombatants.slice(0, currentTurnIndex);

    const carouselItems = [
        ...unacted,
        { isDivider: true, id: 'round-divider' },
        ...acted
    ];


    return (
        <>
            <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[150] pointer-events-auto flex flex-col items-center gap-2">

                {/* Multiple Combats Selector */}
                {activeCombats.length > 1 && !isMinimized && (
                    <div className="flex items-center gap-2 bg-black/80 backdrop-blur-md px-3 py-1 rounded-full border border-white/10 shadow-lg text-xs font-medium text-white/70">
                        <button
                            onClick={() => setSelectedCombatIndex(prev => Math.max(0, prev - 1))}
                            disabled={selectedCombatIndex === 0}
                            className="p-1 hover:text-white disabled:opacity-30 disabled:hover:text-white/70 transition-colors"
                        >
                            <ChevronLeft className="w-4 h-4" />
                        </button>
                        <span>Encounter {selectedCombatIndex + 1} of {activeCombats.length}</span>
                        <button
                            onClick={() => setSelectedCombatIndex(prev => Math.min(activeCombats.length - 1, prev + 1))}
                            disabled={selectedCombatIndex === activeCombats.length - 1}
                            className="p-1 hover:text-white disabled:opacity-30 disabled:hover:text-white/70 transition-colors"
                        >
                            <ChevronRight className="w-4 h-4" />
                        </button>
                    </div>
                )}

                {/* Minimized Bubble */}
                {isMinimized ? (
                    <button
                        onClick={() => setIsMinimized(false)}
                        className="flex flex-col items-center gap-1 bg-black/90 backdrop-blur-2xl px-4 py-2 rounded-2xl border border-white/20 shadow-2xl hover:bg-neutral-900 transition-all duration-300 group"
                    >
                        <div className="text-xs font-medium text-white/80">
                            <span className="text-maroon-400 font-bold">Round {activeCombat?.round || 1}</span> - {currentActorName}
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
                                {carouselItems.map((item: any, visualIdx: number) => {
                                    // Render the Round Divider
                                    if (item.isDivider) {
                                        return (
                                            <div key={item.id} className="flex flex-col items-center justify-center mx-1 px-1 h-20 sm:h-24 relative">
                                                <div className="w-[2px] h-full bg-white/20 rounded-full"></div>
                                                <div className="absolute top-1/2 left-1 -translate-y-1/2 -translate-x-1/2 w-6 h-6 rounded-full bg-black/90 border border-white/20 flex items-center justify-center shadow-md">
                                                    <span className="text-[10px] font-bold text-white/40">
                                                        {activeCombat ? (activeCombat.round ?? 0) + 1 : 2}
                                                    </span>
                                                </div>
                                            </div>
                                        );
                                    }

                                    const combatant = item;
                                    const originalIndex = sortedCombatants.findIndex(c => c._id === combatant._id);
                                    const isCurrentTurn = originalIndex === currentTurnIndex;
                                    const hasActed = originalIndex < currentTurnIndex;
                                    const isDefeated = combatant.defeated;

                                    return (
                                        <div
                                            key={combatant._id || visualIdx}
                                            className={`relative flex flex-col items-center flex-shrink-0 transition-all duration-500 origin-bottom
                                            ${isCurrentTurn ? 'scale-110 z-10 mx-2 w-20 sm:w-24' : 'scale-95 opacity-80 hover:opacity-100 w-14 sm:w-16'}
                                            ${hasActed ? 'opacity-40 grayscale-[70%]' : ''}
                                        `}
                                        >
                                            {/* Current Turn Indicator Arrow */}
                                            {isCurrentTurn && (
                                                <div className="absolute animate-bounce flex flex-col items-center z-20 hidden">
                                                    <div className="w-3 h-3 bg-rose-800 rotate-45 transform origin-bottom border-t border-l border-rose-600 shadow-[0_-5px_15px_rgba(159,18,57,0.5)]"></div>
                                                </div>
                                            )}

                                            {/* Portrait Container */}
                                            <div className={`
                                            w-full h-20 sm:h-24 rounded-t-full overflow-hidden border-[3px] shadow-lg relative bg-neutral-900 flex items-center justify-center transition-all duration-300
                                            ${isCurrentTurn ? 'border-rose-800 shadow-[0_0_20px_rgba(159,18,57,0.7)] ring-2 ring-rose-900/50' : 'border-neutral-700 hover:border-neutral-500'}
                                            ${isDefeated ? 'border-red-950/50 grayscale opacity-60' : ''}
                                        `}>
                                                {!combatant.hidden && combatant.actor?.img && combatant.actor.img !== 'icons/svg/mystery-man.svg' ? (
                                                    <img
                                                        src={combatant.actor?.img}
                                                        alt={combatant.actor?.name || 'Combatant'}
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
                                                    <span className={`text-[11px] font-black font-mono shadow-md ${combatant.defeated ? 'line-through decoration-red-600 decoration-2' : ''}`}>
                                                        {!combatant.hidden ? combatant.actor?.name?.split(' ')[0] || 'Unknown' : 'Hidden'}
                                                    </span>
                                                </div>

                                                {/* Initiative Overlay */}
                                                {combatant.actor && combatant.initiative == null &&
                                                    (currentUser?.isGM || combatant.actor.ownership?.[currentUser?._id || currentUser?.id || ''] === 3 || combatant.actor.ownership?.default === 3) && (
                                                        <div className="absolute inset-0 bg-black/60 flex items-center justify-center z-30">
                                                            <button
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    handleInitiativeClick(combatant);
                                                                }}
                                                                className="bg-rose-800 text-white p-2 rounded-full hover:bg-rose-600 transition-colors shadow-lg flex items-center justify-center w-12 h-12"
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
                                {currentUser?.isGM && activeCombat && ((activeCombat.round ?? 0) > 1 || ((activeCombat.round ?? 0) === 1 && (activeCombat.turn ?? 0) > 0)) && (
                                    <button
                                        onClick={handlePreviousTurn}
                                        className="bg-black/90 border border-white/20 rounded-full w-8 h-8 flex items-center justify-center text-white/40 hover:text-white hover:border-white/40 shadow-lg transition-all"
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
                                    {activeCombat?.round || `0`}
                                </span>
                            </div>

                            {/* Next Turn Button Slot */}
                            <div className="w-8 h-8 flex items-center justify-center">
                                {(() => {
                                    if (!activeCombat || activeCombat.round === 0) return null;

                                    const currentCombatant = sortedCombatants[currentTurnIndex];
                                    const isOwner = currentCombatant?.actor && (
                                        currentUser?.isGM ||
                                        currentCombatant.actor.ownership?.[currentUser?._id || currentUser?.id || ''] === 3 ||
                                        currentCombatant.actor.ownership?.default === 3
                                    );

                                    if (isOwner || currentUser?.isGM) {
                                        return (
                                            <button
                                                onClick={handleNextTurn}
                                                className="bg-rose-950/80 border border-rose-800/50 rounded-full w-8 h-8 flex items-center justify-center text-rose-400 hover:text-rose-100 hover:bg-rose-900 hover:border-rose-600 shadow-lg transition-all"
                                                title={isOwner ? "End Turn" : "Force Next Turn"}
                                            >
                                                <SkipForward className="w-4 h-4" />
                                            </button>
                                        );
                                    }
                                    return null;
                                })()}
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
                            abilityBonus: rollCommand?.actor?.system?.abilities?.dex?.mod || 0,
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
