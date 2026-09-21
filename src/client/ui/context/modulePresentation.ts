import type { AppSystemInfo } from '@shared/interfaces';
import type { UIModuleManifest } from '@shared/sdk';

/** Overlay executable UI styles locally, leaving the wire snapshot unchanged. */
export function applyModulePresentation(
    system: AppSystemInfo | null,
    manifest: UIModuleManifest | null,
): AppSystemInfo | null {
    if (!system || !manifest || system.id !== manifest.info.id) return system;
    if (!manifest.theme && !manifest.componentStyles) return system;
    return {
        ...system,
        theme: manifest.theme ?? system.theme,
        componentStyles: manifest.componentStyles ?? system.componentStyles,
        config: {
            ...system.config,
            componentStyles: manifest.componentStyles ?? system.config?.componentStyles,
        },
    };
}
