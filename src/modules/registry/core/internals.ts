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
import { validateModuleIndexDocument, type ModuleIndexDocument } from '../distribution/moduleIndex';
import type { SystemPlugin } from './types';
import type { ModuleLifecycleRecord } from '../lifecycle/lifecycle';
import { lifecycleStore } from './state';
import { logger } from '@shared/utils/logger';

export const LIFECYCLE_STATE_FILE_ENV = 'SHEET_DELVER_MODULE_STATE_FILE';
export const ARTIFACT_STATE_FILE_ENV = 'SHEET_DELVER_MODULE_ARTIFACT_FILE';
export const MANIFEST_FAIL_OPEN_ENV = 'SHEET_DELVER_MANIFEST_FAIL_OPEN';
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

export async function buildSourceResolutionContext(sourceRef: string): Promise<{ ok: true; context?: SourceResolutionContext } | { ok: false; error: string }> {
    if (!sourceRef.startsWith('index://')) {
        return { ok: true };
    }

    const indexFilePath = process.env[MODULE_INDEX_FILE_ENV];
    if (indexFilePath && indexFilePath.trim()) {
        try {
            const raw = fs.readFileSync(indexFilePath, 'utf8');
            const parsed = JSON.parse(raw) as ModuleIndexDocument;
            const validation = validateModuleIndexDocument(parsed);
            if (!validation.valid) {
                return {
                    ok: false,
                    error: `Index document is invalid: ${validation.errors.join('; ')}`,
                };
            }

            return {
                ok: true,
                context: {
                    indexes: {
                        [sourceRef]: parsed,
                    },
                },
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
                ok: false,
                error: `Failed to load module index from ${indexFilePath}: ${message}`,
            };
        }
    }

    try {
        const { loadSourceProfiles } = await import('../distribution/sourceProfiles');
        const { fetchRemoteIndex } = await import('../distribution/remoteIndexFetcher');
        const { isHostAllowed } = await import('../security/sourceGovernance');
        const { getConfig: loadConfig } = await import('../../../server/core/config');

        const config = loadConfig();
        const allowlist = config?.security?.sourceGovernance?.hostAllowlist ?? [];
        const mode = process.env.NODE_ENV === 'production' ? 'production' : 'development';

        const profiles = loadSourceProfiles().filter(p => p.enabled && p.kind === 'indexed');

        const indexes: Record<string, ModuleIndexDocument> = {};
        for (const profile of profiles) {
            if (!isHostAllowed(profile.baseUrl, allowlist, mode)) {
                logger.error(`[Registry] Skipping source profile "${profile.name}" due to governance violation (host not allowed)`);
                continue;
            }

            const result = await fetchRemoteIndex(profile.baseUrl, { auth: profile.auth });
            if (result.ok && result.index) {
                indexes[profile.baseUrl] = result.index;
                if (sourceRef === 'index://' || sourceRef === profile.baseUrl || profile.baseUrl.includes(sourceRef.replace('index://', ''))) {
                    if (sourceRef === 'index://') {
                        if (!indexes[sourceRef]) {
                            indexes[sourceRef] = { ...result.index, modules: { ...result.index.modules } };
                        } else {
                            Object.assign(indexes[sourceRef].modules, result.index.modules);
                        }
                    } else {
                        indexes[sourceRef] = result.index;
                    }
                }
            }
        }

        return { ok: true, context: { indexes } };
    } catch {
        return { ok: false, error: 'Failed to fetch remote indexes' };
    }
}

export async function resolveManagedSource(moduleId: string, sourceRef: string, targetVersion?: string): Promise<{ ok: true; value: ModuleSourceResolution } | { ok: false; error: string }> {
    const contextResult = await buildSourceResolutionContext(sourceRef);
    if (!contextResult.ok) {
        return contextResult;
    }

    const resolved = resolveModuleSource(
        getDefaultModuleSourceAdapters(),
        {
            moduleId,
            sourceRef,
            targetVersion,
        },
        contextResult.context
    );

    if (!resolved.ok || !resolved.value) {
        return {
            ok: false,
            error: resolved.error || 'Failed to resolve module source',
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
    return lifecycleStore.modules[moduleId.toLowerCase()];
}

export function isModuleEnabledForRuntime(moduleId: string): boolean {
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
