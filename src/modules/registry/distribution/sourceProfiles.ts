import fs from 'node:fs';
import {
    LegacyModuleSourceCategory,
    ModuleSourceKind,
    ModuleTrustTier,
    SourceProfileId,
    type ModuleTrustTier as ModuleTrustTierValue,
} from '@shared/types/modules';
import path from 'node:path';
import { getModulesDataDir, writeOwnerOnlyFileAtomicSync } from '@core/paths';
import { logger } from '@shared/utils/logger';

export type RedactedSourceProfile = SourceProfile;

/** Retained as the response boundary while source profiles are public-only. */
export function redactSourceProfile(profile: SourceProfile): RedactedSourceProfile {
    return profile;
}

export interface SourceProfile {
    id: string;
    name: string;
    kind: ModuleSourceKind;
    baseUrl: string;
    enabled: boolean;
    priority: number;
    trustTier?: ModuleTrustTierValue;
    createdAt: number;
    updatedAt: number;
}

export interface PublicCatalogProfileInput {
    name: string;
    baseUrl: string;
    enabled?: boolean;
    priority?: number;
}

export const DEFAULT_LOCAL_PROFILE_ID = SourceProfileId.LocalDefault;
export const OFFICIAL_CATALOG_PROFILE_ID = SourceProfileId.OfficialCatalog;
export const OFFICIAL_CATALOG_URL = 'https://sheetdelver.com/module-catalog/catalog.json';

export const DEFAULT_LOCAL_PROFILE: SourceProfile = {
    id: DEFAULT_LOCAL_PROFILE_ID,
    name: 'Default Local Source',
    kind: ModuleSourceKind.Local,
    baseUrl: 'local://',
    enabled: true,
    priority: 0,
    trustTier: ModuleTrustTier.FirstParty,
    createdAt: 0,
    updatedAt: 0,
};

export const DEFAULT_OFFICIAL_CATALOG_PROFILE: SourceProfile = {
    id: OFFICIAL_CATALOG_PROFILE_ID,
    name: 'SheetDelver Official Catalog',
    kind: ModuleSourceKind.Indexed,
    baseUrl: OFFICIAL_CATALOG_URL,
    enabled: true,
    priority: 100,
    trustTier: ModuleTrustTier.FirstParty,
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
    profiles = profiles.map((profile) => {
        if (profile.id === DEFAULT_LOCAL_PROFILE_ID) {
            const normalized = { ...DEFAULT_LOCAL_PROFILE };
            if (JSON.stringify(profile) !== JSON.stringify(normalized)) profilesChanged = true;
            return normalized;
        }
        if (profile.id === OFFICIAL_CATALOG_PROFILE_ID) {
            const normalized = {
                ...DEFAULT_OFFICIAL_CATALOG_PROFILE,
                enabled: typeof profile.enabled === 'boolean' ? profile.enabled : true,
                priority: Number.isSafeInteger(profile.priority) && profile.priority >= 0
                    ? profile.priority
                    : DEFAULT_OFFICIAL_CATALOG_PROFILE.priority,
            };
            if (JSON.stringify(profile) !== JSON.stringify(normalized)) profilesChanged = true;
            return normalized;
        }
        const {
            auth: discardedAuth,
            hostAllowlist: discardedHostAllowlist,
            ...publicProfile
        } = profile as SourceProfile & { auth?: unknown; hostAllowlist?: unknown };
        const normalized = {
            ...publicProfile,
            kind: ModuleSourceKind.Indexed,
            trustTier: ModuleTrustTier.Unverified,
        };
        if (
            discardedAuth !== undefined
            || discardedHostAllowlist !== undefined
            || profile.kind !== normalized.kind
            || profile.trustTier !== normalized.trustTier
        ) {
            profilesChanged = true;
        }
        return normalized;
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
    const hasOfficialCatalog = profiles.some(p => p.id === OFFICIAL_CATALOG_PROFILE_ID);
    if (!hasOfficialCatalog) {
        profiles.push(DEFAULT_OFFICIAL_CATALOG_PROFILE);
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
        writeOwnerOnlyFileAtomicSync(filePath, `${JSON.stringify(profiles, null, 2)}\n`);
        _profilesCache = profiles;
        _profilesCache.sort((a, b) => a.priority - b.priority);
    } catch (error) {
        logger.error(`Failed to save source profiles to ${filePath}`, error);
        throw error;
    }
}

export function getSourceProfile(id: string): SourceProfile | undefined {
    const profiles = loadSourceProfiles();
    return profiles.find(p => p.id === id);
}

function normalizeCatalogName(value: string): string {
    const name = value.trim();
    if (!name || name.length > 120) throw new Error('Catalog name must be between 1 and 120 characters');
    return name;
}

function normalizeCatalogUrl(value: string): string {
    let url: URL;
    try {
        url = new URL(value.trim());
    } catch {
        throw new Error('Catalog URL is invalid');
    }
    if (url.protocol !== 'https:' || url.username || url.password) {
        throw new Error('Catalog URL must use HTTPS without credentials');
    }
    url.hash = '';
    return url.href;
}

function normalizePriority(value: number | undefined, fallback: number): number {
    const priority = value === undefined ? fallback : value;
    if (!Number.isSafeInteger(priority) || priority < 0) {
        throw new Error('Catalog priority must be a non-negative integer');
    }
    return priority;
}

function normalizeEnabled(value: boolean | undefined, fallback: boolean): boolean {
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') throw new Error('Catalog enabled must be true or false');
    return value;
}

export function createSourceProfile(input: PublicCatalogProfileInput): SourceProfile {
    const profiles = loadSourceProfiles();
    const id = `src_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const now = Date.now();
    const newProfile: SourceProfile = {
        id,
        name: normalizeCatalogName(input.name),
        kind: ModuleSourceKind.Indexed,
        baseUrl: normalizeCatalogUrl(input.baseUrl),
        enabled: normalizeEnabled(input.enabled, true),
        priority: normalizePriority(input.priority, 200),
        trustTier: ModuleTrustTier.Unverified,
        createdAt: now,
        updatedAt: now,
    };
    profiles.push(newProfile);
    saveSourceProfiles(profiles);
    return newProfile;
}

export function updateSourceProfile(id: string, updates: Partial<PublicCatalogProfileInput>): SourceProfile | null {
    if (id === DEFAULT_LOCAL_PROFILE_ID || id === LegacyModuleSourceCategory.BuiltIn) {
        throw new Error('Cannot modify the default local source profile');
    }

    const profiles = loadSourceProfiles();
    const index = profiles.findIndex(p => p.id === id);
    if (index === -1) return null;

    if (id === OFFICIAL_CATALOG_PROFILE_ID && (updates.name !== undefined || updates.baseUrl !== undefined)) {
        throw new Error('Cannot modify the official catalog identity or URL');
    }

    profiles[index] = {
        ...profiles[index],
        ...(updates.name !== undefined ? { name: normalizeCatalogName(updates.name) } : {}),
        ...(updates.baseUrl !== undefined ? { baseUrl: normalizeCatalogUrl(updates.baseUrl) } : {}),
        ...(updates.enabled !== undefined
            ? { enabled: normalizeEnabled(updates.enabled, profiles[index].enabled) }
            : {}),
        ...(updates.priority !== undefined
            ? { priority: normalizePriority(updates.priority, profiles[index].priority) }
            : {}),
        updatedAt: Date.now(),
    };

    saveSourceProfiles(profiles);
    return profiles[index];
}

export function deleteSourceProfile(id: string): boolean {
    if (
        id === DEFAULT_LOCAL_PROFILE_ID
        || id === OFFICIAL_CATALOG_PROFILE_ID
        || id === LegacyModuleSourceCategory.BuiltIn
    ) {
        throw new Error('Cannot delete a protected source profile');
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

export function __resetSourceProfilesForTests(): void {
    _profilesCache = null;
}
