import { DocumentOwnershipLevel, FoundryUserRole, isAssistantGM, isGM,
    type DocumentAccessSubject } from './ownership';
import { isRecord } from './PrimaryDocumentStore';

export type CombatCopyPermission = 'ACTOR_CREATE' | 'FILES_BROWSE';

/** Source-backed v13/v14 permission rules for manager Actor copies only. */
export function hasCombatCopyPermission(subject: DocumentAccessSubject, permission: CombatCopyPermission,
    generation: number | undefined, userPermissions: unknown, rolePermissions: unknown): boolean {
    if (subject.role === FoundryUserRole.NONE) return false;
    if (generation === 14 && isAssistantGM(subject)) return true; // Native requiredRoles precede overrides.
    if (isRecord(userPermissions) && typeof userPermissions[permission] === 'boolean') {
        return userPermissions[permission] as boolean;
    }
    // Missing role state fails closed, as native hasPermission does. Never
    // infer it from a service-account bootstrap or the permission's defaultRole.
    const roles = isRecord(rolePermissions) ? rolePermissions[permission] : undefined;
    return Array.isArray(roles) && roles.includes(subject.role);
}

/** Packs have role-level ownership, separate from world Actor ownership. */
export function canReadCombatActorPack(subject: DocumentAccessSubject, generation: number | undefined,
    metadataOwnership: unknown, configuredOwnership: unknown): boolean {
    if (subject.role === FoundryUserRole.NONE) return false;
    if (isGM(subject) || (generation === 13 && isAssistantGM(subject))) return true;
    if (generation !== 14) return false;
    const ownership = configuredOwnership ?? metadataOwnership ?? { PLAYER: 'OBSERVER', ASSISTANT: 'OWNER' };
    if (!isRecord(ownership)) return false;
    let level = DocumentOwnershipLevel.NONE;
    for (const [name, value] of Object.entries(ownership)) {
        const role = FoundryUserRole[name as keyof typeof FoundryUserRole];
        const permission = typeof value === 'string'
            ? DocumentOwnershipLevel[value as keyof typeof DocumentOwnershipLevel] : undefined;
        if (typeof role === 'number' && subject.role >= role && typeof permission === 'number') {
            level = Math.max(level, permission);
        }
    }
    return level >= DocumentOwnershipLevel.OBSERVER;
}
