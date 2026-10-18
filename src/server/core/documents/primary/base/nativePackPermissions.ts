import { DocumentOwnershipLevel, FoundryUserRole, isGM, isAssistantGM, type DocumentAccessSubject } from './ownership';
import { userStore } from '../users/UserStore';
import { settingStore } from '../settings/SettingStore';
import { worldStateStore } from '@server/core/world/WorldStateStore';
import { compendiumStore } from '@server/core/compendium/CompendiumStore';
import { isRecord } from './PrimaryDocumentStore';
import type { CompendiumPackMetadata } from '@server/core/compendium/types';

/** Native v13/v14 CompendiumCollection.locked: configuration, then package
 * ownership default. metadata.locked is not part of that native precedence.
 * null means the configuration/identity cannot be established, not unlocked. */
export function nativePackLocked(metadata: CompendiumPackMetadata, configuration: unknown): boolean | null {
    if (!['world', 'system', 'module'].includes(String(metadata.packageType))) return null;
    if (configuration !== undefined && !isRecord(configuration)) return null;
    const row = isRecord(configuration) ? configuration[String(metadata.id)] : undefined;
    if (row != null && !isRecord(row)) return null;
    const override = isRecord(row) ? row.locked : undefined;
    if (override != null && typeof override !== 'boolean') return null;
    return override ?? metadata.packageType !== 'world';
}

/** Native CompendiumCollection role ownership on v13/v14, not a Combat capability. */
export function canReadNativePackForSubject(subject: DocumentAccessSubject, generation: number | undefined,
    metadataOwnership: unknown, configuredOwnership: unknown): boolean {
    if (subject.role === FoundryUserRole.NONE || generation !== 13 && generation !== 14) return false;
    if (isGM(subject) || generation === 13 && isAssistantGM(subject)) return true;
    const ownership = configuredOwnership ?? metadataOwnership ?? { PLAYER: 'OBSERVER', ASSISTANT: 'OWNER' };
    if (!isRecord(ownership)) return false;
    let level = DocumentOwnershipLevel.NONE;
    for (const [name, value] of Object.entries(ownership)) {
        const role = FoundryUserRole[name as keyof typeof FoundryUserRole];
        const permission = typeof value === 'string' ? DocumentOwnershipLevel[value as keyof typeof DocumentOwnershipLevel] : undefined;
        if (typeof role === 'number' && subject.role >= role && typeof permission === 'number') level = Math.max(level, permission);
    }
    return level >= DocumentOwnershipLevel.OBSERVER;
}

/** Same native role/pack policy for all document kinds; cached rows confer no access. */
export function canReadNativePack(userId: string, packId: string): boolean {
    const subject = userStore.get(userId) ? userStore.createAccessSubject(userId) : null;
    const metadata = compendiumStore.getPackMetadata(packId);
    if (!subject || !metadata) return false;
    const config = settingStore.getValueByKey('core.compendiumConfiguration');
    const configured = isRecord(config) && isRecord(config[packId]) ? config[packId] : null;
    return canReadNativePackForSubject(subject, worldStateStore.getRelease()?.generation, metadata.ownership, configured?.ownership);
}
