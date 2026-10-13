import type { NotificationAPI } from './notifications';
import type { UserSession } from './contracts';
import type { SystemComponentStyles } from './interfaces';

// ---------------------------------------------------------------------------
// Platform component prop interfaces
// Types for components the platform provides that modules may render.
// Implementations stay in src/client/ui/components/.
// ---------------------------------------------------------------------------

export interface LoadingModalProps {
    message?: string;
    theme?: SystemComponentStyles['loadingModal'];
}

export interface SheetRollDialogProps {
    isOpen: boolean;
    title: string;
    type: 'attack' | 'ability' | 'spell';
    actor?: unknown;
    defaults?: {
        abilityBonus?: number;
        itemBonus?: number;
        talentBonus?: number;
        showItemBonus?: boolean;
        advantageMode?: 'normal' | 'advantage' | 'disadvantage';
    };
    onConfirm: (options: {
        abilityBonus: number;
        itemBonus: number;
        talentBonus: number;
        rollingMode: string;
        advantageMode: 'normal' | 'advantage' | 'disadvantage';
        manualValue?: number;
    }) => void;
    onClose: () => void;
    theme?: SystemComponentStyles['rollDialog'];
}

export type InitiativeRollChoice =
    | { kind: 'roll'; advantageMode: 'normal' | 'advantage' | 'disadvantage' }
    | { kind: 'manual'; total: number };

/** Core owns formula resolution and transport; module overrides present only. */
export interface InitiativeRollModalProps {
    isOpen: boolean;
    type: 'initiative';
    title: string;
    combatantName: string;
    formula: string;
    source: 'module' | 'gm' | 'core';
    rollAvailable: boolean;
    advantageAvailable: boolean;
    manualAvailable: boolean;
    audience: 'public' | 'gm';
    onConfirm: (choice: InitiativeRollChoice) => void;
    onClose: () => void;
    theme?: SystemComponentStyles['rollDialog'];
}

export type RollDialogProps = SheetRollDialogProps | InitiativeRollModalProps;

export interface ConfirmationModalProps {
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    isDanger?: boolean;
    onConfirm: () => void | Promise<void>;
    onCancel: () => void;
    theme?: SystemComponentStyles['modal'];
}

export interface SharedContentModalProps {
    type: 'image' | 'journal' | null;
    data?: {
        url?: string;
        title?: string;
        id?: string;
        [key: string]: unknown;
    };
    onClose: () => void;
}

export interface RichTextEditorProps {
    content: string;
    onChange: (content: string) => void;
    placeholder?: string;
    className?: string;
    minHeight?: number;
}

// ---------------------------------------------------------------------------
// Platform hook interfaces
// Describe the shape of hooks the platform injects into the module UI context.
// ---------------------------------------------------------------------------

/**
 * Describes what useFoundry() provides to module UI components.
 * appSocket and activeUIModule are excluded — these are platform-shell concerns.
 */
export interface UseFoundry {
    /** @deprecated Non-secret session-readiness marker; use fetchWithAuth for requests. */
    token: string | null;
    currentUser: UserSession | null;
    system: {
        id: string | null;
        title?: string;
        config?: Record<string, unknown>;
        [key: string]: unknown;
    } | null;
    isConnected: boolean;
    baseUrl: string;
}

/** Describes what useUI() provides — dice tray and chat sidebar state. */
export interface UseUI {
    isDiceTrayOpen: boolean;
    toggleDiceTray: () => void;
    isChatOpen: boolean;
    setChatOpen: (open: boolean) => void;
}

/** Notification methods supplied by useSDK(); there is no separate public hook. */
export type UseNotifications = NotificationAPI;

/**
 * Describes what useConfig() provides — the Foundry base URL and image resolver.
 * Used to resolve relative image paths and HTML content from Foundry to full URLs.
 */
export interface UseConfig {
    /** The base URL of the connected Foundry instance, if known. */
    foundryUrl?: string;
    /** Set the Foundry base URL (called when the platform receives actor/system data). */
    setFoundryUrl: (url: string) => void;
    /** Resolve a relative image path to a full URL using the current foundryUrl. */
    resolveImageUrl: (path: string) => string;
}
