import type { ActorDocument } from '@server/shared/types/actors';
import type { CombatClientLike, CombatDocument, CombatantDocument } from '@server/shared/types/documents';
import { actorStore } from '@server/core/documents/primary/actors/ActorStore';
import { combatStore } from '@server/core/documents/primary/combats/CombatStore';
import { folderStore } from '@server/core/documents/primary/folders/FolderStore';
import { settingStore } from '@server/core/documents/primary/settings/SettingStore';
import { sceneStore } from '@server/core/documents/primary/scenes/SceneStore';
import { combatEncounterReadModel } from '@server/core/documents/encounters/CombatEncounterReadModel';
import { ActorRepository } from '@server/core/documents/primary/actors/ActorRepository';
import { CombatRepository } from '@server/core/documents/primary/combats/CombatRepository';
import { FolderRepository } from '@server/core/documents/primary/folders/FolderRepository';
import { getDocumentId, isRecord } from '@server/core/documents/primary/base/PrimaryDocumentStore';
import { DocumentOwnershipLevel, FoundryUserRole, getEffectiveOwnership, isGM,
    type DocumentOwnershipMap } from '@server/core/documents/primary/base/ownership';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import { compendiumStore } from '@server/core/compendium/CompendiumStore';
import { preparedActorStore } from '@server/core/documents/prepared/actors/PreparedActorStore';
import { parseCombatStatSelection } from '@shared/contracts/combatStatAttributes';
import { combatStatDisplayService, projectCombatStatFields } from './CombatStatDisplayService';
import type {
    CombatManagerActorChoiceDto,
    CombatManagerActorSearchDto,
    CombatManagerEncounterDto,
    CombatManagerPackDto,
    CombatManagerParticipantDto,
    CombatManagerResourceDto,
    CombatManagerStatPreferencesDto,
    CombatManagerSelectedStatDto,
    CombatManagerInitiativeBatchDto,
    CombatManagerInitiativeScope,
} from '@shared/contracts/combatManager';
import { readCombatManagerFlag, type CombatManagerFlag } from './combatManagerFlag';
import { discoverActorSortFields, parseActorPickerSort, sortActorChoices } from './CombatActorPickerSort';

export class CombatManagerError extends Error {
    constructor(message: string, public readonly status: number) { super(message); }
}

const ID_PATTERN = /^[A-Za-z0-9]{1,64}$/;
const STAT_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const PACK_PATTERN = /^[A-Za-z0-9_.-]{1,160}$/;
const PATH_PATTERN = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/;
const MAX_BATCH_ROLL = 100;
const MAX_PACK_COPIES_PER_ADD = 20;

function requiredId(value: unknown): string {
    if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new CombatManagerError('Invalid document ID', 400);
    return value;
}

function resultDocument(response: unknown): Record<string, unknown> | null {
    const data = isRecord(response) && 'result' in response ? response.result : response;
    const row = Array.isArray(data) ? data[0] : data;
    return isRecord(row) ? row : null;
}

function resultRows(response: unknown): Record<string, unknown>[] {
    const data = isRecord(response) && 'result' in response ? response.result : response;
    return Array.isArray(data) ? data.filter(isRecord) : [];
}

function copyMarker(actor: ActorDocument): Record<string, unknown> | null {
    const flags = (actor as Record<string, unknown>).flags;
    if (!isRecord(flags) || !isRecord(flags.world)) return null;
    const value = flags.world.sheetDelverCombatCopy;
    return isRecord(value) ? value : null;
}

function folderMarker(folder: Record<string, unknown>): Record<string, unknown> | null {
    if (!isRecord(folder.flags) || !isRecord(folder.flags.world)) return null;
    const value = folder.flags.world.sheetDelverCombatFolder;
    return isRecord(value) ? value : null;
}

function trackedResourcePath(): string | null {
    const setting = settingStore.getValueByKey('core.combatTrackerConfig');
    if (!isRecord(setting) || typeof setting.resource !== 'string') return null;
    const path = setting.resource.replace(/^system\./, '');
    if (!PATH_PATTERN.test(path) || path.split('.').some(part => ['__proto__', 'constructor', 'prototype'].includes(part))) return null;
    return path;
}

function sourceResource(actor: ActorDocument | null, path: string | null): CombatManagerResourceDto | null {
    if (!actor || !path || !isRecord(actor.system)) return null;
    let value: unknown = actor.system;
    for (const segment of path.split('.')) {
        if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, segment)) return null;
        value = value[segment];
    }
    const numeric = isRecord(value) ? value.value : value;
    if (typeof numeric !== 'number' || !Number.isFinite(numeric)) return null;
    const max = isRecord(value) && typeof value.max === 'number' && Number.isFinite(value.max) ? value.max : null;
    return { path: `system.${path}${isRecord(value) ? '.value' : ''}`, value: numeric, max, editable: true };
}

function effectLabels(actor: ActorDocument | null): string[] {
    const effects = actor && (actor as Record<string, unknown>).effects;
    if (!Array.isArray(effects)) return [];
    return effects.filter(isRecord).filter(effect => effect.disabled !== true)
        .map(effect => typeof effect.name === 'string' ? effect.name.trim() : '')
        .filter(Boolean).slice(0, 12);
}

function hasPlayerOwner(actor: ActorDocument): boolean {
    const ownership = actor.ownership as DocumentOwnershipMap | undefined;
    return userStore.list().some(user => {
        const userId = getDocumentId(user);
        if (!userId) return false;
        const role = userStore.getRole(userId);
        if (role >= FoundryUserRole.ASSISTANT) return false;
        return getEffectiveOwnership(ownership, { userId, role }) >= DocumentOwnershipLevel.OWNER;
    });
}

function roleSubject(client: CombatClientLike) {
    const subject = userStore.createAccessSubject(client.userId);
    if (!subject || !isGM(subject)) throw new CombatManagerError('Gamemaster access required', 403);
    return subject;
}

function requiredEncounter(combatId: string): { combat: CombatDocument; flag: CombatManagerFlag } {
    const combat = combatStore.get(requiredId(combatId));
    const flag = readCombatManagerFlag(combat);
    if (!combat || !flag) throw new CombatManagerError('SheetDelver tokenless encounter not found', 404);
    return { combat, flag };
}

function activeEncounter(combatId: string): { combat: CombatDocument; flag: CombatManagerFlag } {
    const found = requiredEncounter(combatId);
    if (found.flag.status !== 'active') throw new CombatManagerError('Encounter is not active', 409);
    return found;
}

const busy = new Set<string>();
async function withEncounterLock<T>(combatId: string, operation: () => Promise<T>): Promise<T> {
    if (busy.has(combatId)) throw new CombatManagerError('Encounter has another pending change', 409);
    busy.add(combatId);
    try { return await operation(); } finally { busy.delete(combatId); }
}

function repositories(client: CombatClientLike) {
    const transport = { dispatchDocument: client.dispatchDocument.bind(client) };
    return {
        combats: new CombatRepository(transport),
        actors: new ActorRepository(transport),
        folders: new FolderRepository(transport),
    };
}

async function updateFlag(client: CombatClientLike, combatId: string, flag: CombatManagerFlag): Promise<void> {
    await repositories(client).combats.update(combatId, { 'flags.world.sheetDelverCombat': flag });
}

async function preserveCurrentTurn(client: CombatClientLike, combatId: string, currentCombatantId: string | null): Promise<void> {
    if (!currentCombatantId) return;
    const combat = combatStore.get(combatId);
    if (!combat || (combat.round ?? 0) < 1) return;
    const prepared = combatEncounterReadModel.getOrRebuild(combatId);
    const newIndex = prepared?.rows.findIndex(row => row.id === currentCombatantId) ?? -1;
    if (newIndex >= 0 && combat.turn !== newIndex) {
        await repositories(client).combats.update(combatId, { turn: newIndex });
    }
}

function projectEncounter(combat: CombatDocument, client: CombatClientLike,
    attributes: CombatManagerSelectedStatDto[]): CombatManagerEncounterDto | null {
    const flag = readCombatManagerFlag(combat);
    const id = getDocumentId(combat);
    if (!flag || !id) return null;
    const prepared = combatEncounterReadModel.getOrRebuild(id);
    const resourcePath = trackedResourcePath();
    const participants: CombatManagerParticipantDto[] = (prepared?.rows || []).map(row => {
        const actor = row.actorId ? actorStore.get(row.actorId) : null;
        const source = row.actorId && flag.copyIds.includes(row.actorId) ? 'compendium-copy' : 'world';
        return {
            id: row.id,
            actorId: row.actorId || '',
            source,
            isNpc: actor ? !hasPlayerOwner(actor) : false,
            name: row.name || actor?.name || 'Unknown actor',
            img: typeof row.img === 'string' ? client.resolveUrl(row.img) : null,
            initiative: row.initiative,
            hidden: row.hidden,
            defeated: row.defeated,
            isCurrent: prepared?.currentCombatantId === row.id,
            resource: sourceResource(actor, resourcePath),
            effects: effectLabels(actor),
            stats: projectCombatStatFields(actor && row.actorId ? preparedActorStore.get(row.actorId) : null, attributes, actor),
        };
    });
    return {
        id,
        label: flag.label,
        status: flag.status,
        keepHistory: flag.keepHistory,
        round: prepared?.round ?? combat.round ?? 0,
        currentCombatantId: prepared?.currentCombatantId ?? null,
        participants,
    };
}

export const combatManagerService = {
    async list(client: CombatClientLike): Promise<CombatManagerEncounterDto[]> {
        const subject = roleSubject(client);
        const combats = combatStore.list({ subject });
        if (combats.length === 0) return [];
        const attributes = (await combatStatDisplayService.resolve(client))?.attributes ?? [];
        return combats.map(combat => projectEncounter(combat, client, attributes))
            .filter((row): row is CombatManagerEncounterDto => row !== null);
    },

    async detail(client: CombatClientLike, combatId: string): Promise<CombatManagerEncounterDto> {
        roleSubject(client);
        const combat = requiredEncounter(combatId).combat;
        const attributes = (await combatStatDisplayService.resolve(client))?.attributes ?? [];
        const projected = projectEncounter(combat, client, attributes);
        if (!projected) throw new CombatManagerError('Encounter unavailable', 404);
        return projected;
    },

    async statPreferences(client: CombatClientLike, actorIdInput?: unknown, includeCatalog = false): Promise<CombatManagerStatPreferencesDto> {
        const subject = roleSubject(client);
        const actorId = actorIdInput === undefined ? undefined : requiredId(actorIdInput);
        if (actorId && !actorStore.get(actorId, { subject })) throw new CombatManagerError('Actor not found', 404);
        const preferences = await combatStatDisplayService.detail(client, actorId, includeCatalog);
        if (!preferences) throw new CombatManagerError('World is not ready', 503);
        return preferences;
    },

    async saveStatPreferences(client: CombatClientLike, attributesInput: unknown): Promise<CombatManagerStatPreferencesDto> {
        roleSubject(client);
        const attributes = parseCombatStatSelection(attributesInput);
        if (!attributes) throw new CombatManagerError('Invalid combat-stat selection', 400);
        const preferences = await combatStatDisplayService.save(client, attributes);
        if (!preferences) throw new CombatManagerError('World is not ready', 503);
        return preferences;
    },

    async resetStatPreferences(client: CombatClientLike): Promise<CombatManagerStatPreferencesDto> {
        roleSubject(client);
        const preferences = await combatStatDisplayService.reset(client);
        if (!preferences) throw new CombatManagerError('World is not ready', 503);
        return preferences;
    },

    worldActors(client: CombatClientLike, query: string, sortInput?: unknown): CombatManagerActorSearchDto {
        const subject = roleSubject(client);
        const sort = parseActorPickerSort(sortInput);
        if (!sort) throw new CombatManagerError('Invalid Actor sort', 400);
        const term = query.trim().toLocaleLowerCase().slice(0, 80);
        const source = actorStore.list({ subject });
        const sortFields = discoverActorSortFields(source as Record<string, unknown>[]);
        const matching = source.filter(actor => !term || actor.name?.toLocaleLowerCase().includes(term));
        const ordered = sortActorChoices(matching, sort, sortFields, actor => getDocumentId(actor) || '');
        if (!ordered) throw new CombatManagerError('Actor sort field is unavailable', 400);
        const actors: CombatManagerActorChoiceDto[] = ordered.map(actor => ({
                id: getDocumentId(actor) || '', name: actor.name || 'Unnamed Actor',
                img: typeof actor.img === 'string' ? client.resolveUrl(actor.img) : null,
                type: actor.type || null, source: 'world' as const,
            })).filter(actor => actor.id);
        return { actors, sortFields };
    },

    packs(client: CombatClientLike): CombatManagerPackDto[] {
        roleSubject(client);
        return compendiumStore.listPackMetadata()
            .filter(pack => [pack.type, pack.documentName, pack.entity].includes('Actor'))
            .map(pack => ({ id: pack.id || pack._id || '', label: pack.label || pack.title || pack.name || pack.id || 'Actor pack' }))
            .filter(pack => PACK_PATTERN.test(pack.id)).slice(0, 200);
    },

    async packActors(client: CombatClientLike, packId: string, query: string, sortInput?: unknown): Promise<CombatManagerActorSearchDto> {
        roleSubject(client);
        const sort = parseActorPickerSort(sortInput);
        if (!sort) throw new CombatManagerError('Invalid Actor sort', 400);
        if (!PACK_PATTERN.test(packId) || !this.packs(client).some(pack => pack.id === packId)) {
            throw new CombatManagerError('Actor pack not found', 404);
        }
        const response = await client.dispatchDocument('Actor', 'get', {
            pack: packId, index: true, query: {}, indexFields: ['_id', 'name', 'img', 'type', 'system'], broadcast: false,
        });
        const term = query.trim().toLocaleLowerCase().slice(0, 80);
        const source = resultRows(response);
        const sortFields = discoverActorSortFields(source);
        const matching = source.filter(row => typeof row.name === 'string' && (!term || row.name.toLocaleLowerCase().includes(term)));
        const ordered = sortActorChoices(matching, sort, sortFields, row => typeof row._id === 'string' ? row._id : '');
        if (!ordered) throw new CombatManagerError('Actor sort field is unavailable', 400);
        const actors: CombatManagerActorChoiceDto[] = ordered.map(row => ({
                id: typeof row._id === 'string' ? row._id : '', name: row.name as string,
                img: typeof row.img === 'string' ? client.resolveUrl(row.img) : null,
                type: typeof row.type === 'string' ? row.type : null,
                source: 'compendium' as const, packId,
            })).filter(row => ID_PATTERN.test(row.id));
        return { actors, sortFields };
    },

    async create(client: CombatClientLike, labelInput: unknown, keepHistoryInput: unknown): Promise<CombatManagerEncounterDto> {
        roleSubject(client);
        const label = typeof labelInput === 'string' ? labelInput.trim() : '';
        if (!label || label.length > 100 || typeof keepHistoryInput !== 'boolean') {
            throw new CombatManagerError('A label and Keep for history choice are required', 400);
        }
        const repo = repositories(client);
        const flag: CombatManagerFlag = {
            schemaVersion: 1, mode: 'tokenless', label, status: 'provisioning',
            keepHistory: keepHistoryInput, folderId: null, copyIds: [],
        };
        // Foundry deactivates every other active Combat when a new active
        // Combat is created, including scene encounters. The manager's own
        // lifecycle flag is independent of Foundry's global `active` bit.
        const created = resultDocument(await repo.combats.create({ scene: null, active: false, round: 0, turn: null,
            flags: { world: { sheetDelverCombat: flag } } }));
        const combatId = created && getDocumentId(created);
        if (!combatId) throw new CombatManagerError('Foundry did not return the new Combat ID', 502);
        const folder = resultDocument(await repo.folders.create({ name: `Combat: ${label}`, type: 'Actor',
            flags: { world: { sheetDelverCombatFolder: { combatId } } } }));
        const folderId = folder && getDocumentId(folder);
        if (!folderId) throw new CombatManagerError(`Combat ${combatId} was created but its Actor Folder was not; completion can retry cleanup`, 502);
        await updateFlag(client, combatId, { ...flag, folderId, status: 'active' });
        return this.detail(client, combatId);
    },

    async addWorldActor(client: CombatClientLike, combatId: string, actorIdInput: unknown): Promise<CombatManagerEncounterDto> {
        const subject = roleSubject(client);
        const actorId = requiredId(actorIdInput);
        return withEncounterLock(combatId, async () => {
            const { combat } = activeEncounter(combatId);
            if (!actorStore.get(actorId, { subject })) throw new CombatManagerError('World Actor not found', 404);
            if (combat.combatants?.some(row => row.actorId === actorId)) {
                throw new CombatManagerError('World Actor is already in this encounter', 409);
            }
            const currentId = combatEncounterReadModel.getOrRebuild(combatId)?.currentCombatantId ?? null;
            await repositories(client).combats.createCombatant(combatId, { actorId, tokenId: null, sceneId: null });
            await preserveCurrentTurn(client, combatId, currentId);
            return this.detail(client, combatId);
        });
    },

    async addPackActor(client: CombatClientLike, combatId: string, packId: unknown, documentId: unknown,
        quantityInput: unknown = 1): Promise<CombatManagerEncounterDto> {
        roleSubject(client);
        const actorId = requiredId(documentId);
        if (!Number.isInteger(quantityInput) || (quantityInput as number) < 1
            || (quantityInput as number) > MAX_PACK_COPIES_PER_ADD) {
            throw new CombatManagerError(`Choose 1–${MAX_PACK_COPIES_PER_ADD} copies per Add`, 400);
        }
        const quantity = quantityInput as number;
        if (typeof packId !== 'string' || !PACK_PATTERN.test(packId) || !this.packs(client).some(pack => pack.id === packId)) {
            throw new CombatManagerError('Actor pack not found', 404);
        }
        return withEncounterLock(combatId, async () => {
            const { flag } = activeEncounter(combatId);
            if (!flag.folderId) throw new CombatManagerError('Encounter Actor Folder is unavailable', 409);
            const currentId = combatEncounterReadModel.getOrRebuild(combatId)?.currentCombatantId ?? null;
            const response = await client.dispatchDocument('Actor', 'get', {
                pack: packId, query: { _id: actorId }, index: false, broadcast: false,
            });
            const source = resultRows(response).find(row => row._id === actorId);
            if (!source) throw new CombatManagerError('Compendium Actor not found', 404);
            const { _id, id, folder, ownership, _stats, flags, ...copy } = source;
            void _id; void id; void folder; void ownership; void _stats;
            const sourceFlags = isRecord(flags) ? flags : {};
            const worldFlags = isRecord(sourceFlags.world) ? sourceFlags.world : {};
            const sourceUuid = `Compendium.${packId}.Actor.${actorId}`;
            // Foundry treats dots in flag object keys as update paths. Encode
            // the UUID so the counter remains a single safe property name.
            const counterKey = Buffer.from(sourceUuid).toString('base64url');
            const sourceName = typeof source.name === 'string' && source.name.trim() ? source.name.trim() : 'Actor';
            // Existing single-copy encounters may predate numbered labels. Their
            // marked copies still occupy numbers even after a Combatant removal.
            const priorCount = flag.copyIds.filter(copyId => {
                const actor = actorStore.get(copyId);
                return actor && copyMarker(actor)?.sourceUuid === sourceUuid;
            }).length;
            let nextFlag = flag;
            let added = 0;
            try {
                for (let index = 0; index < quantity; index++) {
                    const number = (nextFlag.copyNameCounters?.[counterKey] ?? priorCount) + 1;
                    const created = await repositories(client).actors.createActor({ ...copy, folder: flag.folderId,
                        ownership: { default: 0 },
                        flags: { ...sourceFlags, world: { ...worldFlags, sheetDelverCombatCopy: {
                            combatId, sourceUuid,
                        } } },
                    });
                    const copyId = isRecord(created) ? getDocumentId(created) : null;
                    if (!copyId) throw new CombatManagerError('Foundry did not return the copied Actor ID', 502);
                    const updatedFlag: CombatManagerFlag = {
                        ...nextFlag,
                        copyIds: [...nextFlag.copyIds, copyId],
                        copyNameCounters: { ...nextFlag.copyNameCounters, [counterKey]: number },
                    };
                    try { await updateFlag(client, combatId, updatedFlag); }
                    catch (cause) {
                        // A copy must never be left outside the Combat's cleanup list.
                        try { await repositories(client).actors.deleteActor(copyId); }
                        catch { throw new CombatManagerError(`Copied Actor ${copyId} could not be recorded or removed; inspect the encounter Folder`, 502); }
                        throw cause;
                    }
                    nextFlag = updatedFlag;
                    await repositories(client).combats.createCombatant(combatId, {
                        actorId: copyId, tokenId: null, sceneId: null, name: `${sourceName} #${number}`,
                    });
                    added++;
                    await preserveCurrentTurn(client, combatId, currentId);
                }
            } catch (cause) {
                const message = cause instanceof Error ? cause.message : 'Copy failed';
                const status = cause instanceof CombatManagerError ? cause.status : 502;
                throw new CombatManagerError(`Added ${added} of ${quantity} copies: ${message}`, status);
            }
            return this.detail(client, combatId);
        });
    },

    async updateParticipant(client: CombatClientLike, combatId: string, combatantIdInput: unknown,
        body: Record<string, unknown>): Promise<CombatManagerEncounterDto> {
        roleSubject(client);
        const combatantId = requiredId(combatantIdInput);
        return withEncounterLock(combatId, async () => {
            const { combat } = activeEncounter(combatId);
            if (!combat.combatants?.some(row => getDocumentId(row) === combatantId)) throw new CombatManagerError('Combatant not found', 404);
            const currentId = combatEncounterReadModel.getOrRebuild(combatId)?.currentCombatantId ?? null;
            const allowed = ['initiative', 'hidden', 'defeated'];
            if (!Object.keys(body).length || Object.keys(body).some(key => !allowed.includes(key))) throw new CombatManagerError('Unsupported participant update', 400);
            if ('initiative' in body && !(body.initiative === null || (typeof body.initiative === 'number' && Number.isFinite(body.initiative)))) {
                throw new CombatManagerError('Initiative must be a number or null', 400);
            }
            if ('hidden' in body && typeof body.hidden !== 'boolean') throw new CombatManagerError('Hidden must be a boolean', 400);
            if ('defeated' in body && typeof body.defeated !== 'boolean') throw new CombatManagerError('Defeated must be a boolean', 400);
            await repositories(client).combats.updateCombatant(combatId, combatantId, body);
            if ('initiative' in body) await preserveCurrentTurn(client, combatId, currentId);
            return this.detail(client, combatId);
        });
    },

    async rollInitiativeBatch(client: CombatClientLike, combatId: string, scope: unknown,
        rollOne: (combatantId: string) => Promise<{ success: true; initiative: number } | { error: string; status: number }>,
    ): Promise<CombatManagerInitiativeBatchDto> {
        roleSubject(client);
        if (scope !== 'all' && scope !== 'npc') throw new CombatManagerError('Invalid initiative scope', 400);
        return withEncounterLock(combatId, async () => {
            const { combat } = activeEncounter(combatId);
            const targets = (combat.combatants || []).filter(row => {
                if (row.initiative !== null && row.initiative !== undefined) return false;
                const actor = row.actorId ? actorStore.get(row.actorId) : null;
                return actor && (scope === 'all' || !hasPlayerOwner(actor));
            });
            if (targets.length > MAX_BATCH_ROLL) throw new CombatManagerError('Too many combatants for one initiative batch', 413);
            const currentId = combatEncounterReadModel.getOrRebuild(combatId)?.currentCombatantId ?? null;
            let rolled = 0;
            try {
                for (const row of targets) {
                    const rowId = getDocumentId(row);
                    if (!rowId) continue;
                    const result = await rollOne(rowId);
                    if ('error' in result) throw new CombatManagerError(result.error, result.status);
                    rolled++;
                }
            } catch (cause) {
                const message = cause instanceof Error ? cause.message : 'Initiative roll failed';
                const status = cause instanceof CombatManagerError ? cause.status : 502;
                throw new CombatManagerError(`Rolled ${rolled} of ${targets.length}: ${message}`, status);
            } finally {
                // Reordering initiative must not silently change the active
                // Combatant, even if a later roll fails after earlier writes.
                await preserveCurrentTurn(client, combatId, currentId);
            }
            return { rolled, encounter: await this.detail(client, combatId) };
        });
    },

    async updateResource(client: CombatClientLike, combatId: string, combatantIdInput: unknown,
        request: unknown): Promise<CombatManagerEncounterDto> {
        roleSubject(client);
        const value = isRecord(request) ? request.value : undefined;
        const expected = isRecord(request) && isRecord(request.expected) ? request.expected : null;
        if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1_000_000_000) {
            throw new CombatManagerError('Resource value must be a finite number', 400);
        }
        if (!expected || typeof expected.path !== 'string' || expected.path.length > 256
            || typeof expected.value !== 'number' || !Number.isFinite(expected.value)) {
            throw new CombatManagerError('Expected resource state is required', 400);
        }
        const expectedActorId = requiredId(expected.actorId);
        return withEncounterLock(combatId, async () => {
            const { combat } = activeEncounter(combatId);
            const combatant = combat.combatants?.find(row => getDocumentId(row) === requiredId(combatantIdInput));
            if (!combatant?.actorId) throw new CombatManagerError('Combatant Actor not found', 404);
            const actor = actorStore.get(combatant.actorId);
            const resource = sourceResource(actor, trackedResourcePath());
            if (!resource?.editable) throw new CombatManagerError('Tracked resource is not source-backed and editable', 409);
            if (combatant.actorId !== expectedActorId || resource.path !== expected.path || resource.value !== expected.value) {
                throw new CombatManagerError('Tracked resource changed; review the current value and retry', 409);
            }
            // This checks the latest Core Store value; Foundry modifyDocument has
            // no atomic compare-and-set precondition against external clients.
            await repositories(client).actors.updateActor(combatant.actorId, { [resource.path]: value });
            return this.detail(client, combatId);
        });
    },

    async updateStat(client: CombatClientLike, combatId: string, combatantIdInput: unknown,
        statKeyInput: unknown, request: unknown): Promise<CombatManagerEncounterDto> {
        roleSubject(client);
        const combatantId = requiredId(combatantIdInput);
        if (typeof statKeyInput !== 'string' || !STAT_KEY_PATTERN.test(statKeyInput)) {
            throw new CombatManagerError('Invalid stat key', 400);
        }
        const value = isRecord(request) ? request.value : undefined;
        const expected = isRecord(request) && isRecord(request.expected) ? request.expected : null;
        if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1_000_000_000) {
            throw new CombatManagerError('Stat value must be a finite number', 400);
        }
        if (!expected || typeof expected.path !== 'string' || expected.path.length > 256
            || typeof expected.value !== 'number' || !Number.isFinite(expected.value)) {
            throw new CombatManagerError('Expected stat state is required', 400);
        }
        const expectedActorId = requiredId(expected.actorId);
        return withEncounterLock(combatId, async () => {
            const { combat } = activeEncounter(combatId);
            const combatant = combat.combatants?.find(row => getDocumentId(row) === combatantId);
            if (!combatant?.actorId) throw new CombatManagerError('Combatant Actor not found', 404);
            const actor = actorStore.get(combatant.actorId);
            const prepared = preparedActorStore.get(combatant.actorId);
            const selection = await combatStatDisplayService.resolve(client);
            const field = selection?.attributes.find(row => row.key === statKeyInput && row.editable === true);
            if (!actor || !prepared || !field) throw new CombatManagerError('Stat is not configured for editing', 409);
            const edit = projectCombatStatFields(prepared, [field], actor)[0]?.edit;
            if (!edit) throw new CombatManagerError('Stat is not source-backed and editable', 409);
            if (combatant.actorId !== expectedActorId || edit.path !== expected.path || edit.value !== expected.value) {
                throw new CombatManagerError('Stat changed; review the current value and retry', 409);
            }
            // As with tracked resources, this is a Core Store freshness check;
            // Foundry has no atomic compare-and-set precondition for this write.
            await repositories(client).actors.updateActor(combatant.actorId, { [edit.path]: value });
            return this.detail(client, combatId);
        });
    },

    async removeParticipant(client: CombatClientLike, combatId: string, combatantIdInput: unknown): Promise<CombatManagerEncounterDto> {
        roleSubject(client);
        const combatantId = requiredId(combatantIdInput);
        return withEncounterLock(combatId, async () => {
            const { combat } = activeEncounter(combatId);
            if (!combat.combatants?.some(row => getDocumentId(row) === combatantId)) throw new CombatManagerError('Combatant not found', 404);
            const before = combatEncounterReadModel.getOrRebuild(combatId);
            await repositories(client).combats.deleteCombatant(combatId, combatantId);
            if (before?.started) {
                const after = combatEncounterReadModel.getOrRebuild(combatId);
                if (after && !after.rows.length) await repositories(client).combats.update(combatId, { turn: null });
                else if (before.currentCombatantId === combatantId && after) {
                    await repositories(client).combats.update(combatId, { turn: Math.min(before.turn ?? 0, after.rows.length - 1) });
                } else await preserveCurrentTurn(client, combatId, before.currentCombatantId);
            }
            // An owned pack copy remains marked in the encounter until completion.
            // This keeps interrupted removal recoverable and never touches linked world Actors.
            return this.detail(client, combatId);
        });
    },

    async turn<T>(client: CombatClientLike, combatId: string, execute: () => Promise<T>): Promise<T> {
        roleSubject(client);
        return withEncounterLock(combatId, async () => {
            const { combat } = activeEncounter(combatId);
            if (!combat.combatants?.length) throw new CombatManagerError('Add a participant before advancing turns', 409);
            return execute();
        });
    },

    async complete(client: CombatClientLike, combatId: string): Promise<{ completed: true; retained: boolean }> {
        roleSubject(client);
        return withEncounterLock(combatId, async () => {
            const { flag } = requiredEncounter(combatId);
            if (flag.status === 'completed') throw new CombatManagerError('Encounter already completed', 409);
            if (flag.status !== 'active' && flag.status !== 'cleaning' && flag.status !== 'provisioning') {
                throw new CombatManagerError('Encounter cannot be completed', 409);
            }
            if (flag.keepHistory && flag.status === 'active') {
                await repositories(client).combats.update(combatId, {
                    active: false,
                    'flags.world.sheetDelverCombat': { ...flag, status: 'completed', completedAt: new Date().toISOString() },
                });
                return { completed: true, retained: true };
            }

            // Recover a Folder created just before an interrupted Combat-flag
            // update. Only a unique Folder carrying this Combat's marker can
            // be adopted for cleanup; never guess by name or proximity.
            const recoverableFolders = !flag.folderId
                ? folderStore.list().filter(folder => folderMarker(folder)?.combatId === combatId)
                : [];
            if (recoverableFolders.length > 1) throw new CombatManagerError('Multiple encounter Folders found; cleanup stopped', 409);
            const recoveredFolderId = recoverableFolders[0] ? getDocumentId(recoverableFolders[0]) : null;
            const cleaning: CombatManagerFlag = { ...flag, folderId: flag.folderId || recoveredFolderId, status: 'cleaning' };
            await updateFlag(client, combatId, cleaning);
            const folder = cleaning.folderId ? folderStore.get(cleaning.folderId) : null;
            if (cleaning.folderId && folder && folderMarker(folder)?.combatId !== combatId) {
                throw new CombatManagerError('Encounter Folder ownership mismatch; cleanup stopped', 409);
            }
            const copySet = new Set(cleaning.copyIds);
            if (copySet.size !== cleaning.copyIds.length) throw new CombatManagerError('Duplicate copy references; cleanup stopped', 409);
            if (cleaning.folderId) {
                const unexpected = actorStore.list().find(actor => actor.folder === cleaning.folderId && !copySet.has(getDocumentId(actor) || ''));
                if (unexpected) throw new CombatManagerError('Encounter Folder contains an unrelated Actor; cleanup stopped', 409);
                const nested = folderStore.list().find(other => other.folder === cleaning.folderId);
                if (nested) throw new CombatManagerError('Encounter Folder contains a nested Folder; cleanup stopped', 409);
            }
            for (const copyId of cleaning.copyIds) {
                const actor = actorStore.get(copyId);
                if (!actor) continue; // Previous cleanup attempt may have removed this copy.
                if (!folder || actor.folder !== cleaning.folderId || copyMarker(actor)?.combatId !== combatId) {
                    throw new CombatManagerError('Encounter Actor ownership mismatch; cleanup stopped', 409);
                }
                const externallyReferenced = combatStore.list().some(other => getDocumentId(other) !== combatId
                    && other.combatants?.some(row => row.actorId === copyId));
                const onScene = sceneStore.list().some(scene => scene.tokens?.some(token => token.actorId === copyId));
                if (externallyReferenced || onScene) {
                    throw new CombatManagerError('Encounter Actor is referenced outside this Combat; cleanup stopped', 409);
                }
            }
            const repo = repositories(client);
            for (const copyId of cleaning.copyIds) {
                if (actorStore.get(copyId)) await repo.actors.deleteActor(copyId);
            }
            if (cleaning.folderId && folderStore.get(cleaning.folderId)) {
                if (actorStore.list().some(actor => actor.folder === cleaning.folderId)
                    || folderStore.list().some(other => other.folder === cleaning.folderId)) {
                    throw new CombatManagerError('Encounter Folder is not empty; cleanup stopped', 409);
                }
                await repo.folders.delete(cleaning.folderId);
            }
            await repo.combats.delete(combatId);
            return { completed: true, retained: false };
        });
    },
};
