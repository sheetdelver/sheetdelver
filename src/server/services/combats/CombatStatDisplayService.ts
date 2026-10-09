import type { PreparedActorData, ModuleCombatStatAttribute } from '@shared/sdk';
import type { CombatClientLike } from '@server/shared/types/documents';
import type { CombatManagerAvailableStatDto, CombatManagerSelectedStatDto, CombatManagerStatDto, CombatManagerStatPreferencesDto } from '@shared/contracts/combatManager';
import { isSafeCombatStatPath, parseCombatStatAttributes, parseCombatStatSelection } from '@shared/contracts/combatStatAttributes';
import type { ActorDocument } from '@server/shared/types/actors';
import { preparedActorStore } from '@server/core/documents/prepared/actors/PreparedActorStore';
import { worldStateStore } from '@server/core/world/WorldStateStore';
import { listModules } from '@modules/registry/server';
import { combatStatPreferenceStore } from './CombatStatPreferenceStore';
import { combatManagerPreferenceEvents } from './CombatManagerPreferenceEvents';

function readPath(actor: unknown, path: string): unknown {
    if (!isSafeCombatStatPath(path)) return null;
    let value: unknown = actor;
    for (const segment of path.split('.')) {
        if (!value || typeof value !== 'object' || Array.isArray(value)
            || !Object.prototype.hasOwnProperty.call(value, segment)) return null;
        value = (value as Record<string, unknown>)[segment];
    }
    return value;
}

export function projectCombatStatFields(actor: PreparedActorData | null,
    attributes: CombatManagerSelectedStatDto[], sourceActor?: ActorDocument | null): CombatManagerStatDto[] {
    if (!actor) return [];
    const stats: CombatManagerStatDto[] = [];
    for (const attribute of attributes) {
        if (attribute.actorTypes?.length && !attribute.actorTypes.includes(actor.type)) continue;
        const raw = readPath(actor, attribute.path);
        const roster = attribute.showInRoster === true ? { showInRoster: true as const } : {};
        const health = attribute.health === true ? { health: true as const } : {};
        const edit = editableSourceStat(sourceActor ?? null, attribute, raw);
        if (attribute.kind === 'resource') {
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
            const value = (raw as Record<string, unknown>).value;
            const max = (raw as Record<string, unknown>).max;
            if (typeof value !== 'number' || !Number.isFinite(value)) continue;
            stats.push({ title: attribute.label, value, ...roster, ...health, ...(edit ? { edit } : {}),
                ...(typeof max === 'number' && Number.isFinite(max) ? { subValue: `/ ${max}` } : {}) });
        } else if (attribute.kind === 'number') {
            if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
            stats.push({ title: attribute.label, value: raw, ...roster, ...health, ...(edit ? { edit } : {}) });
        } else if (typeof raw === 'string' && raw.trim()) {
            stats.push({ title: attribute.label, value: raw.trim().slice(0, 48), ...roster });
        } else if (typeof raw === 'number' && Number.isFinite(raw)) {
            stats.push({ title: attribute.label, value: raw, ...roster });
        }
    }
    return stats;
}

function editableSourceStat(sourceActor: ActorDocument | null, attribute: CombatManagerSelectedStatDto,
    preparedValue: unknown): CombatManagerStatDto['edit'] | null {
    if (!sourceActor || attribute.editable !== true || !attribute.path.startsWith('system.')
        || !['number', 'resource'].includes(attribute.kind)) return null;
    const sourceValue = readPath(sourceActor, attribute.path);
    if (attribute.kind === 'resource' && (!sourceValue || typeof sourceValue !== 'object' || Array.isArray(sourceValue)
        || !preparedValue || typeof preparedValue !== 'object' || Array.isArray(preparedValue))) return null;
    const value = attribute.kind === 'resource' ? (sourceValue as Record<string, unknown>).value : sourceValue;
    const shown = attribute.kind === 'resource' ? (preparedValue as Record<string, unknown>).value : preparedValue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value !== shown) return null;
    const sourceMax = attribute.kind === 'resource' ? (sourceValue as Record<string, unknown>).max : undefined;
    return { key: attribute.key, path: `${attribute.path}${attribute.kind === 'resource' ? '.value' : ''}`, value,
        ...(typeof sourceMax === 'number' && Number.isFinite(sourceMax) ? { max: sourceMax } : {}) };
}

function fieldLabel(name: string): string {
    return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ')
        .split(' ').filter(Boolean)
        .map(word => word.length <= 2 ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1))
        .join(' ');
}

function contextualFieldLabel(path: string, kind: ModuleCombatStatAttribute['kind']): string {
    const parts = path.split('.').slice(1);
    const shown = kind === 'resource' ? parts.slice(-1) : parts.slice(-2);
    return shown.map(fieldLabel).join(' · ').slice(0, 32);
}

function actorFields(actor: PreparedActorData): ModuleCombatStatAttribute[] {
    const fields: ModuleCombatStatAttribute[] = [];
    const visit = (value: unknown, prefix: string, depth: number): void => {
        if (fields.length >= 100 || depth > 6 || !value || typeof value !== 'object' || Array.isArray(value)) return;
        for (const [name, child] of Object.entries(value)) {
            if (fields.length >= 100) break;
            const fieldPath = `${prefix}.${name}`;
            if (!isSafeCombatStatPath(fieldPath)) continue;
            if (typeof child === 'number' && Number.isFinite(child)) {
                fields.push({ key: `field${fields.length}`, label: contextualFieldLabel(fieldPath, 'number'), path: fieldPath, kind: 'number' });
            } else if (typeof child === 'string' && child.trim() && child.length <= 48) {
                fields.push({ key: `field${fields.length}`, label: contextualFieldLabel(fieldPath, 'text'), path: fieldPath, kind: 'text' });
            } else if (child && typeof child === 'object' && !Array.isArray(child)) {
                const record = child as Record<string, unknown>;
                if (typeof record.value === 'number' && Number.isFinite(record.value)
                    && (record.max === undefined || typeof record.max === 'number' && Number.isFinite(record.max))) {
                    fields.push({ key: `field${fields.length}`, label: contextualFieldLabel(fieldPath, 'resource'), path: fieldPath, kind: 'resource' });
                } else visit(child, fieldPath, depth + 1);
            }
        }
    };
    visit(actor.system, 'system', 1);
    visit(actor.derived, 'derived', 1);
    return fields;
}

/** Discover a bounded, system-neutral catalog from prepared Actor field shapes. */
export function discoverCombatStatFields(actors: PreparedActorData[]): CombatManagerAvailableStatDto[] {
    const fields = new Map<string, CombatManagerAvailableStatDto>();
    const perType = new Map<string, number>();
    for (const actor of actors) {
        if (fields.size >= 160) break;
        if (perType.size >= 16 && !perType.has(actor.type)) continue;
        const count = perType.get(actor.type) ?? 0;
        if (count >= 4) continue;
        perType.set(actor.type, count + 1);
        for (const field of actorFields(actor)) {
            const identity = `${field.path}\0${field.kind}`;
            const existing = fields.get(identity);
            if (existing) {
                if (!existing.observedActorTypes.includes(actor.type)) existing.observedActorTypes.push(actor.type);
            } else if (fields.size < 160) {
                fields.set(identity, {
                    ...field,
                    key: `field${fields.size}`,
                    observedActorTypes: [actor.type],
                });
            }
        }
    }
    const catalog = [...fields.values()];
    const labelCounts = new Map<string, number>();
    for (const field of catalog) labelCounts.set(field.label, (labelCounts.get(field.label) ?? 0) + 1);
    for (const field of catalog) {
        if ((labelCounts.get(field.label) ?? 0) <= 1) continue;
        field.label = field.path.split('.').slice(1).map(fieldLabel).join(' · ').slice(0, 32);
    }
    return catalog;
}

export function resolveCombatStatSelection(saved: CombatManagerSelectedStatDto[] | null,
    suggestions: ModuleCombatStatAttribute[]): Pick<CombatManagerStatPreferencesDto, 'source' | 'attributes'> {
    if (saved !== null) return { source: 'saved', attributes: saved };
    if (suggestions.length) return { source: 'module', attributes: suggestions.slice(0, 8) };
    return { source: 'none', attributes: [] };
}

async function activeScope(client: CombatClientLike): Promise<{ worldId: string; moduleId: string } | null> {
    const worldId = worldStateStore.getWorld()?.id;
    if (!worldId) return null;
    return { worldId, moduleId: (await client.getSystem()).id.toLowerCase() };
}

async function resolve(client: CombatClientLike): Promise<CombatManagerStatPreferencesDto | null> {
    const scope = await activeScope(client);
    if (!scope) return null;
    const info = listModules({ includeExperimental: true }).find(row => row.info.id === scope.moduleId)?.info;
    const suggestions = parseCombatStatAttributes(info?.combatTracking?.attributes, 16) ?? [];
    const saved = combatStatPreferenceStore.get(scope.worldId, scope.moduleId);
    return { ...resolveCombatStatSelection(saved, suggestions), suggestions, available: [],
        initiativeFormula: combatStatPreferenceStore.getInitiativeFormula(scope.worldId, scope.moduleId) };
}

export const combatStatDisplayService = {
    resolve,
    async detail(client: CombatClientLike, actorId?: string, includeCatalog = false): Promise<CombatManagerStatPreferencesDto | null> {
        const selection = await resolve(client);
        if (!selection) return null;
        if (!includeCatalog) return selection;
        const actors = preparedActorStore.list();
        if (actorId) actors.sort((a, b) => Number(b.id === actorId) - Number(a.id === actorId));
        return { ...selection, available: discoverCombatStatFields(actors) };
    },
    async save(client: CombatClientLike, attributes: unknown): Promise<CombatManagerStatPreferencesDto | null> {
        const scope = await activeScope(client);
        if (!scope) return null;
        const parsed = parseCombatStatSelection(attributes);
        if (!parsed) throw new Error('Invalid combat-stat selection');
        combatStatPreferenceStore.set(scope.worldId, scope.moduleId, parsed);
        combatManagerPreferenceEvents.changed();
        return resolve(client);
    },
    async reset(client: CombatClientLike): Promise<CombatManagerStatPreferencesDto | null> {
        const scope = await activeScope(client);
        if (!scope) return null;
        combatStatPreferenceStore.reset(scope.worldId, scope.moduleId);
        combatManagerPreferenceEvents.changed();
        return resolve(client);
    },
    async saveInitiativeFormula(client: CombatClientLike, formula: string | null): Promise<CombatManagerStatPreferencesDto | null> {
        const scope = await activeScope(client);
        if (!scope) return null;
        combatStatPreferenceStore.setInitiativeFormula(scope.worldId, scope.moduleId, formula);
        combatManagerPreferenceEvents.changed();
        return resolve(client);
    },
};
