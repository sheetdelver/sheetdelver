import type { RawMacro } from '@server/shared/types/documents';
import {
    PrimaryDocumentStore,
    type PrimaryDocumentType,
} from '../base/PrimaryDocumentStore';
import {
    DocumentOwnershipLevel,
    getEffectiveOwnership,
    type DocumentAccessSubject,
    type DocumentOwnershipMap,
    type ResolvedDocumentOwnershipLevel,
} from '../base/ownership';

/**
 * Macro primary-document Store. Full hydration + bootstrap seed.
 *
 * Visibility (per ADR-0013): standard `ownership` map — GMs short-circuit to
 * OWNER via `getEffectiveOwnership`; non-GM subjects read explicit user entry
 * or fall back to `ownership.default`. The `author` schema field is creator
 * attribution metadata only — NOT part of ownership resolution.
 *
 * No embedded children: macros are flat docs.
 */
export class MacroStore extends PrimaryDocumentStore<RawMacro> {
    public readonly documentType: PrimaryDocumentType = 'Macro';

    protected resolveOwnership(
        macro: RawMacro,
        subject: DocumentAccessSubject,
    ): ResolvedDocumentOwnershipLevel {
        const ownership = macro.ownership as DocumentOwnershipMap | undefined;
        return getEffectiveOwnership(ownership, subject);
    }

    public listByFolderIds(folderIds: Iterable<string | null>, options?: {
        subject?: DocumentAccessSubject;
        minOwnership?: ResolvedDocumentOwnershipLevel;
    }): RawMacro[] {
        const ids = new Set<string | null>();
        for (const id of folderIds) ids.add(id);

        const filterByFolder = (macros: RawMacro[]) =>
            macros.filter(macro => ids.has((macro.folder as string | null) ?? null));

        if (options?.subject) {
            const subject = options.subject;
            const threshold = options.minOwnership ?? DocumentOwnershipLevel.LIMITED;
            return filterByFolder(this.list({ subject, minOwnership: threshold }));
        }
        return filterByFolder(this.list());
    }

    /**
     * Subject-scoped lookup of macros authored by a given user. `author` is
     * creator attribution, not ownership — this method is a convenience for
     * UIs that want to project "my macros" without re-deriving the filter
     * on the caller side.
     */
    public listByAuthor(authorId: string, options?: {
        subject?: DocumentAccessSubject;
        minOwnership?: ResolvedDocumentOwnershipLevel;
    }): RawMacro[] {
        const all = options?.subject
            ? this.list({
                subject: options.subject,
                minOwnership: options.minOwnership ?? DocumentOwnershipLevel.LIMITED,
            })
            : this.list();
        return all.filter(macro => macro.author === authorId);
    }
}

export const macroStore = new MacroStore();
