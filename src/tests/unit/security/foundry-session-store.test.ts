import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    EncryptedFoundrySessionStore,
    createFoundrySessionStoreFromEnvironment,
    type PersistedFoundrySessions,
} from '@server/security/foundrySessionStore';

const KEY_A = Buffer.alloc(32, 0x11);
const KEY_B = Buffer.alloc(32, 0x22);
const SESSIONS: PersistedFoundrySessions = {
    'browser-session-id': {
        username: 'ptest',
        userId: 'foundry-user-1',
        cookie: 'session=plaintext-cookie-value; foundry=secret',
        worldId: 'world-1',
        lastSaved: 123456789,
    },
};

function keyEnv(key: Buffer): string {
    return `base64:${key.toString('base64')}`;
}

function createPaths(root: string) {
    return {
        filePath: path.join(root, 'security', 'foundry-sessions.enc.json'),
        legacyFilePath: path.join(root, 'cache', 'core', 'sessions.json'),
    };
}

function writeLegacy(filePath: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(SESSIONS), 'utf8');
}

export async function run(): Promise<void> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-delver-foundry-session-store-'));
    try {
        const encryptedPaths = createPaths(path.join(root, 'encrypted'));
        const store = new EncryptedFoundrySessionStore({
            ...encryptedPaths,
            currentKey: KEY_A,
        });
        await store.save(SESSIONS);

        const raw = fs.readFileSync(encryptedPaths.filePath, 'utf8');
        assert.doesNotMatch(raw, /plaintext-cookie-value|ptest|foundry-user-1/);
        assert.equal((JSON.parse(raw) as any).algorithm, 'aes-256-gcm');
        if (process.platform !== 'win32') {
            assert.equal(fs.statSync(encryptedPaths.filePath).mode & 0o777, 0o600);
        }
        assert.deepEqual(await store.load(), SESSIONS);

        const reloaded = new EncryptedFoundrySessionStore({
            ...encryptedPaths,
            currentKey: KEY_A,
        });
        assert.deepEqual(await reloaded.load(), SESSIONS);

        const wrongKeyStore = new EncryptedFoundrySessionStore({
            ...encryptedPaths,
            currentKey: KEY_B,
        });
        await assert.rejects(() => wrongKeyStore.load(), /No configured key matches/);

        const tamperedEnvelope = JSON.parse(raw);
        tamperedEnvelope.ciphertext = `${tamperedEnvelope.ciphertext[0] === 'A' ? 'B' : 'A'}${tamperedEnvelope.ciphertext.slice(1)}`;
        fs.writeFileSync(encryptedPaths.filePath, JSON.stringify(tamperedEnvelope), 'utf8');
        const tamperedStore = new EncryptedFoundrySessionStore({
            ...encryptedPaths,
            currentKey: KEY_A,
        });
        await assert.rejects(() => tamperedStore.load(), /authentication failed/);

        const migrationPaths = createPaths(path.join(root, 'migration'));
        writeLegacy(migrationPaths.legacyFilePath);
        const migrationStore = new EncryptedFoundrySessionStore({
            ...migrationPaths,
            currentKey: KEY_A,
        });
        await migrationStore.initialize();
        assert.equal(fs.existsSync(migrationPaths.legacyFilePath), false);
        assert.deepEqual(await migrationStore.load(), SESSIONS);
        assert.doesNotMatch(fs.readFileSync(migrationPaths.filePath, 'utf8'), /plaintext-cookie-value/);

        const disabledPaths = createPaths(path.join(root, 'disabled'));
        writeLegacy(disabledPaths.legacyFilePath);
        const disabledStore = createFoundrySessionStoreFromEnvironment({
            env: {},
            ...disabledPaths,
        });
        assert.equal(disabledStore.enabled, false);
        await disabledStore.initialize();
        assert.equal(fs.existsSync(disabledPaths.legacyFilePath), false);
        assert.deepEqual(await disabledStore.load(), {});

        const automaticPaths = createPaths(path.join(root, 'automatic'));
        const automaticKeyPath = path.join(root, 'host-config', 'foundry-session.key');
        const automaticStore = createFoundrySessionStoreFromEnvironment({
            env: {},
            ...automaticPaths,
            autoKeyFilePath: automaticKeyPath,
            dataDir: path.join(root, 'automatic'),
        });
        assert.equal(automaticStore.enabled, true);
        await automaticStore.save(SESSIONS);
        assert.equal(fs.existsSync(automaticKeyPath), true);
        if (process.platform !== 'win32') {
            assert.equal(fs.statSync(automaticKeyPath).mode & 0o777, 0o600);
        }
        assert.doesNotMatch(fs.readFileSync(automaticKeyPath, 'utf8'), /plaintext-cookie-value/);

        const automaticReload = createFoundrySessionStoreFromEnvironment({
            env: {},
            ...automaticPaths,
            autoKeyFilePath: automaticKeyPath,
            dataDir: path.join(root, 'automatic'),
        });
        assert.deepEqual(await automaticReload.load(), SESSIONS);

        assert.throws(
            () => createFoundrySessionStoreFromEnvironment({
                env: {},
                ...createPaths(path.join(root, 'inside-data')),
                autoKeyFilePath: path.join(root, 'inside-data', 'key'),
                dataDir: path.join(root, 'inside-data'),
            }),
            /outside <DATA_DIR>/,
        );

        if (process.platform !== 'win32') {
            const symlinkDataDir = path.join(root, 'symlink-data');
            const symlinkConfigHome = path.join(root, 'symlink-config-home');
            fs.mkdirSync(symlinkDataDir, { recursive: true });
            fs.symlinkSync(symlinkDataDir, symlinkConfigHome, 'dir');
            assert.throws(
                () => createFoundrySessionStoreFromEnvironment({
                    env: {},
                    ...createPaths(symlinkDataDir),
                    autoKeyFilePath: path.join(symlinkConfigHome, 'sheet-delver', 'foundry-session.key'),
                    dataDir: symlinkDataDir,
                }),
                /outside <DATA_DIR>/,
                'parent symlinks must not place the automatic key physically inside data',
            );
        }

        const missingKeyPaths = createPaths(path.join(root, 'missing-host-key'));
        fs.mkdirSync(path.dirname(missingKeyPaths.filePath), { recursive: true });
        fs.writeFileSync(missingKeyPaths.filePath, '{}', 'utf8');
        assert.throws(
            () => createFoundrySessionStoreFromEnvironment({
                env: {},
                ...missingKeyPaths,
                autoKeyFilePath: path.join(root, 'missing-key', 'foundry-session.key'),
                dataDir: path.join(root, 'missing-host-key'),
            }),
            /Foundry session key is missing/i,
        );

        const rotationPaths = createPaths(path.join(root, 'rotation'));
        const oldStore = new EncryptedFoundrySessionStore({
            ...rotationPaths,
            currentKey: KEY_A,
        });
        await oldStore.save(SESSIONS);
        const beforeRotation = fs.readFileSync(rotationPaths.filePath, 'utf8');

        const rotatingStore = new EncryptedFoundrySessionStore({
            ...rotationPaths,
            currentKey: KEY_B,
            previousKey: KEY_A,
        });
        assert.deepEqual(await rotatingStore.load(), SESSIONS);
        const afterRotation = fs.readFileSync(rotationPaths.filePath, 'utf8');
        assert.notEqual(afterRotation, beforeRotation);
        const currentOnlyStore = new EncryptedFoundrySessionStore({
            ...rotationPaths,
            currentKey: KEY_B,
        });
        assert.deepEqual(await currentOnlyStore.load(), SESSIONS);

        assert.throws(
            () => createFoundrySessionStoreFromEnvironment({
                env: { APP_FOUNDRY_SESSION_KEY: keyEnv(Buffer.alloc(16, 0x33)) },
                ...createPaths(path.join(root, 'invalid')),
            }),
            /32 bytes/,
        );
        assert.throws(
            () => createFoundrySessionStoreFromEnvironment({
                env: { APP_FOUNDRY_SESSION_PREVIOUS_KEY: keyEnv(KEY_A) },
                ...createPaths(path.join(root, 'invalid-rotation')),
            }),
            /requires APP_FOUNDRY_SESSION_KEY/,
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }

    console.log('  - encrypted Foundry session store: all checks passed');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    void run();
}
