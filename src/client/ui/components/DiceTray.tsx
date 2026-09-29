'use client';

import { useState, useEffect } from 'react';
import type { RollMode } from '@shared/sdk';
import { Globe, UserRoundSearch, EyeOff, User } from 'lucide-react';

import { DicePresentationPreference } from './Dice/DicePresentationPreference';

interface DiceTrayProps {
    onSend: (message: string, options?: { rollMode?: RollMode; speaker?: string }) => void;
    hideHeader?: boolean;
    speaker?: string;
}

const defaultStyles = {
    container: "sd-ui-panel backdrop-blur-md rounded-2xl p-4 flex flex-col gap-4 h-full shadow-2xl",
    header: "sd-ui-muted text-[10px] font-bold uppercase tracking-widest border-b sd-ui-divider pb-2",
    textarea: "sd-ui-control w-full h-24 rounded-xl p-3 font-sans text-lg resize-none transition-all",
    clearBtn: "sd-ui-muted absolute top-2 right-2 text-[10px] hover:opacity-80 uppercase font-bold tracking-widest transition-opacity",
    diceRow: "sd-ui-inset flex flex-wrap justify-between gap-2 p-2 rounded-xl",
    diceBtn: "sd-ui-button w-10 h-10 flex items-center justify-center active:scale-95 rounded-lg text-xs font-bold font-sans transition-all",
    modGroup: "flex gap-1",
    modBtn: "sd-ui-button px-3 py-2 rounded-lg active:scale-95 font-bold transition-all",
    advGroup: "sd-ui-inset flex rounded-lg p-1",
    advBtn: (active: boolean, type: 'normal' | 'adv' | 'dis') => {
        const base = "px-2 py-1 text-[10px] font-bold rounded-md transition-all ";
        if (!active) return base + "sd-ui-muted hover:opacity-80";
        if (type === 'normal') return base + "sd-ui-button-primary";
        if (type === 'adv') return base + "sd-ui-success sd-ui-inset";
        return base + "sd-ui-danger sd-ui-inset";
    },
    sendBtn: "sd-ui-button sd-ui-button-primary flex-1 font-bold uppercase tracking-widest py-3 rounded-xl shadow-lg active:scale-95 transition-all text-xl",
    helpText: "sd-ui-muted text-[10px] text-center mt-2 uppercase tracking-widest font-medium"
};

import { useFoundry } from '@client/ui/context/FoundryContext';

const getPrefix = (mode: RollMode) => {
    switch (mode) {
        case 'gmroll': return '/gmr';
        case 'blindroll': return '/br';
        case 'selfroll': return '/sr';
        default: return '/r';
    }
};

const DICE_REGEX = /(\d+)d(\d+)([a-z]*)/g;

const updateFormulaForMode = (currentFormula: string, mode: 'normal' | 'adv' | 'dis') => {
    if (!currentFormula) return currentFormula;

    return currentFormula.replace(DICE_REGEX, (match, count, faces, suffix) => {
        if (mode === 'normal') {
            if (count === '2' && (suffix === 'kh' || suffix === 'kl')) {
                return `1d${faces}`;
            }
            return match;
        }

        if (mode === 'adv') {
            if (count === '1' && !suffix) {
                return `2d${faces}kh`;
            }
            if (count === '2' && suffix === 'kl') {
                return `2d${faces}kh`;
            }
            return match;
        }

        if (mode === 'dis') {
            if (count === '1' && !suffix) {
                return `2d${faces}kl`;
            }
            if (count === '2' && suffix === 'kh') {
                return `2d${faces}kl`;
            }
            return match;
        }

        return match;
    });
};

export default function DiceTray({ onSend, hideHeader = false, speaker }: DiceTrayProps) {
    const { system } = useFoundry();
    const [formula, setFormula] = useState('');
    const [advMode, setAdvMode] = useState<'normal' | 'adv' | 'dis'>('normal');
    const [rollMode, setRollMode] = useState<RollMode>('publicroll');

    // Persistence: Load roll mode
    useEffect(() => {
        const saved = localStorage.getItem('sheetdelver_roll_mode') as RollMode;
        if (saved) setRollMode(saved);
    }, []);

    // Persistence: Save roll mode
    const updateRollMode = (mode: RollMode) => {
        setRollMode(mode);
        localStorage.setItem('sheetdelver_roll_mode', mode);
    };

    // Effect: Sync formula prefix when rollMode changes
    useEffect(() => {
        setFormula(prev => {
            const prefix = getPrefix(rollMode);
            // If empty, just set the prefix
            if (!prev.trim()) return prefix + ' ';

            // If it already has a roll command, swap it
            const prefixRegex = /^\/(r|roll|gmr|gmroll|br|blindroll|sr|selfroll)\s*/i;
            if (prefixRegex.test(prev)) {
                return prev.replace(prefixRegex, prefix + ' ');
            }

            // If it looks like a roll but lacks prefix, prepend it
            if (prev.match(/\d*d\d+/) || prev.match(/^[\+\-]\d+/)) {
                return prefix + ' ' + prev;
            }

            return prev;
        });
    }, [rollMode]);

    const s = { ...defaultStyles, ...(system?.config?.componentStyles?.diceTray || {}) };
    // @ts-ignore - The theme might have this, but not in all adapters yet
    const themeStyles = system?.config?.componentStyles?.diceTray;

    // Effect: Update formula when advMode changes
    useEffect(() => {
        setFormula(prev => updateFormulaForMode(prev, advMode));
    }, [advMode]);

    const addTerm = (term: string) => {
        // Prepare terms based on mode
        let finalTerm = term;
        // Check if term is a die (e.g. "1d20")
        if (term.match(/^\d+d\d+$/)) {
            // Let the helper transform it immediately
            finalTerm = updateFormulaForMode(term, advMode);
        }

        setFormula(prev => {
            // If empty, start with current prefix 
            const prefix = getPrefix(rollMode);
            const newFormula = prev || (prefix + ' ');
            // Simple check to avoid double spaces or weird joins
            const spacer = newFormula.endsWith(' ') ? '' : ' + ';
            return newFormula + spacer + finalTerm;
        });
    };

    const handleManualChange = (val: string) => {
        setFormula(val);
    };

    const clear = () => setFormula('');

    const roll = () => {
        if (!formula) return;
        // Formula is already reactive, so just send it.
        onSend(formula, { rollMode, speaker });
        setFormula('');
        setAdvMode('normal');
    };

    return (
        <div className={`${system?.id ? `sdk-module--${system.id}` : ''} ${s.container} flex flex-col gap-4 [&>*]:shrink-0`} style={{ maxHeight: 'calc(100dvh - 12rem)', overflowY: 'auto' }}>
            {!hideHeader && <h3 className={s.header}>Dice Tray</h3>}
            <DicePresentationPreference />

            {/* Roll Mode Selector */}
            {/* @ts-ignore - Use the new theme extension if available */}
            <div className={themeStyles?.rollModeGroup || "flex gap-1 mb-2"}>
                <button
                    onClick={() => updateRollMode('publicroll')}
                    title="Public Roll"
                    /* @ts-ignore */
                    className={themeStyles?.rollModeBtn ? themeStyles.rollModeBtn(rollMode === 'publicroll') : `sd-ui-button flex-1 flex items-center justify-center p-2 rounded-lg transition-all ${rollMode === 'publicroll' ? 'sd-ui-button-primary shadow-inner' : ''}`}
                >
                    <Globe size={18} />
                </button>
                <button
                    onClick={() => updateRollMode('gmroll')}
                    title="Private GM Roll"
                    /* @ts-ignore */
                    className={themeStyles?.rollModeBtn ? themeStyles.rollModeBtn(rollMode === 'gmroll') : `sd-ui-button flex-1 flex items-center justify-center p-2 rounded-lg transition-all ${rollMode === 'gmroll' ? 'sd-ui-button-primary shadow-inner' : ''}`}
                >
                    <UserRoundSearch size={18} />
                </button>
                <button
                    onClick={() => updateRollMode('blindroll')}
                    title="Blind GM Roll"
                    /* @ts-ignore */
                    className={themeStyles?.rollModeBtn ? themeStyles.rollModeBtn(rollMode === 'blindroll') : `sd-ui-button flex-1 flex items-center justify-center p-2 rounded-lg transition-all ${rollMode === 'blindroll' ? 'sd-ui-button-primary shadow-inner' : ''}`}
                >
                    <EyeOff size={18} />
                </button>
                <button
                    onClick={() => updateRollMode('selfroll')}
                    title="Self Roll"
                    /* @ts-ignore */
                    className={themeStyles?.rollModeBtn ? themeStyles.rollModeBtn(rollMode === 'selfroll') : `sd-ui-button flex-1 flex items-center justify-center p-2 rounded-lg transition-all ${rollMode === 'selfroll' ? 'sd-ui-button-primary shadow-inner' : ''}`}
                >
                    <User size={18} />
                </button>
            </div>

            {/* Display / Input */}
            <div className="relative">
                <textarea
                    value={formula}
                    onChange={(e) => handleManualChange(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            roll();
                        }
                    }}
                    className={s.textarea || defaultStyles.textarea}
                    placeholder="/r 1d20 + 5 OR Hello World"
                />
                <button
                    onClick={clear}
                    className={s.clearBtn || defaultStyles.clearBtn}
                >
                    Clear
                </button>
            </div>

            {/* Controls */}
            <div className="grid grid-cols-1 gap-4">

                {/* Dice Row */}
                <div className={s.diceRow || defaultStyles.diceRow}>
                    {['d4', 'd6', 'd8', 'd10', 'd12', 'd20', 'd100'].map(d => (
                        <button
                            key={d}
                            onClick={() => addTerm('1' + d)}
                            className={s.diceBtn || defaultStyles.diceBtn}
                        >
                            {d}
                        </button>
                    ))}
                </div>

                {/* Modifiers & Roll */}
                <div className="flex flex-wrap gap-2 items-center">
                    <div className={s.modGroup || defaultStyles.modGroup}>
                        <button onClick={() => addTerm('1')} className={s.modBtn || defaultStyles.modBtn}>+1</button>
                        <button onClick={() => addTerm('5')} className={s.modBtn || defaultStyles.modBtn}>+5</button>
                        <button onClick={() => addTerm('-1')} className={s.modBtn || defaultStyles.modBtn}>-1</button>
                    </div>

                    <div className={s.advGroup || defaultStyles.advGroup}>
                        <button
                            onClick={() => setAdvMode('normal')}
                            className={s.advBtn ? s.advBtn(advMode === 'normal', 'normal') : defaultStyles.advBtn(advMode === 'normal', 'normal')}
                        >
                            -
                        </button>
                        <button
                            onClick={() => setAdvMode('adv')}
                            className={s.advBtn ? s.advBtn(advMode === 'adv', 'adv') : defaultStyles.advBtn(advMode === 'adv', 'adv')}
                        >
                            ADV
                        </button>
                        <button
                            onClick={() => setAdvMode('dis')}
                            className={s.advBtn ? s.advBtn(advMode === 'dis', 'dis') : defaultStyles.advBtn(advMode === 'dis', 'dis')}
                        >
                            DIS
                        </button>
                    </div>

                    <button
                        onClick={roll}
                        className={`${s.sendBtn || defaultStyles.sendBtn} basis-full`}
                    >
                        Send
                    </button>
                </div>
            </div>

            <div className={s.helpText || defaultStyles.helpText}>
                Click dice to append. Edit manually if needed. ADV/DIS applies to d20s.
            </div>
        </div>
    );
}
