import { logger } from '@shared/utils/logger';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';
const isBrowser = typeof window !== 'undefined';
let fs: any = null;
let path: any = null;
let ClassicLevel: any = null;

async function loadDeps() {
    if (isBrowser) return false;
    if (fs && path && ClassicLevel) return true;
    try {
        const fsMod = await import('node:fs');
        const pathMod = await import('node:path');
        const clMod = await import('classic-level');
        fs = fsMod.default || fsMod;
        path = pathMod.default || pathMod;
        ClassicLevel = clMod.ClassicLevel;
        return true;
    } catch (e) {
        return false;
    }
}

export interface ScrapedUser {
    id: string;
    name: string;
    role: number;
}

export interface ScrapedWorldData {
    id: string;
    title: string;
    system: string;
    version: string;
    background: string;
    description: string;
    users: ScrapedUser[];
}

type ScrapedUserRecord = {
    _id?: unknown;
    name?: unknown;
    role?: unknown;
};

function toScrapedUser(value: unknown): ScrapedUser | null {
    if (!value || typeof value !== 'object') return null;

    const user = value as ScrapedUserRecord;
    if (typeof user.name !== 'string' || user.name.length === 0) return null;

    return {
        id: typeof user._id === 'string' ? user._id : '',
        name: user.name,
        role: typeof user.role === 'number' ? user.role : 0
    };
}

export class DirectScraper {
    private worldPath: string;

    static async scrape(worldPath: string): Promise<ScrapedWorldData> {
        await loadDeps();
        return new DirectScraper(worldPath).process();
    }

    /**
     * Discover available worlds in a given Data directory.
     * Looks for <dataRoot>/Data/worlds/ OR <dataRoot>/worlds/
     */
    static async discover(dataRoot: string): Promise<{ id: string; title: string; path: string; system: string }[]> {
        await loadDeps();
        if (!fs || !path) return [];
        // 1. Check if the path ITSELF is a world
        const directWorldJson = path.join(dataRoot, 'world.json');
        if (fs.existsSync(directWorldJson)) {
            try {
                const content = fs.readFileSync(directWorldJson, 'utf8');
                const json = JSON.parse(content);
                return [{
                    id: json.id || path.basename(dataRoot),
                    title: json.title || path.basename(dataRoot),
                    system: json.system || 'unknown',
                    path: dataRoot
                }];
            } catch (e) {
                // If invalid JSON, treat as standard directory scan
            }
        }

        // 2. Scan for 'worlds' subdirectories
        const potentialPaths = [
            path.join(dataRoot, 'Data', 'worlds'), // Standard UserData
            path.join(dataRoot, 'worlds'),         // Direct worlds folder
            dataRoot                               // The root itself is worlds folder?
        ];

        let worldsDir: string | null = null;
        for (const p of potentialPaths) {
            // Check if directory exists AND has subdirectories that contain world.json
            if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
                // Quick validation: does it contain at least one world-like folder?
                const hasWorld = (fs.readdirSync(p) as string[]).some((sub: string) =>
                    fs.existsSync(path.join(p, sub, 'world.json'))
                );
                if (hasWorld) {
                    worldsDir = p;
                    break;
                }
            }
        }

        if (!worldsDir) {
            // Be more lenient; if we couldn't find a clear 'worlds' parent, throw, 
            // but the first check covers the direct path case.
            throw new Error(`Could not find a valid 'worlds' directory or 'world.json' in ${dataRoot}`);
        }

        const entries = fs.readdirSync(worldsDir, { withFileTypes: true });
        const worlds: { id: string; title: string; path: string; system: string }[] = [];

        for (const entry of entries) {
            if (entry.isDirectory()) {
                const worldJsonPath = path.join(worldsDir, entry.name, 'world.json');
                if (fs.existsSync(worldJsonPath)) {
                    try {
                        const content = fs.readFileSync(worldJsonPath, 'utf8');
                        const json = JSON.parse(content);
                        worlds.push({
                            id: json.id || entry.name,
                            title: json.title || entry.name,
                            system: json.system || 'unknown',
                            path: path.join(worldsDir, entry.name)
                        });
                    } catch (e) {
                        // Skip unreadable
                    }
                }
            }
        }

        return worlds;
    }

    constructor(worldPath: string) {
        if (!fs.existsSync(worldPath)) {
            throw new Error(`World directory not found: ${worldPath}`);
        }
        this.worldPath = worldPath;
    }

    async process(): Promise<ScrapedWorldData> {
        await loadDeps();
        const worldJsonPath = path.join(this.worldPath, 'world.json');
        if (!fs.existsSync(worldJsonPath)) {
            throw new Error(`world.json not found in: ${this.worldPath}`);
        }

        // 1. Parse world.json
        const worldJson = JSON.parse(fs.readFileSync(worldJsonPath, 'utf-8'));

        // 2. Read Users DB
        const usersDbPath = path.join(this.worldPath, 'data', 'users');
        const users: ScrapedUser[] = [];

        if (fs.existsSync(usersDbPath)) {
            let db: any = null;
            let tempDbPath: string | null = null;

            try {
                // Attempt 1: Direct Open
                db = new ClassicLevel(usersDbPath, { valueEncoding: 'json' });
                await db.open();
            } catch (err: unknown) {
                // If locked, try Copy-and-Read strategy
                const errorWithCode = err as { code?: unknown; cause?: { code?: unknown } };
                if (errorWithCode.code === 'LEVEL_LOCKED' || errorWithCode.cause?.code === 'LEVEL_LOCKED') {
                    // Close the failed instance (just in case)
                    try {
                        await db.close();
                    } catch (error) {
                        logger.debug('DirectScraper | Ignored close error on locked DB handle:', error);
                    }
                    db = null;

                    try {
                        const os = await import('node:os');
                        tempDbPath = path.join(os.tmpdir(), `sheet-delver-users-${Date.now()}`);

                        logger.info(`DirectScraper | Database locked. Attempting read from snapshot: ${tempDbPath}`);

                        // Copy entire directory to temp
                        // Node 16.7.0+ has fs.cp
                        if (fs.cp) {
                            await new Promise<void>((resolve, reject) => {
                                fs.cp(usersDbPath, tempDbPath, { recursive: true }, (err: any) => {
                                    if (err) reject(err);
                                    else resolve();
                                });
                            });
                        } else {
                            // Fallback for older node? (Unlikely given engine requirements, but safe to just fail)
                            throw new Error('fs.cp not available');
                        }

                        db = new ClassicLevel(tempDbPath, { valueEncoding: 'json' });
                        await db.open();

                    } catch (copyErr) {
                        logger.error('DirectScraper | Failed to create temp snapshot:', copyErr);
                        db = null;
                    }
                } else {
                    logger.error('DirectScraper | Failed to open LevelDB:', err);
                }
            }

            if (db) {
                try {
                    // Iterate through the DB
                    for await (const [_key, value] of db.iterator()) {
                        const user = toScrapedUser(value);
                        if (user) {
                            users.push(user);
                        }
                    }
                } catch (readErr) {
                    logger.error('DirectScraper | Iteration error:', readErr);
                } finally {
                    try {
                        await db.close();
                    } catch (error) {
                        logger.debug('DirectScraper | Ignored close error during DB cleanup:', error);
                    }

                    // Cleanup temp dir if created
                    if (tempDbPath && fs.existsSync(tempDbPath)) {
                        try {
                            fs.rmSync(tempDbPath, { recursive: true, force: true });
                        } catch (cleanErr) {
                            logger.error('DirectScraper | Failed to cleanup temp DB:', cleanErr);
                        }
                    }
                }
            }
        }

        // 3. Construct Result
        return {
            id: worldJson.id,
            title: worldJson.title,
            system: worldJson.system,
            version: worldJson.coreVersion,
            background: worldJson.background, // This might be relative, might need resolving but raw is fine for now
            description: worldJson.description,
            users: users.sort((a, b) => b.role - a.role) // Highest role first (GM)
        };
    }
}
