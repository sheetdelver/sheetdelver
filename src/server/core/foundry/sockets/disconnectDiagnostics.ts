type SocketRole = 'core' | 'player';

const KNOWN_REASONS = new Set([
    'io server disconnect',
    'io client disconnect',
    'ping timeout',
    'transport close',
    'transport error',
]);

function safeDetail(value: unknown): string | null {
    const text = typeof value === 'string'
        ? value.trim()
        : typeof value === 'number' && Number.isFinite(value)
            ? String(value)
            : '';
    if (!text || text.length > 120 || !/^[\w .,:;()/-]+$/.test(text)
        || text.includes('://') || /(?:cookie|token|session|password|authorization)/i.test(text)) {
        return null;
    }
    return text;
}

/** Allowlisted operational facts only; never persist details.context. */
export function formatDisconnectDiagnostic(input: {
    role: SocketRole;
    generation: number;
    connectedAt: number | null;
    now: number;
    reason: unknown;
    transport: unknown;
    details?: unknown;
}): string {
    const details = input.details && typeof input.details === 'object'
        ? input.details as { message?: unknown; description?: unknown }
        : {};
    const reason = typeof input.reason === 'string' && KNOWN_REASONS.has(input.reason)
        ? input.reason : 'other';
    const transport = input.transport === 'websocket' || input.transport === 'polling'
        ? input.transport : 'unknown';
    const ageMs = input.connectedAt === null ? 'unknown'
        : String(Math.max(0, Math.floor(input.now - input.connectedAt)));
    const message = safeDetail(details.message);
    const description = safeDetail(details.description);
    return `Foundry socket | role=${input.role}, generation=${input.generation}, ageMs=${ageMs}, transport=${transport}, reason=${reason}`
        + (message ? `, detail=${message}` : '')
        + (description ? `, description=${description}` : '');
}
