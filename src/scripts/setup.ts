
/// <reference types="node" />

import inquirer from 'inquirer';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import yaml from 'js-yaml';
import { logger } from '../shared/utils/logger';
import { resolveDataDir, initDataDir, getConfigFilePath, getDataDir } from '../server/core/paths';

// Resolve and initialize data directory before anything else
const dataDir = resolveDataDir(process.argv);
initDataDir(dataDir);

const SETTINGS_PATH = getConfigFilePath();

function generateServiceToken(): string {
    return randomBytes(32).toString('hex');
}

function generateAdminSetupToken(): string {
    return randomBytes(32).toString('hex');
}

function buildAppUrl(protocol: string, host: string, port: number): string {
    const isStandardPort = (protocol === 'http' && port === 80) || (protocol === 'https' && port === 443);
    return `${protocol}://${host}${isStandardPort ? '' : `:${port}`}`;
}

async function main() {
    logger.info('\x1b[36m%s\x1b[0m', '--- SheetDelver Configuration Setup ---');

    if (fs.existsSync(SETTINGS_PATH)) {
        const { overwrite } = await inquirer.prompt([
            {
                type: 'confirm',
                name: 'overwrite',
                message: 'settings.yaml already exists. Overwrite?',
                default: false
            }
        ]);

        if (!overwrite) {
            logger.info('Setup cancelled. Existing configuration preserved.');
            process.exit(0);
        }
    }

    const answers = await inquirer.prompt([
        // App Settings
        {
            type: 'input',
            name: 'appHost',
            message: 'App Host:',
            default: 'localhost'
        },
        {
            type: 'number',
            name: 'appPort',
            message: 'App Port:',
            default: 3000
        },
        {
            type: 'number',
            name: 'apiPort',
            message: 'API Port (internal):',
            default: 3001
        },
        {
            type: 'list',
            name: 'appProtocol',
            message: 'App Protocol:',
            choices: ['http', 'https'],
            default: 'http'
        },
        {
            type: 'number',
            name: 'chatHistory',
            message: 'Chat History Limit:',
            default: 100
        },
        // Foundry Settings
        {
            type: 'input',
            name: 'foundryHost',
            message: 'Foundry VTT Host:',
            default: 'localhost'
        },
        {
            type: 'number',
            name: 'foundryPort',
            message: 'Foundry VTT Port:',
            default: 30000
        },
        {
            type: 'list',
            name: 'foundryProtocol',
            message: 'Foundry VTT Protocol:',
            choices: ['http', 'https'],
            default: 'http'
        },
        {
            type: 'input',
            name: 'foundryUsername',
            message: 'Foundry Username (GM/Assistant):',
            default: 'gamemaster'
        },
        {
            type: 'password',
            name: 'foundryPassword',
            message: 'Foundry Password:',
        },
        {
            type: 'input',
            name: 'foundryDataDir',
            message: 'Foundry Data Directory (Optional, for imports):',
        },
        {
            type: 'confirm',
            name: 'debugEnabled',
            message: 'Enable Debug Logging?',
            default: false
        },
        {
            type: 'list',
            name: 'debugLevel',
            message: 'Debug Level:',
            choices: [
                { name: '0 - None', value: 0 },
                { name: '1 - Error', value: 1 },
                { name: '2 - Warn', value: 2 },
                { name: '3 - Info', value: 3 },
                { name: '4 - Debug', value: 4 }
            ],
            default: 1,
            when: (answers) => answers.debugEnabled
        }
    ]);

    const config = {
        app: {
            host: answers.appHost,
            port: answers.appPort,
            "api-port": answers.apiPort,
            protocol: answers.appProtocol,
            "chat-history": answers.chatHistory
        },
        foundry: {
            host: answers.foundryHost,
            port: answers.foundryPort,
            protocol: answers.foundryProtocol,
            connector: 'socket',
            username: answers.foundryUsername,
            password: answers.foundryPassword,
            "allow-live-compendium-uuid-fallback": false,
            ...(answers.foundryDataDir ? { foundryDataDirectory: answers.foundryDataDir } : {})
        },
        debug: {
            enabled: answers.debugEnabled,
            level: answers.debugLevel || 1
        },
        security: {
            "rate-limit": {
                enabled: true,
                "window-minutes": 15,
                "max-attempts": 5
            },
            "body-limit": "10mb",
            cors: {
                "allow-all-origins": false,
                "allowed-origins": [buildAppUrl(answers.appProtocol, answers.appHost, answers.appPort)]
            },
            "service-token": generateServiceToken(),
            "admin-setup-token": generateAdminSetupToken()
        }
    };

    const yamlStr = yaml.dump(config);

    // Ensure config directory exists before writing
    const configDir = path.dirname(SETTINGS_PATH);
    if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
    }

    fs.writeFileSync(SETTINGS_PATH, yamlStr, 'utf8');

    logger.info(`\n\x1b[32mConfiguration saved to ${SETTINGS_PATH}\x1b[0m`);
    logger.info(`Data directory: ${getDataDir()}`);
    logger.info('You can now run:');
    logger.info('  npm run dev      (Development)');
    logger.info('  npm run build && npm start (Production)');
}

main().catch(err => {
    logger.error('Setup failed:', err);
    process.exit(1);
});
