import { lazy, type LazyExoticComponent, type ComponentType } from 'react';
import type { ModuleSettingsTab, ModuleSettingsTabProps } from '@shared/sdk';

type Loader = ModuleSettingsTab['load'];
type Panel = LazyExoticComponent<ComponentType<ModuleSettingsTabProps>>;

// Cache component definitions only. Each mounted panel still owns its form state,
// SDK context and abort signal. Weak keys do not retain retired module loaders.
let panels = new WeakMap<Loader, Panel>();

export function getSettingsPanel(load: Loader): Panel {
    const cached = panels.get(load);
    if (cached) return cached;
    const cache = panels;
    const panel = lazy(() => Promise.resolve().then(load).catch(error => {
        // A failed import must be retryable. An obsolete promise cannot evict a
        // replacement created by Retry or a source/session change.
        if (cache.get(load) === panel) cache.delete(load);
        throw error;
    }));
    cache.set(load, panel);
    return panel;
}

export function forgetSettingsPanel(load: Loader): void {
    panels.delete(load);
}

export function clearSettingsPanelCache(): void {
    panels = new WeakMap();
}
