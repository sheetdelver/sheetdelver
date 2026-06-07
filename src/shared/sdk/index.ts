// ---------------------------------------------------------------------------
// @sheet-delver/sdk — shared entry point (ADR-0027 decision 2).
//
// This barrel exposes ONLY environment-agnostic types and pure utilities. The
// client surface lives at `@sheet-delver/sdk/react`, the server runtime + route
// helpers at `@sheet-delver/sdk/server`, and the mock host at
// `@sheet-delver/sdk/testing`. Server-only exports are kept out of this barrel so
// they can never be pulled into a UI bundle.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Adapter contract — implement these to create a system module
// ---------------------------------------------------------------------------

export type {
    SystemAdapter,
    SystemThemeColors,
    SystemComponentStyles,
    ChatCard,
    ChatCardRoll,
    ChatCardButton,
} from './interfaces';

export type {
    FoundryActor,
    FoundryItem,
    FoundryDocument,
} from './interfaces';

export type {
    ActorSheetData,
    ActorCardData,
    ActorCardBlock,
} from './interfaces';

export type {
    UIModuleManifest,
    ModuleInfo,
    ModuleSettingDeclaration,
    ModuleManifestPaths,
    ModulePackageDeclaration,
    ModulePermissionDeclaration,
    ModuleTrustDeclaration,
    ModuleTrustTier,
    ModuleManifest,
    CompendiumPackConfig,
    CompendiumPackDeclaration,
    CompendiumPackDocumentType,
    RollMode,
    RollData,
    RollDataOptions,
} from './interfaces';

export { BaseSystemAdapter } from './base';

// ---------------------------------------------------------------------------
// Platform contracts — chat/session shapes
// ---------------------------------------------------------------------------

export type {
    ChatMessage,
    UserSession,
} from './contracts';

export type { ModuleLogger } from './logging';
export { logger, createModuleLogger, setModuleLogSink } from './logging';

// ---------------------------------------------------------------------------
// Structured error taxonomy — shared by routes (server) and hooks (client)
// ---------------------------------------------------------------------------

export { SdkError, isSdkError, SDK_ERROR_STATUS } from './errors';
export type { SdkErrorCode } from './errors';

// ---------------------------------------------------------------------------
// Utilities — error handling, HTML/image processing, dice, asset URLs
// ---------------------------------------------------------------------------

export {
    getErrorMessage,
    resolveImage,
    processHtmlContent,
    getSafeDescription,
    simulateRoll,
    simulateTableDraw,
    parseRollResult,
    buildModuleAssetUrl,
} from './utils';

export type {
    DrawResult,
    DrawResultRow,
} from './utils';

// ---------------------------------------------------------------------------
// Capability detection
// ---------------------------------------------------------------------------

export { capabilities, SDK_CAPABILITIES } from './capabilities';
export type { SdkCapability } from './capabilities';

// ---------------------------------------------------------------------------
// Version constants — matched against info.json compatibility.apiContracts
// ---------------------------------------------------------------------------

export const SDK_VERSION = '1.0.0';

export const API_CONTRACT_VERSIONS = {
    'module-api': '1.0.0',
    'ui-extension-api': '1.0.0',
    'roll-engine-api': '1.0.0',
} as const;
