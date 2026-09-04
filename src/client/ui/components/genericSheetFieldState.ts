export type GenericPrimitiveValue = string | number | boolean | null | undefined;

export interface GenericPrimitiveEditState {
    draft: string;
    originalValue: GenericPrimitiveValue;
    dirty: boolean;
}

export interface GenericPrimitiveCommit {
    changed: boolean;
    value: GenericPrimitiveValue;
}

function toDraftValue(value: GenericPrimitiveValue): string {
    return value === null || value === undefined ? '' : String(value);
}

export function beginPrimitiveEdit(value: GenericPrimitiveValue): GenericPrimitiveEditState {
    return {
        draft: toDraftValue(value),
        originalValue: value,
        dirty: false,
    };
}

export function updatePrimitiveDraft(
    state: GenericPrimitiveEditState,
    draft: string,
): GenericPrimitiveEditState {
    return { ...state, draft, dirty: true };
}

export function commitPrimitiveEdit(state: GenericPrimitiveEditState): GenericPrimitiveCommit {
    let value: GenericPrimitiveValue = state.draft;
    if (typeof state.originalValue === 'number') {
        const numericValue = Number(state.draft);
        value = Number.isFinite(numericValue) ? numericValue : state.originalValue;
    } else if (typeof state.originalValue === 'boolean') {
        value = state.draft.trim().toLowerCase() === 'true';
    }

    return {
        // Focus and blur are never mutations. A write requires user input that
        // also differs from the value captured when editing began.
        changed: state.dirty && !Object.is(value, state.originalValue),
        value,
    };
}

const MULTILINE_FIELD_NAMES = new Set([
    'background',
    'biography',
    'connections',
    'content',
    'description',
    'notes',
]);

export function shouldUseMultilineField(value: GenericPrimitiveValue, path: string): boolean {
    if (typeof value !== 'string') return false;
    const fieldName = path.split('.').at(-1)?.toLowerCase();
    return value.includes('\n')
        || value.length >= 80
        || /<\/?[a-z][^>]*>/i.test(value)
        || (fieldName !== undefined && MULTILINE_FIELD_NAMES.has(fieldName));
}
