'use client';

import { COMBAT_STAT_LAYOUT_LIMITS, type CombatManagerStatKind, type CombatManagerStatLayout } from '@shared/contracts/combatManager';

export interface CombatStatEditorDraft { label: string; path: string; kind: CombatManagerStatKind; layout: CombatManagerStatLayout }

/** One form for Add and Edit; validation/persistence remains with the manager. */
export function CombatStatAttributeEditor({ value, onChange, onApply, onCancel, editing, disabled,
    checking, reason, error, inputClass, buttonClass }: {
    value: CombatStatEditorDraft; onChange: (value: CombatStatEditorDraft) => void;
    onApply: () => void; onCancel?: () => void; editing: boolean; disabled: boolean;
    checking: boolean; reason: string; error: string; inputClass: string; buttonClass: string;
}) {
    const layoutChoice = (key: keyof CombatManagerStatLayout, label: string, max: number) => <label className="flex items-center gap-2">
        {label}<select aria-label={label} value={value.layout[key]} disabled={disabled}
            onChange={event => onChange({ ...value, layout: { ...value.layout, [key]: Number(event.target.value) } })}
            className={inputClass}>{Array.from({ length: max }, (_, index) => index + 1).map(number =>
                <option key={number} value={number}>{number}</option>)}</select>
    </label>;
    return <div className="space-y-3" aria-label={editing ? 'Edit stat presentation' : 'Add custom stat'}>
        <div className="flex flex-wrap items-center gap-2">
            <input aria-label="Custom stat label" placeholder="Label" value={value.label} maxLength={32} disabled={disabled}
                onChange={event => onChange({ ...value, label: event.target.value })} className={`w-32 ${inputClass}`} />
            <input aria-label="Custom Actor path" aria-describedby="custom-stat-help" aria-invalid={!!error} disabled={disabled}
                placeholder="system.attributes.example" value={value.path} maxLength={128}
                onChange={event => onChange({ ...value, path: event.target.value })} className={`min-w-0 flex-1 basis-64 font-mono ${inputClass}`} />
            <select aria-label="Custom stat kind" value={value.kind} disabled={disabled}
                onChange={event => onChange({ ...value, kind: event.target.value as CombatManagerStatKind })} className={inputClass}>
                <option value="text">Text</option><option value="resource">Value / max</option>
                <option value="number">Number</option><option value="textarea">Textarea</option>
            </select>
        </div>
        <fieldset className="flex flex-wrap items-center gap-3">
            <legend className="sd-ui-muted mb-2">Detail layout</legend>
            {layoutChoice('columnSpan', 'Column span', COMBAT_STAT_LAYOUT_LIMITS.columns)}
            {layoutChoice('rowSpan', 'Row span', COMBAT_STAT_LAYOUT_LIMITS.rows)}
            {value.kind === 'textarea' && layoutChoice('textRows', 'Visible text rows', COMBAT_STAT_LAYOUT_LIMITS.textRows)}
        </fieldset>
        <div className="flex flex-wrap gap-2">
            <button type="button" disabled={disabled || checking || !!reason} onClick={onApply} className={buttonClass}>
                {checking ? 'Checking attribute…' : editing ? 'Apply changes' : 'Add custom'}
            </button>
            {editing && onCancel && <button type="button" disabled={disabled} onClick={onCancel} className={buttonClass}>Cancel editing</button>}
        </div>
        <p id="custom-stat-help" className="sd-ui-muted text-xs">{reason || 'The path and type are checked before applying to this draft. Save persists the configuration. Textarea is read-only, scrollable plain text; narrow screens stack fields.'}</p>
        {error && <p role="alert" className="sd-ui-danger break-words text-xs">{error}</p>}
    </div>;
}
