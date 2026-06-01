/**
 * Compendium pack config lookup for declared modules. Per ADR-0022 Phase 3,
 * this was carved out of the monolithic `server.ts`.
 *
 * Prefers the static `info.json` declaration when present; falls back to the
 * already-instantiated adapter's hook (no recursive adapter load).
 */
import type { CompendiumPackConfig } from '@shared/sdk';
import { hasCompendiumPackConfig } from './types';
import { pluginMap, adapterInstances } from './state';

export function getModuleCompendiumPackConfig(moduleId: string): CompendiumPackConfig | null {
    const id = moduleId.toLowerCase();
    const plugin = pluginMap.get(id);
    const manifestConfig = plugin?.info.compendiumPacks;
    if (manifestConfig?.packs?.length) return manifestConfig;

    // If the adapter is already instantiated, expose its pack config hook without
    // creating it here. That avoids recursive adapter initialization while still
    // letting ModuleRuntime use hook-declared packs after SystemService has
    // loaded the adapter.
    const adapter = adapterInstances.get(id);
    if (hasCompendiumPackConfig(adapter)) return adapter.getCompendiumPackConfig();
    return null;
}
