import type { SystemModuleInfo } from '../core/types';
import { validateModuleInfoShape } from '../lifecycle/validation';
import { parseModuleId } from '@shared/security/moduleId';
import type { MigrationSummary } from '../migrations/catalog';

export const MODULE_RELEASE_MANIFEST_SCHEMA_VERSION = 'sheet-delver-release.v1';
export const SHA256_INTEGRITY_PATTERN = /^sha256:[a-f0-9]{64}$/;

export interface ModuleReleaseMetadata {
    id: string;
    title: string;
    version: string;
    compatibility?: SystemModuleInfo['compatibility'];
    permissions?: SystemModuleInfo['permissions'];
    dependencies?: string[];
    conflicts?: string[];
    worldSettings?: SystemModuleInfo['worldSettings'];
}

export interface ModuleReleaseArtifact {
    url: string;
    size: number;
    integrity: string;
}

export interface ModuleReleaseManifest {
    schemaVersion: typeof MODULE_RELEASE_MANIFEST_SCHEMA_VERSION | 'sheet-delver-release.v2';
    migrations?: MigrationSummary;
    publishedAt: number;
    module: ModuleReleaseMetadata;
    artifact: ModuleReleaseArtifact;
    repository?: string;
    changelog?: string;
}

export interface ModuleReleaseManifestValidationResult {
    valid: boolean;
    errors: string[];
}

export interface CreateModuleReleaseManifestOptions {
    migrations?: MigrationSummary;
    publishedAt?: number;
    repository?: string;
    changelog?: string;
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

function isHttpsUrl(value: unknown): boolean {
    if (!isNonEmptyString(value)) return false;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password;
    } catch {
        return false;
    }
}

export function isValidModuleReleaseVersion(value: unknown): value is string {
    return isNonEmptyString(value)
        && value.length <= 128
        && /^[0-9A-Za-z](?:[0-9A-Za-z.+-]*[0-9A-Za-z])?$/.test(value)
        && !value.includes('..');
}

export function isValidReleaseArtifactUrl(value: unknown): value is string {
    if (!isNonEmptyString(value)) return false;
    if (isHttpsUrl(value)) return true;

    return !value.includes('/')
        && !value.includes('\\')
        && value !== '.'
        && value !== '..';
}

function validateReleaseMetadata(value: unknown): string[] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return ['Release manifest field "module" must be an object'];
    }

    const candidate = value as Partial<ModuleReleaseMetadata> & { trust?: unknown; trustTier?: unknown };
    const errors: string[] = [];
    if (Object.prototype.hasOwnProperty.call(candidate, 'trust') || Object.prototype.hasOwnProperty.call(candidate, 'trustTier')) {
        errors.push('Release manifest module metadata must not declare its own trust tier');
    }
    if (!isValidModuleReleaseVersion(candidate.version)) {
        errors.push('Release manifest field "module.version" must be a safe non-empty release version');
    }

    const shape = validateModuleInfoShape({
        id: candidate.id,
        title: candidate.title,
        compatibility: candidate.compatibility,
        permissions: candidate.permissions,
        dependencies: candidate.dependencies,
        conflicts: candidate.conflicts,
        worldSettings: candidate.worldSettings,
        manifest: {
            ui: 'dist/ui.js',
            logic: 'dist/logic.js',
        },
    });
    for (const error of shape.errors) {
        errors.push(`Release manifest module metadata: ${error}`);
    }
    return errors;
}

export function validateModuleReleaseManifest(value: unknown): ModuleReleaseManifestValidationResult {
    const errors: string[] = [];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { valid: false, errors: ['Release manifest root must be an object'] };
    }

    const candidate = value as Partial<ModuleReleaseManifest> & { trust?: unknown; trustTier?: unknown };
    if (candidate.schemaVersion !== MODULE_RELEASE_MANIFEST_SCHEMA_VERSION && candidate.schemaVersion !== 'sheet-delver-release.v2') {
        errors.push(`Release manifest field "schemaVersion" must equal "${MODULE_RELEASE_MANIFEST_SCHEMA_VERSION}"`);
    }
    if (candidate.migrations !== undefined && (candidate.schemaVersion !== 'sheet-delver-release.v2'
        || candidate.migrations.schemaVersion !== 'sheet-delver-migrations.v1'
        || !SHA256_INTEGRITY_PATTERN.test(candidate.migrations.catalogDigest) || !Number.isSafeInteger(candidate.migrations.steps))) {
        errors.push('Invalid derived migration summary');
    }
    if (candidate.schemaVersion === 'sheet-delver-release.v2' && candidate.migrations === undefined) errors.push('Release v2 requires a derived migration summary');
    if (!Number.isSafeInteger(candidate.publishedAt) || Number(candidate.publishedAt) < 0) {
        errors.push('Release manifest field "publishedAt" must be a non-negative integer timestamp');
    }
    if (Object.prototype.hasOwnProperty.call(candidate, 'trust') || Object.prototype.hasOwnProperty.call(candidate, 'trustTier')) {
        errors.push('Release manifest must not declare its own trust tier');
    }
    errors.push(...validateReleaseMetadata(candidate.module));

    if (!candidate.artifact || typeof candidate.artifact !== 'object' || Array.isArray(candidate.artifact)) {
        errors.push('Release manifest field "artifact" must be an object');
    } else {
        if (!isValidReleaseArtifactUrl(candidate.artifact.url)) {
            errors.push('Release manifest field "artifact.url" must be an HTTPS URL or a sibling release asset name');
        }
        if (!Number.isSafeInteger(candidate.artifact.size) || Number(candidate.artifact.size) <= 0) {
            errors.push('Release manifest field "artifact.size" must be a positive integer');
        }
        if (!isNonEmptyString(candidate.artifact.integrity) || !SHA256_INTEGRITY_PATTERN.test(candidate.artifact.integrity)) {
            errors.push('Release manifest field "artifact.integrity" must be sha256 followed by 64 lowercase hexadecimal characters');
        }
    }

    for (const field of ['repository', 'changelog'] as const) {
        const url = candidate[field];
        if (url !== undefined && !isHttpsUrl(url)) {
            errors.push(`Release manifest field "${field}" must be an HTTPS URL without credentials when provided`);
        }
    }

    return { valid: errors.length === 0, errors };
}

export function createModuleReleaseManifest(
    info: SystemModuleInfo,
    artifact: ModuleReleaseArtifact,
    options: CreateModuleReleaseManifestOptions = {},
): ModuleReleaseManifest {
    const moduleId = parseModuleId(info.id);
    if (!moduleId || moduleId !== info.id) {
        throw new Error('Cannot create release manifest: info.json id must be canonical');
    }
    if (!isValidModuleReleaseVersion(info.version)) {
        throw new Error('Cannot create release manifest: info.json version must be a safe non-empty release version');
    }

    const manifest: ModuleReleaseManifest = {
        schemaVersion: options.migrations ? 'sheet-delver-release.v2' : MODULE_RELEASE_MANIFEST_SCHEMA_VERSION,
        ...(options.migrations ? { migrations: options.migrations } : {}),
        publishedAt: options.publishedAt ?? Date.now(),
        module: {
            id: moduleId,
            title: info.title,
            version: info.version,
            ...(info.compatibility ? { compatibility: info.compatibility } : {}),
            ...(info.permissions ? { permissions: info.permissions } : {}),
            ...(info.dependencies ? { dependencies: info.dependencies } : {}),
            ...(info.conflicts ? { conflicts: info.conflicts } : {}),
            ...(info.worldSettings ? { worldSettings: info.worldSettings } : {}),
        },
        artifact,
        ...(options.repository ? { repository: options.repository } : {}),
        ...(options.changelog ? { changelog: options.changelog } : {}),
    };

    const validation = validateModuleReleaseManifest(manifest);
    if (!validation.valid) {
        throw new Error(`Cannot create release manifest: ${validation.errors.join('; ')}`);
    }
    return manifest;
}
