import { UIModuleManifest } from './types';
export * from './utils';
import React from 'react';

/**
 * Platform default manifest — always available, no file lookup required.
 * Used when no system-specific module is registered or when the system is 'generic'.
 */
const PLATFORM_DEFAULT_MANIFEST: UIModuleManifest = {
    info: { id: 'generic', title: 'Generic System' },
    sheet:     () => import('@client/ui/components/GenericSheet'),
    actorPage: () => import('@client/ui/pages/GenericActorPage'),
};

// Keyed by systemId. Cleared by invalidateModuleSourceCache() on source switches.
const manifestCache = new Map<string, UIModuleManifest>();

// ─── Source-aware loading ──────────────────────────────────────────────────────
//
// Module UI files live in one of two locations on disk, each mapped to a
// separate webpack alias in next.config.ts:
//
//   @local-modules  →  data/local/modules/<id>/module/ui   (local dev source)
//   @modules        →  src/modules OR data/modules/<id>/module/ui  (built-in / managed install)
//
// The server tracks which source is currently active for each module in the
// lifecycle store. GET /api/registry/sources returns the full map so the
// browser can pick the right alias at import time.
//
// When an admin switches a module's active source, the server emits a
// 'moduleSourceChanged' socket event. FoundryContext and ActorPageRouter both
// listen for this event, call invalidateModuleSourceCache(), and re-resolve —
// giving clients an in-place reload without a full page refresh.

// Populated lazily on first getUIModule call; reset by invalidateModuleSourceCache().
let activeSources: Record<string, string> | null = null;

async function fetchActiveSources(): Promise<Record<string, string>> {
    if (activeSources) return activeSources;
    try {
        const res = await fetch('/api/registry/sources');
        if (res.ok) activeSources = await res.json();
    } catch {
        // Network failure — fall back to the managed/built-in alias for all modules.
    }
    return activeSources ?? {};
}

/**
 * Clears the cached active-source map and all cached manifests so the next
 * getUIModule call re-fetches from the server and reimports the module file.
 *
 * Called by:
 *  - FoundryContext on 'moduleSourceChanged' socket event (global cache bust)
 *  - ActorPageRouter on 'moduleSourceChanged' (before re-resolving its own module)
 *  - ModuleLifecycleControl after a successful switch-source API call (admin panel)
 */
export function invalidateModuleSourceCache() {
    activeSources = null;
    manifestCache.clear();
}

/**
 * JIT UI Manifest Loader (Browser-Safe)
 *
 * Resolves the UIModuleManifest for a system, respecting whichever source the
 * server has marked active. Import alias selection:
 *   'local'    → @local-modules/<id>/module/ui  (TypeScript source in data/local/modules)
 *   'data'     → @modules/<id>/module/ui        (managed install in data/modules)
 *   'built-in' → @modules/<id>/module/ui        (platform module in src/modules)
 *
 * Both aliases are understood by webpack/turbopack and bundled at build time,
 * so switching between them at runtime only changes which already-bundled chunk
 * is executed — no dynamic filesystem access occurs in the browser.
 *
 * Falls back to PLATFORM_DEFAULT_MANIFEST when the module file cannot be found.
 */
export async function getUIModule(systemId: string): Promise<UIModuleManifest> {
    const id = systemId.toLowerCase();

    if (id === 'generic') return PLATFORM_DEFAULT_MANIFEST;

    if (manifestCache.has(id)) return manifestCache.get(id)!;

    const sources = await fetchActiveSources();
    const source = sources[id];

    // Local dev source takes priority when the server has it marked active.
    if (source === 'local') {
        try {
            const m = await import(`@local-modules/${id}/module/ui`);
            const manifest = m.default || m;
            manifestCache.set(id, manifest);
            return manifest;
        } catch (e) {
            console.warn(`[Registry] Failed to load local UI manifest for "${id}":`, e);
            // Fall through to the managed alias below.
        }
    }

    // Managed install or built-in — try the TypeScript source convention first
    // (module/ui.tsx), then the compiled artifact convention (dist/ui.js).
    // The packaging script produces dist/ui.js; source-mode modules use module/ui.tsx.
    // Both patterns are registered as webpack require-contexts so Turbopack
    // can bundle whichever one exists on disk.
    try {
        const m = await import(`@modules/${id}/module/ui`);
        const manifest = m.default || m;
        manifestCache.set(id, manifest);
        return manifest;
    } catch {
        // module/ui not found — try the compiled artifact path.
    }
    try {
        const m = await import(`@modules/${id}/dist/ui`);
        const manifest = m.default || m;
        manifestCache.set(id, manifest);
        return manifest;
    } catch (e) {
        console.warn(`[Registry] Failed to load UI manifest for "${id}" (tried module/ui and dist/ui):`, e);
    }

    return PLATFORM_DEFAULT_MANIFEST;
}
