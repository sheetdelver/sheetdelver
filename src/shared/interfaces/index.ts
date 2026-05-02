import { ServerConnectionStatus } from '../types/connection';

export type { ServerConnectionStatus };

export interface AppSystemInfo {
    id: string | null;
    title?: string;
    version?: string;
    appVersion?: string;
    worldTitle?: string;
    worldBackground?: string;
    worldDescription?: string | null;
    nextSession?: string | null;
    /**
     * Auth state is separate from connection status. 
     * true = user is explicitly logged in. 
     * false = guest or unauthenticated.
     */
    isLoggedIn?: boolean;
    background?: string;
    users?: { active: number; total: number; list?: any[] };
    status?: string;
    worlds?: any[];
    theme?: any;
    config?: any;
    componentStyles?: SystemAdapter['componentStyles'];
}

export interface FoundrySystemMeta {
    id: string;
    title: string;
    version: string;
}

export interface User {
    id?: string;
    _id?: string;
    name: string;
    active?: boolean;
    isGM?: boolean;
    role?: number;
    color?: string;
    characterName?: string;
}

export interface Combatant {
    tokenId: string;
    sceneId: string;
    actorId: string;
    actor: any;
    hidden: boolean;
    _id: string;
    type: string;
    system: any;
    img: string | null;
    initiative: number;
    defeated: boolean;
    group: string | null;
    flags: any;
    _stats: any;
}

export interface Combat {
    id: string;
    _id?: string;
    type: string;
    system: any;
    scene: string | null;
    groups: any[];
    combatants: Combatant[];
    round: number;
    turn: number;
    sort: number;
    flags: any;
    stats: any;
}

export type ConnectionStep = 'init' | 'reconnecting' | 'login' | 'dashboard' | 'setup' | 'startup' | 'authenticating' | 'initializing' | 'world-closed';


export interface ActorCardBlock {
    title: string;
    value: string | number;
    subValue?: string | number;
    valueClass?: string;
}

export interface ActorCardData {
    name?: string;
    img?: string;
    subtext?: string;
    blocks?: ActorCardBlock[];
    /**
     * UI-specific footer content. 
     * Refined as ReactNode in the client layer.
     */
    footer?: any | string;
}

export interface ActorSheetData {
    id: string;
    name: string;
    type: string;
    img: string;
    system?: any;
    items?: any[];
    effects?: any[];
    derived?: any;
    [key: string]: any;
}

/**
 * System configuration provided to the UI.
 */
export interface SystemConfig {
    id: string;
    title: string;
    [key: string]: any;
}

/**
 * Core application configuration.
 */
export interface AppConfig {
    app: {
        host: string;
        port: number;
        apiPort: number;
        protocol: string;
        chatHistory: number;
        version: string;
        url: string;
    };
    foundry: {
        host: string;
        port: number;
        protocol: string;
        url: string;
        username?: string;
        password?: string;
        userId?: string;
        connector?: string;
        foundryDataDirectory?: string;
    };
    debug: {
        enabled: boolean;
        level: number;
    };
    security: {
        rateLimit: {
            enabled: boolean;
            windowMinutes: number;
            maxAttempts: number;
        };
        bodyLimit: string;
        serviceToken?: string;
        adminSetupToken?: string; // One-time token for bootstrap setup
        adminPepper?: string; // Optional pepper for admin password hashing
        modulePolicy: {
            minimumTrustTier: 'first-party' | 'verified-third-party' | 'unverified';
            allowUnverifiedInDevelopment: boolean;
            requireAdminOverrideForLowerTrust: boolean;
            requirePermissionEscalationApproval: boolean;
        };
        sourceGovernance?: {
            hostAllowlist?: string[];
        };
        cors: {
            allowAllOrigins: boolean;
            allowedOrigins: string[];
        };
    };
}

export type RollMode = 'publicroll' | 'gmroll' | 'blindroll' | 'selfroll';

export interface PackDiscoveryConfig {
    id: string;
    type: 'Item' | 'Actor' | 'JournalEntry' | 'Scene' | 'Macro';
    hydrate: boolean;
    fields?: string[];
}

export interface DiscoveryConfig {
    packs: PackDiscoveryConfig[];
}

/**
 * Interface that all RPG system adapters must implement.
 */
export interface SystemAdapter {
    systemId: string;
    normalizeActorData(actor: any, client?: any): ActorSheetData;
    getRollData(actor: any, type: string, key: string, options?: { rollMode?: RollMode;[key: string]: any }): any;
    match(actor: any): boolean;
    renderNavigation?: boolean;
    getSystemData(client: any, options?: { minimal?: boolean }): Promise<any>;
    /**
     * Optional: Provide data requirements for the Core Discovery Service.
     * The service will use this to sync and hydrate compendium packs.
     */
    getDiscoveryConfig?(): DiscoveryConfig;

    /**
     * Optional: Perform asynchronous initialization for the adapter.
     * Use this for tasks like cache warming, pre-fetching data, or setup.
     */
    initialize?(client: any): Promise<void>;
    postCreate?(client: any, actorId: string, sourceData: any): Promise<void>;
    getActor?(client: any, actorId: string): Promise<any>;
    resolveDocument?(client: any, uuid: string): Promise<any | null>;
    resolveActorNames?(actor: any, cache: any): void | Promise<void>;
    loadSupplementaryData?(cache: any): Promise<void>;
    expandTableResults?(client: any, table: any): Promise<any[] | null>;
    validateUpdate?(path: string, value: any): boolean;
    getActorCardData?(actor: any): ActorCardData;
    /**
     * Optional: Calculate derived/computed stats from normalized actor data.
     * Called by the core /api/actors/:id endpoint after normalizeActorData.
     * Use this for values derived from system data (HP totals, AC, encumbrance, etc.)
     */
    computeActorData?(actor: any): any;
    /**
     * Optional: Categorize items by type for easier UI rendering.
     * Called by the core /api/actors/:id endpoint after normalizeActorData.
     * Return an object with named arrays (e.g. { weapons: [], armor: [], spells: [] })
     */
    categorizeItems?(actor: any): any;
    /**
     * Optional: Generate a stylized HTML roll card for chat evaluation.
     */
    generateRollCard?(actor: any, results: any): string;
    /**
     * Optional: Return the initiative formula for a given actor.
     * If not provided, the core system defaults to '1d20'.
     */
    getInitiativeFormula?(actor: any): string;
    /**
     * Optional: Perform an automated roll sequence (e.g. Attack/Defend loop).
     * This moves system-specific logic out of the core server.
     */
    performAutomatedSequence?(client: any, actor: any, rollData: any, options: any): Promise<any>;
    theme?: {
        bg?: string;
        panelBg?: string;
        text?: string;
        accent?: string;
        button?: string;
        headerFont?: string;
        input?: string;
        success?: string;
    };
    componentStyles?: {
        chat?: {
            container?: string;
            header?: string;
            msgContainer?: (isRoll: boolean) => string;
            user?: string;
            time?: string;
            flavor?: string;
            content?: string;
            rollResult?: string;
            rollFormula?: string;
            rollTotal?: string;
            button?: string;
            buttonText?: string;
            buttonValue?: string;
            scrollButton?: string;
            inputContainer?: string;
            inputField?: string;
            sendBtn?: string;
        };
        diceTray?: {
            container?: string;
            header?: string;
            textarea?: string;
            clearBtn?: string;
            diceRow?: string;
            diceBtn?: string;
            modGroup?: string;
            modBtn?: string;
            advGroup?: string;
            advBtn?: (active: boolean, type: 'normal' | 'adv' | 'dis') => string;
            sendBtn?: string;
            helpText?: string;
            button?: string;
            input?: string;
        };
        modal?: {
            overlay?: string;
            container?: string;
            header?: string;
            title?: string;
            body?: string;
            footer?: string;
            confirmBtn?: (isDanger?: boolean) => string;
            cancelBtn?: string;
            closeBtn?: string;
        };
        rollDialog?: {
            overlay?: string;
            container?: string;
            header?: string;
            title?: string;
            body?: string;
            inputGroup?: string;
            label?: string;
            input?: string;
            footer?: string;
            rollBtn?: (mode: 'normal' | 'adv' | 'dis') => string;
            closeBtn?: string;
            select?: string;
            selectArrow?: string;
        };
        loadingModal?: {
            overlay?: string;
            container?: string;
            spinner?: string;
            text?: string;
        };
        globalChat?: {
            window?: string;
            header?: string;
            title?: string;
            diceWindow?: string;
            chatWindow?: string;
            toggleBtn?: (isOpen: boolean, isDice?: boolean) => string;
            closeBtn?: string;
        };
    };
}

/**
 * Browser-safe manifest for system UI components.
 * This should NEVER import Adapter classes.
 * Refined with specific React types in the client layer.
 */
export interface UIModuleManifest {
    info: {
        id: string;
        title: string;
    };
    sheet: (() => Promise<any>) | any;
    rollModal?: (() => Promise<any>) | any;
    actorPage?: (() => Promise<any>) | any;
    tools?: Record<string, (() => Promise<any>) | any>;
    dashboardTools?: (() => Promise<any>) | any;
    dashboardLoading?: any;
}

/**
 * Full manifest for pluggable system modules.
 * Includes the Adapter class for server-side logic.
 */
export interface ModuleManifest extends UIModuleManifest {
    adapter: new () => SystemAdapter;
}
