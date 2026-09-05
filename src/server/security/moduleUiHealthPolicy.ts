import { ModuleSourceCategory, type ModuleSourceCategory as ModuleSource } from '@shared/types/modules';

export const MODULE_UI_HEALTH_LIMIT = 5;
export const MODULE_UI_HEALTH_WINDOW_MS = 60_000;

/** Flatten client error text before it enters persistent lifecycle state or logs. */
export function sanitizeModuleUiHealthText(value: unknown, fallback: string, maxLength: number): string {
    if (typeof value !== 'string') return fallback;
    const singleLine = value
        .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!singleLine) return fallback;
    return singleLine.slice(0, maxLength);
}

export function parseModuleUiHealthSource(value: unknown): ModuleSource | null {
    if (value === ModuleSourceCategory.Local || value === ModuleSourceCategory.Managed) return value;
    return null;
}

/** Small in-memory limiter scoped to one authenticated session and module. */
export class ModuleUiHealthRateLimiter {
    private readonly attempts = new Map<string, number[]>();

    public constructor(
        private readonly maxAttempts = MODULE_UI_HEALTH_LIMIT,
        private readonly windowMs = MODULE_UI_HEALTH_WINDOW_MS,
    ) {}

    public consume(sessionId: string, moduleId: string, now = Date.now()): boolean {
        const key = `${sessionId}:${moduleId}`;
        const cutoff = now - this.windowMs;
        const current = (this.attempts.get(key) ?? []).filter((timestamp) => timestamp > cutoff);
        if (current.length >= this.maxAttempts) {
            this.attempts.set(key, current);
            return false;
        }
        current.push(now);
        this.attempts.set(key, current);
        return true;
    }
}
