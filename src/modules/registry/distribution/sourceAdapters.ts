import type { ModulePermissionDeclaration, ModuleTrustTier } from '../core/types';
import { ModuleSourceKind } from '@shared/types/modules';
import type { ModuleIndexDocument } from './moduleIndex';
import {
    getRemoteModuleDistributionDenial,
    isRemoteModuleSourceRef,
} from '../security/remoteDistributionPolicy';
import { parseModuleId } from '@shared/security/moduleId';

export type { ModuleSourceKind };

export interface ModuleSourceResolution {
    kind: ModuleSourceKind;
    moduleId: string;
    version: string;
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
    publisher?: string;
    sourceRef?: string;
}

export interface SourceResolutionContext {
    indexes?: Record<string, ModuleIndexDocument>;
}

export interface SourceResolveInput {
    moduleId: string;
    targetVersion?: string;
    sourceRef: string;
}

export interface SourceResolveResult {
    ok: boolean;
    value?: ModuleSourceResolution;
    error?: string;
    errorCode?: string;
}

export interface ModuleSourceAdapter {
    kind: ModuleSourceKind;
    canHandle(sourceRef: string): boolean;
    resolve(input: SourceResolveInput, context?: SourceResolutionContext): SourceResolveResult;
}

export const localModuleSourceAdapter: ModuleSourceAdapter = {
    kind: ModuleSourceKind.Local,
    canHandle(sourceRef: string): boolean {
        return sourceRef.startsWith('local://') || sourceRef.startsWith('file://');
    },
    resolve(input: SourceResolveInput): SourceResolveResult {
        if (!this.canHandle(input.sourceRef)) {
            return {
                ok: false,
                error: `Local source adapter cannot handle source ref "${input.sourceRef}"`,
            };
        }

        const moduleId = parseModuleId(input.moduleId);
        if (!moduleId) {
            return { ok: false, error: 'Invalid module ID', errorCode: 'invalid-module-id' };
        }

        return {
            ok: true,
            value: {
                kind: ModuleSourceKind.Local,
                moduleId,
                version: input.targetVersion?.trim() || '0.0.0-local',
                source: input.sourceRef,
                sourceRef: input.sourceRef,
            },
        };
    },
};

export const indexedModuleSourceAdapter: ModuleSourceAdapter = {
    kind: 'indexed',
    canHandle(sourceRef: string): boolean {
        return sourceRef.startsWith('index://');
    },
    resolve(input: SourceResolveInput): SourceResolveResult {
        if (!this.canHandle(input.sourceRef)) {
            return {
                ok: false,
                error: `Indexed source adapter cannot handle source ref "${input.sourceRef}"`,
            };
        }

        // The adapter remains parseable as dormant scaffolding, but no direct
        // caller may bypass the active adapter set and resolve an index.
        const denial = getRemoteModuleDistributionDenial();
        return { ok: false, error: denial.message, errorCode: denial.code };
    },
};

export const directModuleSourceAdapter: ModuleSourceAdapter = {
    kind: 'direct',
    canHandle(sourceRef: string): boolean {
        return sourceRef.startsWith('http://') || sourceRef.startsWith('https://');
    },
    resolve(input: SourceResolveInput): SourceResolveResult {
        if (!this.canHandle(input.sourceRef)) {
            return {
                ok: false,
                error: `Direct source adapter cannot handle source ref "${input.sourceRef}"`,
            };
        }

        // Direct URLs are the second dormant network entry point and share the
        // same non-configurable denial as indexed sources.
        const denial = getRemoteModuleDistributionDenial();
        return { ok: false, error: denial.message, errorCode: denial.code };
    },
};

export function getDefaultModuleSourceAdapters(): ModuleSourceAdapter[] {
    // Only owner-controlled local sources participate in active resolution.
    return [localModuleSourceAdapter];
}

export function resolveModuleSource(
    adapters: ModuleSourceAdapter[],
    input: SourceResolveInput,
    context?: SourceResolutionContext
): SourceResolveResult {
    if (isRemoteModuleSourceRef(input.sourceRef)) {
        const denial = getRemoteModuleDistributionDenial();
        return { ok: false, error: denial.message, errorCode: denial.code };
    }

    const adapter = adapters.find((candidate) => candidate.canHandle(input.sourceRef));
    if (!adapter) {
        return {
            ok: false,
            error: `No module source adapter found for source ref "${input.sourceRef}"`,
        };
    }

    return adapter.resolve(input, context);
}
