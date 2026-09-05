/**
 * Authenticated Foundry world probe (operator CLI).
 *
 * Per ADR-0022 Phase 1, the in-app world-scrape path was removed from the
 * production tree. The mechanics — authenticated probe of an active world via
 * `/join` + socket session — are preserved here for occasional operator use.
 *
 * Usage:
 *   npm run admin:scrape -- <foundryUrl> <username> [password]
 *
 * Example:
 *   npm run admin:scrape -- http://127.0.0.1:30000 GameMaster hunter2
 *
 * Exits 0 on success with the discovered world payload printed as JSON;
 * exits 1 on failure with the error printed to stderr.
 */
import { io, type Socket } from 'socket.io-client';
import { logger } from '@shared/utils/logger';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';

interface ProbeResult {
    world: {
        worldId: string;
        worldTitle: string | null;
        systemId: string;
        systemVersion: string;
        status: 'active' | 'offline';
        source: string;
    };
    cookie: string;
}

async function connectSocket(baseUrl: string, sessionCookie: string): Promise<Socket> {
    if (!sessionCookie) {
        throw new Error('Session cookie is required for socket connection.');
    }

    let sessionId: string | undefined;
    const match = sessionCookie.match(/(?:session|foundry)=([^; ]+)/);
    if (match) {
        sessionId = match[1];
    } else if (!sessionCookie.includes('=')) {
        sessionId = sessionCookie.trim();
    }

    const headers = {
        'Cookie': sessionCookie,
        'User-Agent': 'SheetDelver/1.0',
        'Origin': baseUrl,
    };

    return new Promise((resolve, reject) => {
        const socket = io(baseUrl, {
            path: '/socket.io',
            transports: ['websocket'],
            reconnection: false,
            query: sessionId ? { session: sessionId } : {},
            auth: sessionId ? { session: sessionId } : {},
            extraHeaders: headers,
            transportOptions: { websocket: { extraHeaders: headers } },
            withCredentials: true,
        });

        const timeout = setTimeout(() => {
            socket.disconnect();
            reject(new Error('Socket connection timeout'));
        }, 10000);

        socket.on('connect', () => {
            clearTimeout(timeout);
            logger.info('[scrape-world] Socket connected.');
            resolve(socket);
        });

        socket.on('connect_error', (err) => {
            clearTimeout(timeout);
            socket.disconnect();
            reject(err);
        });
    });
}

async function probeActiveWorld(baseUrl: string, username: string, password?: string): Promise<ProbeResult | null> {
    logger.info(`[scrape-world] Probing active world at ${baseUrl} as ${username}...`);
    const url = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;

    // 1. GET /join for CSRF + session cookie.
    const getResponse = await fetch(`${url}/join`, {
        headers: { 'User-Agent': 'SheetDelver/1.0' },
    });
    const html = await getResponse.text();
    const cookie = getResponse.headers.get('set-cookie');
    const getSessionId = cookie ? /session=([^;]+)/.exec(cookie)?.[1] : null;

    // 2. Parse CSRF + world title from HTML.
    const titleMatch = html.match(/<title>(.*?)<\/title>/) || html.match(/<h1>(.*?)<\/h1>/);
    let worldTitleFromHtml = titleMatch ? titleMatch[1].trim() : null;
    if (worldTitleFromHtml === 'Foundry Virtual Tabletop') worldTitleFromHtml = null;

    const csrfMatch = html.match(/name="csrf-token" content="(.*?)"/) || html.match(/"csrfToken":"(.*?)"/);
    const csrfToken = csrfMatch ? csrfMatch[1] : null;

    // 3. Map username → user id from the join page.
    let userId: string | null = null;
    const userMatch = new RegExp(`<option[^>]+value="([^"]+)"[^>]*>\\s*${username}\\s*</option>`, 'i').exec(html);
    if (userMatch) {
        userId = userMatch[1];
        logger.info(`[scrape-world] Mapped ${username} to user id ${userId}.`);
    } else {
        userId = username;
    }

    // 4. POST /join to authenticate.
    const response = await fetch(`${url}/join`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Cookie': cookie || '',
            'User-Agent': 'SheetDelver/1.0',
            'Origin': url,
            'Referer': `${url}/join`,
        },
        body: JSON.stringify({
            userid: userId,
            password: password || '',
            action: 'join',
            'csrf-token': csrfToken,
        }),
        redirect: 'manual',
    });

    // 5. Combine cookies, prefer post-login session id.
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
        logger.warn('[scrape-world] No session id captured after join. Aborting probe.');
        return null;
    }

    // 6. Authenticated socket + getJoinData.
    const socket = await connectSocket(url, combinedCookie);

    const sessionData = await new Promise<any>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('session event timeout')), 10000);
        socket.on('session', (data) => { clearTimeout(t); resolve(data); });
    });
    logger.info(`[scrape-world] Socket authenticated as ${sessionData?.userId ?? 'unknown'}.`);

    const joinData = await new Promise<any>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('getJoinData timeout')), 5000);
        socket.emit('getJoinData', (result: any) => { clearTimeout(t); resolve(result); });
    });

    socket.disconnect();

    if (joinData?.world || (worldTitleFromHtml && worldTitleFromHtml !== 'Critical Failure!')) {
        const isReady = !!joinData?.world;
        return {
            world: {
                worldId: joinData?.world?.id || 'unknown',
                worldTitle: joinData?.world?.title || worldTitleFromHtml,
                systemId: joinData?.system?.id || 'unknown',
                systemVersion: joinData?.system?.version || '0.0.0',
                status: isReady ? 'active' : 'offline',
                source: 'Authenticated Probe',
            },
            cookie: combinedCookie,
        };
    }

    logger.warn(`[scrape-world] Probe failed: no world found. Title from HTML: ${worldTitleFromHtml ?? 'null'}`);
    return null;
}

async function main(): Promise<void> {
    const [foundryUrl, username, password] = process.argv.slice(2);

    if (!foundryUrl || !username) {
        console.error('Usage: npm run admin:scrape -- <foundryUrl> <username> [password]');
        process.exit(1);
    }

    try {
        const result = await probeActiveWorld(foundryUrl, username, password);
        if (!result) {
            console.error('Probe returned no world.');
            process.exit(1);
        }
        console.log(JSON.stringify(result, null, 2));
        process.exit(0);
    } catch (error) {
        console.error(`Probe failed: ${getErrorMessage(error)}`);
        process.exit(1);
    }
}

void main();
