// ---------------------------------------------------------------------------
// @sheet-delver/sdk/react — client entry point (ADR-0027 decision 2).
//
// The full client surface a module's UI consumes: the SDK context/components,
// the data + sheet hooks, the document cache types, the realtime event bus, and
// the platform component/hook prop interfaces. Safe for UI bundles (no server code).
// ---------------------------------------------------------------------------

export {
    useSDK,
    useSDKComponents,
    SDKContext,
    SDKComponentsContext,
} from './react';

export type {
    SDKContextValue,
    SDKComponentsValue,
    ModuleClientLogger,
    RealtimeActorChangedPayload,
} from './react';

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

// Platform-provided component + hook prop interfaces (documentation surface).
export type {
    LoadingModalProps,
    RollDialogProps,
    ConfirmationModalProps,
    SharedContentModalProps,
    RichTextEditorProps,
    UseFoundry,
    UseUI,
    UseNotifications,
    UseConfig,
} from './ui';
