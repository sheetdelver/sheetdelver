import type { UIModuleManifest } from './types';
import { ModuleSourceCategory, type ModuleSourceCategory as ModuleSource } from '@shared/types/modules';

export type UIModuleLoader = () => Promise<unknown>;

export interface UIModuleLoadFailure {
    source: ModuleSource;
    message: string;
    error?: unknown;
}

export interface UIModuleResolution {
    manifest?: UIModuleManifest;
    compiledStyles?: string;
    failure?: UIModuleLoadFailure;
}

interface ResolveUIModuleOptions {
    moduleId: string;
    source?: string;
    localLoader?: UIModuleLoader;
    managedLoader?: UIModuleLoader;
    loadManagedRuntime: UIModuleLoader;
}

function readManifest(moduleNamespace: unknown): UIModuleManifest {
    const namespace = moduleNamespace as { default?: UIModuleManifest };
    return namespace.default ?? moduleNamespace as UIModuleManifest;
}

/**
 * Resolves UI code only from the source selected by the server lifecycle state.
 * A failure may degrade to the platform UI, but must never cross into another
 * source because that can misattribute health and disable the wrong source.
 */
export async function resolveUIModuleForSource({
    moduleId,
    source,
    localLoader,
    managedLoader,
    loadManagedRuntime,
}: ResolveUIModuleOptions): Promise<UIModuleResolution> {
    if (source === ModuleSourceCategory.Local) {
        if (!localLoader) {
            return {
                failure: {
                    source: ModuleSourceCategory.Local,
                    message: `No bundled local UI manifest found for "${moduleId}"`,
                },
            };
        }

        try {
            return { manifest: readManifest(await localLoader()) };
        } catch (error) {
            return {
                failure: {
                    source: ModuleSourceCategory.Local,
                    message: `Failed to load local UI manifest for "${moduleId}"`,
                    error,
                },
            };
        }
    }

    if (source === ModuleSourceCategory.Managed) {
        // The static managed loader is retained for legacy generated registries.
        // Its runtime route is still the same managed source, so this fallback is safe.
        if (managedLoader) {
            try {
                return { manifest: readManifest(await managedLoader()) };
            } catch {
                // The runtime artifact below is the canonical managed load path.
            }
        }

        try {
            const moduleNamespace = await loadManagedRuntime();
            const compiledStyles = (moduleNamespace as { __sdCompiledStyles?: unknown }).__sdCompiledStyles;
            return {
                manifest: readManifest(moduleNamespace),
                compiledStyles: typeof compiledStyles === 'string' ? compiledStyles : undefined,
            };
        } catch (error) {
            return {
                failure: {
                    source: ModuleSourceCategory.Managed,
                    message: `Failed to load runtime UI manifest for "${moduleId}"`,
                    error,
                },
            };
        }
    }

    // Unknown lifecycle state is not permission to guess at a source.
    return {};
}
