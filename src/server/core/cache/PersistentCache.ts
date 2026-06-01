import { logger } from '@shared/utils/logger';
import { getCacheDir } from '@core/paths';

// Browser-safe Dynamic Imports
let fs: any = null;
let path: any = null;
const isBrowser = typeof window !== 'undefined';

async function loadDeps() {
    if (isBrowser) return false;
    if (fs && path) return true;
    try {
        // Use node: prefix and dynamic import to satisfy both ESM and Bundlers
        const fsMod = await import(/* webpackIgnore: true */ 'node:fs');
        const pathMod = await import(/* webpackIgnore: true */ 'node:path');
        fs = fsMod.default || fsMod;
        path = pathMod.default || pathMod;
        return true;
    } catch (e) {
        logger.error('PersistentCache | Failed to load Node.js modules:', e);
        return false;
    }
}

export class PersistentCache {
    private static instance: PersistentCache;
    private baseDir: string | null = null;
    private initPromise: Promise<void> | null = null;

    private constructor() { }

    public static getInstance(): PersistentCache {
        if (!PersistentCache.instance) {
            PersistentCache.instance = new PersistentCache();
        }
        return PersistentCache.instance;
    }

    private async ensureInitialized() {
        if (isBrowser) return;
        if (this.baseDir) return;
        if (this.initPromise) return this.initPromise;

        this.initPromise = (async () => {
            if (await loadDeps()) {
                try {
                    // Use the centralized data directory resolver for cache storage
                    this.baseDir = getCacheDir();

                    if (process.env.DEBUG) {
                        logger.info(`PersistentCache | Initialized with base directory: ${this.baseDir}`);
                    }

                    if (!fs.existsSync(this.baseDir)) {
                        fs.mkdirSync(this.baseDir, { recursive: true });
                    }
                } catch (e) {
                    logger.error('PersistentCache | Failed to initialize base directory:', e);
                }
            }
        })();

        return this.initPromise;
    }

    private async getFilePath(namespace: string, key: string): Promise<string | null> {
        await this.ensureInitialized();
        if (isBrowser || !this.baseDir || !fs || !path) return null;

        const nsDir = path.join(this.baseDir, namespace);
        if (!fs.existsSync(nsDir)) {
            try {
                fs.mkdirSync(nsDir, { recursive: true });
            } catch (e) {
                return null;
            }
        }
        return path.join(nsDir, `${key}.json`);
    }

    public async set<T>(namespace: string, key: string, data: T): Promise<void> {
        if (isBrowser) return;
        const filePath = await this.getFilePath(namespace, key);
        if (!filePath || !fs) return;

        const tempPath = `${filePath}.${Date.now()}.tmp`;

        try {
            const content = JSON.stringify(data, null, 2);
            await fs.promises.writeFile(tempPath, content, 'utf-8');
            await fs.promises.rename(tempPath, filePath);
            logger.debug(`PersistentCache | Saved ${namespace}/${key}`);
        } catch (error) {
            logger.error(`PersistentCache | Failed to save ${namespace}/${key}:`, error);
            if (fs.existsSync && fs.existsSync(tempPath)) {
                await fs.promises.unlink(tempPath).catch(() => { });
            }
            throw error;
        }
    }

    public async get<T>(namespace: string, key: string): Promise<T | null> {
        if (isBrowser) return null;
        const filePath = await this.getFilePath(namespace, key);

        if (!filePath || !fs || !fs.existsSync(filePath)) {
            logger.debug(`PersistentCache | MISS: ${namespace}/${key} (Path: ${filePath || 'N/A'})`);
            return null;
        }

        try {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            logger.debug(`PersistentCache | HIT: ${namespace}/${key}`);
            return JSON.parse(content) as T;
        } catch (error) {
            logger.error(`PersistentCache | Failed to read ${namespace}/${key}:`, error);
            return null;
        }
    }

    public async has(namespace: string, key: string): Promise<boolean> {
        await this.ensureInitialized();
        if (isBrowser || !this.baseDir || !fs || !path) return false;
        return fs.existsSync(path.join(this.baseDir, namespace, `${key}.json`));
    }

    /** List stored keys under a namespace (extension stripped), optionally filtered by prefix. */
    public async keys(namespace: string, prefix?: string): Promise<string[]> {
        await this.ensureInitialized();
        if (isBrowser || !this.baseDir || !fs || !path) return [];
        const nsDir = path.join(this.baseDir, namespace);
        if (!fs.existsSync(nsDir)) return [];
        try {
            const entries: string[] = await fs.promises.readdir(nsDir);
            return entries
                .filter((name: string) => name.endsWith('.json'))
                .map((name: string) => name.slice(0, -('.json'.length)))
                .filter((key: string) => (prefix ? key.startsWith(prefix) : true));
        } catch (error) {
            logger.error(`PersistentCache | Failed to list keys for ${namespace}:`, error);
            return [];
        }
    }

    public async delete(namespace: string, key: string): Promise<void> {
        return this.remove(namespace, key);
    }

    public async remove(namespace: string, key: string): Promise<void> {
        if (isBrowser) return;
        const filePath = await this.getFilePath(namespace, key);
        if (filePath && fs && fs.existsSync(filePath)) {
            await fs.promises.unlink(filePath).catch((err: unknown) => {
                logger.error(`PersistentCache | Failed to remove ${namespace}/${key}:`, err);
            });
        }
    }

    public async clearNamespace(namespace: string): Promise<void> {
        await this.ensureInitialized();
        if (isBrowser || !this.baseDir || !fs || !path) return;
        const nsDir = path.join(this.baseDir, namespace);
        if (fs.existsSync(nsDir)) {
            await fs.promises.rm(nsDir, { recursive: true, force: true }).catch((err: unknown) => {
                logger.error(`PersistentCache | Failed to clear namespace ${namespace}:`, err);
            });
        }
    }
}

export const persistentCache = PersistentCache.getInstance();
