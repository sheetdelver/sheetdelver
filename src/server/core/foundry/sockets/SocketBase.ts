import { io, Socket } from 'socket.io-client';
import { logger } from '@shared/utils/logger';
import { FoundryConfig } from '../types';
import { EventEmitter } from 'events';
import { randomUUID } from 'node:crypto';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';

type HeadersWithSetCookie = Headers & {
    getSetCookie?: () => string[];
};

export const FOUNDRY_LOGOUT_TIMEOUT_MS = 5_000;
export const FOUNDRY_STATUS_TIMEOUT_MS = 10_000;
export const FOUNDRY_LOGIN_TIMEOUT_MS = 10_000;

export abstract class SocketBase extends EventEmitter {
    protected socket: Socket | null = null;
    protected cookieMap = new Map<string, string>();
    protected sessionCookie: string | null = null;
    protected foundryVersion: string | null = null;
    public isSocketConnected: boolean = false;
    protected config: FoundryConfig;
    protected statusTimeoutMs = FOUNDRY_STATUS_TIMEOUT_MS;
    protected loginTimeoutMs = FOUNDRY_LOGIN_TIMEOUT_MS;

    constructor(config: FoundryConfig) {
        super();
        this.config = config;
    }

    public getSessionCookie(): string | null {
        return this.sessionCookie;
    }

    protected getBaseUrl(): string {
        if (this.config.url) {
            return this.config.url.endsWith('/') ? this.config.url.slice(0, -1) : this.config.url;
        }
        if (this.config.host) {
            const protocol = this.config.protocol || 'http';
            const port = this.config.port ? `:${this.config.port}` : '';
            return `${protocol}://${this.config.host}${port}`;
        }
        throw new Error("Foundry URL or Host not configured");
    }

    protected updateCookies(headerVal: string | string[] | null | undefined) {
        if (!headerVal) return;
        const cookies = Array.isArray(headerVal) ? headerVal : [headerVal];

        cookies.forEach(c => {
            // Split multiple cookies if they are comma separated (common in simple fetch)
            const parts = c.split(/,(?=\s*\w+=)/g);
            parts.forEach(part => {
                const [pair] = part.split(';');
                if (pair.includes('=')) {
                    const [key, value] = pair.split('=');
                    this.cookieMap.set(key.trim(), value.trim());
                }
            });
        });

        // Update the main session string
        this.sessionCookie = Array.from(this.cookieMap.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    }

    protected getSetCookieHeader(headers: Headers): string | string[] | null {
        const headersWithSetCookie = headers as HeadersWithSetCookie;
        if (typeof headersWithSetCookie.getSetCookie === 'function') {
            return headersWithSetCookie.getSetCookie();
        }

        return headers.get('set-cookie');
    }

    protected async performHandshake(
        baseUrl: string,
        options: { omitCookie?: boolean; replaceCookiesOnSuccess?: boolean; signal?: AbortSignal; canCommit?: () => boolean } = {},
    ): Promise<{ csrfToken: string | null, isSetupMatch: boolean, pageTitle: string }> {
        logger.debug(`[${this.constructor.name}] Performing Handshake (GET /api/status)...`);

        // 1. Fetch JSON status instead of HTML /join
        // IMPORTANT: Must send existing cookies to maintain session continuity
        const headers: Record<string, string> = {
            'Accept': 'application/json',
            'User-Agent': 'SheetDelver/1.0'
        };

        if (this.sessionCookie && !options.omitCookie) {
            headers['Cookie'] = this.sessionCookie;
        }

        const statusRes = await fetch(`${baseUrl}/api/status`, {
            headers,
            signal: options.signal
                ? AbortSignal.any([options.signal, AbortSignal.timeout(this.statusTimeoutMs)])
                : AbortSignal.timeout(this.statusTimeoutMs),
        });

        if (!statusRes.ok) {
            throw new Error(`Handshake failed with status ${statusRes.status}`);
        }

        const status = await statusRes.json();

        // The world-login request changed in Foundry 14.366. Retain the version
        // discovered by this handshake so authentication can use its wire contract.
        // A missing/partial status is not evidence that the world entered
        // Setup. Session invalidation must never follow an ambiguous response.
        if (typeof status?.active !== 'boolean') {
            throw new Error('Foundry status response did not contain an active boolean');
        }
        if (options.signal?.aborted || options.canCommit?.() === false) {
            throw new Error('Foundry status probe was superseded');
        }
        this.foundryVersion = typeof status.version === 'string' ? status.version : null;

        // A successful anonymous recovery replaces, rather than merges into,
        // a potentially invalid service-account session. A failed or malformed
        // diagnostic never changes the retained cookie.
        if (options.replaceCookiesOnSuccess) {
            this.cookieMap.clear();
            this.sessionCookie = null;
        }
        const setCookie = this.getSetCookieHeader(statusRes.headers);
        if (setCookie) this.updateCookies(setCookie);

        // 2. Derive States from JSON
        const isSetupMatch = status.active === false;
        const pageTitle = status.world || (isSetupMatch ? 'Setup' : 'Foundry Virtual Tabletop');
        const csrfToken: string | null = null; // No longer needed or scraped in V13 programmatic flow

        logger.debug(`[${this.constructor.name}] Handshake Complete. Active: ${status.active}, World: ${pageTitle}`);

        return { csrfToken, isSetupMatch, pageTitle };
    }

    protected async performLogin(baseUrl: string, userId: string, csrfToken: string | null, canCommit?: () => boolean): Promise<void> {
        logger.info(`[${this.constructor.name}] Performing POST Login (User: ${userId})...`);

        const [foundryGeneration = 0, foundryBuild = 0] = (this.foundryVersion || '')
            .split('.')
            .map((part) => Number.parseInt(part, 10));
        const usesUsernameLogin = foundryGeneration > 14
            || (foundryGeneration === 14 && foundryBuild >= 366);
        const payload: Record<string, string> = {
            password: this.config.password || '',
            action: 'join'
        };

        if (usesUsernameLogin) {
            // V14 build 366 replaced the user selector with username autocomplete;
            // its /join contract submits both the visible name and resolved ID.
            payload.username = this.config.username || '';
            payload.userId = userId;
        } else {
            // Builds before 14.366 submit the selected ID under lowercase `userid`.
            payload.userid = userId;
        }

        // If the server explicitly required one from an older caching flow, pass it (usually ignored in v13)
        if (csrfToken) {
            payload['csrf-token'] = csrfToken;
        }

        const loginResponse = await fetch(`${baseUrl}/join`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Cookie': this.sessionCookie || '',
                'User-Agent': 'SheetDelver/1.0'
            },
            body: JSON.stringify(payload),
            redirect: 'manual',
            signal: AbortSignal.timeout(this.loginTimeoutMs),
        });

        if (loginResponse.status !== 200 && loginResponse.status !== 302) {
            logger.error(`[${this.constructor.name}] Login failed (${loginResponse.status}).`);
            throw new Error(`Login failed with status ${loginResponse.status}`);
        }
        if (canCommit?.() === false) return;
        const setCookie = this.getSetCookieHeader(loginResponse.headers);
        this.updateCookies(setCookie);
        logger.info(`[${this.constructor.name}] Login Outcome: ${loginResponse.status}. Cookie Map Size: ${this.cookieMap.size}`);
    }

    protected getSessionId(): string | undefined {
        if (!this.sessionCookie) return undefined;
        const parts = this.sessionCookie.split(';');
        for (const part of parts) {
            const [key, value] = part.trim().split('=');
            if (key === 'session' || key === 'foundry') {
                return value;
            }
        }
        return undefined;
    }

    protected hydrateCookieHeader(cookie: string, options: { replace?: boolean } = {}): void {
        // Restored-session cookies arrive as a browser Cookie header, not as
        // Set-Cookie response headers. Keep the parsing here because cookie
        // header state is transport mechanics shared by user/socket clients.
        if (options.replace !== false) {
            this.cookieMap.clear();
        }

        for (const part of cookie.split(';')) {
            const trimmed = part.trim();
            const separatorIndex = trimmed.indexOf('=');
            if (separatorIndex <= 0) continue;

            const key = trimmed.slice(0, separatorIndex).trim();
            const value = trimmed.slice(separatorIndex + 1).trim();
            if (key) this.cookieMap.set(key, value);
        }

        this.sessionCookie = Array.from(this.cookieMap.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    }

    protected createGuestProbeSocket(baseUrl: string, options: Parameters<typeof io>[1]): Socket {
        return io(baseUrl, options);
    }

    protected async probeWorldState(baseUrl: string): Promise<any> {
        logger.info(`[${this.constructor.name}] Probing world state (Socket + API)...`);

        // 1. Socket Probe Logic
        const probeSocket = async (): Promise<any> => {
            const guestCookie = this.sessionCookie || '';
            const sessionId = this.getSessionId();

            return new Promise<any>((resolve) => {
                const guestSocket = this.createGuestProbeSocket(baseUrl, {
                    path: '/socket.io',
                    transports: ['websocket'],
                    reconnection: false,
                    query: sessionId ? { session: sessionId } : {},
                    auth: sessionId ? { session: sessionId } : {},
                    extraHeaders: { 'Cookie': guestCookie, 'User-Agent': 'SheetDelver/1.0' },
                    transportOptions: { websocket: { extraHeaders: { 'Cookie': guestCookie } } }
                });

                let settled = false;
                const finish = (result: any = null) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(t);
                    guestSocket.removeAllListeners();
                    guestSocket.disconnect();
                    resolve(result);
                };
                const t = setTimeout(() => finish(), 10000);

                guestSocket.on('connect', () => {
                    logger.debug(`[${this.constructor.name}] Guest Socket Probe Connected.`);

                    // Try getJoinData first (Legacy/v12)
                    guestSocket.emit('getJoinData', (result: any) => {
                        if (result && result.world) {
                            finish(result);
                        } else {
                            // Try 'world' (v13)
                            guestSocket.emit('world', (worldResult: any) => {
                                if (worldResult && worldResult.world) {
                                    finish(worldResult);
                                } else {
                                    // Try status fallback
                                    guestSocket.emit('getWorldStatus', (status: boolean) => {
                                        finish(status === true
                                            ? { world: { title: 'Authenticating...' }, status: 'active' }
                                            : null);
                                    });
                                }
                            });
                        }
                    });
                });

                guestSocket.on('connect_error', (err) => {
                    logger.debug(`[${this.constructor.name}] Guest Socket Probe Error: ${err.message}`);
                    finish();
                });
            });
        };

        // 2. API Probe Logic (/api/status)
        const probeApi = async (): Promise<any> => {
            try {
                const statusRes = await fetch(`${baseUrl}/api/status`, {
                    signal: AbortSignal.timeout(this.statusTimeoutMs),
                });
                if (statusRes.ok) {
                    const status = await statusRes.json();
                    if (status?.active === true && typeof status.world === 'string' && status.world) {
                        logger.info(`[${this.constructor.name}] API Probe Success: ${status.world}`);
                        return {
                            world: { id: status.world, title: status.world },
                            system: { id: status.system },
                            version: status.version,
                            status: 'active'
                        };
                    }
                }
            } catch (e) {
                logger.debug(`[${this.constructor.name}] API Probe Failed: ${e}`);
            }
            return null;
        };

        const [socketResult, apiResult] = await Promise.all([probeSocket(), probeApi()]);
        return socketResult?.world ? socketResult : apiResult;
    }

    public async logout(): Promise<void> {
        try {
            const baseUrl = this.getBaseUrl();
            logger.info(`[${this.constructor.name}] Attempting explicit logout from Foundry via GET /join...`);
            // Foundry v13 and v14 retire the current world assignment when an
            // authenticated client opens /join; neither exposes POST /logout.
            const response = await fetch(`${baseUrl}/join`, {
                method: 'GET',
                redirect: 'manual',
                // Foundry teardown is best-effort after local authority has
                // already been retired; bound an unavailable upstream so the
                // browser cannot remain in its logging-out state indefinitely.
                signal: AbortSignal.timeout(FOUNDRY_LOGOUT_TIMEOUT_MS),
                headers: {
                    'Cookie': this.sessionCookie || '',
                    'Accept': 'text/html'
                }
            });
            if (response.ok) {
                logger.info(`[${this.constructor.name}] Extinguished session on Foundry server successfully.`);
            } else {
                logger.warn(`[${this.constructor.name}] Logout returned ${response.status}`);
            }
        } catch (error: unknown) {
            logger.warn(`[${this.constructor.name}] Error during explicit logout: ${getErrorMessage(error)}`);
        }
    }

    public disconnect() {
        if (this.socket) {
            logger.info(`[${this.constructor.name}] Disconnecting socket...`);
            this.socket.disconnect();
            this.socket.removeAllListeners();
            this.socket = null;
        }
        this.isSocketConnected = false;
        logger.info(`[${this.constructor.name}] Socket disconnected.`);
    }

    public get isConnected(): boolean {
        return this.isSocketConnected;
    }

    protected setupSharedContentListeners(socket: Socket) {
        socket.on('shareImage', (data: any) => {
            logger.info(`[${this.constructor.name}] Received shared image.`);
            this.emit('foundry:shareImage', { data, timestamp: Date.now(), shareId: randomUUID() });
        });

        socket.on('showEntry', (uuid: string, ...args: any[]) => {
            logger.info(`[${this.constructor.name}] Received shared journal.`);
            this.emit('foundry:showEntry', { uuid, args, timestamp: Date.now(), shareId: randomUUID() });
        });
    }

    public get url(): string {
        return this.getBaseUrl();
    }

    abstract connect(): Promise<void>;
}
