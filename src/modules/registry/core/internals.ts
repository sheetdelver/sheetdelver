/**
 * Cross-cutting private helpers and env constants used by the registry's
 * thematic submodules. Per ADR-0022 Phase 3, these were carved out of the
 * monolithic `server.ts` so the satellite files (adapterResolution,
 * managedModules, moduleSources, lifecyclePreflight) can share them without
 * importing one another.
 *
 * Not exported from `@modules/registry/server` — these are internals.
 */
import path from 'node:path';
import { parseModuleId } from '@shared/security/moduleId';
import fs from 'node:fs';
import { getConfig } from '@server/core/config';
import {
    getDefaultModuleTrustPolicy,
    type ModuleTrustPolicyConfig,
} from '../security/trustPolicy';
import {
    getDefaultModuleSourceAdapters,
    resolveModuleSource,
    type ModuleSourceResolution,
    type SourceResolutionContext,
} from '../distribution/sourceAdapters';
import type { SystemPlugin } from './types';
import type { ModuleLifecycleRecord } from '../lifecycle/lifecycle';
import { lifecycleStore } from './state';
import {
    getRemoteModuleDistributionDenial,
    isRemoteModuleSourceRef,
} from '../security/remoteDistributionPolicy';

export const LIFECYCLE_STATE_FILE_ENV = 'SHEET_DELVER_MODULE_STATE_FILE';
export const ARTIFACT_STATE_FILE_ENV = 'SHEET_DELVER_MODULE_ARTIFACT_FILE';
export const MANIFEST_FAIL_OPEN_ENV = 'SHEET_DELVER_MANIFEST_FAIL_OPEN';
/** Historical test/config name retained so old settings fail closed, not open. */
export const MODULE_INDEX_FILE_ENV = 'SHEET_DELVER_MODULE_INDEX_FILE';

/** Resolve the actual file path for a module logic entry (adds extension if needed). */
export function resolveLogicPath(base: string): string {
    for (const ext of ['.ts', '.tsx', '.js', '.mjs']) {
        if (fs.existsSync(base + ext)) return base + ext;
    }
    return base;
}

/** Return the mtime (ms) of a logic file, 0 if unresolvable. */
export function getLogicMtime(plugin: SystemPlugin): number {
    try {
        const resolved = resolveLogicPath(path.join(plugin.directory, plugin.info.manifest.logic));
        return fs.statSync(resolved).mtimeMs;
    } catch {
        return 0;
    }
}

export function getLifecycleStateFilePathOverride(): string | undefined {
    const value = process.env[LIFECYCLE_STATE_FILE_ENV];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function getArtifactStateFilePathOverride(): string | undefined {
    const value = process.env[ARTIFACT_STATE_FILE_ENV];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export async function buildSourceResolutionContext(sourceRef: string): Promise<{ ok: true; context?: SourceResolutionContext } | { ok: false; error: string; errorCode?: string }> {
    if (isRemoteModuleSourceRef(sourceRef)) {
        // Reject before consulting the historical index-file environment value,
        // source profiles, configuration, dynamic imports, or network fetchers.
        const denial = getRemoteModuleDistributionDenial();
        return { ok: false, error: denial.message, errorCode: denial.code };
    }

    return { ok: true };
}

export async function resolveManagedSource(moduleId: string, sourceRef: string, targetVersion?: string): Promise<{ ok: true; value: ModuleSourceResolution } | { ok: false; error: string; errorCode?: string }> {
    const canonicalId = parseModuleId(moduleId);
    if (!canonicalId) {
        return { ok: false, error: 'Invalid module ID', errorCode: 'invalid-module-id' };
    }
    const contextResult = await buildSourceResolutionContext(sourceRef);
    if (!contextResult.ok) {
        return contextResult;
    }

    const resolved = resolveModuleSource(
        getDefaultModuleSourceAdapters(),
        {
            moduleId: canonicalId,
            sourceRef,
            targetVersion,
        },
        contextResult.context
    );

    if (!resolved.ok || !resolved.value) {
        return {
            ok: false,
            error: resolved.error || 'Failed to resolve module source',
            errorCode: resolved.errorCode,
        };
    }

    return {
        ok: true,
        value: resolved.value,
    };
}

export function isManifestFailOpenEnabled(): boolean {
    if (process.env.NODE_ENV === 'production') return false;
    return process.env[MANIFEST_FAIL_OPEN_ENV] === 'true';
}

export function getTrustPolicyConfig(): ModuleTrustPolicyConfig {
    try {
        const config = getConfig();
        return config.security.modulePolicy;
    } catch {
        return getDefaultModuleTrustPolicy(process.env);
    }
}

export function getLifecycleRecord(moduleId: string): ModuleLifecycleRecord | undefined {
    const id = parseModuleId(moduleId);
    return id ? lifecycleStore.modules[id] : undefined;
}

export function isModuleEnabledForRuntime(moduleId: string): boolean {
    if (!parseModuleId(moduleId)) return false;
    const record = getLifecycleRecord(moduleId);
    if (!record) return true;
    if (!record.enabled) return false;
    return record.status !== 'incompatible' && record.status !== 'errored';
}

export function getCoreVersion(): string {
    try {
        const packagePath = path.join(process.cwd(), 'package.json');
        const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { version?: unknown };
        return typeof packageJson.version === 'string' ? packageJson.version : '0.0.0';
    } catch {
        return '0.0.0';
    }
}
