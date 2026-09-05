import type { FoundryDocumentAction } from './FoundrySocketEvents';

const DOCUMENT_ACTIONS = new Set<FoundryDocumentAction>(['get', 'create', 'update', 'delete']);

type UnknownRecord = Record<string, unknown>;

export interface FoundryDocumentResponseFallback {
    type?: string;
    action?: FoundryDocumentAction | string;
    operation?: unknown;
}

export interface NormalizedFoundryDocumentResult {
    source: 'single' | 'batch';
    index: number;
    type: string | null;
    action: FoundryDocumentAction | null;
    operation?: UnknownRecord;
    result: unknown;
    sideEffect: boolean;
    error?: unknown;
    malformedReason?: string;
}

/**
 * Converts supported Foundry single and batch response envelopes into one
 * ordered shape. The optional fallback describes the initiating request and is
 * used only for the primary entry; side effects must identify themselves.
 */
export function normalizeFoundryDocumentResponse(
    response: unknown,
    fallback: FoundryDocumentResponseFallback = {},
): NormalizedFoundryDocumentResult[] {
    const envelope = toRecord(response);
    const hasResultsEnvelope = Boolean(envelope && Object.hasOwn(envelope, 'results'));

    if (hasResultsEnvelope && !Array.isArray(envelope!.results)) {
        return [malformedEnvelopeResult('Batch response has a non-array results field')];
    }

    const source = hasResultsEnvelope ? 'batch' : 'single';
    const entries = hasResultsEnvelope ? envelope!.results as unknown[] : [response];

    return entries.map((entry, index) => {
        const raw = toRecord(entry);
        if (!raw) {
            return {
                source,
                index,
                type: null,
                action: null,
                result: undefined,
                sideEffect: false,
                malformedReason: 'Document response entry is not an object',
            };
        }

        // A request fallback can repair a terse primary acknowledgement, but
        // applying it to side effects would misroute an under-specified entry.
        const entryFallback = index === 0 ? fallback : {};
        const type = readNonEmptyString(raw.type) ?? readNonEmptyString(entryFallback.type);
        const actionValue = readNonEmptyString(raw.action) ?? readNonEmptyString(entryFallback.action);
        const action = isDocumentAction(actionValue) ? actionValue : null;
        const operation = mergeOperations(entryFallback.operation, raw.operation);
        const malformed: string[] = [];

        if (!type) malformed.push('missing document type');
        if (!action) malformed.push(actionValue ? `unsupported action "${actionValue}"` : 'missing document action');

        return {
            source,
            index,
            type,
            action,
            operation,
            result: raw.result,
            sideEffect: raw.sideEffect === true,
            ...(raw.error == null ? {} : { error: raw.error }),
            ...(malformed.length === 0 ? {} : { malformedReason: malformed.join('; ') }),
        };
    });
}

export function isPackScopedDocumentResult(result: NormalizedFoundryDocumentResult): boolean {
    return Boolean(result.operation?.pack);
}

function malformedEnvelopeResult(reason: string): NormalizedFoundryDocumentResult {
    return {
        source: 'batch',
        index: 0,
        type: null,
        action: null,
        result: undefined,
        sideEffect: false,
        malformedReason: reason,
    };
}

function mergeOperations(fallback: unknown, response: unknown): UnknownRecord | undefined {
    const fallbackOperation = toRecord(fallback);
    const responseOperation = toRecord(response);

    if (!fallbackOperation) return responseOperation;
    if (!responseOperation) return fallbackOperation;
    return { ...fallbackOperation, ...responseOperation };
}

function toRecord(value: unknown): UnknownRecord | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return value as UnknownRecord;
}

function readNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function isDocumentAction(value: string | null): value is FoundryDocumentAction {
    return value !== null && DOCUMENT_ACTIONS.has(value as FoundryDocumentAction);
}
