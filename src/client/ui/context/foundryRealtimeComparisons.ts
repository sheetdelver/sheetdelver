import type { User } from '@shared/interfaces';
import type { RealtimeSharedContentPayload } from '@shared/contracts/realtime';

type SeenPairs = WeakMap<object, WeakSet<object>>;

function isObject(value: unknown): value is object {
    return typeof value === 'object' && value !== null;
}

function markSeen(a: object, b: object, seen: SeenPairs): boolean {
    const seenForA = seen.get(a);
    if (seenForA?.has(b)) return true;

    if (seenForA) {
        seenForA.add(b);
    } else {
        seen.set(a, new WeakSet([b]));
    }

    return false;
}

export function areJsonLikeEqual(a: unknown, b: unknown, seen: SeenPairs = new WeakMap()): boolean {
    if (Object.is(a, b)) return true;
    if (!isObject(a) || !isObject(b)) return false;

    if (markSeen(a, b, seen)) return true;

    const aIsArray = Array.isArray(a);
    const bIsArray = Array.isArray(b);
    if (aIsArray || bIsArray) {
        if (!aIsArray || !bIsArray) return false;
        if (a.length !== b.length) return false;
        return a.every((value, index) => areJsonLikeEqual(value, b[index], seen));
    }

    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;

    for (const key of aKeys) {
        if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
        if (!areJsonLikeEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], seen)) {
            return false;
        }
    }

    return true;
}

export function areSystemInfoEqual(current: unknown, next: unknown): boolean {
    return areJsonLikeEqual(current, next ?? null);
}

export function areUsersEqual(current: readonly User[], next: unknown): boolean {
    return areJsonLikeEqual(current, next ?? []);
}

export function areSharedContentEqual(
    current: RealtimeSharedContentPayload | null,
    next: RealtimeSharedContentPayload | null,
): boolean {
    return areJsonLikeEqual(current, next);
}
