/**
 * Category labels for module sources.
 * Used to distinguish between built-in modules, managed data-directory modules,
 * and local developer overrides.
 */
export const ModuleSourceCategory = {
    Local: 'local',
    Managed: 'data',
    BuiltIn: 'built-in'
} as const;

export type ModuleSourceCategory = typeof ModuleSourceCategory[keyof typeof ModuleSourceCategory];

/**
 * Origin types for module distribution.
 * Distinguishes between local files, indexed repositories, and direct URLs.
 */
export const ModuleSourceKind = {
    Local: 'local',
    Indexed: 'indexed',
    Direct: 'direct'
} as const;

export type ModuleSourceKind = typeof ModuleSourceKind[keyof typeof ModuleSourceKind];

/**
 * Current lifecycle state of a module in the registry.
 */
export const ModuleLifecycleStatus = {
    Discovered: 'discovered',
    Installed: 'installed',
    Validated: 'validated',
    Enabled: 'enabled',
    Disabled: 'disabled',
    Incompatible: 'incompatible',
    Errored: 'errored',
    Upgrading: 'upgrading',
    Uninstalling: 'uninstalling',
    Removed: 'removed'
} as const;

export type ModuleLifecycleStatus = typeof ModuleLifecycleStatus[keyof typeof ModuleLifecycleStatus];

/**
 * Trust classification for modules based on their origin and signature.
 */
export const ModuleTrustTier = {
    FirstParty: 'first-party',
    VerifiedThirdParty: 'verified-third-party',
    Unverified: 'unverified',
    Untrusted: 'untrusted'
} as const;

export type ModuleTrustTier = typeof ModuleTrustTier[keyof typeof ModuleTrustTier];

/**
 * Operations that can be performed by the Module Manager.
 */
export const ManagerAction = {
    Install: 'install',
    Uninstall: 'uninstall',
    Upgrade: 'upgrade',
    Validate: 'validate',
    Enable: 'enable',
    Disable: 'disable'
} as const;

export type ManagerAction = typeof ManagerAction[keyof typeof ManagerAction];

/**
 * Standardized outcomes for manager operations and dry-runs.
 */
export const ManagerOutcome = {
    Allow: 'allow',
    Block: 'block',
    Success: 'success',
    Failure: 'failure',
    Error: 'error'
} as const;

export type ManagerOutcome = typeof ManagerOutcome[keyof typeof ManagerOutcome];

/**
 * Types of dependency or conflict violations.
 */
export const DependencyViolationType = {
    MissingDependency: 'missing-dependency',
    UnmetDependency: 'unmet-dependency',
    ConflictingModule: 'conflicting-module',
    HasDependents: 'has-dependents'
} as const;

export type DependencyViolationType = typeof DependencyViolationType[keyof typeof DependencyViolationType];

/**
 * Known platform contract identifiers.
 */
export const CoreContractName = {
    ModuleApi: 'module-api',
    UiExtensionApi: 'ui-extension-api',
    RollEngineApi: 'roll-engine-api'
} as const;

export type CoreContractName = typeof CoreContractName[keyof typeof CoreContractName];

/**
 * Status of artifact verification.
 */
export const ArtifactVerificationStatus = {
    Verified: 'verified',
    Failed: 'failed',
    Skipped: 'skipped'
} as const;

export type ArtifactVerificationStatus = typeof ArtifactVerificationStatus[keyof typeof ArtifactVerificationStatus];

/**
 * Types of UI notifications.
 */
export const NotificationType = {
    Info: 'info',
    Success: 'success',
    Error: 'error'
} as const;

export type NotificationType = typeof NotificationType[keyof typeof NotificationType];
