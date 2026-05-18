export enum DocumentOwnershipLevel {
    INHERIT = -1,
    NONE = 0,
    LIMITED = 1,
    OBSERVER = 2,
    OWNER = 3,
}

export type ResolvedDocumentOwnershipLevel =
    | DocumentOwnershipLevel.NONE
    | DocumentOwnershipLevel.LIMITED
    | DocumentOwnershipLevel.OBSERVER
    | DocumentOwnershipLevel.OWNER;

export enum FoundryUserRole {
    NONE = 0,
    PLAYER = 1,
    TRUSTED = 2,
    ASSISTANT = 3,
    GAMEMASTER = 4,
}

export type UserId = string;
export type DocumentOwnershipMap = Partial<Record<string, DocumentOwnershipLevel>> & {
    default?: DocumentOwnershipLevel;
};

export interface DocumentAccessSubject {
    userId: UserId;
    role: FoundryUserRole;
}

// Shared thresholds keep route, realtime, and SDK-wrapper authorization aligned.
// CARD_VISIBLE is reserved for a future card-projection split off LIST_VISIBLE.
// Today both bands resolve to LIMITED; the constant exists so a future product
// decision can diverge the dashboard-card threshold from the list threshold
// in one place without touching call sites.
export const DOCUMENT_VISIBILITY = {
    LIST_VISIBLE: DocumentOwnershipLevel.LIMITED,
    CARD_VISIBLE: DocumentOwnershipLevel.LIMITED,
    DETAIL_VISIBLE: DocumentOwnershipLevel.OBSERVER,
    WRITEABLE: DocumentOwnershipLevel.OWNER,
} as const;

/**
 * Strict GAMEMASTER check. Used by Store `resolveOwnership` short-circuits
 * where Foundry's implicit OWNER grant applies. ASSISTANT does NOT pass —
 * ASSISTANT GMs have moderation authority but not full ownership override.
 */
export function isGM(subject: DocumentAccessSubject): boolean {
    return subject.role >= FoundryUserRole.GAMEMASTER;
}

/**
 * GM-like check for permission-elevated contexts. Returns true for ASSISTANT
 * and GAMEMASTER. Used where Foundry treats ASSISTANT as GM-equivalent: chat
 * blind/whisper unmasking, journal world-list visibility, combat turn
 * advancement, world-config writes. Distinct from {@link isGM} which is the
 * narrower implicit-OWNER grant on `resolveOwnership` short-circuits.
 */
export function isAssistantGM(subject: DocumentAccessSubject): boolean {
    return subject.role >= FoundryUserRole.ASSISTANT;
}

export function getEffectiveOwnership(
    ownership: DocumentOwnershipMap | undefined,
    subject: DocumentAccessSubject,
    resolveInherited?: () => ResolvedDocumentOwnershipLevel,
): ResolvedDocumentOwnershipLevel {
    // Foundry treats GMs as effective owners even if the ownership map says otherwise.
    if (isGM(subject)) return DocumentOwnershipLevel.OWNER;

    const level = ownership?.[subject.userId] !== undefined
        ? ownership[subject.userId]!
        : ownership?.default ?? DocumentOwnershipLevel.NONE;

    if (level !== DocumentOwnershipLevel.INHERIT) return level;
    // Actor folder inheritance is not cached yet, so callers can opt into a resolver later.
    return resolveInherited?.() ?? DocumentOwnershipLevel.NONE;
}

export function createDocumentAccessSubject(
    userId: string | null | undefined,
    role: number | null | undefined,
): DocumentAccessSubject | null {
    if (!userId) return null;
    return {
        userId,
        role: typeof role === 'number' ? role : FoundryUserRole.NONE,
    };
}
