import type { PreparedActorData, ModuleCombatStatAttribute } from '@shared/sdk';
import type { CombatClientLike } from '@server/shared/types/documents';
import type { CombatManagerAvailableStatDto, CombatManagerSelectedStatDto, CombatManagerStatDto, CombatManagerStatPreferencesDto, CombatManagerStatPathValidationDto } from '@shared/contracts/combatManager';
import { isSafeCombatStatPath, parseCombatStatAttributes, parseCombatStatSelection } from '@shared/contracts/combatStatAttributes';
import type { ActorDocument } from '@server/shared/types/actors';
import { preparedActorStore } from '@server/core/documents/prepared/actors/PreparedActorStore';
import { actorStore } from '@server/core/documents/primary/actors/ActorStore';
import { combatStore } from '@server/core/documents/primary/combats/CombatStore';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import { worldStateStore } from '@server/core/world/WorldStateStore';
import { worldBootstrapper } from '@server/services/world';
import { listModules } from '@modules/registry/server';
import { combatStatPreferenceStore } from './CombatStatPreferenceStore';
import { combatManagerPreferenceEvents } from './CombatManagerPreferenceEvents';
import { CombatManagerError, requireCombatManagerSubject } from './CombatManagerAccess';
import { readCombatManagerFlag } from './combatManagerFlag';
import { validateInitiativeOverride } from './CombatInitiativeFormula';
import { getDocumentId } from '@server/core/documents/primary/base/PrimaryDocumentStore';

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
                }
                // Keep the resource aggregate for stat display, but also
                // discover its real numeric leaves for formula references.
                visit(child, fieldPath, depth + 1);
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
    if (suggestions.length) return { source: 'module', attributes: suggestions };
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
    return resolveScope(scope);
}

function resolveScope(scope: { worldId: string; moduleId: string }): CombatManagerStatPreferencesDto {
    const info = listModules({ includeExperimental: true }).find(row => row.info.id === scope.moduleId)?.info;
    const suggestions = parseCombatStatAttributes(info?.combatTracking?.attributes, 16) ?? [];
    const saved = combatStatPreferenceStore.get(scope.worldId, scope.moduleId);
    return { ...resolveCombatStatSelection(saved, suggestions), suggestions, available: [],
        initiativeFormula: combatStatPreferenceStore.getInitiativeFormula(scope.worldId, scope.moduleId) };
}

/** Capture once, then synchronously revalidate after the caller's system await. */
function captureManagerScope(client: CombatClientLike) {
    const userId = client.userId;
    const worldId = worldStateStore.getCurrentWorldId();
    const epoch = worldBootstrapper.getRuntimeEpoch();
    requireCombatManagerSubject(userId);
    return (moduleId: string) => {
        if (client.userId !== userId || !userId || !userStore.get(userId) || userStore.get(userId)?.banned) {
            throw new CombatManagerError('Player session is no longer valid', 401);
        }
        const subject = requireCombatManagerSubject(userId);
        if (!worldId || !worldStateStore.isReady() || !combatStore.isReady() || !actorStore.isReady()
            || worldStateStore.getCurrentWorldId() !== worldId || worldBootstrapper.getRuntimeEpoch() !== epoch
            || worldStateStore.getSystem()?.id?.toLowerCase() !== moduleId
            || (client as CombatClientLike & { isConnected?: boolean }).isConnected === false) {
            throw new CombatManagerError('World changed or is unavailable; retry after reconnecting', 503);
        }
        return { worldId, moduleId, subject };
    };
}

function matchesStatKind(value: unknown, kind: ModuleCombatStatAttribute['kind']): boolean {
    const number = (candidate: unknown) => typeof candidate === 'number' && Number.isFinite(candidate);
    if (kind === 'number') return number(value);
    if (kind === 'text') return (typeof value === 'string' && !!value.trim()) || number(value);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const resource = value as Record<string, unknown>;
    return number(resource.value) && (resource.max == null || number(resource.max));
}

export const combatStatDisplayService = {
    resolve,
    async validateStatPath(client: CombatClientLike, pathInput: unknown, kindInput: unknown): Promise<CombatManagerStatPathValidationDto> {
        const currentScope = captureManagerScope(client);
        const { subject } = currentScope((await client.getSystem()).id.toLowerCase());
        const path = typeof pathInput === 'string' ? pathInput.trim() : '';
        if (!isSafeCombatStatPath(path)) throw new CombatManagerError('Use a safe system.* or derived.* attribute path', 400);
        if (typeof kindInput !== 'string' || !['number', 'text', 'resource'].includes(kindInput)) throw new CombatManagerError('Invalid stat kind', 400);
        const kind = kindInput as ModuleCombatStatAttribute['kind'];
        const actorTypes = new Set<string>();
        let exists = false, matched = false;
        // Exact reads bypass catalog sampling limits, but never source authorization.
        for (const source of actorStore.list({ subject })) {
            const id = getDocumentId(source);
            const prepared = id ? preparedActorStore.get(id) : null;
            if (!prepared) continue;
            const value = readPath(prepared, path);
            if (value === undefined || value === null) continue;
            exists = true;
            if (!matchesStatKind(value, kind)) continue;
            matched = true;
            if (typeof prepared.type === 'string') actorTypes.add(prepared.type);
        }
        if (!matched) throw new CombatManagerError(exists
            ? `Attribute does not contain ${kind === 'resource' ? 'a numeric value/max resource' : kind === 'number' ? 'a finite number' : 'displayable text'} on current Actors`
            : 'Attribute not found on current prepared world Actors', exists ? 400 : 404);
        return { path, kind, observedActorTypes: [...actorTypes].sort() };
    },
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
        requireCombatManagerSubject(client.userId);
        const parsed = parseCombatStatSelection(attributes);
        if (!parsed) throw new Error('Invalid combat-stat selection');
        combatStatPreferenceStore.set(scope.worldId, scope.moduleId, parsed);
        combatManagerPreferenceEvents.changed();
        return resolve(client);
    },
    async reset(client: CombatClientLike): Promise<CombatManagerStatPreferencesDto | null> {
        const scope = await activeScope(client);
        if (!scope) return null;
        requireCombatManagerSubject(client.userId);
        combatStatPreferenceStore.reset(scope.worldId, scope.moduleId);
        combatManagerPreferenceEvents.changed();
        return resolve(client);
    },
    async saveInitiativeFormula(client: CombatClientLike, formula: string | null): Promise<CombatManagerStatPreferencesDto | null> {
        const currentScope = captureManagerScope(client);
        const { worldId, moduleId, subject } = currentScope((await client.getSystem()).id.toLowerCase());
        const scope = { worldId, moduleId };
        if (formula !== null) {
            // All current managed participants, including hidden/scored rows,
            // share this preference. Never sample or scan unrelated world Actors.
            const actorIds = new Set<string>();
            for (const combat of combatStore.list({ subject })) {
                const flag = readCombatManagerFlag(combat);
                if (!flag || flag.status !== 'active' || flag.deletionRequested || flag.historyRemovalRequested) continue;
                for (const row of combat.combatants ?? []) if (row.actorId) actorIds.add(row.actorId);
            }
            if (!actorIds.size && formula.includes('@')) {
                throw new CombatManagerError('Add encounter participants before validating attribute references', 400);
            }
            try {
                if (!actorIds.size) validateInitiativeOverride(formula);
                for (const actorId of actorIds) {
                    const source = actorStore.get(actorId, { subject });
                    const prepared = source ? preparedActorStore.get(actorId) : null;
                    if (!prepared) throw new CombatManagerError('A participant Actor is unavailable; refresh before saving', 409);
                    try { validateInitiativeOverride(formula, prepared); }
                    catch (error) {
                        throw new CombatManagerError(`${source?.name || 'Participant'}: ${(error as Error).message}`, 400);
                    }
                }
            } catch (error) {
                if (error instanceof CombatManagerError) throw error;
                throw new CombatManagerError((error as Error).message, 400);
            }
        }
        // No await between the current scope/participant check and persistence.
        combatStatPreferenceStore.setInitiativeFormula(scope.worldId, scope.moduleId, formula);
        combatManagerPreferenceEvents.changed();
        return resolveScope(scope);
    },
};
