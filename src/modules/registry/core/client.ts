import { UIModuleManifest } from './types';
export * from './utils';
import React from 'react';

/**
 * Platform default manifest — always available, no file lookup required.
 * Used when no system-specific module is registered or when the system is 'generic'.
 * External modules override this by providing their own sheet/actorPage in UIModuleManifest.
 */
const PLATFORM_DEFAULT_MANIFEST: UIModuleManifest = {
    info: { id: 'generic', title: 'Generic System' },
    sheet:     () => import('@client/ui/components/GenericSheet'),
    actorPage: () => import('@client/ui/pages/GenericActorPage'),
};

const manifestCache = new Map<string, UIModuleManifest>();

/**
 * JIT UI Manifest Loader (Browser-Safe)
 * Returns the system's UIModuleManifest. Falls back to the platform default when:
 *  - systemId is 'generic' (explicit default request)
 *  - No module file is registered for the system
 *  - The module file fails to load
 */
export async function getUIModule(systemId: string): Promise<UIModuleManifest> {
    const id = systemId.toLowerCase();

    if (id === 'generic') return PLATFORM_DEFAULT_MANIFEST;

    if (manifestCache.has(id)) return manifestCache.get(id)!;

    try {
        const m = await import(`@modules/${id}/module/ui`);
        const manifest = m.default || m;
        manifestCache.set(id, manifest);
        return manifest;
    } catch (e) {
        console.warn(`[Registry] Failed to load UI manifest for "${id}":`, e);
        return PLATFORM_DEFAULT_MANIFEST;
    }
}
