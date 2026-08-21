import { io, Socket } from 'socket.io-client';
import { logger } from '@shared/utils/logger';
import { FoundryConfig } from '../types';
import { EventEmitter } from 'events';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';

type HeadersWithSetCookie = Headers & {
    getSetCookie?: () => string[];
};

export abstract class SocketBase extends EventEmitter {
    protected socket: Socket | null = null;
    protected cookieMap = new Map<string, string>();
    protected sessionCookie: string | null = null;
    protected foundryVersion: string | null = null;
    public isSocketConnected: boolean = false;
    protected config: FoundryConfig;

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

    protected async performHandshake(baseUrl: string): Promise<{ csrfToken: string | null, isSetupMatch: boolean, pageTitle: string }> {
        logger.info(`[${this.constructor.name}] Performing Handshake (GET /api/status)...`);

        // 1. Fetch JSON status instead of HTML /join
        // IMPORTANT: Must send existing cookies to maintain session continuity
        const headers: Record<string, string> = {
            'Accept': 'application/json',
            'User-Agent': 'SheetDelver/1.0'
        };

        if (this.sessionCookie) {
            headers['Cookie'] = this.sessionCookie;
        }

        const statusRes = await fetch(`${baseUrl}/api/status`, {
            headers
        });

        if (!statusRes.ok) {
            throw new Error(`Handshake failed with status ${statusRes.status}`);
        }

        const status = await statusRes.json();

        // The world-login request changed in Foundry 14.366. Retain the version
        // discovered by this handshake so authentication can use its wire contract.
        this.foundryVersion = typeof status.version === 'string' ? status.version : null;

        // If the backend returned a set-cookie (less likely on /api/status, but just in case)
        const setCookie = this.getSetCookieHeader(statusRes.headers);

        if (setCookie) {
            this.updateCookies(setCookie);
        }

        // 2. Derive States from JSON
        const isSetupMatch = !status.active;
        const pageTitle = status.world || (isSetupMatch ? 'Setup' : 'Foundry Virtual Tabletop');
        const csrfToken: string | null = null; // No longer needed or scraped in V13 programmatic flow

        logger.debug(`[${this.constructor.name}] Handshake Complete. Active: ${status.active}, World: ${pageTitle}`);

        return { csrfToken, isSetupMatch, pageTitle };
    }

    protected async performLogin(baseUrl: string, userId: string, csrfToken: string | null): Promise<void> {
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
            redirect: 'manual'
        });

        if (loginResponse.status !== 200 && loginResponse.status !== 302) {
            const body = await loginResponse.text();
            logger.error(`[${this.constructor.name}] Login failed (${loginResponse.status}): ${body.substring(0, 200)}`);
            throw new Error(`Login failed with status ${loginResponse.status}: ${body.substring(0, 200)}`);
        }

        const setCookie = this.getSetCookieHeader(loginResponse.headers);

        logger.debug(`[${this.constructor.name}] Set-Cookie from login: ${JSON.stringify(setCookie)}`);
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

    protected async probeWorldState(baseUrl: string): Promise<any> {
        logger.info(`[${this.constructor.name}] Probing world state (Socket + API)...`);

        let discoveryResult: any = null;

        // 1. Socket Probe Logic
        const probeSocket = async (): Promise<void> => {
            const guestCookie = this.sessionCookie || '';
            const sessionId = this.getSessionId();

            return new Promise<void>((resolve) => {
                const guestSocket = io(baseUrl, {
                    path: '/socket.io',
                    transports: ['websocket'],
                    reconnection: false,
                    query: sessionId ? { session: sessionId } : {},
                    auth: sessionId ? { session: sessionId } : {},
                    extraHeaders: { 'Cookie': guestCookie, 'User-Agent': 'SheetDelver/1.0' },
                    transportOptions: { websocket: { extraHeaders: { 'Cookie': guestCookie } } }
                });

                const t = setTimeout(() => {
                    guestSocket.disconnect();
                    resolve();
                }, 10000);

                guestSocket.on('connect', () => {
                    logger.debug(`[${this.constructor.name}] Guest Socket Probe Connected.`);

                    // Try getJoinData first (Legacy/v12)
                    guestSocket.emit('getJoinData', (result: any) => {
                        if (result && result.world) {
                            discoveryResult = result;
                            clearTimeout(t);
                            guestSocket.disconnect();
                            resolve();
                        } else {
                            // Try 'world' (v13)
                            guestSocket.emit('world', (worldResult: any) => {
                                clearTimeout(t);
                                if (worldResult && worldResult.world) {
                                    discoveryResult = worldResult;
                                } else {
                                    // Try status fallback
                                    guestSocket.emit('getWorldStatus', (status: boolean) => {
                                        if (status) {
                                            discoveryResult = { world: { title: 'Authenticating...' }, status: 'active' };
                                        }
                                    });
                                }
                                guestSocket.disconnect();
                                resolve();
                            });
                        }
                    });
                });

                guestSocket.on('connect_error', (err) => {
                    logger.debug(`[${this.constructor.name}] Guest Socket Probe Error: ${err.message}`);
                    clearTimeout(t);
                    guestSocket.disconnect();
                    resolve();
                });
            });
        };

        // 2. API Probe Logic (/api/status)
        const probeApi = async (): Promise<void> => {
            try {
                const statusRes = await fetch(`${baseUrl}/api/status`);
                if (statusRes.ok) {
                    const status = await statusRes.json();
                    if (status.world) {
                        logger.info(`[${this.constructor.name}] API Probe Success: ${status.world}`);
                        if (!discoveryResult) {
                            discoveryResult = {
                                world: { id: status.world, title: status.world },
                                system: { id: status.system },
                                version: status.version,
                                status: status.active ? 'active' : 'offline'
                            };
                        }
                    }
                }
            } catch (e) {
                logger.debug(`[${this.constructor.name}] API Probe Failed: ${e}`);
            }
        };

        await Promise.all([probeSocket(), probeApi()]);
        return discoveryResult;
    }

    public async logout(): Promise<void> {
        try {
            const baseUrl = this.getBaseUrl();
            logger.info(`[${this.constructor.name}] Attempting explicit logout from Foundry via POST /logout...`);
            const response = await fetch(`${baseUrl}/logout`, {
                method: 'POST',
                headers: {
                    'Cookie': this.sessionCookie || '',
                    'Content-Type': 'application/json'
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
            logger.info(`[${this.constructor.name}] Received shared image: ${data.image}`);
            this.emit('foundry:shareImage', { data });
        });

        socket.on('showEntry', (uuid: string, ...args: any[]) => {
            logger.info(`[${this.constructor.name}] Received shared entry: ${uuid}`);
            this.emit('foundry:showEntry', { uuid, args });
        });
    }

    public get url(): string {
        return this.getBaseUrl();
    }

    abstract connect(): Promise<void>;
}
