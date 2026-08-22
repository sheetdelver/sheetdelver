export interface AdminOriginInput {
    appOrigin: string;
    configuredOrigin?: unknown;
    env?: Readonly<Record<string, string | undefined>>;
}

export interface AdminOriginConfig {
    origin: string;
    host: string;
    secure: boolean;
}

/**
 * Resolve the browser-facing admin origin independently from the process bind
 * address. This supports a local reverse-proxy hostname without creating a
 * second browser application or listener.
 */
export function resolveAdminOrigin(input: AdminOriginInput): AdminOriginConfig {
    const env = input.env ?? process.env;
    const candidate = env.APP_ADMIN_ORIGIN ?? input.configuredOrigin ?? input.appOrigin;
    if (typeof candidate !== 'string' || !candidate.trim()) {
        throw new Error('Admin origin must be a non-empty absolute URL');
    }

    let url: URL;
    try {
        url = new URL(candidate);
    } catch {
        throw new Error('Admin origin must be a valid absolute URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Admin origin must use http or https');
    }
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
        throw new Error('Admin origin must contain only scheme, hostname, and optional port');
    }

    return {
        origin: url.origin,
        host: url.host.toLowerCase(),
        secure: url.protocol === 'https:',
    };
}

/** Host matching gates whether the main shell exposes its admin route graph. */
export function isAdminRequestHostAllowed(hostHeader: string | null, expectedOrigin: string): boolean {
    if (!hostHeader) return false;
    const [firstHost] = hostHeader.split(',');
    return firstHost.trim().toLowerCase() === new URL(expectedOrigin).host.toLowerCase();
}
