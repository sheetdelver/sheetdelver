import fs from 'node:fs';
import { LegacyModuleSourceCategory, ModuleSourceKind, SourceProfileId } from '@shared/types/modules';
import path from 'node:path';
import { getModulesDataDir } from '@core/paths';
import { logger } from '@shared/utils/logger';

export interface SourceProfileAuth {
    type: 'bearer';
    token: string;
}

export interface SourceProfile {
    id: string;
    name: string;
    kind: ModuleSourceKind;
    baseUrl: string;
    enabled: boolean;
    priority: number;
    auth?: SourceProfileAuth;
    hostAllowlist?: string[];
    createdAt: number;
    updatedAt: number;
}

export const DEFAULT_LOCAL_PROFILE_ID = SourceProfileId.LocalDefault;

export const DEFAULT_LOCAL_PROFILE: SourceProfile = {
    id: DEFAULT_LOCAL_PROFILE_ID,
    name: 'Default Local Source',
    kind: ModuleSourceKind.Local,
    baseUrl: 'local://',
    enabled: true,
    priority: 0,
    createdAt: 0,
    updatedAt: 0,
};

let _profilesCache: SourceProfile[] | null = null;

function getProfilesFilePath(): string {
    return path.join(getModulesDataDir(), 'sources.json');
}

export function loadSourceProfiles(): SourceProfile[] {
    if (_profilesCache) return _profilesCache;

    const filePath = getProfilesFilePath();
    let profiles: SourceProfile[] = [];

    if (fs.existsSync(filePath)) {
        try {
            const data = fs.readFileSync(filePath, 'utf8');
            profiles = JSON.parse(data) as SourceProfile[];
        } catch (error) {
            logger.error(`Failed to load source profiles from ${filePath}`, error);
            profiles = [];
        }
    }

    // Migrate the old protected "built-in" profile id to the current default local
    // profile id so the admin API no longer exposes "built-in" as a module source.
    let profilesChanged = false;
    profiles = profiles.map(profile => {
        if (profile.id !== LegacyModuleSourceCategory.BuiltIn) return profile;
        profilesChanged = true;
        return { ...profile, id: DEFAULT_LOCAL_PROFILE_ID, name: DEFAULT_LOCAL_PROFILE.name };
    });
    const beforeDedupeCount = profiles.length;
    profiles = profiles.filter((profile, index, all) => (
        profile.id !== DEFAULT_LOCAL_PROFILE_ID
        || index === all.findIndex(candidate => candidate.id === DEFAULT_LOCAL_PROFILE_ID)
    ));
    profilesChanged = profilesChanged || profiles.length !== beforeDedupeCount;

    // Ensure the protected default local source exists.
    const hasDefaultLocal = profiles.some(p => p.id === DEFAULT_LOCAL_PROFILE_ID);
    if (!hasDefaultLocal) {
        profiles.push(DEFAULT_LOCAL_PROFILE);
        profilesChanged = true;
    }
    if (profilesChanged) {
        saveSourceProfiles(profiles);
    }

    // Sort by priority ascending
    profiles.sort((a, b) => a.priority - b.priority);
    _profilesCache = profiles;
    return profiles;
}

export function saveSourceProfiles(profiles: SourceProfile[]): void {
    const filePath = getProfilesFilePath();
    try {
        fs.writeFileSync(filePath, JSON.stringify(profiles, null, 2), 'utf8');
        _profilesCache = profiles;
        _profilesCache.sort((a, b) => a.priority - b.priority);
    } catch (error) {
        logger.error(`Failed to save source profiles to ${filePath}`, error);
    }
}

export function getSourceProfile(id: string): SourceProfile | undefined {
    const profiles = loadSourceProfiles();
    return profiles.find(p => p.id === id);
}

export function createSourceProfile(profile: Omit<SourceProfile, 'id' | 'createdAt' | 'updatedAt'>): SourceProfile {
    const profiles = loadSourceProfiles();
    const id = `src_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const now = Date.now();
    const newProfile: SourceProfile = {
        ...profile,
        id,
        createdAt: now,
        updatedAt: now,
    };
    profiles.push(newProfile);
    saveSourceProfiles(profiles);
    return newProfile;
}

export function updateSourceProfile(id: string, updates: Partial<Omit<SourceProfile, 'id' | 'createdAt' | 'updatedAt'>>): SourceProfile | null {
    if (id === DEFAULT_LOCAL_PROFILE_ID || id === LegacyModuleSourceCategory.BuiltIn) {
        throw new Error('Cannot modify the default local source profile');
    }

    const profiles = loadSourceProfiles();
    const index = profiles.findIndex(p => p.id === id);
    if (index === -1) return null;

    profiles[index] = {
        ...profiles[index],
        ...updates,
        updatedAt: Date.now(),
    };

    saveSourceProfiles(profiles);
    return profiles[index];
}

export function deleteSourceProfile(id: string): boolean {
    if (id === DEFAULT_LOCAL_PROFILE_ID || id === LegacyModuleSourceCategory.BuiltIn) {
        throw new Error('Cannot delete the default local source profile');
    }

    const profiles = loadSourceProfiles();
    const initialLength = profiles.length;
    const filtered = profiles.filter(p => p.id !== id);
    
    if (filtered.length !== initialLength) {
        saveSourceProfiles(filtered);
        return true;
    }
    return false;
}
