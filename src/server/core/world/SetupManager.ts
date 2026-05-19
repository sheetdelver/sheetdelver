import { io, Socket } from 'socket.io-client';
import { logger } from '@shared/utils/logger';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';
import { persistentCache } from '../cache/PersistentCache';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface WorldUser {
    _id: string;
    name: string;
    role: number;
}

export interface WorldData {
    worldId: string;
    worldTitle: string;
    worldDescription: string | null;
    systemId: string;
    systemVersion?: string;
    backgroundUrl: string | null;
    users: WorldUser[];
    lastUpdated: string;
    modules?: any[];
    data?: any;
}

export interface CacheData {
    worlds: Record<string, WorldData>;
    currentWorldId: string | null;
}

const CACHE_NS = 'core';
const CACHE_KEY = 'worlds';
const CACHE_MAX_AGE_DAYS = 7;

/**
 * Setup-mode world discovery and disk-cache helper.
 *
 * ADR-0014 Phase 4 moved this under `core/world` because it owns world
 * metadata snapshots for setup/admin/status flows, not Foundry transport.
 * Bootstrap orchestration still stays in CoreSocket until ADR-0017.
 */
export class SetupManager {

    /**
     * Scrape world data from an authenticated Foundry session
     * @deprecated Scraping is currently disabled/muted in favor of local import.
     */
    static async scrapeWorldData(foundryUrl: string, sessionCookie: string): Promise<WorldData> {
        logger.warn('[SetupManager] Scraping is currently disabled. Returning dummy data.');
        return {
            worldId: 'scraping-disabled',
            worldTitle: 'Scraping Disabled',
            worldDescription: null,
            systemId: 'unknown',
            systemVersion: '0.0.0',
            backgroundUrl: null,
            users: [],
            lastUpdated: new Date().toISOString()
        };
    }
    /**
     * Probes for an active world using credentials.
     * Useful when the world is already running but we don't know which one.
     */
    static async probeActiveWorld(baseUrl: string, username: string, password?: string): Promise<{ world: any, cookie: string } | null> {
        try {
            logger.info(`SetupManager | Probing active world with user ${username}...`);
            const url = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;

            // 1. GET /join to get CSRF and session
            const getResponse = await fetch(`${url}/join`, {
                headers: { 'User-Agent': 'SheetDelver/1.0' }
            });
            const html = await getResponse.text();

            const cookie = getResponse.headers.get('set-cookie');
            const getSessionId = cookie ? /session=([^;]+)/.exec(cookie)?.[1] : null;

            // 2. Parse CSRF and World Title from HTML
            const titleMatch = html.match(/<title>(.*?)<\/title>/) || html.match(/<h1>(.*?)<\/h1>/);
            let worldTitleFromHtml = titleMatch ? titleMatch[1].trim() : null;
            if (worldTitleFromHtml === 'Foundry Virtual Tabletop') worldTitleFromHtml = null;

            const csrfMatch = html.match(/name="csrf-token" content="(.*?)"/) || html.match(/"csrfToken":"(.*?)"/);
            const csrfToken = csrfMatch ? csrfMatch[1] : null;

            // 3. Parse User ID for the username
            let userId: string | null = null;
            const userMatch = new RegExp(`<option[^>]+value="([^"]+)"[^>]*>\\s*${username}\\s*</option>`, 'i').exec(html);
            if (userMatch) {
                userId = userMatch[1];
                logger.info(`!!! SetupManager | Found User ID for ${username}: ${userId}`);
            } else {
                userId = username;
            }

            // 4. POST to /join to authenticate
            const response = await fetch(`${url}/join`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Cookie': cookie || '',
                    'User-Agent': 'SheetDelver/1.0',
                    'Origin': url,
                    'Referer': `${url}/join`
                },
                body: JSON.stringify({
                    userid: userId,
                    password: password || '',
                    action: 'join',
                    'csrf-token': csrfToken
                }),
                redirect: 'manual'
            });

            const postBody = await response.text();
            logger.info(`!!! SetupManager | POST /join status: ${response.status}`);

            // Check for success markers in body if 200
            const isJsonSuccess = response.status === 200 && (postBody.includes('"status":"success"') || postBody.includes('JOIN.LoginSuccess'));
            const isRedirect = response.status === 302;

            if (response.status === 401 || (!isRedirect && !isJsonSuccess && !response.headers.get('set-cookie') && !cookie)) {
                logger.warn(`!!! SetupManager | Auth might have failed. Status: ${response.status}, Success: ${isJsonSuccess}`);
                if (postBody.length < 500) logger.debug(`!!! SetupManager | POST Body: ${postBody}`);
            }

            // Capture ALL cookies, prioritizing new ones
            const cookieMap = new Map<string, string>();
            const parseCookies = (c: string | null) => {
                if (!c) return;
                c.split(',').forEach(part => {
                    const pair = part.split(';')[0].split('=');
                    if (pair.length >= 2) cookieMap.set(pair[0].trim(), pair[1].trim());
                });
            };

            parseCookies(cookie);
            parseCookies(response.headers.get('set-cookie'));

            const combinedCookie = Array.from(cookieMap.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
            const sessionId = cookieMap.get('session') || cookieMap.get('foundry') || getSessionId;

            if (!sessionId) {
                logger.warn('!!! SetupManager | Failed to capture session ID for probe.');
                return null;
            }

            // 5. Connect via Socket and wait for authentication
            logger.info(`!!! SetupManager | Connecting to socket with sessionId: ${sessionId}`);
            const socket = await this.connectSocket(url, combinedCookie);

            // Wait for session event before getJoinData
            const sessionData = await new Promise<any>((resolve, reject) => {
                const t = setTimeout(() => {
                    logger.warn(`!!! SetupManager | session event TIMED OUT after 10s`);
                    reject(new Error('session event timeout'));
                }, 10000);

                socket.on('session', (data) => {
                    clearTimeout(t);
                    logger.info(`!!! SetupManager | Session event received for userId: ${data.userId}`);
                    resolve(data);
                });
            });

            logger.info(`!!! SetupManager | Socket authenticated. Emitting getJoinData...`);

            const joinData = await new Promise<any>((resolve, reject) => {
                const t = setTimeout(() => {
                    logger.warn(`!!! SetupManager | getJoinData TIMED OUT after 5s`);
                    reject(new Error('getJoinData timeout'));
                }, 5000);

                socket.emit('getJoinData', (result: any) => {
                    clearTimeout(t);
                    logger.info(`!!! SetupManager | getJoinData RECEIVED result: ${result ? 'YES' : 'NO'}`);
                    resolve(result);
                });
            });

            socket.disconnect();

            if (joinData) {
                logger.debug(`!!! SetupManager | joinData keys: ${Object.keys(joinData).join(', ')}`);
                if (joinData.world) {
                    logger.info(`!!! SetupManager | PROBE SUCCESS! World: ${joinData.world.title}`);
                }
            }

            if (joinData?.world || (worldTitleFromHtml && worldTitleFromHtml !== 'Critical Failure!')) {
                const isReady = !!joinData?.world;
                return {
                    world: {
                        worldId: joinData?.world?.id || 'unknown',
                        worldTitle: joinData?.world?.title || worldTitleFromHtml,
                        systemId: joinData?.system?.id || 'unknown',
                        systemVersion: joinData?.system?.version || '0.0.0',
                        status: isReady ? 'active' : 'offline',
                        source: 'Authenticated Probe'
                    },
                    cookie: combinedCookie
                };
            } else {
                logger.warn(`!!! SetupManager | PROBE FAILED: No world found. Title from HTML: ${worldTitleFromHtml}`);
            }
        } catch (error: unknown) {
            logger.warn(`!!! SetupManager | PROBE EXCEPTION: ${getErrorMessage(error)}`);
        }
        return null;
    }

    /**
     * TODO: Implement authenticated setup page scraping if needed.
     * Currently focusing on world-specific probes.
     */
    static async scrapeAvailableWorlds(foundryUrl: string, sessionCookie?: string): Promise<Partial<WorldData>[]> {
        // Placeholder for future implementation
        return [];
    }

    /**
     * Connect socket with authenticated session
     */
    private static async connectSocket(baseUrl: string, sessionCookie: string): Promise<Socket> {
        if (!sessionCookie) {
            throw new Error('[SetupManager] Session cookie is required for socket connection.');
        }

        let sessionId: string | undefined;

        // Handle "session=s%3A...; other=..." or just "s%3A..."
        const match = sessionCookie.match(/(?:session|foundry)=([^; ]+)/);
        if (match) {
            sessionId = match[1];
        } else if (!sessionCookie.includes('=')) {
            sessionId = sessionCookie.trim();
        }

        const headers = {
            'Cookie': sessionCookie,
            'User-Agent': 'SheetDelver/1.0',
            'Origin': baseUrl
        };

        return new Promise((resolve, reject) => {
            const socket = io(baseUrl, {
                path: '/socket.io',
                transports: ['websocket'],
                reconnection: false,
                query: sessionId ? { session: sessionId } : {},
                auth: sessionId ? { session: sessionId } : {},
                extraHeaders: headers,
                transportOptions: {
                    websocket: {
                        extraHeaders: headers
                    }
                },
                withCredentials: true
            });

            const timeout = setTimeout(() => {
                socket.disconnect();
                reject(new Error('Socket connection timeout'));
            }, 10000);

            socket.on('connect', () => {
                clearTimeout(timeout);
                logger.info('[SetupManager] Socket connected successfully');
                resolve(socket);
            });

            socket.on('connect_error', (err) => {
                clearTimeout(timeout);
                socket.disconnect();
                logger.error('[SetupManager] Socket connection error:', err.message);
                reject(err);
            });
        });
    }

    /**
     * Save world data to cache
     */
    static async saveCache(worldData: WorldData, setActive: boolean = true): Promise<void> {
        const cache = await this.loadCache();

        cache.worlds[worldData.worldId] = worldData;
        if (setActive) {
            cache.currentWorldId = worldData.worldId;
        }

        await persistentCache.set(CACHE_NS, CACHE_KEY, cache);
    }

    /**
     * Save multiple worlds to cache without changing active world
     */
    static async saveBatchCache(worldsData: WorldData[]): Promise<void> {
        const cache = await this.loadCache();

        for (const w of worldsData) {
            cache.worlds[w.worldId] = w;
        }

        await persistentCache.set(CACHE_NS, CACHE_KEY, cache);
    }

    /**
     * Load all cached worlds
     */
    static async loadCache(): Promise<CacheData> {
        logger.debug('[SetupManager] loadCache called.');

        try {
            const cache = await persistentCache.get<CacheData>(CACHE_NS, CACHE_KEY);
            //logger.debug('[SetupManager] Raw cache from persistent store:', JSON.stringify(cache, null, 2));
            if (!cache) {
                logger.warn('[SetupManager] Cache is null or undefined');
                return { worlds: {}, currentWorldId: null };
            }

            // Validate that the current world actually has users
            if (cache.currentWorldId && cache.worlds[cache.currentWorldId]) {
                const world = cache.worlds[cache.currentWorldId];
                if (!world.users || world.users.length === 0) {
                    logger.warn(`[SetupManager] Cache exists for ${world.worldTitle} but has 0 users. Treating as invalid/setup-required.`);
                    // We don't delete the data, but we treat it as "no current world" so the app redirects to setup
                    return { ...cache, currentWorldId: null };
                }
            } else {
                logger.warn('[SetupManager] currentWorldId mismatch or missing in worlds map');
            }

            return cache;
        } catch (e) {
            logger.error('[SetupManager] Error loading cache:', e);
            return { worlds: {}, currentWorldId: null };
        }
    }

    /**
     * Get cached world data by ID
     */
    static async getCachedWorld(worldId: string): Promise<WorldData | null> {
        const cache = await this.loadCache();
        return cache.worlds[worldId] || null;
    }

    /**
     * Validate cache freshness (< 7 days old)
     */
    static async validateCache(worldId: string): Promise<boolean> {
        const world = await this.getCachedWorld(worldId);
        if (!world) return false;

        const lastUpdated = new Date(world.lastUpdated);
        const now = new Date();
        const ageInDays = (now.getTime() - lastUpdated.getTime()) / (1000 * 60 * 60 * 24);

        return ageInDays < CACHE_MAX_AGE_DAYS;
    }

    /**
     * Detect current world ID from Foundry server
     */
    static async getCurrentWorldId(foundryUrl: string, sessionCookie: string): Promise<string | null> {
        try {
            const socket = await this.connectSocket(foundryUrl, sessionCookie);

            const sessionData = await new Promise<any>((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Session timeout')), 5000);
                socket.on('session', (data) => {
                    clearTimeout(timeout);
                    resolve(data);
                });
            });

            socket.disconnect();
            return sessionData.worldId || null;
        } catch {
            return null;
        }
    }
}
