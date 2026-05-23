import { ServerConnectionStatus } from '../types/connection';
import type { SystemComponentStyles } from '@shared/sdk';

export type { ServerConnectionStatus };

// Re-export SDK types used broadly in the platform client
// so existing @shared/interfaces import paths continue to resolve
// during the migration period.
export type {
    SystemAdapter,
    UIModuleManifest,
    ActorCardData,
    ActorCardBlock,
    ActorSheetData,
    CompendiumPackConfig,
    CompendiumPackDeclaration,
    RollMode,
    SystemThemeColors,
    SystemComponentStyles,
} from '@shared/sdk';

// ---------------------------------------------------------------------------
// Platform-internal types — not part of the module SDK
// ---------------------------------------------------------------------------

export interface AppSystemInfo {
    id: string | null;
    title?: string;
    version?: string;
    appVersion?: string;
    worldTitle?: string;
    worldBackground?: string;
    worldDescription?: string | null;
    nextSession?: string | null;
    isLoggedIn?: boolean;
    background?: string;
    users?: { active: number; total: number; list?: any[] };
    status?: string;
    worlds?: any[];
    theme?: any;
    config?: any;
    componentStyles?: SystemComponentStyles;
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

export interface SystemConfig {
    id: string;
    title: string;
    [key: string]: any;
}

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
        allowLiveCompendiumUuidFallback?: boolean;
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
        adminSetupToken?: string;
        adminPepper?: string;
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
