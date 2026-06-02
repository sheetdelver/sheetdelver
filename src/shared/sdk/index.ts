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
// Platform contracts — chat/session shapes used by route handlers
// ---------------------------------------------------------------------------

export type {
    ChatMessage,
    UserSession,
} from './contracts';

// ---------------------------------------------------------------------------
// Module runtime — injected into adapter initialize() (and module route factories)
// ---------------------------------------------------------------------------

export type {
    ModuleRuntime,
    ModuleRequestRuntime,
    DataStore,
    CompendiumPackReader,
    ReadonlyDocumentStore,
    DocumentStore,
    DocumentQuery,
    DocumentListResult,
    DocumentOpOptions,
    ModuleOwnershipLevel,
    RollResult,
    RollRuntime,
    TableRuntime,
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
    ModuleRouteTable,
    ModuleServerExport,
    ModuleAccessContext,
} from './server';

export { json, error } from './server';

// Structured error taxonomy
export { SdkError, isSdkError, SDK_ERROR_STATUS } from './errors';
export type { SdkErrorCode } from './errors';

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
    parseRollResult,
    buildModuleAssetUrl,
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

export type {
    ClientDocumentSource,
    ClientDocumentMutations,
    DocumentSnapshot,
    ClientDocumentError,
} from './client-documents';

export type {
    SdkEvents,
    SdkSignal,
    SdkSignalPayloads,
    SdkSignalHandler,
    DocumentChangeAction,
} from './events';

export {
    useDocument,
    useDocumentMutation,
    useActorSheet,
    useModuleSettings,
    createActorPage,
} from './client-hooks';

export type {
    ActorSheetProps,
    ActorPageProps,
    UseActorSheetResult,
    ModuleSettings,
} from './client-hooks';

// ---------------------------------------------------------------------------
// Version constants — matched against info.json compatibility.apiContracts
// ---------------------------------------------------------------------------

export { capabilities, SDK_CAPABILITIES } from './capabilities';
export type { SdkCapability } from './capabilities';

export const SDK_VERSION = '1.0.0';

export const API_CONTRACT_VERSIONS = {
    'module-api': '1.0.0',
    'ui-extension-api': '1.0.0',
    'roll-engine-api': '1.0.0',
} as const;
