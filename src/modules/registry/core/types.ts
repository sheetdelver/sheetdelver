import { SystemAdapter, UIModuleManifest, type ModuleInfo } from '@shared/sdk';
import type { DiscoveryConfig } from '@shared/sdk';
export type { ModuleLifecycleRecord, ModuleLifecycleStatus, ModuleLifecycleStore } from '../lifecycle/lifecycle';
export type { ModuleCompatibilityResult, ModuleValidationResult } from '../lifecycle/validation';
import { ModuleSourceCategory, ModuleTrustTier } from '@shared/types/modules';

export type { ModuleTrustTier };
export type { ModulePermissionDeclaration } from '@shared/sdk';

export interface ModuleTrustDeclaration {
    tier: ModuleTrustTier;
}

export interface SystemModuleInfo extends Omit<ModuleInfo, 'trust'> {
    trust?: ModuleTrustDeclaration;
}

/**
 * Registry Plugin Metadata
 * Defines how a discovered system module is represented in memory.
 */

export type ModuleSource = ModuleSourceCategory;

export interface SystemPlugin {
    info: SystemModuleInfo;
    directory: string;
    source: ModuleSource;
    getLogic: () => Promise<any>;
    getUI: () => Promise<any>;
    getServer?: () => Promise<any>;
}

export interface DiscoveryConfigProviderAdapter {
    getDiscoveryConfig(): DiscoveryConfig;
}

export interface InitializableAdapter {
    initialize(context: import('@shared/sdk').ModuleContext): Promise<void>;
}

export function hasDiscoveryConfig(
    adapter: SystemAdapter | null
): adapter is SystemAdapter & DiscoveryConfigProviderAdapter {
    return typeof adapter?.getDiscoveryConfig === 'function';
}

export function hasInitialize(
    adapter: SystemAdapter | null
): adapter is SystemAdapter & InitializableAdapter {
    return typeof adapter?.initialize === 'function';
}

export type { SystemAdapter, UIModuleManifest };
