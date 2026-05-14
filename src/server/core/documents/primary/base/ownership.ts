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

export const DOCUMENT_VISIBILITY = {
    LIST_VISIBLE: DocumentOwnershipLevel.LIMITED,
    CARD_VISIBLE: DocumentOwnershipLevel.LIMITED,
    DETAIL_VISIBLE: DocumentOwnershipLevel.OBSERVER,
    WRITEABLE: DocumentOwnershipLevel.OWNER,
} as const;

export function getEffectiveOwnership(
    ownership: DocumentOwnershipMap | undefined,
    subject: DocumentAccessSubject,
    resolveInherited?: () => ResolvedDocumentOwnershipLevel,
): ResolvedDocumentOwnershipLevel {
    if (subject.role >= FoundryUserRole.GAMEMASTER) return DocumentOwnershipLevel.OWNER;

    const level = ownership?.[subject.userId] !== undefined
        ? ownership[subject.userId]!
        : ownership?.default ?? DocumentOwnershipLevel.NONE;

    if (level !== DocumentOwnershipLevel.INHERIT) return level;
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
