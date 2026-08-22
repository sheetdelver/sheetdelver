const MODULE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/**
 * Canonical module IDs are lowercase ASCII slugs. Normalizing case preserves
 * legacy callers while separators, dots, whitespace, Unicode, and drive paths
 * fail before an ID reaches registry state or filesystem resolution.
 */
export function parseModuleId(value: unknown): string | null {
    if (typeof value !== 'string' || value.length === 0 || value.length > 64) return null;
    const normalized = value.toLowerCase();
    return MODULE_ID_PATTERN.test(normalized) ? normalized : null;
}

export function requireModuleId(value: unknown, fieldName = 'moduleId'): string {
    const moduleId = parseModuleId(value);
    if (!moduleId) throw new TypeError(`${fieldName} must be a valid module ID`);
    return moduleId;
}

/** Module entry paths are portable, relative, slash-separated paths only. */
export function isSafeModuleRelativePath(value: unknown): value is string {
    if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || value.includes('\0') || value.startsWith('/')) {
        return false;
    }
    return value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}
