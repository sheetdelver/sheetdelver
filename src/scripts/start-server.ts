import { logger } from '../shared/utils/logger';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { spawn, ChildProcess } from 'child_process';
import { resolveDataDir, initDataDir, getConfigFilePath, getCacheDir, getDataDir } from '../server/core/paths';

// Resolve and initialize data directory before anything else
const dataDir = resolveDataDir(process.argv);
initDataDir(dataDir);

const SETTINGS_PATH = getConfigFilePath();

// Default settings
let host = 'localhost';
let port = 3000;
let apiPort = 3001;

// Read settings.yaml from the data directory
try {
    logger.info(`[Manager] Data directory: ${getDataDir()}`);
    logger.info(`[Manager] Looking for settings at: ${SETTINGS_PATH}`);

    if (fs.existsSync(SETTINGS_PATH)) {
        logger.info('[Manager] settings.yaml found.');
        const fileContents = fs.readFileSync(SETTINGS_PATH, 'utf8');
        const settings = yaml.load(fileContents) as any;

        if (settings.app) {
            if (settings.app.host) host = settings.app.host;
            if (settings.app.port) port = settings.app.port;
            if (settings.app['api-port']) apiPort = settings.app['api-port'];
        }

        logger.info(`[Manager] Loading configuration: App=${host}:${port}, API=${apiPort}`);
    } else {
        logger.info(`[Manager] No settings.yaml found at ${SETTINGS_PATH}, using defaults.`);
    }
} catch (e) {
    logger.error('[Manager] Error reading settings.yaml:', e);
}

// Determine command (dev or start)
const args = process.argv.slice(2).filter(a => !a.startsWith('--data-dir'));
const command = args[0] || 'dev'; // Default to dev

// Pre-flight Check: Ensure Cache Exists (Skip for build)
if (command !== 'build') {
    const CACHE_PATH = path.join(getCacheDir(), 'core', 'worlds.json');

    if (!fs.existsSync(CACHE_PATH)) {
        logger.error('\n\x1b[31m[CRITICAL] Cache Missing: World data not found.\x1b[0m');
        logger.error('The application cannot start without initial world data.');
        logger.error('Please run the setup script to initialize the cache:');
        logger.error('\n    \x1b[36mnpm run setup\x1b[0m\n');
        process.exit(1);
    }
}

let coreProcess: ChildProcess | null = null;
let shellProcess: ChildProcess | null = null;

// When the terminal sends a signal, all processes in the same group receive it.
// Skip explicit child kills in that case to avoid sending a duplicate signal.
function cleanup(skipChildSignals = false) {
    logger.info('\n[Manager] Shutting down services...');
    if (!skipChildSignals) {
        if (coreProcess) {
            logger.info('[Manager] Stopping Core Service...');
            coreProcess.kill('SIGINT');
        }
        if (shellProcess) {
            logger.info('[Manager] Stopping Shell Service...');
            shellProcess.kill('SIGINT');
        }
    }
}

// Handle termination signals
process.on('SIGINT', () => {
    cleanup(true);
    process.exit(0);
});

process.on('SIGTERM', () => {
    cleanup(true);
    process.exit(0);
});

async function start() {
    // Handle Build Command
    if (command === 'build') {
        logger.info(`[Manager] Building Application with API_PORT=${apiPort}...`);
        const nextCmd = path.join(process.cwd(), 'node_modules', '.bin', 'next');
        const env = { ...process.env, API_PORT: apiPort.toString(), SHEET_DELVER_DATA: getDataDir() };

        const buildProcess = spawn(nextCmd, ['build'], {
            stdio: 'inherit',
            env
        });

        buildProcess.on('close', (code) => {
            process.exit(code || 0);
        });
        return;
    }

    logger.info('[Manager] Starting Decoupled Architecture...');

    // 0. Generate Dynamic Configuration for Development
    if (command === 'dev') {
        const managedDir = path.join(process.cwd(), '.managed');
        if (!fs.existsSync(managedDir)) {
            fs.mkdirSync(managedDir, { recursive: true });
        }

        const tsconfigPaths = {
            compilerOptions: {
                baseUrl: ".",
                paths: {
                    "@/*": ["../src/*"],
                    "@app/*": ["../src/app/*"],
                    "@client/*": ["../src/client/*"],
                    "@server/*": ["../src/server/*"],
                    "@shared/*": ["../src/shared/*"],
                    "@core/*": ["../src/server/core/*"],
                    "@modules/*": [
                        "../src/modules/*",
                        path.join(getDataDir(), "modules", "*")
                    ]
                }
            }
        };

        fs.writeFileSync(
            path.join(managedDir, 'tsconfig.paths.json'),
            JSON.stringify(tsconfigPaths, null, 2)
        );

        logger.info(`[Manager] Generated dynamic paths at .managed/tsconfig.paths.json`);

        // Generate PostCSS plugin for dynamic Tailwind sources
        const pluginPath = path.join(managedDir, 'postcss-plugin.cjs');
        const dataDir = getDataDir();
        const srcModules = path.join(process.cwd(), 'src', 'modules');

        const pluginContent = `const path = require('path');

module.exports = (opts = {}) => {
  return {
    postcssPlugin: 'dynamic-tailwind-sources',
    Once(root) {
      if (root.raws.dynamicSourcesInjected) return;

      const currentFile = root.source?.input?.file;
      if (!currentFile) return;
      const currentDir = path.dirname(currentFile);

      const DATA_DIR = process.env.SHEET_DELVER_DATA || '${dataDir}';
      if (DATA_DIR) {
        const modulesPath = path.resolve(DATA_DIR, 'modules');
        const relativePath = path.relative(currentDir, modulesPath);
        root.prepend(\`@source "\${relativePath}/**/*.tsx";\`);
      }

      const srcModulesPath = '${srcModules}';
      const relativeSrcPath = path.relative(currentDir, srcModulesPath);
      root.prepend(\`@source "\${relativeSrcPath}/**/*.tsx";\`);

      root.raws.dynamicSourcesInjected = true;
    },
  };
};
module.exports.postcss = true;`;

        fs.writeFileSync(pluginPath, pluginContent);
        logger.info(`[Manager] Generated dynamic PostCSS plugin at .managed/postcss-plugin.cjs`);
    }

    // 1. Start Core Service
    logger.info(`[Manager] Launching Core Service (Express) on port ${apiPort}...`);
    // npx tsx src/server/index.ts
    // We pass the API_PORT via env var as usual, but specific naming might be needed depending on server/index.ts
    // server/index.ts reads config.app.apiPort mostly, but falls back to env.PORT or env.API_PORT

    coreProcess = spawn('npx', ['-y', 'tsx', 'src/server/index.ts'], {
        stdio: 'inherit',
        env: { ...process.env, PORT: apiPort.toString(), API_PORT: apiPort.toString(), SHEET_DELVER_DATA: getDataDir() }
    });

    coreProcess.on('error', (err) => {
        logger.error('[Manager] Core Service failed to start:', err);
        cleanup();
        process.exit(1);
    });

    coreProcess.on('close', (code) => {
        if (code !== 0 && code !== null) {
            logger.error(`[Manager] Core Service crashed with code ${code}`);
        } else {
            logger.info(`[Manager] Core Service exited.`);
        }
        cleanup();
        process.exit(code || 0);
    });

    // 2. Start Shell Service
    logger.info(`[Manager] Launching Shell Service (Next.js ${command}) on ${host}:${port}...`);
    logger.info(`[Manager] Shell Service proxying API requests to Core Service on port ${apiPort}`);
    const nextCmd = path.join(process.cwd(), 'node_modules', '.bin', 'next');

    // Pass API_PORT and SHEET_DELVER_DATA to Next.js so it knows where to proxy and find data
    const env = { ...process.env, PORT: port.toString(), HOSTNAME: host, API_PORT: apiPort.toString(), SHEET_DELVER_DATA: getDataDir() };


    const nextArgs = [command];
    if (command === 'dev') {
        nextArgs.push('-H', host, '-p', port.toString());
    }
    nextArgs.push('--webpack');

    shellProcess = spawn(nextCmd, nextArgs, {
        stdio: 'inherit',
        env
    });

    shellProcess.on('error', (err) => {
        logger.error('[Manager] Shell Service failed to start:', err);
        cleanup();
        process.exit(1);
    });

    shellProcess.on('close', (code) => {
        logger.info(`[Manager] Shell Service exited with code ${code}`);
        cleanup();
        process.exit(code || 0);
    });
}

start().catch(err => {
    logger.error('[Manager] Fatal error during startup:', err);
    cleanup();
    process.exit(1);
});
