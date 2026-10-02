import { isSafeCombatStatPath } from '@shared/contracts/combatStatAttributes';
import type { CombatManagerActorSortFieldDto, CombatManagerActorSortRequest,
    CombatManagerSortDirection } from '@shared/contracts/combatManager';

export const DEFAULT_ACTOR_SORT: CombatManagerActorSortRequest = { nameDirection: 'asc', fields: [] };
const MAX_SORT_FIELDS = 3;
const MAX_CATALOG_FIELDS = 160;
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function direction(value: unknown): value is CombatManagerSortDirection {
    return value === 'asc' || value === 'desc';
}

/** Reject malformed or stale client sort requests before they reach the store/index. */
export function parseActorPickerSort(input: unknown): CombatManagerActorSortRequest | null {
    if (input === undefined || input === '') return DEFAULT_ACTOR_SORT;
    if (typeof input !== 'string' || input.length > 700) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(input); } catch { return null; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    if (!direction(value.nameDirection) || !Array.isArray(value.fields) || value.fields.length > MAX_SORT_FIELDS) return null;
    const seen = new Set<string>();
    const fields: CombatManagerActorSortRequest['fields'] = [];
    for (const item of value.fields) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
        const row = item as Record<string, unknown>;
        if (!isSafeCombatStatPath(row.path) || !row.path.startsWith('system.')
            || !direction(row.direction) || seen.has(row.path)) return null;
        seen.add(row.path);
        fields.push({ path: row.path, direction: row.direction });
    }
    return { nameDirection: value.nameDirection, fields };
}

function fieldLabel(path: string): string {
    return path.split('.').slice(1).map(part => part.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ').split(' ').filter(Boolean)
        .map(word => word.length <= 2 ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1))
        .join(' ')).join(' · ');
}

function comparable(value: unknown): 'number' | 'text' | null {
    if (typeof value === 'number' && Number.isFinite(value)) return 'number';
    if (typeof value === 'string' && value.trim() && value.length <= 48) return 'text';
    return null;
}

/** Foundry pack indexes may project dotted keys or nested `system` objects. */
export function readActorSortField(actor: Record<string, unknown>, path: string): unknown {
    if (Object.prototype.hasOwnProperty.call(actor, path)) return actor[path];
    let value: unknown = actor;
    for (const part of path.split('.')) {
        if (!value || typeof value !== 'object' || Array.isArray(value)
            || !Object.prototype.hasOwnProperty.call(value, part)) return undefined;
        value = (value as Record<string, unknown>)[part];
    }
    return value;
}

/** Catalog all comparable source fields, without sending Actor source documents to the browser. */
export function discoverActorSortFields(actors: Record<string, unknown>[]): CombatManagerActorSortFieldDto[] {
    const kinds = new Map<string, 'number' | 'text' | 'mixed'>();
    const observe = (path: string, value: unknown): void => {
        if (!isSafeCombatStatPath(path) || !path.startsWith('system.')) return;
        const kind = comparable(value);
        if (!kind) return;
        const previous = kinds.get(path);
        kinds.set(path, previous && previous !== kind ? 'mixed' : previous || kind);
    };
    const visit = (value: unknown, path: string, depth: number): void => {
        if (depth > 7 || !value || typeof value !== 'object' || Array.isArray(value)) return;
        for (const [key, child] of Object.entries(value)) {
            const fieldPath = `${path}.${key}`;
            if (!isSafeCombatStatPath(fieldPath)) continue;
            if (child && typeof child === 'object' && !Array.isArray(child)) visit(child, fieldPath, depth + 1);
            else observe(fieldPath, child);
        }
    };
    for (const actor of actors) {
        visit(actor.system, 'system', 1);
        for (const [path, value] of Object.entries(actor)) {
            if (path.startsWith('system.')) observe(path, value);
        }
    }
    return [...kinds.entries()].filter(([, kind]) => kind !== 'mixed')
        .map(([path, kind]) => ({ path, label: fieldLabel(path), kind: kind as 'number' | 'text' }))
        .sort((a, b) => collator.compare(a.label, b.label) || collator.compare(a.path, b.path))
        .slice(0, MAX_CATALOG_FIELDS);
}

export function sortActorChoices<T extends Record<string, unknown>>(actors: T[], sort: CombatManagerActorSortRequest,
    catalog: CombatManagerActorSortFieldDto[], idOf: (actor: T) => string): T[] | null {
    const allowed = new Map(catalog.map(field => [field.path, field]));
    if (sort.fields.some(field => !allowed.has(field.path))) return null;
    const compare = (left: T, right: T, path: string, kind: 'number' | 'text', order: CombatManagerSortDirection): number => {
        const a = readActorSortField(left, path);
        const b = readActorSortField(right, path);
        const validA = comparable(a) === kind;
        const validB = comparable(b) === kind;
        if (!validA || !validB) return validA === validB ? 0 : validA ? -1 : 1;
        const result = kind === 'number' ? (a as number) - (b as number) : collator.compare(a as string, b as string);
        return order === 'asc' ? result : -result;
    };
    return [...actors].sort((left, right) => {
        for (const field of sort.fields) {
            const result = compare(left, right, field.path, allowed.get(field.path)!.kind, field.direction);
            if (result) return result;
        }
        const byName = collator.compare(String(left.name || ''), String(right.name || ''));
        if (byName) return sort.nameDirection === 'asc' ? byName : -byName;
        return collator.compare(idOf(left), idOf(right));
    });
}
