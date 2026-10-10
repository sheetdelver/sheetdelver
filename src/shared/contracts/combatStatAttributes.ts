import type { ModuleCombatStatAttribute } from '@shared/sdk/interfaces';
import type { CombatManagerSelectedStatDto } from './combatManager';

export const MAX_COMBAT_STATS = 8;
const MAX_DECLARED_STATS = 16;
const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const SEGMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KINDS = new Set(['number', 'text', 'resource']);

export function isSafeCombatStatPath(value: unknown): value is string {
    if (typeof value !== 'string' || value.length > 128) return false;
    const segments = value.split('.');
    return segments.length >= 2 && segments.length <= 8
        && ['system', 'derived'].includes(segments[0])
        && segments.every(segment => SEGMENT_PATTERN.test(segment)
            && !['__proto__', 'constructor', 'prototype'].includes(segment));
}

/** Pure validator shared by module manifest ingestion and GM preference writes. */
export function parseCombatStatAttributes(value: unknown, limit = MAX_COMBAT_STATS): ModuleCombatStatAttribute[] | null {
    if (!Array.isArray(value) || value.length > limit || value.length > MAX_DECLARED_STATS) return null;
    const keys = new Set<string>();
    const attributes: ModuleCombatStatAttribute[] = [];
    for (const item of value) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
        const row = item as Record<string, unknown>;
        if (typeof row.key !== 'string' || !KEY_PATTERN.test(row.key) || keys.has(row.key)
            || typeof row.label !== 'string' || !row.label.trim() || row.label.trim().length > 32
            || !isSafeCombatStatPath(row.path) || !KINDS.has(String(row.kind))) return null;
        const actorTypes = row.actorTypes;
        if (actorTypes !== undefined && (!Array.isArray(actorTypes) || actorTypes.length > 16
            || actorTypes.some(type => typeof type !== 'string' || !type || type.length > 64
                || type.trim() !== type || /[\u0000-\u001f\u007f]/.test(type)))) return null;
        if (row.showInRoster !== undefined && typeof row.showInRoster !== 'boolean') return null;
        keys.add(row.key);
        attributes.push({
            key: row.key, label: row.label.trim(), path: row.path,
            kind: row.kind as ModuleCombatStatAttribute['kind'],
            ...(actorTypes === undefined ? {} : { actorTypes: [...actorTypes] as string[] }),
            ...(row.showInRoster === true ? { showInRoster: true } : {}),
        });
    }
    return attributes;
}

/** Validate Core's persisted GM selection without broadening module metadata. */
export function parseCombatStatSelection(value: unknown, limit = MAX_COMBAT_STATS): CombatManagerSelectedStatDto[] | null {
    const attributes = parseCombatStatAttributes(value, limit);
    if (!attributes) return null;
    const selected: CombatManagerSelectedStatDto[] = [];
    let healthCount = 0;
    for (const [index, attribute] of attributes.entries()) {
        const raw = (value as Record<string, unknown>[])[index];
        if (raw.editable !== undefined && typeof raw.editable !== 'boolean') return null;
        if (raw.health !== undefined && typeof raw.health !== 'boolean') return null;
        if (raw.editable === true && (!attribute.path.startsWith('system.')
            || !['number', 'resource'].includes(attribute.kind))) return null;
        if (raw.health === true && (raw.editable !== true || ++healthCount > 1)) return null;
        selected.push({ ...attribute, ...(raw.editable === true ? { editable: true } : {}),
            ...(raw.health === true ? { health: true } : {}) });
    }
    return selected;
}
