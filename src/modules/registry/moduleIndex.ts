import type { ModulePermissionDeclaration, ModuleTrustTier } from './types';

export interface ModuleIndexVersionEntry {
    source: string;
    integrity?: string;
    signature?: string;
    trustTier?: ModuleTrustTier;
    compatibility?: {
        coreVersion?: string;
        apiContracts?: Record<string, string>;
    };
    permissions?: ModulePermissionDeclaration;
    dependencies?: string[];
    conflicts?: string[];
    changelog?: string;
    publishedAt?: number;
}

export interface ModuleIndexEntry {
    moduleId: string;
    title: string;
    latestVersion: string;
    versions: Record<string, ModuleIndexVersionEntry>;
}

export interface ModuleIndexDocument {
    schemaVersion: string;
    generatedAt: number;
    publisher: string;
    modules: Record<string, ModuleIndexEntry>;
}

export interface ModuleIndexValidationResult {
    valid: boolean;
    errors: string[];
}

export interface ResolvedIndexedModuleVersion {
    moduleId: string;
    version: string;
    entry: ModuleIndexEntry;
    artifact: ModuleIndexVersionEntry;
}

export interface ResolveIndexedModuleVersionResult {
    ok: boolean;
    value?: ResolvedIndexedModuleVersion;
    error?: string;
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((entry) => isNonEmptyString(entry));
}

function isStringRecord(value: unknown): value is Record<string, string> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return Object.entries(value).every(([key, entry]) => isNonEmptyString(key) && isNonEmptyString(entry));
}

function isValidTrustTier(value: unknown): value is ModuleTrustTier {
    return value === 'first-party' || value === 'verified-third-party' || value === 'unverified';
}

function validateVersionEntry(moduleId: string, version: string, value: unknown): string[] {
    const errors: string[] = [];

    if (!value || typeof value !== 'object') {
        return [`Index field "modules.${moduleId}.versions.${version}" must be an object`];
    }

    const candidate = value as Partial<ModuleIndexVersionEntry>;

    if (!isNonEmptyString(candidate.source)) {
        errors.push(`Index field "modules.${moduleId}.versions.${version}.source" must be a non-empty string`);
    }
    if (candidate.integrity !== undefined && !isNonEmptyString(candidate.integrity)) {
        errors.push(`Index field "modules.${moduleId}.versions.${version}.integrity" must be a non-empty string when provided`);
    }
    if (candidate.signature !== undefined && !isNonEmptyString(candidate.signature)) {
        errors.push(`Index field "modules.${moduleId}.versions.${version}.signature" must be a non-empty string when provided`);
    }
    if (candidate.trustTier !== undefined && !isValidTrustTier(candidate.trustTier)) {
        errors.push(`Index field "modules.${moduleId}.versions.${version}.trustTier" must be one of: first-party, verified-third-party, unverified`);
    }

    if (candidate.compatibility !== undefined) {
        if (!candidate.compatibility || typeof candidate.compatibility !== 'object') {
            errors.push(`Index field "modules.${moduleId}.versions.${version}.compatibility" must be an object when provided`);
        } else {
            if (candidate.compatibility.coreVersion !== undefined && !isNonEmptyString(candidate.compatibility.coreVersion)) {
                errors.push(`Index field "modules.${moduleId}.versions.${version}.compatibility.coreVersion" must be a non-empty string when provided`);
            }
            if (candidate.compatibility.apiContracts !== undefined && !isStringRecord(candidate.compatibility.apiContracts)) {
                errors.push(`Index field "modules.${moduleId}.versions.${version}.compatibility.apiContracts" must be a record of non-empty strings when provided`);
            }
        }
    }

    if (candidate.dependencies !== undefined && !isStringArray(candidate.dependencies)) {
        errors.push(`Index field "modules.${moduleId}.versions.${version}.dependencies" must be an array of non-empty strings when provided`);
    }
    if (candidate.conflicts !== undefined && !isStringArray(candidate.conflicts)) {
        errors.push(`Index field "modules.${moduleId}.versions.${version}.conflicts" must be an array of non-empty strings when provided`);
    }
    if (candidate.changelog !== undefined && !isNonEmptyString(candidate.changelog)) {
        errors.push(`Index field "modules.${moduleId}.versions.${version}.changelog" must be a non-empty string when provided`);
    }
    if (candidate.publishedAt !== undefined && typeof candidate.publishedAt !== 'number') {
        errors.push(`Index field "modules.${moduleId}.versions.${version}.publishedAt" must be a number when provided`);
    }

    return errors;
}

export function validateModuleIndexDocument(value: unknown): ModuleIndexValidationResult {
    const errors: string[] = [];

    if (!value || typeof value !== 'object') {
        return { valid: false, errors: ['Module index root must be an object'] };
    }

    const candidate = value as Partial<ModuleIndexDocument>;

    if (!isNonEmptyString(candidate.schemaVersion)) {
        errors.push('Index field "schemaVersion" must be a non-empty string');
    }
    if (typeof candidate.generatedAt !== 'number') {
        errors.push('Index field "generatedAt" must be a number');
    }
    if (!isNonEmptyString(candidate.publisher)) {
        errors.push('Index field "publisher" must be a non-empty string');
    }
    if (!candidate.modules || typeof candidate.modules !== 'object' || Array.isArray(candidate.modules)) {
        errors.push('Index field "modules" must be an object');
    } else {
        for (const [moduleId, moduleEntry] of Object.entries(candidate.modules)) {
            if (!moduleEntry || typeof moduleEntry !== 'object') {
                errors.push(`Index field "modules.${moduleId}" must be an object`);
                continue;
            }

            const moduleCandidate = moduleEntry as Partial<ModuleIndexEntry>;
            if (!isNonEmptyString(moduleCandidate.moduleId)) {
                errors.push(`Index field "modules.${moduleId}.moduleId" must be a non-empty string`);
            }
            if (!isNonEmptyString(moduleCandidate.title)) {
                errors.push(`Index field "modules.${moduleId}.title" must be a non-empty string`);
            }
            if (!isNonEmptyString(moduleCandidate.latestVersion)) {
                errors.push(`Index field "modules.${moduleId}.latestVersion" must be a non-empty string`);
            }

            if (!moduleCandidate.versions || typeof moduleCandidate.versions !== 'object' || Array.isArray(moduleCandidate.versions)) {
                errors.push(`Index field "modules.${moduleId}.versions" must be an object`);
                continue;
            }

            const versionKeys = Object.keys(moduleCandidate.versions);
            if (versionKeys.length === 0) {
                errors.push(`Index field "modules.${moduleId}.versions" must contain at least one version entry`);
            }

            for (const [version, versionEntry] of Object.entries(moduleCandidate.versions)) {
                errors.push(...validateVersionEntry(moduleId, version, versionEntry));
            }

            if (
                isNonEmptyString(moduleCandidate.latestVersion)
                && !Object.prototype.hasOwnProperty.call(moduleCandidate.versions, moduleCandidate.latestVersion)
            ) {
                errors.push(`Index field "modules.${moduleId}.latestVersion" must match a key in "modules.${moduleId}.versions"`);
            }
        }
    }

    return {
        valid: errors.length === 0,
        errors,
    };
}

export function resolveIndexedModuleVersion(
    index: ModuleIndexDocument,
    moduleId: string,
    requestedVersion?: string
): ResolveIndexedModuleVersionResult {
    const id = moduleId.trim().toLowerCase();
    const moduleEntry = index.modules[id];
    if (!moduleEntry) {
        return {
            ok: false,
            error: `Module "${id}" was not found in index`,
        };
    }

    const version = requestedVersion?.trim() || moduleEntry.latestVersion;
    const artifact = moduleEntry.versions[version];
    if (!artifact) {
        return {
            ok: false,
            error: `Module "${id}" does not have published version "${version}"`,
        };
    }

    return {
        ok: true,
        value: {
            moduleId: id,
            version,
            entry: moduleEntry,
            artifact,
        },
    };
}
