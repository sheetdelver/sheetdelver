import { ModuleRuntime } from './runtime';
import { ModuleFoundryClient } from './contracts';
import { CompendiumPackReader } from './runtime';

// ---------------------------------------------------------------------------
// Foundry document primitives
// ---------------------------------------------------------------------------

export interface FoundryDocument extends Record<string, unknown> {
    _id: string;
    name: string;
    type: string;
    img: string | null;
    system: Record<string, unknown>;
    flags?: Record<string, unknown>;
    ownership?: Record<string, number>;
    _stats?: {
        systemId?: string;
        systemVersion?: string;
        coreVersion?: string;
        createdTime?: number;
        modifiedTime?: number;
        lastModifiedBy?: string;
        [key: string]: unknown;
    };
}

export interface FoundryActor extends FoundryDocument {
    items: FoundryItem[];  // always present but may be empty
    effects?: unknown[];
    folder?: string | null;
}

export interface FoundryItem extends FoundryDocument {
    parent: string | null;
}

// ---------------------------------------------------------------------------
// Actor data shapes
// ---------------------------------------------------------------------------

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
    footer?: unknown;
}

export interface ActorSheetData {
    id: string;
    name: string;
    type: string;
    img: string;
    system: Record<string, unknown>;
    items: FoundryItem[];
    effects?: unknown[];
    derived: Record<string, unknown>;
    [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Roll types
// ---------------------------------------------------------------------------

export type RollMode = 'publicroll' | 'gmroll' | 'blindroll' | 'selfroll';

export interface RollDataOptions {
    rollMode?: RollMode;
    speaker?: { actor?: string; alias?: string };
    [key: string]: unknown;
}

export interface RollData {
    formula?: string;
    label?: string;
    flags?: unknown;
    isAutomated?: boolean;
    [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Compendium packs
// ---------------------------------------------------------------------------

export const CompendiumPackDocumentType = {
    Item: 'Item',
    Actor: 'Actor',
    JournalEntry: 'JournalEntry',
    Scene: 'Scene',
    Macro: 'Macro',
    RollTable: 'RollTable',
} as const;

export type CompendiumPackDocumentType =
    typeof CompendiumPackDocumentType[keyof typeof CompendiumPackDocumentType];

export interface CompendiumPackDeclaration {
    id: string;
    type: CompendiumPackDocumentType;
    hydrate: boolean;
    fields?: string[];
}

export interface CompendiumPackConfig {
    packs: CompendiumPackDeclaration[];
}

// ---------------------------------------------------------------------------
// Module info.json manifest
// ---------------------------------------------------------------------------

export type ModuleTrustTier = 'first-party' | 'verified-third-party' | 'unverified';

export interface ModuleTrustDeclaration {
    tier: ModuleTrustTier;
}

export interface ModulePermissionDeclaration {
    network?: {
        outbound?: boolean;
        allowHosts?: string[];
    };
    filesystem?: {
        read?: string[];
        write?: string[];
    };
    adminRoutes?: boolean;
    sensitiveData?: string[];
}

export interface ModuleManifestPaths {
    ui: string;
    logic: string;
    server?: string;
}

export interface ModulePackageDeclaration {
    include?: string[];
}

export interface ModuleInfo {
    id: string;
    title: string;
    version?: string;
    aliases?: string[];
    experimental?: boolean;
    trust?: ModuleTrustDeclaration;
    permissions?: ModulePermissionDeclaration;
    compatibility?: {
        coreVersion?: string;
        apiContracts?: Record<string, string>;
    };
    manifest: ModuleManifestPaths;
    compendiumPacks?: CompendiumPackConfig;
    package?: ModulePackageDeclaration;
    dependencies?: string[];
    conflicts?: string[];
}

// ---------------------------------------------------------------------------
// Theming
// ---------------------------------------------------------------------------

export interface SystemThemeColors {
    bg?: string;
    panelBg?: string;
    text?: string;
    accent?: string;
    button?: string;
    headerFont?: string;
    input?: string;
    success?: string;
    [key: string]: string | undefined;
}

export interface SystemComponentStyles {
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
}

// ---------------------------------------------------------------------------
// SystemAdapter — the contract between modules and the platform
// ---------------------------------------------------------------------------

export interface SystemAdapter {
    // --- Identity ---
    systemId: string;

    // --- Required: core always calls these ---
    normalizeActorData(actor: FoundryActor, client?: ModuleFoundryClient): ActorSheetData;
    match(actor: FoundryActor): boolean;

    // --- Optional: core calls if present (all verified by runtime grep) ---
    initialize?(runtime: ModuleRuntime): Promise<void>;
    getSystemData?(client: ModuleFoundryClient, options?: { minimal?: boolean }): Promise<unknown>;
    getCompendiumPackConfig?(): CompendiumPackConfig;
    getActorCardData?(actor: FoundryActor): ActorCardData;
    computeActorData?(actor: ActorSheetData): Record<string, unknown>;
    categorizeItems?(actor: ActorSheetData): Record<string, FoundryItem[]>;
    getRollData?(actor: FoundryActor, type: string, key: string, options?: RollDataOptions): RollData | null;
    performAutomatedSequence?(client: ModuleFoundryClient, actor: FoundryActor, rollData: RollData, options: unknown): Promise<unknown>;
    resolveActorNames?(actor: FoundryActor, packs: CompendiumPackReader): void | Promise<void>;
    getInitiativeFormula?(actor: FoundryActor): string;
    validateUpdate?(path: string, value: unknown): boolean;

    // --- Visual theming ---
    theme?: SystemThemeColors;
    componentStyles?: SystemComponentStyles;
}

// ---------------------------------------------------------------------------
// UI module manifest
// ---------------------------------------------------------------------------

export interface UIModuleManifest {
    info: ModuleInfo;
    sheet: () => Promise<{ default: unknown }>;
    rollModal?: () => Promise<{ default: unknown }>;
    actorPage?: () => Promise<{ default: unknown }>;
    tools?: Record<string, () => Promise<{ default: unknown }>>;
    dashboardTools?: () => Promise<{ default: unknown }>;
    dashboardLoading?: unknown;
    /**
     * Path to a CSS file relative to the module root (e.g. "assets/styles.css").
     * The platform injects this as a <link rel="stylesheet"> when the module mounts.
     * The file must be present in the module's assets/ directory.
     */
    stylesheet?: string;
}

export interface ModuleManifest extends UIModuleManifest {
    adapter: new () => SystemAdapter;
}
