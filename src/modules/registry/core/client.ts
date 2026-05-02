import { UIModuleManifest } from './types';
export * from './utils';
import React from 'react';
import { logger } from '@shared/utils/logger';

/**
 * Registry Client Instance
 * Note: The client-side registry doesn't perform filesystem discovery.
 * It relies on the server-provided systemId and uses dynamic import thunks.
 */

// We don't have a pluginMap on the client because discovery is a server-side task.
// Instead, we use a mapping of known systemIds to their UI thunks.
// This is populated by Next.js's dynamic import capabilities.
const manifestCache = new Map<string, UIModuleManifest>();

/**
 * JIT UI Manifest Loader (Browser-Safe)
 * Fetches the system's own UI manifest asynchronously.
 * Uses a directory-anchored relative path to ensure production bundler visibility.
 */
export async function getUIModule(systemId: string): Promise<UIModuleManifest | undefined> {
    const id = systemId.toLowerCase();
    
    if (manifestCache.has(id)) {
        return manifestCache.get(id);
    }

    try {
        // Scoping the import to the parent directory allows the bundler to 
        // auto-discover all system modules without us listing them.
        const m = await import(`../${id}/module/ui`);
        const manifest = m.default || m;
        
        manifestCache.set(id, manifest);
        return manifest;
    } catch (e) {
        logger.error(`Registry | Failed to load UI manifest for ${id}:`, e);
        return undefined;
    }
}
