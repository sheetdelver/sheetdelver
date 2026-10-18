import type { MigrationTarget, MigrationTargetKind } from '@shared/sdk/migrations';
import { actorStore } from '@server/core/documents/primary/actors/ActorStore';
import { itemStore } from '@server/core/documents/primary/items/ItemStore';
import { sceneStore } from '@server/core/documents/primary/scenes/SceneStore';
import { compendiumStore } from '@server/core/compendium/CompendiumStore';
import { settingStore } from '@server/core/documents/primary/settings/SettingStore';
import { worldStateStore } from '@server/core/world/WorldStateStore';
import { isRecord } from '@server/core/documents/primary/base/PrimaryDocumentStore';
import { serviceAccountAuthority } from '@server/core/world/ServiceAccountAuthority';
import { canReadNativePack, canReadNativePackForSubject, nativePackLocked } from '@server/core/documents/primary/base/nativePackPermissions';
import type { CompendiumPackMetadata } from '@server/core/compendium/types';
import type { DocumentAccessSubject } from '@server/core/documents/primary/base/ownership';

/** A Core-owned read view. Isolated previews reuse the same enumeration/policy. */
export interface MigrationSourceView {
    actors: Record<string, unknown>[];
    items: Record<string, unknown>[];
    scenes: Record<string, unknown>[];
    packs: CompendiumPackMetadata[];
    configuration: unknown;
    /** false for a present but unreadable Setting, distinct from verified absence. */
    configurationAvailable?: boolean;
    subject: DocumentAccessSubject;
    generation: number;
    /** Already enumerated identities, used only to validate untouched delta bases. */
    baseActorIds?: ReadonlySet<string>;
}

export interface MigrationTransport {
    dispatchDocumentSocket(type: string, action: string, operation?: Record<string, unknown>): Promise<unknown>;
}
function id(source: Record<string, unknown>): string {
    const value = source._id ?? source.id;
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid migration target identity');
    return value;
}
function rows(value: unknown): Record<string, unknown>[] {
    return Array.isArray(value) ? value.filter(isRecord) : [];
}
export function expandMigrationTargets(uuid: string, kind: MigrationTarget['kind'], source: Record<string, unknown>, pack?: string): MigrationTarget[] {
    if (source._tombstone === true) return [];
    const targets: MigrationTarget[] = [{ uuid, kind, source: structuredClone(source), ...(pack ? { pack } : {}) }];
    if (kind === 'Actor' || kind === 'ActorDelta') {
        for (const item of rows(source.items)) targets.push(...expandMigrationTargets(`${uuid}.Item.${id(item)}`, 'Item', item, pack));
    }
    if (kind !== 'ActiveEffect') {
        for (const effect of rows(source.effects)) targets.push(...expandMigrationTargets(`${uuid}.ActiveEffect.${id(effect)}`, 'ActiveEffect', effect, pack));
    }
    return targets;
}
export function packIsWritableWorld(packId: string, view?: MigrationSourceView): boolean {
    const metadata = view ? view.packs.find(row => row.id === packId) : compendiumStore.getPackMetadata(packId);
    if (!metadata || metadata.packageType !== 'world' || !view && !settingStore.isReady()) return false;
    const configuration = view ? view.configuration : settingStore.getValueByKey('core.compendiumConfiguration');
    if (view?.configurationAvailable === false || !view && settingStore.hasWorldKey('core.compendiumConfiguration') && configuration === undefined) return false;
    return nativePackLocked({ ...metadata, id: packId }, configuration) === false;
}
export function migrationEnvelope(target: MigrationTarget, updates: Record<string, unknown>): { type: string; operation: Record<string, unknown> } {
    if (target.readOnly) throw new Error('Read-only migration reference cannot be written');
    const parts = target.uuid.split('.');
    const targetId = parts.at(-1)!;
    const type = parts.at(-2)!;
    if (!['Actor', 'Item', 'ActiveEffect', 'ActorDelta'].includes(type)) throw new Error('Unsupported migration target');
    let parentUuid: string | undefined;
    if (target.pack) {
        if (!packIsWritableWorld(target.pack)) throw new Error('World pack is locked or no longer writable');
        const rootOffset = target.pack.split('.').length + 1;
        if (parts.length > rootOffset + 2) parentUuid = parts.slice(0, -2).join('.');
    } else if (parts.length > 2) parentUuid = parts.slice(0, -2).join('.');
    return { type, operation: { updates: [{ _id: targetId, ...updates }], ...(parentUuid ? { parentUuid } : {}),
        ...(target.pack ? { pack: target.pack } : {}), broadcast: true } };
}

/** Source enumeration uses existing Core Stores plus explicitly world-owned pack reads. */
export async function enumerateMigrationTargets(transport: MigrationTransport, kinds: Set<MigrationTargetKind>, readPacks: readonly string[] = [],
    options: { requiredKinds?: Set<MigrationTargetKind>; requiredReadPacks?: Set<string>; exclusions?: string[]; view?: MigrationSourceView; includeRelations?: boolean } = {}): Promise<MigrationTarget[]> {
    const required = options.requiredKinds ?? kinds;
    const view = options.view;
    if (!view && (!actorStore.isReady() || !itemStore.isReady() || !sceneStore.isReady() || !settingStore.isReady())) throw new Error('Fresh migration source Stores are required');
    const generation = view?.generation ?? worldStateStore.getRelease()?.generation;
    if (generation !== 13 && generation !== 14) throw new Error('Unsupported Foundry migration generation');
    const targets: MigrationTarget[] = [];
    const actors = view?.actors ?? actorStore.list();
    for (const actor of actors) targets.push(...expandMigrationTargets(`Actor.${id(actor)}`, 'Actor', actor));
    for (const item of view?.items ?? itemStore.list()) targets.push(...expandMigrationTargets(`Item.${id(item)}`, 'Item', item));
    if (kinds.has('ActorDelta')) {
        for (const scene of view?.scenes ?? sceneStore.list()) for (const token of rows(scene.tokens)) {
            if (token.actorLink === true || token.actorId === null) continue;
            if (typeof token.actorId !== 'string' || !actors.some(actor => id(actor) === token.actorId) && !view?.baseActorIds?.has(token.actorId)
                || token.delta !== null && !isRecord(token.delta)) {
                if (required.has('ActorDelta')) throw new Error('Required unlinked-token delta/base Actor is unavailable');
                options.exclusions?.push(`Scene.${id(scene)}.Token.${id(token)}: advisory delta/base source unavailable`); continue;
            }
            // Native ActorDeltaField materializes a null delta lazily. Its base
            // Actor is already enumerated; no persisted overrides exist here.
            if (token.delta === null) continue;
            targets.push(...expandMigrationTargets(`Scene.${id(scene)}.Token.${id(token)}.ActorDelta.${id(token.delta)}`, 'ActorDelta', token.delta)
                .map(row => ({ ...row, baseActorUuid: `Actor.${token.actorId}` })));
        }
    }
    if (kinds.has('WorldPack')) {
        for (const pack of view?.packs ?? compendiumStore.listPackMetadata()) {
            const packId = String(pack.id ?? '');
            const type = pack.type ?? pack.documentName ?? pack.entity;
            if (type !== 'Actor' && type !== 'Item') continue;
            if (pack.packageType !== 'world') {
                if (!['system', 'module'].includes(String(pack.packageType))) {
                    if (required.has('WorldPack')) throw new Error('Required world pack ownership is unavailable');
                    options.exclusions?.push(`${packId}: advisory pack ownership unavailable`);
                }
                continue; // Explicit system/module packs never become write targets.
            }
            const userId = serviceAccountAuthority.getUserId();
            if (!userId || !canRead(packId) || !packIsWritableWorld(packId, view)) {
                if (required.has('WorldPack')) throw new Error('Required world pack is locked or unreadable');
                options.exclusions?.push(`${packId}: advisory world pack locked/unreadable`); continue;
            }
            const response = await transport.dispatchDocumentSocket(type, 'get', { pack: packId, index: false, query: {}, broadcast: false });
            const documents = isRecord(response) ? response.result : response;
            if (!Array.isArray(documents)) throw new Error('World-pack enumeration unavailable');
            for (const document of rows(documents)) targets.push(...expandMigrationTargets(`Compendium.${packId}.${type}.${id(document)}`, type, document, packId));
        }
    }
    for (const packId of new Set(readPacks)) {
        if (targets.some(target => target.pack === packId)) continue;
        const metadata = view ? view.packs.find(row => row.id === packId) : compendiumStore.getPackMetadata(packId);
        const type = metadata?.type ?? metadata?.documentName ?? metadata?.entity;
        const userId = serviceAccountAuthority.getUserId();
        if (!userId || !canRead(packId) || type !== 'Actor' && type !== 'Item') {
            if (options.requiredReadPacks === undefined || options.requiredReadPacks.has(packId)) throw new Error('Required declared pack reference unavailable');
            options.exclusions?.push(`${packId}: advisory pack reference unavailable`); continue;
        }
        const response = await transport.dispatchDocumentSocket(type, 'get', { pack: packId, index: false, query: {}, broadcast: false });
        const documents = isRecord(response) ? response.result : response;
        if (!Array.isArray(documents)) throw new Error('Pack reference enumeration unavailable');
        for (const document of rows(documents)) targets.push(...expandMigrationTargets(`Compendium.${packId}.${type}.${id(document)}`, type, document, packId).map(row => ({ ...row, readOnly: true })));
    }
    return targets.filter(target => options.includeRelations || target.readOnly || (target.pack ? kinds.has('WorldPack') : kinds.has(target.kind)));

    function canRead(packId: string): boolean {
        if (!view) return canReadNativePack(serviceAccountAuthority.getUserId()!, packId);
        const metadata = view.packs.find(row => row.id === packId);
        const config = isRecord(view.configuration) && isRecord(view.configuration[packId]) ? view.configuration[packId] : null;
        return !!metadata && canReadNativePackForSubject(view.subject, generation, metadata.ownership, config?.ownership);
    }
}
