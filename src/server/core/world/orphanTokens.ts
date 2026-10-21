import { isRecord } from '../documents/primary/base/PrimaryDocumentStore';

/** Foundry BaseActorDelta.applyDelta returns null when the base Actor is absent. */
export function isOrphanToken(token: Record<string, unknown>, actorIds: ReadonlySet<string>): boolean {
    return typeof token.actorId === 'string' && token.actorId.length > 0 && !actorIds.has(token.actorId);
}

export function tokenDisplayName(source: Record<string, unknown>, fallback: string): string {
    return typeof source.name === 'string' && source.name.trim() ? source.name.trim() : fallback;
}

export function tokenRows(scene: Record<string, unknown>): Record<string, unknown>[] {
    return Array.isArray(scene.tokens) ? scene.tokens.filter(isRecord) : [];
}
