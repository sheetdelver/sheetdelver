interface FoundrySortable {
    name?: string;
    sort?: number;
}

interface FoundryPageIdentity extends FoundrySortable {
    id?: string;
    _id?: string;
}

/** UI affordance only; caller-bound Foundry writes remain authoritative. */
export function canEditJournalContent(
    user: { role?: number; _id?: string; id?: string } | null,
    journal: { ownership?: Record<string, number> } | null,
    page?: { ownership?: Record<string, number> },
): boolean {
    if (!user || !journal) return false;
    if ((user.role ?? 0) >= 4) return true;
    const id = user._id || user.id || '';
    if (!id) return false;
    const entryLevel = journal.ownership?.[id] ?? journal.ownership?.default ?? 0;
    if (!page) return entryLevel >= 3;
    if (entryLevel < 2) return false;
    const pageLevel = page.ownership?.[id] ?? page.ownership?.default ?? 0;
    return (pageLevel === -1 ? entryLevel : pageLevel) >= 3;
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

export function getJournalPageId(page: FoundryPageIdentity | undefined): string | null {
    return page?._id || page?.id || null;
}

/** Retain a selected page across refreshed payloads and ordering changes. */
export function resolveJournalPageSelection(
    pages: readonly FoundryPageIdentity[],
    selectedPageId: string | null,
): string | null {
    if (selectedPageId && pages.some(page => getJournalPageId(page) === selectedPageId)) {
        return selectedPageId;
    }
    return getJournalPageId(sortJournalPages(pages)[0]);
}
