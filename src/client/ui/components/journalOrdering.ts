interface FoundrySortable {
    name?: string;
    sort?: number;
}

export type FoundryDirectorySortMode = 'a' | 'm';

function compareAlphabetically(a: FoundrySortable, b: FoundrySortable): number {
    return (a.name ?? '').localeCompare(b.name ?? '');
}

function compareManually(a: FoundrySortable, b: FoundrySortable): number {
    return (a.sort ?? 0) - (b.sort ?? 0);
}

/**
 * Reproduce Foundry's directory sibling ordering without mutating DTO arrays.
 * A folder's persisted sorting mode controls both its child folders and entries.
 */
export function sortDirectorySiblings<T extends FoundrySortable>(
    entries: readonly T[],
    mode: FoundryDirectorySortMode,
): T[] {
    return [...entries].sort(mode === 'a' ? compareAlphabetically : compareManually);
}

/** JournalEntryPage order is always its persisted numeric sort order. */
export function sortJournalPages<T extends FoundrySortable>(pages: readonly T[]): T[] {
    return [...pages].sort(compareManually);
}
