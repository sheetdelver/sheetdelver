export type FoundryDocumentAction = 'get' | 'create' | 'update' | 'delete';

export interface FoundryModifyDocumentEvent {
    response?: unknown;
    type?: string;
    action?: FoundryDocumentAction | string;
    result?: unknown;
    operation?: unknown;
}

export interface FoundryDocumentDispatchConfirmedEvent {
    response?: unknown;
    fallback?: {
        type?: string;
        action?: FoundryDocumentAction | string;
        operation?: unknown;
    };
    type?: string;
    action?: FoundryDocumentAction | string;
    result?: unknown;
    operation?: unknown;
}

export interface FoundryModifyDocumentBatchEvent {
    response: unknown;
}

export interface FoundryAutosaveEvent {
    uuid: string;
    html: string;
}

export interface FoundryManageCompendiumEvent {
    response: unknown;
}

export interface FoundryDocumentCompatibilityEvent {
    type: string;
    action: FoundryDocumentAction | string;
    result: unknown;
    operation?: unknown;
}

export interface FoundryShareImageEvent {
    data: {
        image?: string;
        title?: string;
    };
}

export interface FoundryShowEntryEvent {
    uuid: string;
    args: unknown[];
}

export interface FoundryUserConnectedEvent {
    user: unknown;
}

export interface FoundryUserDisconnectedEvent {
    data: unknown;
}

export interface FoundryUserActivityEvent {
    userId: string;
    data: unknown;
}

export interface FoundryRuntimeTeardownEvent {
    reason: string;
}

export interface FoundryBootstrapSnapshot {
    gameData: any;
    sceneData?: any | null;
}

export interface FoundryHandshakeResult {
    csrfToken: string | null;
    isSetupMatch: boolean;
    pageTitle: string;
}

export interface FoundryWorldTitleDetectedEvent {
    pageTitle: string;
}

export interface FoundryWorldDiscoveredEvent {
    world: any;
    userCount: number;
}

export interface FoundryServiceAccountMissingEvent {
    username: string;
    worldTitle?: string;
    availableUsers: string[];
}

export interface FoundryTransportDisconnectedEvent {
    reason: string;
}

export interface FoundryTransportErrorEvent {
    message: string;
}

export interface FoundryProgressEvent {
    data: unknown;
}
