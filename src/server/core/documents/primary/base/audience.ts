/**
 * Internal delivery audience for Store-backed realtime invalidations.
 * `all`, `users`, and `none` are deliberately distinct so an empty user set
 * can never be interpreted as a broadcast by a downstream gateway.
 */
export type DocumentAudience =
    | { kind: 'all' }
    | { kind: 'users'; userIds: string[] }
    | { kind: 'none' };

export const ALL_DOCUMENT_AUDIENCE: DocumentAudience = Object.freeze({ kind: 'all' });
export const NO_DOCUMENT_AUDIENCE: DocumentAudience = Object.freeze({ kind: 'none' });

export function documentAudienceForUsers(userIds: Iterable<string>): DocumentAudience {
    const unique = Array.from(new Set(userIds)).filter(Boolean).sort();
    return unique.length > 0 ? { kind: 'users', userIds: unique } : NO_DOCUMENT_AUDIENCE;
}

export function unionDocumentAudiences(
    ...audiences: DocumentAudience[]
): DocumentAudience {
    if (audiences.some(audience => audience.kind === 'all')) return ALL_DOCUMENT_AUDIENCE;
    const userIds = audiences.flatMap(audience => audience.kind === 'users' ? audience.userIds : []);
    return documentAudienceForUsers(userIds);
}

export function documentAudienceIncludes(
    audience: DocumentAudience | null | undefined,
    userId: string | null | undefined,
): boolean {
    if (!audience || audience.kind === 'none' || !userId) return false;
    return audience.kind === 'all' || audience.userIds.includes(userId);
}

export function isDocumentAudience(value: unknown): value is DocumentAudience {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as { kind?: unknown; userIds?: unknown };
    if (candidate.kind === 'all' || candidate.kind === 'none') return true;
    return candidate.kind === 'users'
        && Array.isArray(candidate.userIds)
        && candidate.userIds.length > 0
        && candidate.userIds.every(userId => typeof userId === 'string');
}
