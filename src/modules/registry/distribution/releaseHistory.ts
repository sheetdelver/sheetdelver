import { parseModuleId } from '@shared/security/moduleId';
import type { SystemModuleInfo } from '../core/types';
import { validateModuleInfoShape } from '../lifecycle/validation';
import { isValidModuleReleaseVersion } from './releaseManifest';

export const MODULE_RELEASE_HISTORY_SCHEMA_VERSION = 'sheet-delver-release-history.v1';
export const MAX_MODULE_RELEASE_HISTORY_ENTRIES = 100;

export interface ModuleReleaseHistoryEntry {
    version: string;
    manifest: string;
    compatibility?: SystemModuleInfo['compatibility'];
}

export interface ModuleReleaseHistoryDocument {
    schemaVersion: typeof MODULE_RELEASE_HISTORY_SCHEMA_VERSION;
    moduleId: string;
    generatedAt: number;
    releases: ModuleReleaseHistoryEntry[];
}

export interface ModuleReleaseHistoryValidationResult {
    valid: boolean;
    errors: string[];
}

function isPublicHttpsUrl(value: unknown): value is string {
    if (typeof value !== 'string' || value.trim().length === 0) return false;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password;
    } catch {
        return false;
    }
}

export function validateModuleReleaseHistory(
    value: unknown,
): ModuleReleaseHistoryValidationResult {
    const errors: string[] = [];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { valid: false, errors: ['Release history root must be an object'] };
    }

    const candidate = value as Partial<ModuleReleaseHistoryDocument>;
    if (candidate.schemaVersion !== MODULE_RELEASE_HISTORY_SCHEMA_VERSION) {
        errors.push(`Release history field "schemaVersion" must equal "${MODULE_RELEASE_HISTORY_SCHEMA_VERSION}"`);
    }
    const moduleId = parseModuleId(candidate.moduleId);
    if (!moduleId || moduleId !== candidate.moduleId) {
        errors.push('Release history field "moduleId" must be a canonical module ID');
    }
    if (!Number.isSafeInteger(candidate.generatedAt) || Number(candidate.generatedAt) < 0) {
        errors.push('Release history field "generatedAt" must be a non-negative integer timestamp');
    }
    if (!Array.isArray(candidate.releases)) {
        errors.push('Release history field "releases" must be an array');
        return { valid: false, errors };
    }
    if (candidate.releases.length === 0) {
        errors.push('Release history field "releases" must contain at least one release');
    }
    if (candidate.releases.length > MAX_MODULE_RELEASE_HISTORY_ENTRIES) {
        errors.push(`Release history field "releases" must contain at most ${MAX_MODULE_RELEASE_HISTORY_ENTRIES} releases`);
    }

    const versions = new Set<string>();
    const manifests = new Set<string>();
    candidate.releases.forEach((release, index) => {
        if (!release || typeof release !== 'object' || Array.isArray(release)) {
            errors.push(`Release history field "releases.${index}" must be an object`);
            return;
        }
        if (!isValidModuleReleaseVersion(release.version)) {
            errors.push(`Release history field "releases.${index}.version" must be a safe non-empty release version`);
        } else if (versions.has(release.version)) {
            errors.push(`Release history contains duplicate version "${release.version}"`);
        } else {
            versions.add(release.version);
        }
        if (!isPublicHttpsUrl(release.manifest)) {
            errors.push(`Release history field "releases.${index}.manifest" must be a public HTTPS URL without credentials`);
        } else if (manifests.has(release.manifest)) {
            errors.push(`Release history contains duplicate manifest URL "${release.manifest}"`);
        } else {
            manifests.add(release.manifest);
        }
        if (release.compatibility !== undefined) {
            const shape = validateModuleInfoShape({
                id: 'release-history-entry',
                title: 'Release history entry',
                manifest: { ui: 'dist/ui.js', logic: 'dist/logic.js' },
                compatibility: release.compatibility,
            });
            for (const error of shape.errors.filter((message) => message.includes('compatibility'))) {
                errors.push(`Release history field "releases.${index}.compatibility": ${error}`);
            }
        }
    });

    return { valid: errors.length === 0, errors };
}

export function resolveModuleReleaseHistoryEntry(
    history: ModuleReleaseHistoryDocument,
    version: string,
): ModuleReleaseHistoryEntry | undefined {
    return history.releases.find((release) => release.version === version);
}
