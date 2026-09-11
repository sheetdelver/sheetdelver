import dns from 'node:dns/promises';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';

const JSON_CONTENT_TYPE = /^(?:application\/json|application\/[a-z0-9!#$&^_.+-]+\+json)(?:\s*;|$)/i;
const RELEASE_MANIFEST_CONTENT_TYPE = /^(?:application\/json|application\/[a-z0-9!#$&^_.+-]+\+json|application\/octet-stream)(?:\s*;|$)/i;
const ARCHIVE_CONTENT_TYPE = /^(?:application\/(?:gzip|x-gzip|octet-stream)|binary\/octet-stream)(?:\s*;|$)/i;

export const PUBLIC_DISTRIBUTION_LIMITS = Object.freeze({
    maxRedirects: 5,
    connectTimeoutMs: 5_000,
    responseTimeoutMs: 15_000,
    retries: 2,
    retryBackoffMs: 250,
    maxJsonBytes: 1024 * 1024,
});

export type PublicDistributionErrorCode =
    | 'invalid-url'
    | 'host-not-allowed'
    | 'unsafe-address'
    | 'redirect-error'
    | 'timeout'
    | 'network-error'
    | 'http-error'
    | 'response-too-large'
    | 'content-type-error'
    | 'malformed-json';

export class PublicDistributionError extends Error {
    readonly code: PublicDistributionErrorCode;
    readonly retryable: boolean;

    constructor(code: PublicDistributionErrorCode, message: string, retryable = false) {
        super(message);
        this.name = 'PublicDistributionError';
        this.code = code;
        this.retryable = retryable;
    }
}

export interface PublicDistributionPolicy {
    allowedHosts: string[];
    maxRedirects?: number;
    connectTimeoutMs?: number;
    responseTimeoutMs?: number;
    retries?: number;
    retryBackoffMs?: number;
}

export interface PublicDistributionFetchOptions {
    accept: string;
    maxBytes: number;
    contentType: 'json' | 'release-manifest' | 'archive';
}

export interface PublicDistributionJsonOptions {
    allowOctetStream?: boolean;
}

export interface PublicDistributionResponse {
    requestedUrl: string;
    finalUrl: string;
    statusCode: number;
    contentType: string;
    body: Buffer;
    redirectChain: string[];
}

export interface ResolvedDistributionAddress {
    address: string;
    family: 4 | 6;
}

interface DistributionHopResponse {
    statusCode: number;
    headers: IncomingHttpHeaders;
    body: Buffer;
}

export interface PublicDistributionDependencies {
    resolveAddresses?: (hostname: string) => Promise<ResolvedDistributionAddress[]>;
    requestHop?: (
        url: URL,
        address: ResolvedDistributionAddress,
        options: { accept: string; maxBytes: number; connectTimeoutMs: number; responseTimeoutMs: number },
    ) => Promise<DistributionHopResponse>;
    sleep?: (milliseconds: number) => Promise<void>;
}

const blockedIpv4Addresses = new BlockList();
const blockedIpv6Addresses = new BlockList();
for (const [network, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
] as const) {
    blockedIpv4Addresses.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
    ['::', 128],
    ['::1', 128],
    ['::', 96],
    ['::ffff:0:0', 96],
    ['64:ff9b:1::', 48],
    ['100::', 64],
    ['2001::', 32],
    ['2001:2::', 48],
    ['2001:10::', 28],
    ['2001:20::', 28],
    ['2001:db8::', 32],
    ['2002::', 16],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
] as const) {
    blockedIpv6Addresses.addSubnet(network, prefix, 'ipv6');
}

export function isPublicDistributionAddress(address: string): boolean {
    const family = isIP(address);
    if (family === 4) return !blockedIpv4Addresses.check(address, 'ipv4');
    if (family === 6) {
        if (address.toLowerCase().startsWith('::ffff:')) return false;
        return !blockedIpv6Addresses.check(address, 'ipv6');
    }
    return false;
}

function normalizeAllowedHost(value: string): string | null {
    const normalized = value.trim().toLowerCase().replace(/\.$/, '');
    if (!normalized || normalized.includes('/') || normalized.includes(':') || normalized.includes('@')) return null;
    const host = normalized.startsWith('*.') ? normalized.slice(2) : normalized;
    if (!host || host.startsWith('.') || host.endsWith('.') || host.includes('..')) return null;
    return normalized;
}

export function isDistributionHostAllowed(hostname: string, allowedHosts: string[]): boolean {
    const host = hostname.toLowerCase().replace(/\.$/, '');
    return allowedHosts.some((entry) => {
        const allowed = normalizeAllowedHost(entry);
        if (!allowed) return false;
        if (!allowed.startsWith('*.')) return host === allowed;
        const base = allowed.slice(2);
        return host === base || host.endsWith(`.${base}`);
    });
}

function parseDistributionUrl(value: string, allowedHosts: string[]): URL {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new PublicDistributionError('invalid-url', 'Distribution URL is invalid');
    }
    if (url.protocol !== 'https:' || url.username || url.password) {
        throw new PublicDistributionError('invalid-url', 'Distribution URLs must use HTTPS without credentials');
    }
    if (allowedHosts.length === 0 || !isDistributionHostAllowed(url.hostname, allowedHosts)) {
        throw new PublicDistributionError('host-not-allowed', `Distribution host "${url.hostname}" is not allowed`);
    }
    return url;
}

async function defaultResolveAddresses(hostname: string): Promise<ResolvedDistributionAddress[]> {
    const literalFamily = isIP(hostname);
    if (literalFamily === 4 || literalFamily === 6) {
        return [{ address: hostname, family: literalFamily }];
    }
    const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    return addresses
        .filter((entry): entry is ResolvedDistributionAddress => entry.family === 4 || entry.family === 6)
        .map((entry) => ({ address: entry.address, family: entry.family }));
}

async function resolvePublicAddress(
    url: URL,
    resolver: NonNullable<PublicDistributionDependencies['resolveAddresses']>,
): Promise<ResolvedDistributionAddress> {
    let addresses: ResolvedDistributionAddress[];
    try {
        addresses = await resolver(url.hostname);
    } catch (error) {
        throw new PublicDistributionError(
            'network-error',
            `Unable to resolve distribution host "${url.hostname}": ${error instanceof Error ? error.message : String(error)}`,
            true,
        );
    }
    if (addresses.length === 0) {
        throw new PublicDistributionError('network-error', `Distribution host "${url.hostname}" resolved to no addresses`, true);
    }
    const unsafe = addresses.find((entry) => !isPublicDistributionAddress(entry.address));
    if (unsafe) {
        throw new PublicDistributionError(
            'unsafe-address',
            `Distribution host "${url.hostname}" resolved to prohibited address ${unsafe.address}`,
        );
    }
    return addresses[0];
}

export function createPinnedDistributionLookup(address: ResolvedDistributionAddress): LookupFunction {
    return (_hostname, options, callback) => {
        if (options.all) {
            callback(null, [{ address: address.address, family: address.family }]);
            return;
        }
        callback(null, address.address, address.family);
    };
}

function defaultRequestHop(
    url: URL,
    address: ResolvedDistributionAddress,
    options: { accept: string; maxBytes: number; connectTimeoutMs: number; responseTimeoutMs: number },
): Promise<DistributionHopResponse> {
    return new Promise((resolve, reject) => {
        let settled = false;
        let connected = false;
        const fail = (error: Error) => {
            if (settled) return;
            settled = true;
            reject(error);
        };
        const request = https.request({
            protocol: 'https:',
            hostname: url.hostname,
            port: url.port || 443,
            path: `${url.pathname}${url.search}`,
            method: 'GET',
            servername: url.hostname,
            agent: false,
            headers: {
                Accept: options.accept,
                'Accept-Encoding': 'identity',
                'User-Agent': 'Sheet-Delver-Module-Distribution',
            },
            lookup: createPinnedDistributionLookup(address),
        }, (response) => {
            connected = true;
            const declaredLength = Number(response.headers['content-length']);
            if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes) {
                response.destroy();
                fail(new PublicDistributionError('response-too-large', `Distribution response exceeds ${options.maxBytes} bytes`));
                return;
            }
            const encoding = response.headers['content-encoding'];
            if (typeof encoding === 'string' && encoding.toLowerCase() !== 'identity') {
                response.destroy();
                fail(new PublicDistributionError('content-type-error', 'Compressed HTTP content encoding is not accepted'));
                return;
            }

            const chunks: Buffer[] = [];
            let received = 0;
            response.on('data', (chunk: Buffer | string) => {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                received += buffer.length;
                if (received > options.maxBytes) {
                    response.destroy();
                    fail(new PublicDistributionError('response-too-large', `Distribution response exceeds ${options.maxBytes} bytes`));
                    return;
                }
                chunks.push(buffer);
            });
            response.on('end', () => {
                if (settled) return;
                settled = true;
                resolve({
                    statusCode: response.statusCode || 0,
                    headers: response.headers,
                    body: Buffer.concat(chunks, received),
                });
            });
            response.on('error', (error) => fail(new PublicDistributionError('network-error', error.message, true)));
        });

        const connectTimer = setTimeout(() => {
            if (!connected) request.destroy(new PublicDistributionError('timeout', 'Distribution connection timed out', true));
        }, options.connectTimeoutMs);
        request.once('socket', (socket) => {
            socket.once('secureConnect', () => {
                connected = true;
                clearTimeout(connectTimer);
            });
        });
        request.setTimeout(options.responseTimeoutMs, () => {
            request.destroy(new PublicDistributionError('timeout', 'Distribution response timed out', true));
        });
        request.once('error', (error) => {
            clearTimeout(connectTimer);
            if (error instanceof PublicDistributionError) fail(error);
            else fail(new PublicDistributionError('network-error', error.message, true));
        });
        request.end();
    });
}

function singleHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
}

async function fetchOnce(
    requestedUrl: string,
    options: PublicDistributionFetchOptions,
    policy: Required<PublicDistributionPolicy>,
    dependencies: Required<PublicDistributionDependencies>,
): Promise<PublicDistributionResponse> {
    let current = parseDistributionUrl(requestedUrl, policy.allowedHosts);
    const visited = new Set<string>();

    for (let redirectCount = 0; redirectCount <= policy.maxRedirects; redirectCount += 1) {
        if (visited.has(current.href)) {
            throw new PublicDistributionError('redirect-error', 'Distribution redirect loop detected');
        }
        visited.add(current.href);
        const address = await resolvePublicAddress(current, dependencies.resolveAddresses);
        const response = await dependencies.requestHop(current, address, {
            accept: options.accept,
            maxBytes: options.maxBytes,
            connectTimeoutMs: policy.connectTimeoutMs,
            responseTimeoutMs: policy.responseTimeoutMs,
        });

        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
            const location = singleHeader(response.headers, 'location');
            if (!location) throw new PublicDistributionError('redirect-error', 'Distribution redirect omitted Location');
            if (redirectCount === policy.maxRedirects) {
                throw new PublicDistributionError('redirect-error', `Distribution exceeded ${policy.maxRedirects} redirects`);
            }
            current = parseDistributionUrl(new URL(location, current).href, policy.allowedHosts);
            continue;
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
            throw new PublicDistributionError(
                'http-error',
                `Distribution request failed with HTTP ${response.statusCode}`,
                response.statusCode === 408 || response.statusCode === 429 || response.statusCode >= 500,
            );
        }
        if (response.body.length > options.maxBytes) {
            throw new PublicDistributionError('response-too-large', `Distribution response exceeds ${options.maxBytes} bytes`);
        }

        const contentType = singleHeader(response.headers, 'content-type') || '';
        const contentTypePattern = options.contentType === 'json'
            ? JSON_CONTENT_TYPE
            : options.contentType === 'release-manifest'
                ? RELEASE_MANIFEST_CONTENT_TYPE
                : ARCHIVE_CONTENT_TYPE;
        if (!contentTypePattern.test(contentType)) {
            throw new PublicDistributionError(
                'content-type-error',
                `Distribution response has unsupported content type "${contentType || 'missing'}"`,
            );
        }
        return {
            requestedUrl,
            finalUrl: current.href,
            statusCode: response.statusCode,
            contentType,
            body: response.body,
            redirectChain: [...visited],
        };
    }

    throw new PublicDistributionError('redirect-error', `Distribution exceeded ${policy.maxRedirects} redirects`);
}

export async function fetchPublicDistributionResource(
    url: string,
    options: PublicDistributionFetchOptions,
    policy: PublicDistributionPolicy,
    injected: PublicDistributionDependencies = {},
): Promise<PublicDistributionResponse> {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
        throw new PublicDistributionError('response-too-large', 'Distribution response limit must be a positive integer');
    }
    const resolvedPolicy: Required<PublicDistributionPolicy> = {
        allowedHosts: policy.allowedHosts.map((entry) => entry.trim()).filter(Boolean),
        maxRedirects: policy.maxRedirects ?? PUBLIC_DISTRIBUTION_LIMITS.maxRedirects,
        connectTimeoutMs: policy.connectTimeoutMs ?? PUBLIC_DISTRIBUTION_LIMITS.connectTimeoutMs,
        responseTimeoutMs: policy.responseTimeoutMs ?? PUBLIC_DISTRIBUTION_LIMITS.responseTimeoutMs,
        retries: policy.retries ?? PUBLIC_DISTRIBUTION_LIMITS.retries,
        retryBackoffMs: policy.retryBackoffMs ?? PUBLIC_DISTRIBUTION_LIMITS.retryBackoffMs,
    };
    for (const [name, value] of Object.entries(resolvedPolicy).filter(([name]) => name !== 'allowedHosts')) {
        if (!Number.isSafeInteger(value) || Number(value) < 0) {
            throw new PublicDistributionError('invalid-url', `Distribution policy ${name} must be a non-negative integer`);
        }
    }

    const dependencies: Required<PublicDistributionDependencies> = {
        resolveAddresses: injected.resolveAddresses || defaultResolveAddresses,
        requestHop: injected.requestHop || defaultRequestHop,
        sleep: injected.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    };
    let lastError: unknown;
    for (let attempt = 0; attempt <= resolvedPolicy.retries; attempt += 1) {
        try {
            return await fetchOnce(url, options, resolvedPolicy, dependencies);
        } catch (error) {
            lastError = error;
            const retryable = error instanceof PublicDistributionError && error.retryable;
            if (!retryable || attempt === resolvedPolicy.retries) throw error;
            await dependencies.sleep(resolvedPolicy.retryBackoffMs * (attempt + 1));
        }
    }
    throw lastError;
}

export async function fetchPublicDistributionJson<T>(
    url: string,
    policy: PublicDistributionPolicy,
    validate: (value: unknown) => { valid: boolean; errors: string[] },
    injected: PublicDistributionDependencies = {},
    options: PublicDistributionJsonOptions = {},
): Promise<{ response: PublicDistributionResponse; value: T }> {
    const response = await fetchPublicDistributionResource(url, {
        accept: 'application/json',
        maxBytes: PUBLIC_DISTRIBUTION_LIMITS.maxJsonBytes,
        contentType: options.allowOctetStream ? 'release-manifest' : 'json',
    }, policy, injected);
    let value: unknown;
    try {
        value = JSON.parse(response.body.toString('utf8'));
    } catch {
        throw new PublicDistributionError('malformed-json', 'Distribution response is not valid JSON');
    }
    const validation = validate(value);
    if (!validation.valid) {
        throw new PublicDistributionError('malformed-json', `Distribution JSON failed validation: ${validation.errors.join('; ')}`);
    }
    return { response, value: value as T };
}
