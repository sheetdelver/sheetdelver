/** A persisted chat acknowledgement, not an evaluated roll or synthetic result. */
export function isPostedChatMessage(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const message = value as Record<string, unknown>;
    return typeof message._id === 'string' && !!message._id
        && typeof message.author === 'string'
        && Array.isArray(message.rolls)
        && message._synthetic !== true;
}
