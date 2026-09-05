
/// <reference types="node" />

import inquirer from 'inquirer';
import fs from 'node:fs';
import yaml from 'js-yaml';
import { logger } from '../shared/utils/logger';
import {
    resolveDataDir,
    initDataDir,
    getConfigFilePath,
    getDataDir,
    writeOwnerOnlyFileAtomicSync,
} from '../server/core/paths';
import { loadAdminAccount } from '../server/security/adminCredentialStore';
import { issueAdminBootstrapCredential } from '../server/security/adminOneTimeCredentialStore';
import { validateAdminAllowedNetworks } from '../server/security/adminNetwork';

// Resolve and initialize data directory before anything else
const dataDir = resolveDataDir(process.argv);
initDataDir(dataDir);

const SETTINGS_PATH = getConfigFilePath();

function buildAppUrl(protocol: string, host: string, port: number): string {
    const isStandardPort = (protocol === 'http' && port === 80) || (protocol === 'https' && port === 443);
    return `${protocol}://${host}${isStandardPort ? '' : `:${port}`}`;
}

function validateEnvironmentName(value: string): true | string {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
        ? true
        : 'Enter a valid environment variable name.';
}

function validateAdminOrigin(value: string): true | string {
    try {
        const url = new URL(value);
        return (url.protocol === 'http:' || url.protocol === 'https:')
            && url.pathname === '/' && !url.search && !url.hash
            ? true
            : 'Enter an HTTP(S) origin without a path, query, or fragment.';
    } catch {
        return 'Enter a valid absolute HTTP(S) origin.';
    }
}

function parseAdminNetworks(value: string): string[] {
    return value.split(',').map((network) => network.trim()).filter(Boolean);
}

function validateAdminNetworks(value: string): true | string {
    try {
        validateAdminAllowedNetworks(parseAdminNetworks(value));
        return true;
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
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
            type: 'input',
            name: 'adminOrigin',
            message: 'Local Admin Browser Origin:',
            default: (answers) => buildAppUrl(answers.appProtocol, answers.appHost, answers.appPort),
            validate: validateAdminOrigin,
        },
        {
            type: 'input',
            name: 'adminAllowedNetworks',
            message: 'Admin Allowed Networks (comma-separated CIDRs):',
            default: '127.0.0.0/8, ::1/128',
            validate: validateAdminNetworks,
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
            name: 'foundryUsernameEnv',
            message: 'Foundry Username Environment Variable:',
            default: 'FOUNDRY_USERNAME',
            validate: validateEnvironmentName,
        },
        {
            type: 'input',
            name: 'foundryPasswordEnv',
            message: 'Foundry Password Environment Variable:',
            default: 'FOUNDRY_PASSWORD',
            validate: validateEnvironmentName,
        },
        {
            type: 'input',
            name: 'foundryDataDir',
            message: 'Foundry Data Directory (Optional, for imports):',
        },
        {
            type: 'input',
            name: 'serviceTokenEnv',
            message: 'Service Token Environment Variable:',
            default: 'APP_SERVICE_TOKEN',
            validate: validateEnvironmentName,
        },
        {
            type: 'confirm',
            name: 'configureFoundrySessionKey',
            message: 'Configure an explicit Foundry session key instead of the automatic host key?',
            default: false,
        },
        {
            type: 'input',
            name: 'foundrySessionKeyEnv',
            message: 'Foundry Session Key Environment Variable:',
            default: 'APP_FOUNDRY_SESSION_KEY',
            validate: validateEnvironmentName,
            when: (answers) => answers.configureFoundrySessionKey,
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
            "admin-origin": answers.adminOrigin,
            protocol: answers.appProtocol,
            "chat-history": answers.chatHistory
        },
        foundry: {
            host: answers.foundryHost,
            port: answers.foundryPort,
            protocol: answers.foundryProtocol,
            connector: 'socket',
            username: { env: answers.foundryUsernameEnv },
            password: { env: answers.foundryPasswordEnv },
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
            admin: {
                "allowed-networks": parseAdminNetworks(answers.adminAllowedNetworks),
            },
            cors: {
                "allow-all-origins": false,
                "allowed-origins": [buildAppUrl(answers.appProtocol, answers.appHost, answers.appPort)]
            },
            "service-token": { env: answers.serviceTokenEnv },
            // Omitting this reference selects Core's owner-only automatic host key.
            ...(answers.configureFoundrySessionKey
                ? { "foundry-session-key": { env: answers.foundrySessionKeyEnv } }
                : {})
        }
    };

    const yamlStr = yaml.dump(config);

    // Settings now contains references rather than reusable secret values, but
    // retains owner-only atomic replacement as defense in depth.
    writeOwnerOnlyFileAtomicSync(SETTINGS_PATH, yamlStr);

    logger.info(`\n\x1b[32mConfiguration saved to ${SETTINGS_PATH}\x1b[0m`);
    logger.info(`Data directory: ${getDataDir()}`);
    logger.info('Set the referenced environment configuration before startup:');
    logger.info(`  ${answers.foundryUsernameEnv}=<Foundry service-account username>`);
    logger.info(`  ${answers.foundryPasswordEnv}=<Foundry password>`);
    logger.info(`  ${answers.serviceTokenEnv}=<32+ byte random service token>`);
    if (answers.configureFoundrySessionKey) {
        logger.info(`  ${answers.foundrySessionKeyEnv}=base64:<32-byte random key>`);
    }

    if (!await loadAdminAccount()) {
        const issued = issueAdminBootstrapCredential();
        logger.info('One-time admin bootstrap credential (valid for 60 minutes):');
        logger.info(issued.token);
    }
    logger.info('You can now run:');
    logger.info('  npm run dev      (Development)');
    logger.info('  npm run build && npm start (Production)');
}

main().catch(err => {
    logger.error('Setup failed:', err);
    process.exit(1);
});
