
import React, { useState, useEffect, useRef } from 'react';
import InitiativeRollDialog from './InitiativeRollDialog';
import RollDialogFrame, { defaultRollDialogTheme as defaultTheme, resolveRollDialogTheme } from './RollDialogFrame';
import type { RollDialogProps, SheetRollDialogProps } from '@shared/sdk/ui';

function SheetRollDialog({ isOpen, title, type, actor, defaults, onConfirm, onClose, theme }: SheetRollDialogProps) {
    const [abilityBonus, setAbilityBonus] = useState(0);
    const [itemBonus, setItemBonus] = useState(0);
    const [talentBonus, setTalentBonus] = useState(0);
    const [rollingMode, setRollingMode] = useState<string>('publicroll');
    const [advantageMode, setAdvantageMode] = useState<'normal' | 'advantage' | 'disadvantage'>('normal');
    const [isManual, setIsManual] = useState(false);
    const [manualValue, setManualValue] = useState<string>('');
    const popupRef = useRef<HTMLDivElement>(null);

    const t = resolveRollDialogTheme(theme);

    // Reset state when dialog opens with new defaults
    useEffect(() => {
        if (isOpen) {
            setAbilityBonus(defaults?.abilityBonus || 0);
            setItemBonus(defaults?.itemBonus || 0);
            setTalentBonus(defaults?.talentBonus || 0);
            setAdvantageMode(defaults?.advantageMode || 'normal');

            // Persistence: Load roll mode
            const saved = localStorage.getItem('sheetdelver_roll_mode');
            if (saved) setRollingMode(saved);
        }
    }, [isOpen, defaults]);

    // Persistence: Save roll mode
    const updateRollMode = (mode: string) => {
        setRollingMode(mode);
        localStorage.setItem('sheetdelver_roll_mode', mode);
    };

    // Close on click outside
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (popupRef.current && !popupRef.current.contains(event.target as Node)) {
                onClose();
            }
        };

        if (isOpen) {
            document.addEventListener('mousedown', handleClickOutside);
        }
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    const handleRoll = () => {
        onConfirm({
            abilityBonus,
            itemBonus,
            talentBonus,
            rollingMode,
            advantageMode,
            manualValue: isManual ? Number(manualValue) : undefined
        });
    };

    const toggleAdvantage = (mode: 'advantage' | 'disadvantage') => {
        if (advantageMode === mode) {
            setAdvantageMode('normal');
        } else {
            setAdvantageMode(mode);
        }
    };

    // Determine the main button text
    let rollBtnText = 'Roll Normal';
    if (advantageMode === 'advantage') rollBtnText = 'Roll Advantage';
    if (advantageMode === 'disadvantage') rollBtnText = 'Roll Disadvantage';

    const footer = (
        <div className="flex flex-col gap-3 pt-4 border-t sd-ui-divider">
            <button
                onClick={() => setIsManual(!isManual)}
                className={`sd-ui-button w-full py-2 px-4 font-bold text-xs uppercase tracking-widest transition-all ${isManual ? 'sd-ui-button-primary' : ''}`}
            >
                {isManual ? 'Revert to Roll' : 'Manual Input'}
            </button>

            {isManual && (
                <div className="py-2">
                    <div className={t.inputGroup}>
                        <label className={t.label}>Result</label>
                        <input
                            type="number"
                            value={manualValue}
                            onChange={e => setManualValue(e.target.value)}
                            placeholder="Enter result..."
                            className={`${t.input} [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none`}
                            style={{ MozAppearance: 'textfield' }}
                            autoFocus
                        />
                    </div>
                </div>
            )}

            <button
                onClick={handleRoll}
                disabled={isManual && !manualValue.trim()}
                className={t.rollBtn ? t.rollBtn('normal') : defaultTheme.rollBtn('normal')}
                style={{
                    opacity: (isManual && !manualValue.trim()) ? 0.5 : 1,
                    cursor: (isManual && !manualValue.trim()) ? 'not-allowed' : 'pointer'
                }}
            >
                {isManual ? 'Send Result' : rollBtnText}
            </button>

            {!isManual && (
                <div className="flex gap-2">
                    <button
                        onClick={() => toggleAdvantage('advantage')}
                        className={t.rollBtn ? t.rollBtn('adv') : defaultTheme.rollBtn('adv')}
                        style={{
                            opacity: advantageMode === 'advantage' || advantageMode === 'normal' ? 1 : 0.4,
                            transform: advantageMode === 'advantage' ? 'translateY(2px)' : 'none',
                            boxShadow: advantageMode === 'advantage' ? 'none' : undefined,
                            borderWidth: advantageMode === 'advantage' ? '4px' : undefined
                        }}
                    >
                        Advantage
                    </button>
                    <button
                        onClick={() => toggleAdvantage('disadvantage')}
                        className={t.rollBtn ? t.rollBtn('dis') : defaultTheme.rollBtn('dis')}
                        style={{
                            opacity: advantageMode === 'disadvantage' || advantageMode === 'normal' ? 1 : 0.4,
                            transform: advantageMode === 'disadvantage' ? 'translateY(2px)' : 'none',
                            boxShadow: advantageMode === 'disadvantage' ? 'none' : undefined,
                            borderWidth: advantageMode === 'disadvantage' ? '4px' : undefined
                        }}
                    >
                        Disadvantage
                    </button>
                </div>
            )}
        </div>
    );
    return (
        <RollDialogFrame title={title} theme={theme} onClose={onClose} dialogRef={popupRef} footer={footer}>
            {/* Dynamic Inputs based on Type */}
            {(type === 'attack' || type === 'spell') && (defaults?.showItemBonus !== false) && (
                <div className={t.inputGroup}>
                    <label className={t.label}>Item Bonus</label>
                    <input
                        type="number"
                        value={itemBonus}
                        onChange={e => setItemBonus(Number(e.target.value))}
                        className={`${t.input} [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none`}
                        style={{ MozAppearance: 'textfield' }}
                    />
                </div>
            )}

            <div className={t.inputGroup}>
                <label className={t.label}>Ability Bonus</label>
                <input
                    type="number"
                    value={abilityBonus}
                    onChange={e => setAbilityBonus(Number(e.target.value))}
                    className={`${t.input} [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none`}
                    style={{ MozAppearance: 'textfield' }}
                />
            </div>

            {(type === 'attack' || type === 'spell') && (
                <div className={t.inputGroup}>
                    <label className={t.label}>Talent Bonus</label>
                    <input
                        type="number"
                        value={talentBonus}
                        onChange={e => setTalentBonus(Number(e.target.value))}
                        className={`${t.input} [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none`}
                        style={{ MozAppearance: 'textfield' }}
                    />
                </div>
            )}

            <div className={`${t.inputGroup} pt-4 border-t sd-ui-divider`}>
                <label className={t.label}>Mode</label>
                <div className="col-span-2 relative">
                    <select
                        value={rollingMode}
                        onChange={e => updateRollMode(e.target.value)}
                        className={t.select}
                    >
                        <option value="publicroll">Public Roll</option>
                        <option value="gmroll">Private GM Roll</option>
                        <option value="blindroll">Blind GM Roll</option>
                        <option value="selfroll">Self Roll</option>
                    </select>
                    <div className={t.selectArrow}>
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
                            <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
                        </svg>
                    </div>
                </div>
            </div>
        </RollDialogFrame>
    );
}

/** SDK-injected component retains sheet rolls and adds a bounded HUD mode. */
export default function RollDialog(props: RollDialogProps) {
    return props.type === 'initiative' ? <InitiativeRollDialog {...props} /> : <SheetRollDialog {...props} />;
}
