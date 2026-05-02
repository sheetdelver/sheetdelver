import type { SystemModuleInfo } from '../core/types';
import { getCoreContractRegistry } from '../security/contractRegistry';
import {
    resolveModuleCompatibility,
    type ModuleContractDiagnostic,
    type ModuleCoreConstraintDiagnostic,
} from './compatibilityResolver';

export interface ModuleValidationResult {
    valid: boolean;
    errors: string[];
}

export interface ModuleCompatibilityResult {
    compatible: boolean;
    reason?: string;
    coreVersion: string;
    requiredCoreVersion?: string;
    requiredApiContracts?: Record<string, string>;
    providedApiContracts?: Record<string, string>;
    coreDiagnostics?: ModuleCoreConstraintDiagnostic[];
    contractDiagnostics?: ModuleContractDiagnostic[];
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => isNonEmptyString(item));
}

function isStringRecord(value: unknown): value is Record<string, string> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return Object.entries(value).every(([key, entry]) => isNonEmptyString(key) && isNonEmptyString(entry));
}

function isValidTrustTier(value: unknown): boolean {
    return value === 'first-party' || value === 'verified-third-party' || value === 'unverified';
}

export function validateModuleInfoShape(info: unknown): ModuleValidationResult {
    const errors: string[] = [];

    if (!info || typeof info !== 'object') {
        return { valid: false, errors: ['Manifest root must be an object'] };
    }

    const candidate = info as Partial<SystemModuleInfo>;

    if (!isNonEmptyString(candidate.id)) {
        errors.push('Manifest field "id" must be a non-empty string');
    }

    if (!isNonEmptyString(candidate.title)) {
        errors.push('Manifest field "title" must be a non-empty string');
    }

    if (!candidate.manifest || typeof candidate.manifest !== 'object') {
        errors.push('Manifest field "manifest" must be an object');
    } else {
        if (!isNonEmptyString(candidate.manifest.ui)) {
            errors.push('Manifest field "manifest.ui" must be a non-empty string');
        }
        if (!isNonEmptyString(candidate.manifest.logic)) {
            errors.push('Manifest field "manifest.logic" must be a non-empty string');
        }
        if (candidate.manifest.server !== undefined && !isNonEmptyString(candidate.manifest.server)) {
            errors.push('Manifest field "manifest.server" must be a non-empty string when provided');
        }
    }

    if (candidate.aliases !== undefined) {
        if (!Array.isArray(candidate.aliases) || candidate.aliases.some((alias) => !isNonEmptyString(alias))) {
            errors.push('Manifest field "aliases" must be an array of non-empty strings when provided');
        }
    }

    if (candidate.experimental !== undefined && typeof candidate.experimental !== 'boolean') {
        errors.push('Manifest field "experimental" must be a boolean when provided');
    }

    if (candidate.trust !== undefined) {
        if (!candidate.trust || typeof candidate.trust !== 'object') {
            errors.push('Manifest field "trust" must be an object when provided');
        } else if (!isValidTrustTier((candidate.trust as { tier?: unknown }).tier)) {
            errors.push('Manifest field "trust.tier" must be one of: first-party, verified-third-party, unverified');
        }
    }

    if (candidate.permissions !== undefined) {
        if (!candidate.permissions || typeof candidate.permissions !== 'object') {
            errors.push('Manifest field "permissions" must be an object when provided');
        } else {
            const permissions = candidate.permissions;
            if (permissions.network !== undefined) {
                if (!permissions.network || typeof permissions.network !== 'object') {
                    errors.push('Manifest field "permissions.network" must be an object when provided');
                } else {
                    if (permissions.network.outbound !== undefined && typeof permissions.network.outbound !== 'boolean') {
                        errors.push('Manifest field "permissions.network.outbound" must be a boolean when provided');
                    }
                    if (permissions.network.allowHosts !== undefined && !isStringArray(permissions.network.allowHosts)) {
                        errors.push('Manifest field "permissions.network.allowHosts" must be an array of non-empty strings when provided');
                    }
                }
            }

            if (permissions.filesystem !== undefined) {
                if (!permissions.filesystem || typeof permissions.filesystem !== 'object') {
                    errors.push('Manifest field "permissions.filesystem" must be an object when provided');
                } else {
                    if (permissions.filesystem.read !== undefined && !isStringArray(permissions.filesystem.read)) {
                        errors.push('Manifest field "permissions.filesystem.read" must be an array of non-empty strings when provided');
                    }
                    if (permissions.filesystem.write !== undefined && !isStringArray(permissions.filesystem.write)) {
                        errors.push('Manifest field "permissions.filesystem.write" must be an array of non-empty strings when provided');
                    }
                }
            }

            if (permissions.adminRoutes !== undefined && typeof permissions.adminRoutes !== 'boolean') {
                errors.push('Manifest field "permissions.adminRoutes" must be a boolean when provided');
            }

            if (permissions.sensitiveData !== undefined && !isStringArray(permissions.sensitiveData)) {
                errors.push('Manifest field "permissions.sensitiveData" must be an array of non-empty strings when provided');
            }
        }
    }

    if (candidate.compatibility !== undefined) {
        if (!candidate.compatibility || typeof candidate.compatibility !== 'object') {
            errors.push('Manifest field "compatibility" must be an object when provided');
        } else {
            if (candidate.compatibility.coreVersion !== undefined && !isNonEmptyString(candidate.compatibility.coreVersion)) {
                errors.push('Manifest field "compatibility.coreVersion" must be a non-empty string when provided');
            }
            if (
                candidate.compatibility.apiContracts !== undefined
                && !isStringRecord(candidate.compatibility.apiContracts)
            ) {
                errors.push('Manifest field "compatibility.apiContracts" must be a record of non-empty string keys to non-empty version range strings when provided');
            }
        }
    }

    return {
        valid: errors.length === 0,
        errors
    };
}

export function evaluateModuleCompatibility(
    info: SystemModuleInfo,
    coreVersion: string
): ModuleCompatibilityResult {
    const requiredCoreVersion = info.compatibility?.coreVersion;
    const requiredApiContracts = info.compatibility?.apiContracts;
    const providedApiContracts: Record<string, string> = getCoreContractRegistry();
    const resolution = resolveModuleCompatibility({
        coreVersion,
        requiredCoreVersion,
        requiredApiContracts,
        providedApiContracts,
    });

    return {
        compatible: resolution.compatible,
        reason: resolution.reason,
        coreVersion,
        requiredCoreVersion,
        requiredApiContracts,
        providedApiContracts,
        coreDiagnostics: resolution.coreDiagnostics,
        contractDiagnostics: resolution.contractDiagnostics,
    };
}
