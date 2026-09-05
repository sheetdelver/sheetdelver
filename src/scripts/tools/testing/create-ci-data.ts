import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import {
    getConfigFilePath,
    getCacheDir,
    initDataDir,
    writeOwnerOnlyFileAtomicSync,
} from '@server/core/paths';
import { logger } from '@shared/utils/logger';

/** Build-only configuration contains no reusable credential or real deployment path. */
export function createCiSettingsDocument() {
    return {
        app: {
            host: 'localhost',
            port: 3000,
            'api-port': 3001,
            'admin-origin': 'http://localhost:3000',
            protocol: 'http',
            'chat-history': 100,
        },
        foundry: {
            host: 'localhost',
            port: 30000,
            protocol: 'http',
            connector: 'socket',
            username: 'ci-build-user',
            'allow-live-compendium-uuid-fallback': false,
        },
        debug: {
            enabled: false,
            level: 1,
        },
        security: {
            'rate-limit': {
                enabled: true,
                'window-minutes': 15,
                'max-attempts': 5,
            },
            'body-limit': '10mb',
            admin: {
                'allowed-networks': ['127.0.0.0/8', '::1/128'],
            },
            cors: {
                'allow-all-origins': false,
                'allowed-origins': ['http://localhost:3000'],
            },
        },
    };
}

interface CiFixtureEnvironment {
    SHEET_DELVER_DATA?: string;
}

export function createCiDataFixture(
    env: CiFixtureEnvironment = process.env as CiFixtureEnvironment,
): string {
    const configuredDataDir = env.SHEET_DELVER_DATA?.trim();
    if (!configuredDataDir) {
        throw new Error('SHEET_DELVER_DATA must explicitly select an isolated CI data directory');
    }

    const dataDir = path.resolve(configuredDataDir);
    const relativeToWorkspace = path.relative(process.cwd(), dataDir);
    const isInsideWorkspace = relativeToWorkspace === ''
        || (!relativeToWorkspace.startsWith('..') && !path.isAbsolute(relativeToWorkspace));
    if (isInsideWorkspace || dataDir === path.parse(dataDir).root) {
        throw new Error('CI data directory must be outside the workspace and filesystem root');
    }

    initDataDir(dataDir);
    const settingsPath = getConfigFilePath();
    if (fs.existsSync(settingsPath)) {
        throw new Error(`Refusing to overwrite existing CI settings at ${settingsPath}`);
    }

    // Reuse the production owner-only atomic writer so CI exercises the same
    // settings-file creation boundary without duplicating shell YAML.
    writeOwnerOnlyFileAtomicSync(
        settingsPath,
        yaml.dump(createCiSettingsDocument(), { noRefs: true }),
    );

    // Production start requires the setup cache file to exist. This fixture
    // deliberately represents setup state and contains no copied world data.
    writeOwnerOnlyFileAtomicSync(
        path.join(getCacheDir(), 'core', 'worlds.json'),
        JSON.stringify({ worlds: {}, currentWorldId: null }, null, 2),
    );
    return settingsPath;
}

function main(): void {
    try {
        const settingsPath = createCiDataFixture();
        logger.info(`[CI Fixture] Generated isolated settings at ${settingsPath}`);
    } catch (error: unknown) {
        logger.error('[CI Fixture] Failed to generate isolated settings:', error);
        process.exitCode = 1;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main();
}
