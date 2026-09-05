import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    createCipheriv,
    createDecipheriv,
    createHash,
    randomBytes,
} from 'node:crypto';
import { logger } from '@shared/utils/logger';
import {
    getCacheDir,
    getSecurityDir,
    ensureOwnerOnlyFileSync,
    writeOwnerOnlyFileAtomicSync,
} from '@server/core/paths';

const ENVELOPE_VERSION = 1;
const ENVELOPE_ALGORITHM = 'aes-256-gcm';
const ENVELOPE_AAD = Buffer.from('sheet-delver/foundry-sessions/v1', 'utf8');

export interface PersistedFoundrySessionRecord {
    username?: string;
    userId?: string;
    cookie?: string;
    worldId?: string;
    lastSaved?: number;
}

export type PersistedFoundrySessions = Record<string, PersistedFoundrySessionRecord>;

interface EncryptedSessionEnvelope {
    version: 1;
    algorithm: 'aes-256-gcm';
    keyId: string;
    iv: string;
    authTag: string;
    ciphertext: string;
}

interface SessionPlaintextEnvelope {
    version: 1;
    sessions: PersistedFoundrySessions;
}

export interface FoundrySessionStore {
    readonly enabled: boolean;
    initialize(): Promise<void>;
    load(): Promise<PersistedFoundrySessions>;
    save(sessions: PersistedFoundrySessions): Promise<void>;
    clear(): Promise<void>;
}

export interface EncryptedFoundrySessionStoreOptions {
    filePath: string;
    legacyFilePath: string;
    currentKey: Buffer;
    previousKey?: Buffer;
}

function isInside(parent: string, candidate: string): boolean {
    const relative = path.relative(path.resolve(parent), path.resolve(candidate));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Resolve a not-yet-created target through the nearest existing real ancestor. */
function resolvePhysicalTarget(targetPath: string): string {
    let existingAncestor = path.resolve(targetPath);
    const missingSegments: string[] = [];

    while (!fs.existsSync(existingAncestor)) {
        const parent = path.dirname(existingAncestor);
        if (parent === existingAncestor) break;
        missingSegments.unshift(path.basename(existingAncestor));
        existingAncestor = parent;
    }

    const physicalAncestor = fs.realpathSync(existingAncestor);
    return path.join(physicalAncestor, ...missingSegments);
}

/** Stable machine-local key location used when an installation has no explicit key. */
export function getDefaultFoundrySessionKeyPath(
    env: Readonly<Record<string, string | undefined>> = process.env,
    homeDirectory = os.homedir(),
): string {
    const configuredHome = env.XDG_CONFIG_HOME?.trim();
    const configHome = configuredHome ? path.resolve(configuredHome) : path.join(homeDirectory, '.config');
    return path.join(configHome, 'sheet-delver', 'foundry-session.key');
}

function loadOrCreateHostKey(keyFilePath: string, encryptedFilePath: string, dataDir?: string): string {
    const resolvedKeyPath = path.resolve(keyFilePath);
    // Resolve parent symlinks even before the key exists; lexical separation is
    // insufficient when XDG_CONFIG_HOME or one of its parents is a symlink.
    const physicalKeyPath = resolvePhysicalTarget(resolvedKeyPath);
    const physicalDataDir = dataDir ? resolvePhysicalTarget(dataDir) : undefined;
    if (physicalDataDir && isInside(physicalDataDir, physicalKeyPath)) {
        throw new Error('Automatic Foundry session key must be outside <DATA_DIR>');
    }

    if (fs.existsSync(resolvedKeyPath)) {
        ensureOwnerOnlyFileSync(resolvedKeyPath);
        const stat = fs.lstatSync(resolvedKeyPath);
        if (stat.isSymbolicLink() || !stat.isFile()) {
            throw new Error(`Automatic Foundry session key must be a regular non-symlink file: ${resolvedKeyPath}`);
        }
        const value = fs.readFileSync(resolvedKeyPath, 'utf8').replace(/\r?\n$/, '');
        decodeKey(value, 'Automatic Foundry session key');
        return value;
    }

    // Losing a key must not silently replace it while an unreadable envelope remains.
    if (fs.existsSync(encryptedFilePath)) {
        throw new Error(
            `Automatic Foundry session key is missing at ${resolvedKeyPath}; `
            + 'restore the key or configure APP_FOUNDRY_SESSION_KEY before startup',
        );
    }

    const value = `base64:${randomBytes(32).toString('base64')}`;
    writeOwnerOnlyFileAtomicSync(resolvedKeyPath, value);
    logger.warn(`FoundrySessionStore | Generated owner-only host session key at ${resolvedKeyPath}.`);
    return value;
}

function keyId(key: Buffer): string {
    return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function decodeKey(value: string, label: string): Buffer {
    const trimmed = value.trim();
    let key: Buffer;
    if (trimmed.startsWith('hex:')) {
        const encoded = trimmed.slice(4);
        if (!/^[0-9a-fA-F]{64}$/.test(encoded)) {
            throw new Error(`${label} must contain exactly 64 hexadecimal characters after hex:`);
        }
        key = Buffer.from(encoded, 'hex');
    } else if (trimmed.startsWith('base64:')) {
        const encoded = trimmed.slice(7);
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
            throw new Error(`${label} contains invalid base64 data`);
        }
        key = Buffer.from(encoded, 'base64');
    } else {
        throw new Error(`${label} must use an explicit base64: or hex: prefix`);
    }
    if (key.length !== 32) {
        throw new Error(`${label} must decode to exactly 32 bytes`);
    }
    return key;
}

function isSessionMap(value: unknown): value is PersistedFoundrySessions {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return Object.values(value).every((record) => {
        if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
        const candidate = record as PersistedFoundrySessionRecord;
        return (candidate.username === undefined || typeof candidate.username === 'string')
            && (candidate.userId === undefined || typeof candidate.userId === 'string')
            && (candidate.cookie === undefined || typeof candidate.cookie === 'string')
            && (candidate.worldId === undefined || typeof candidate.worldId === 'string')
            && (candidate.lastSaved === undefined || typeof candidate.lastSaved === 'number');
    });
}

function removeRegularFile(filePath: string): void {
    if (!fs.existsSync(filePath)) return;
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`Refusing non-regular Foundry session file: ${filePath}`);
    }
    fs.unlinkSync(filePath);
}

export class EncryptedFoundrySessionStore implements FoundrySessionStore {
    public readonly enabled = true;
    private readonly filePath: string;
    private readonly legacyFilePath: string;
    private readonly currentKey: Buffer;
    private readonly previousKey?: Buffer;
    private initialization?: Promise<void>;

    public constructor(options: EncryptedFoundrySessionStoreOptions) {
        this.filePath = options.filePath;
        this.legacyFilePath = options.legacyFilePath;
        this.currentKey = Buffer.from(options.currentKey);
        this.previousKey = options.previousKey ? Buffer.from(options.previousKey) : undefined;
        if (this.currentKey.length !== 32 || (this.previousKey && this.previousKey.length !== 32)) {
            throw new Error('Foundry session encryption keys must be exactly 32 bytes');
        }
    }

    public initialize(): Promise<void> {
        if (!this.initialization) {
            this.initialization = Promise.resolve().then(() => this.migrateLegacyPlaintext());
        }
        return this.initialization;
    }

    public async load(): Promise<PersistedFoundrySessions> {
        await this.initialize();
        if (!fs.existsSync(this.filePath)) return {};

        const rawEnvelope = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as EncryptedSessionEnvelope;
        const { sessions, usedPreviousKey } = this.decrypt(rawEnvelope);
        if (usedPreviousKey) {
            // Successful previous-key decryption is the rotation commit point.
            // Rewrite immediately with the current key before serving sessions.
            this.writeEncrypted(sessions);
            logger.info('FoundrySessionStore | Re-encrypted persisted sessions with the current rotation key.');
        }
        return sessions;
    }

    public async save(sessions: PersistedFoundrySessions): Promise<void> {
        await this.initialize();
        if (Object.keys(sessions).length === 0) {
            removeRegularFile(this.filePath);
            return;
        }
        this.writeEncrypted(sessions);
    }

    public async clear(): Promise<void> {
        await this.initialize();
        removeRegularFile(this.filePath);
    }

    private migrateLegacyPlaintext(): void {
        if (!fs.existsSync(this.legacyFilePath)) return;

        // An existing encrypted store is authoritative. Any leftover legacy
        // cache is removed so plaintext credentials cannot survive migration.
        if (fs.existsSync(this.filePath)) {
            removeRegularFile(this.legacyFilePath);
            logger.warn('FoundrySessionStore | Removed stale plaintext session cache after encrypted migration.');
            return;
        }

        const parsed = JSON.parse(fs.readFileSync(this.legacyFilePath, 'utf8')) as unknown;
        if (!isSessionMap(parsed)) {
            throw new Error(`Legacy Foundry session cache has an invalid shape: ${this.legacyFilePath}`);
        }
        if (Object.keys(parsed).length > 0) {
            this.writeEncrypted(parsed);
        }
        removeRegularFile(this.legacyFilePath);
        logger.warn('FoundrySessionStore | Migrated plaintext Foundry sessions to authenticated encryption.');
    }

    private writeEncrypted(sessions: PersistedFoundrySessions): void {
        const iv = randomBytes(12);
        const cipher = createCipheriv(ENVELOPE_ALGORITHM, this.currentKey, iv);
        cipher.setAAD(ENVELOPE_AAD);
        const plaintext: SessionPlaintextEnvelope = {
            version: ENVELOPE_VERSION,
            sessions,
        };
        const ciphertext = Buffer.concat([
            cipher.update(JSON.stringify(plaintext), 'utf8'),
            cipher.final(),
        ]);
        const envelope: EncryptedSessionEnvelope = {
            version: ENVELOPE_VERSION,
            algorithm: ENVELOPE_ALGORITHM,
            keyId: keyId(this.currentKey),
            iv: iv.toString('base64'),
            authTag: cipher.getAuthTag().toString('base64'),
            ciphertext: ciphertext.toString('base64'),
        };
        writeOwnerOnlyFileAtomicSync(this.filePath, JSON.stringify(envelope));
    }

    private decrypt(envelope: EncryptedSessionEnvelope): {
        sessions: PersistedFoundrySessions;
        usedPreviousKey: boolean;
    } {
        if (envelope.version !== ENVELOPE_VERSION || envelope.algorithm !== ENVELOPE_ALGORITHM) {
            throw new Error('Unsupported Foundry session encryption envelope');
        }

        const candidates = [
            { key: this.currentKey, previous: false },
            ...(this.previousKey ? [{ key: this.previousKey, previous: true }] : []),
        ];
        const candidate = candidates.find(({ key }) => keyId(key) === envelope.keyId);
        if (!candidate) {
            throw new Error('No configured key matches the persisted Foundry session envelope');
        }

        try {
            const decipher = createDecipheriv(
                ENVELOPE_ALGORITHM,
                candidate.key,
                Buffer.from(envelope.iv, 'base64'),
            );
            decipher.setAAD(ENVELOPE_AAD);
            decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
            const plaintext = Buffer.concat([
                decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
                decipher.final(),
            ]);
            const parsed = JSON.parse(plaintext.toString('utf8')) as SessionPlaintextEnvelope;
            if (parsed.version !== ENVELOPE_VERSION || !isSessionMap(parsed.sessions)) {
                throw new Error('Decrypted Foundry session payload has an invalid shape');
            }
            return { sessions: parsed.sessions, usedPreviousKey: candidate.previous };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Foundry session decryption/authentication failed: ${message}`);
        }
    }
}

class DisabledFoundrySessionStore implements FoundrySessionStore {
    public readonly enabled = false;
    private initialized = false;

    public constructor(private readonly legacyFilePath: string) {}

    public async initialize(): Promise<void> {
        if (this.initialized) return;
        this.initialized = true;
        if (fs.existsSync(this.legacyFilePath)) {
            removeRegularFile(this.legacyFilePath);
            logger.warn('FoundrySessionStore | Removed plaintext session cache; cross-restart restoration is disabled without an external key.');
        } else {
            logger.warn('FoundrySessionStore | Cross-restart Foundry session restoration is disabled; APP_FOUNDRY_SESSION_KEY is not configured.');
        }
    }

    public async load(): Promise<PersistedFoundrySessions> {
        await this.initialize();
        return {};
    }

    public async save(_sessions: PersistedFoundrySessions): Promise<void> {
        await this.initialize();
    }

    public async clear(): Promise<void> {
        await this.initialize();
    }
}

export function createFoundrySessionStoreFromEnvironment(options: {
    env?: Readonly<Record<string, string | undefined>>;
    filePath?: string;
    legacyFilePath?: string;
    autoKeyFilePath?: string;
    dataDir?: string;
} = {}): FoundrySessionStore {
    const env = options.env ?? process.env;
    const legacyFilePath = options.legacyFilePath ?? path.join(getCacheDir(), 'core', 'sessions.json');
    const filePath = options.filePath ?? path.join(getSecurityDir(), 'foundry-sessions.enc.json');
    let currentValue = env.APP_FOUNDRY_SESSION_KEY;
    const previousValue = env.APP_FOUNDRY_SESSION_PREVIOUS_KEY;

    if (!currentValue) {
        if (previousValue) {
            throw new Error('APP_FOUNDRY_SESSION_PREVIOUS_KEY requires APP_FOUNDRY_SESSION_KEY');
        }
        if (options.autoKeyFilePath) {
            currentValue = loadOrCreateHostKey(
                options.autoKeyFilePath,
                filePath,
                options.dataDir,
            );
        }
    }

    if (!currentValue) {
        return new DisabledFoundrySessionStore(legacyFilePath);
    }

    return new EncryptedFoundrySessionStore({
        filePath,
        legacyFilePath,
        currentKey: decodeKey(currentValue, 'APP_FOUNDRY_SESSION_KEY'),
        previousKey: previousValue
            ? decodeKey(previousValue, 'APP_FOUNDRY_SESSION_PREVIOUS_KEY')
            : undefined,
    });
}
