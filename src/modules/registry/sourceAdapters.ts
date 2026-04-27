import type { ModulePermissionDeclaration, ModuleTrustTier } from './types';
import {
    resolveIndexedModuleVersion,
    type ModuleIndexDocument,
    type ModuleIndexVersionEntry,
} from './moduleIndex';

export type ModuleSourceKind = 'local' | 'indexed';

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
}

export interface ModuleSourceAdapter {
    kind: ModuleSourceKind;
    canHandle(sourceRef: string): boolean;
    resolve(input: SourceResolveInput, context?: SourceResolutionContext): SourceResolveResult;
}

function mapVersionMetadata(
    metadata: ModuleIndexVersionEntry,
    base: Pick<ModuleSourceResolution, 'kind' | 'moduleId' | 'version' | 'publisher' | 'sourceRef'>
): ModuleSourceResolution {
    return {
        ...base,
        source: metadata.source,
        integrity: metadata.integrity,
        signature: metadata.signature,
        trustTier: metadata.trustTier,
        compatibility: metadata.compatibility,
        permissions: metadata.permissions,
        dependencies: metadata.dependencies,
        conflicts: metadata.conflicts,
        changelog: metadata.changelog,
        publishedAt: metadata.publishedAt,
    };
}

export const localModuleSourceAdapter: ModuleSourceAdapter = {
    kind: 'local',
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

        return {
            ok: true,
            value: {
                kind: 'local',
                moduleId: input.moduleId.trim().toLowerCase(),
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
    resolve(input: SourceResolveInput, context?: SourceResolutionContext): SourceResolveResult {
        if (!this.canHandle(input.sourceRef)) {
            return {
                ok: false,
                error: `Indexed source adapter cannot handle source ref "${input.sourceRef}"`,
            };
        }

        const index = context?.indexes?.[input.sourceRef];
        if (!index) {
            return {
                ok: false,
                error: `Index source ref "${input.sourceRef}" is not available in resolution context`,
            };
        }

        const resolved = resolveIndexedModuleVersion(index, input.moduleId, input.targetVersion);
        if (!resolved.ok || !resolved.value) {
            return {
                ok: false,
                error: resolved.error || 'Failed to resolve indexed module version',
            };
        }

        return {
            ok: true,
            value: mapVersionMetadata(resolved.value.artifact, {
                kind: 'indexed',
                moduleId: resolved.value.moduleId,
                version: resolved.value.version,
                publisher: index.publisher,
                sourceRef: input.sourceRef,
            }),
        };
    },
};

export function getDefaultModuleSourceAdapters(): ModuleSourceAdapter[] {
    return [localModuleSourceAdapter, indexedModuleSourceAdapter];
}

export function resolveModuleSource(
    adapters: ModuleSourceAdapter[],
    input: SourceResolveInput,
    context?: SourceResolutionContext
): SourceResolveResult {
    const adapter = adapters.find((candidate) => candidate.canHandle(input.sourceRef));
    if (!adapter) {
        return {
            ok: false,
            error: `No module source adapter found for source ref "${input.sourceRef}"`,
        };
    }

    return adapter.resolve(input, context);
}
