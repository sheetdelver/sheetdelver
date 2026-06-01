// ---------------------------------------------------------------------------
// Adapter contract — implement these to create a system module
// ---------------------------------------------------------------------------

export type {
    SystemAdapter,
    SystemThemeColors,
    SystemComponentStyles,
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
// Platform client — injected into module server handlers
// ---------------------------------------------------------------------------

export type {
    ModuleFoundryClient,
    FoundryClient,     // @deprecated alias for ModuleFoundryClient
    ChatMessage,
    UserSession,
} from './contracts';

// ---------------------------------------------------------------------------
// Module runtime — injected into adapter initialize() (and module route factories)
// ---------------------------------------------------------------------------

export type {
    ModuleRuntime,
    DataStore,
    CompendiumPackReader,
} from './runtime';

export type { ModuleLogger } from './logging';

// ---------------------------------------------------------------------------
// Server API surface — type module/server.ts apiRoutes with these
// ---------------------------------------------------------------------------

export type {
    ModuleServerRequest,
    ModuleServerParams,
    ModuleServerResponse,
    ModuleRouteHandler,
    ModuleServerExport,
} from './server';

// ---------------------------------------------------------------------------
// UI component contracts — prop interfaces for platform-provided components
// ---------------------------------------------------------------------------

export type {
    LoadingModalProps,
    RollDialogProps,
    ConfirmationModalProps,
    SharedContentModalProps,
    RichTextEditorProps,
} from './ui';

export type {
    UseFoundry,
    UseUI,
    UseNotifications,
    UseConfig,
} from './ui';

// ---------------------------------------------------------------------------
// Utilities — error handling, HTML/image processing, dice simulation
// ---------------------------------------------------------------------------

export {
    getErrorMessage,
    resolveImage,
    processHtmlContent,
    getSafeDescription,
    simulateRoll,
    simulateTableDraw,
} from './utils';

export type {
    DrawResult,
    DrawResultRow,
} from './utils';

// ---------------------------------------------------------------------------
// Client-side SDK hooks — for use in module UI components
// ---------------------------------------------------------------------------

export { useSDK, useSDKComponents, SDKContext, SDKComponentsContext } from './react';

export type {
    SDKContextValue,
    SDKComponentsValue,
    ModuleClientLogger,
    RealtimeActorChangedPayload,
} from './react';

// ---------------------------------------------------------------------------
// Version constants — matched against info.json compatibility.apiContracts
// ---------------------------------------------------------------------------

export const SDK_VERSION = '1.0.0';

export const API_CONTRACT_VERSIONS = {
    'module-api': '1.0.0',
    'ui-extension-api': '1.0.0',
    'roll-engine-api': '1.0.0',
} as const;
