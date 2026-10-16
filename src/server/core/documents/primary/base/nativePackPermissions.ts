import { canReadCombatActorPack } from './nativeCombatPermissions';
import { userStore } from '../users/UserStore';
import { settingStore } from '../settings/SettingStore';
import { worldStateStore } from '@server/core/world/WorldStateStore';
import { compendiumStore } from '@server/core/compendium/CompendiumStore';
import { isRecord } from './PrimaryDocumentStore';

/** Same native role/pack policy for all document kinds; cached rows confer no access. */
export function canReadNativePack(userId: string, packId: string): boolean {
    const subject = userStore.get(userId) ? userStore.createAccessSubject(userId) : null;
    const metadata = compendiumStore.getPackMetadata(packId);
    if (!subject || !metadata) return false;
    const config = settingStore.getValueByKey('core.compendiumConfiguration');
    const configured = isRecord(config) && isRecord(config[packId]) ? config[packId] : null;
    return canReadCombatActorPack(subject, worldStateStore.getRelease()?.generation, metadata.ownership, configured?.ownership);
}
