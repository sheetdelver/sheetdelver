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

// Exit code 75 means the Core Service is requesting a full stack restart
// (e.g. triggered by the admin "Restart Now" button after a module install).
// The manager catches this code, kills Next.js, and relaunches both services
// so new adapter code and — in dev mode — newly installed module UI files are
// picked up without the user having to touch the terminal.
const RESTART_EXIT_CODE = 75;

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
        
        // 0. Ensure managed configs are present for build
        ensureManagedConfigs();

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

    // 0. Generate Dynamic Configuration
    if (command === 'dev') {
        ensureManagedConfigs();
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
        if (code === RESTART_EXIT_CODE) {
            // Admin-requested restart — bring down Next.js and relaunch both.
            logger.info('[Manager] Core Service requested restart — cycling both services...');
            if (shellProcess) {
                shellProcess.kill('SIGINT');
                shellProcess = null;
            }
            coreProcess = null;
            // Brief pause lets ports free up before relaunching.
            setTimeout(() => start(), 1500);
            return;
        }

        if (code !== 0 && code !== null) {
            logger.error(`[Manager] Core Service crashed with code ${code}`);
        } else {
            logger.info('[Manager] Core Service exited.');
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
        nextArgs.push('--webpack'); // force webpack bundler in dev (disable Turbopack)
    }

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

/**
 * Scans the local-dev and managed-install module directories and emits
 * `<dataDir>/module-ui-registry.ts` with one explicit `import()` per discovered
 * module UI file.
 *
 * The file lives in the data directory (not .managed/) because its contents
 * depend on what modules are installed in the current environment, making it
 * environment-specific runtime state rather than a project-structure artifact.
 * It is referenced via the @data-registry webpack/Turbopack alias.
 *
 * Using explicit string literals instead of template-literal dynamic imports
 * lets webpack statically analyse the file during `next build` and include the
 * correct chunks in the production bundle. Template-literal imports with alias
 * arrays are not reliably resolved by webpack's require-context scanner.
 */
function generateModuleUIRegistry(_managedDir: string, localModulesDir: string, dataDir: string) {
    const dataModulesDir = path.join(dataDir, 'modules');

    // Candidate UI entry filenames, checked in priority order.
    const UI_CANDIDATES = ['module/ui.tsx', 'module/ui.ts', 'module/ui.js', 'dist/ui.js'];

    function findUIEntry(moduleDir: string): string | null {
        for (const candidate of UI_CANDIDATES) {
            if (fs.existsSync(path.join(moduleDir, candidate))) {
                return candidate;
            }
        }
        return null;
    }

    function scanModules(baseDir: string): Array<{ id: string; entry: string }> {
        if (!fs.existsSync(baseDir)) return [];
        return fs.readdirSync(baseDir, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .flatMap(d => {
                const entry = findUIEntry(path.join(baseDir, d.name));
                return entry ? [{ id: d.name, entry }] : [];
            });
    }

    const localModules = scanModules(localModulesDir);
    const dataModules  = scanModules(dataModulesDir);

    // Import paths are relative to the data directory (where the registry lives).
    // Strip the file extension — TypeScript and webpack both resolve extensionless
    // imports via their normal module resolution (trying .ts, .tsx, .js, etc.).
    // Including the extension requires allowImportingTsExtensions which is not set.
    const toRelative = (baseDir: string, moduleId: string, entry: string) => {
        const rel = path.relative(dataDir, path.join(baseDir, moduleId, entry)).replace(/\\/g, '/');
        return './' + rel.replace(/\.(tsx?|jsx?)$/, '');
    };

    const localEntries = localModules
        .map(({ id, entry }) => `    "${id}": () => import("${toRelative(localModulesDir, id, entry)}"),`)
        .join('\n');

    const dataEntries = dataModules
        .map(({ id, entry }) => `    "${id}": () => import("${toRelative(dataModulesDir, id, entry)}"),`)
        .join('\n');

    const content = [
        '// Auto-generated by ensureManagedConfigs — do not edit manually.',
        '// Re-generated on every `npm run dev` and `npm run build`.',
        '//',
        '// Contains one explicit import() per discovered module UI so webpack can',
        '// statically analyse the file and include the correct chunks in the build.',
        '',
        '// @ts-nocheck',
        '/* eslint-disable */',
        '// prettier-ignore',
        `export const localModuleUIs: Record<string, () => Promise<any>> = {`,
        localEntries,
        '};',
        '',
        '// prettier-ignore',
        `export const dataModuleUIs: Record<string, () => Promise<any>> = {`,
        dataEntries,
        '};',
        '',
    ].join('\n');

    fs.writeFileSync(path.join(dataDir, 'module-ui-registry.ts'), content, 'utf8');

    logger.info(`[Manager] Generated module UI registry in data/ — local: [${localModules.map(m => m.id).join(', ')}], data: [${dataModules.map(m => m.id).join(', ')}]`);
}

function ensureManagedConfigs() {
    const managedDir = path.join(process.cwd(), '.managed');
    if (!fs.existsSync(managedDir)) {
        fs.mkdirSync(managedDir, { recursive: true });
    }

    const localModulesDir = process.env.SHEET_DELVER_LOCAL_MODULES
        ? path.resolve(process.env.SHEET_DELVER_LOCAL_MODULES)
        : path.join(getDataDir(), 'local', 'modules');

    // All tsconfig path values must be RELATIVE to managedDir (baseUrl ".").
    // Turbopack reads these paths and resolves them relative to the tsconfig
    // file location. Absolute paths cause Turbopack to mangle them into broken
    // server-relative URLs (e.g. .//home/... or treating /abs as a URL).
    const rel = (absPath: string) =>
        path.relative(managedDir, absPath).replace(/\\/g, '/');

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
                    rel(path.join(getDataDir(), "modules")) + "/*"
                ],
                "@local-modules/*": [
                    rel(localModulesDir) + "/*"
                ],
                // Relative path from .managed/ to the data dir so Turbopack can
                // resolve @data-registry/module-ui-registry without absolute paths.
                "@data-registry/*": [
                    rel(getDataDir()) + "/*"
                ],
                "@sheet-delver/sdk": ["../src/shared/sdk"]
            }
        }
    };

    fs.writeFileSync(
        path.join(managedDir, 'tsconfig.paths.json'),
        JSON.stringify(tsconfigPaths, null, 2)
    );

    logger.info(`[Manager] Generated dynamic paths at .managed/tsconfig.paths.json`);

    // Generate module UI registry — explicit per-module import() calls so webpack
    // can statically analyze them during next build without relying on alias arrays
    // or template-literal require contexts, which don't resolve reliably in production.
    generateModuleUIRegistry(managedDir, localModulesDir, getDataDir());

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

start().catch(err => {
    logger.error('[Manager] Fatal error during startup:', err);
    cleanup();
    process.exit(1);
});
