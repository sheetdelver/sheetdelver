import rateLimit from 'express-rate-limit';
import type { AppConfig } from '@shared/interfaces';

export function createLoginLimiter(config: AppConfig) {
    return rateLimit({
        windowMs: config.security.rateLimit.windowMinutes * 60 * 1000,
        max: config.security.rateLimit.maxAttempts,
        message: {
            error: `Too many login attempts. Please try again after ${config.security.rateLimit.windowMinutes} minutes.`
        },
        standardHeaders: true,
        legacyHeaders: false,
        skip: () => !config.security.rateLimit.enabled,
    });
}

export function createAdminLoginLimiter(config: AppConfig) {
    const { windowMinutes, maxAttempts } = getAdminLoginRateLimitSettings(config);

    return rateLimit({
        windowMs: windowMinutes * 60 * 1000,
        max: maxAttempts,
        message: {
            error: `Too many admin login attempts. Please try again after ${windowMinutes} minutes.`
        },
        standardHeaders: true,
        legacyHeaders: false,
        skip: () => !config.security.rateLimit.enabled,
    });
}

export function createCspReportLimiter(config: AppConfig) {
    return rateLimit({
        windowMs: 60 * 1000,
        max: 60,
        message: { error: 'Too many CSP reports.' },
        standardHeaders: true,
        legacyHeaders: false,
        // Keep the project-wide rate-limit switch authoritative in development.
        skip: () => !config.security.rateLimit.enabled,
    });
}

export function getAdminLoginRateLimitSettings(config: AppConfig): { windowMinutes: number; maxAttempts: number } {
    const windowMinutes = Math.max(1, Math.floor(config.security.rateLimit.windowMinutes));
    const maxAttempts = Math.max(1, Math.floor(config.security.rateLimit.maxAttempts / 2));

    return { windowMinutes, maxAttempts };
}
