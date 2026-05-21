import { io, Socket } from 'socket.io-client';
import { logger } from '@shared/utils/logger';
import { FoundryConfig } from '../types';
import { EventEmitter } from 'events';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';
import { sharedContentStore } from '@server/core/world/SharedContentStore';
import type { RealtimeSharedContentPayload } from '@shared/contracts/realtime';
import { resolveFoundryHtml, resolveFoundryUrl } from '@server/shared/utils/foundryUrl';

type HeadersWithSetCookie = Headers & {
    getSetCookie?: () => string[];
};

export abstract class SocketBase extends EventEmitter {
    protected socket: Socket | null = null;
    protected cookieMap = new Map<string, string>();
    protected sessionCookie: string | null = null;
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

        // V13 allows programmatic login to /join via application/json without a CSRF token
        const payload: any = {
            userid: userId,
            password: this.config.password || '',
            action: 'join'
        };

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
        // The socket is the wire-event source, but the canonical snapshot lives
        // in SharedContentStore. Defensive copies on Store read/write keep
        // request-time projections from mutating what other consumers read next.
        socket.on('shareImage', (data: any) => {
            logger.info(`[${this.constructor.name}] Received shared image: ${data.image}`);
            const payload: RealtimeSharedContentPayload = {
                type: 'image',
                data: {
                    url: data.image,
                    title: data.title,
                },
                timestamp: Date.now(),
            };
            sharedContentStore.set(payload);
        });

        socket.on('showEntry', (uuid: string, ..._args: any[]) => {
            logger.info(`[${this.constructor.name}] Received shared entry: ${uuid}`);
            const parts = uuid.split('.');
            if (parts.length >= 2 && parts[0] === 'JournalEntry') {
                const payload: RealtimeSharedContentPayload = {
                    type: 'journal',
                    data: {
                        id: parts[1],
                        uuid,
                    },
                    timestamp: Date.now(),
                };
                sharedContentStore.set(payload);
            }
        });
    }

    public get url(): string {
        return this.getBaseUrl();
    }

    /**
     * Resolves a relative path into an absolute Foundry URL.
     */
    public resolveUrl(path: string): string {
        return resolveFoundryUrl(path, this.url);
    }

    /**
     * Processes HTML content to resolve relative image and link paths.
     */
    public resolveHtml(html: string): string {
        return resolveFoundryHtml(html, this.url);
    }

    abstract connect(): Promise<void>;
}
