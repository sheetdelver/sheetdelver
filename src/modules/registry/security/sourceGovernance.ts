import { logger } from '@shared/utils/logger';

/**
 * Checks if a URL is allowed by the host allowlist.
 *
 * @param url The URL to check
 * @param allowlist Array of allowed hostnames (e.g. ['registry.example.com'])
 * @param mode 'production' or 'development'. In development, it only logs a warning if rejected.
 * @returns true if allowed or allowlist is undefined/empty, false if blocked
 */
export function isHostAllowed(url: string, allowlist?: string[], mode: 'production' | 'development' = 'production'): boolean {
    if (!allowlist || allowlist.length === 0) {
        return true; // Optional by default
    }

    try {
        const parsedUrl = new URL(url);
        const host = parsedUrl.hostname;

        const isAllowed = allowlist.some(allowedHost => {
            // Support wildcard subdomains (e.g., *.example.com)
            if (allowedHost.startsWith('*.')) {
                const baseDomain = allowedHost.slice(2);
                return host === baseDomain || host.endsWith(`.${baseDomain}`);
            }
            return host === allowedHost;
        });

        if (!isAllowed) {
            if (mode === 'development') {
                logger.warn(`Source Governance: Host "${host}" is not in the allowlist, but allowed in development mode.`);
                return true;
            }
            logger.warn(`Source Governance: Blocked request to "${host}" (not in allowlist).`);
            return false;
        }

        return true;
    } catch (error) {
        logger.error(`Source Governance: Failed to parse URL "${url}"`);
        return false;
    }
}
