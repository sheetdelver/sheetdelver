import { logger } from '../shared/utils/logger';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { spawn, ChildProcess } from 'child_process';
import { resolveDataDir, initDataDir, getConfigFilePath, getCacheDir, getDataDir } from '../server/core/paths';
import { resolveAdminOrigin } from '../shared/security/adminOrigin';

// Resolve and initialize data directory before anything else
const dataDir = resolveDataDir(process.argv);
initDataDir(dataDir);

const SETTINGS_PATH = getConfigFilePath();

// Default settings
let host = 'localhost';
let port = 3000;
let apiPort = 3001;
let appProtocol = 'http';
let configuredAdminOrigin: unknown;

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
            if (settings.app.protocol) appProtocol = settings.app.protocol;
            configuredAdminOrigin = settings.app['admin-origin'];
        }
    } else {
        logger.info(`[Manager] No settings.yaml found at ${SETTINGS_PATH}, using defaults.`);
    }
} catch (e) {
    logger.error('[Manager] Error reading settings.yaml:', e);
}

let adminOrigin;
try {
    adminOrigin = resolveAdminOrigin({
        appOrigin: `${appProtocol}://${host}:${port}`,
        configuredOrigin: configuredAdminOrigin,
    });
} catch (error) {
    logger.error('[Manager] Invalid admin origin configuration:', error);
    process.exit(1);
}
logger.info(`[Manager] Loading configuration: App=${host}:${port}, API=${apiPort}, Admin Origin=${adminOrigin.origin}`);

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
const expectedShellStops = new WeakSet<ChildProcess>();

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
            logger.info('[Manager] Stopping Application Shell Service...');
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
        const env = {
            ...process.env,
            API_PORT: apiPort.toString(),
            APP_ADMIN_ORIGIN: adminOrigin.origin,
            SHEET_DELVER_DATA: getDataDir(),
        };

        const runBuild = (label: string, buildArgs: string[]) => new Promise<number>((resolve, reject) => {
            logger.info(`[Manager] Building ${label}...`);
            const buildProcess = spawn(nextCmd, buildArgs, { stdio: 'inherit', env });
            buildProcess.once('error', reject);
            buildProcess.once('close', (code) => resolve(code || 0));
        });

        const buildCode = await runBuild('Application Shell', ['build']);
        process.exit(buildCode);
        return;
    }

    logger.info('[Manager] Starting Decoupled Architecture...');

    // 0. Generate Dynamic Configuration
    if (command === 'dev') {
        ensureManagedConfigs();
    }

    // 1. Start Core Service
    logger.info(`[Manager] Launching Core Service (Express) on port ${apiPort}...`);
    // We pass the API_PORT via env var as usual, but specific naming might be needed depending on server/index.ts
    // server/index.ts reads config.app.apiPort mostly, but falls back to env.PORT or env.API_PORT
    //
    // In dev, use `tsx watch` so a source change anywhere under src/ (or the
    // referenced module dirs) reloads the entire Core process. This clears
    // Node's ESM cache wholesale and avoids the "transitive import stays
    // cached" footgun in the registry's per-file mtime cache-bust. In any
    // non-dev command (start, build) we stick with a single-shot tsx run.
    const coreArgs = command === 'dev'
        ? ['-y', 'tsx', 'watch', 'src/server/index.ts']
        : ['-y', 'tsx', 'src/server/index.ts'];

    coreProcess = spawn('npx', coreArgs, {
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
            // Admin-requested restart: Core and the application shell reload so
            // API and module code cannot drift across generations.
            logger.info('[Manager] Core Service requested restart — cycling all services...');
            if (shellProcess) {
                expectedShellStops.add(shellProcess);
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

    // 2. Start the application shell. Route groups keep player/admin providers
    // isolated while one Next service proxies both API surfaces and Socket.IO.
    logger.info(`[Manager] Launching Application Shell (Next.js ${command}) on ${host}:${port}...`);
    logger.info(`[Manager] Application Shell proxying API requests to Core Service on port ${apiPort}`);
    const nextCmd = path.join(process.cwd(), 'node_modules', '.bin', 'next');

    // Pass API_PORT and SHEET_DELVER_DATA to Next.js so it knows where to proxy and find data
    const env = {
        ...process.env,
        PORT: port.toString(),
        HOSTNAME: host,
        API_PORT: apiPort.toString(),
        APP_ADMIN_ORIGIN: adminOrigin.origin,
        SHEET_DELVER_DATA: getDataDir(),
    };


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

    const applicationChild = shellProcess;
    shellProcess.on('close', (code) => {
        if (expectedShellStops.delete(applicationChild)) return;
        logger.info(`[Manager] Application Shell exited with code ${code}`);
        cleanup();
        process.exit(code || 0);
    });
}

/**
 * Scans the local-dev and managed-install module directories and emits
 * `.managed/module-ui-registry.ts` with one explicit `import()` per discovered
 * module UI file.
 *
 * Using explicit string literals instead of template-literal dynamic imports
 * lets webpack statically analyse the file during `next build` and include the
 * correct chunks in the production bundle. Template-literal imports with alias
 * arrays are not reliably resolved by webpack's require-context scanner.
 */
function generateModuleUIRegistry(managedDir: string, localModulesDir: string, dataDir: string) {
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
    // Installed modules (<DATA_DIR>/modules) are PRE-COMPILED artifacts. They are deliberately
    // NOT statically imported into the build (ADR-0027): doing so pulled their compiled
    // bundles into the turbopack/webpack graph, so a single stale or malignant module
    // with a bad import could fail the entire dev/build. Instead they load at runtime via
    // the platform ESM route (GET /api/modules/:id/ui), where `getUIModule`'s per-module
    // try/catch degrades a failing module to the generic manifest. Only local-dev source
    // (which must be compiled) is bundled here.
    const dataModules = scanModules(dataModulesDir);

    // Import paths are relative to .managed (where the registry lives).
    // Strip the file extension — TypeScript and webpack both resolve extensionless
    // imports via their normal module resolution (trying .ts, .tsx, .js, etc.).
    // Including the extension requires allowImportingTsExtensions which is not set.
    const toRelative = (baseDir: string, moduleId: string, entry: string) => {
        const rel = path.relative(managedDir, path.join(baseDir, moduleId, entry)).replace(/\\/g, '/');
        const importPath = rel.startsWith('.') ? rel : `./${rel}`;
        return importPath.replace(/\.(tsx?|jsx?)$/, '');
    };

    const localEntries = localModules
        .map(({ id, entry }) => `    "${id}": () => import("${toRelative(localModulesDir, id, entry)}"),`)
        .join('\n');

    const content = [
        '// Auto-generated by ensureManagedConfigs — do not edit manually.',
        '// Re-generated on every `npm run dev` and `npm run build`.',
        '//',
        '// localModuleUIs: one explicit import() per local-dev module UI (TypeScript',
        '// source) so the bundler statically analyses and compiles it.',
        '//',
        '// dataModuleUIs is intentionally EMPTY: installed modules are pre-compiled and',
        '// load at runtime via GET /api/modules/:id/ui — they are never pulled into the',
        '// build graph, so a stale/incompatible installed module cannot fail the build.',
        '',
        '// @ts-nocheck',
        '// prettier-ignore',
        `export const localModuleUIs: Record<string, () => Promise<any>> = {`,
        localEntries,
        '};',
        '',
        '// prettier-ignore',
        `export const dataModuleUIs: Record<string, () => Promise<any>> = {};`,
        '',
    ].join('\n');

    fs.writeFileSync(path.join(managedDir, 'module-ui-registry.ts'), content, 'utf8');

    logger.info(`[Manager] Generated module UI registry — bundled local: [${localModules.map(m => m.id).join(', ')}]; runtime-loaded installed: [${dataModules.map(m => m.id).join(', ')}]`);
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
                "@modules/*": ["../src/modules/*"],
                "@local-modules/*": [
                    rel(localModulesDir) + "/*"
                ],
                // Registry source is generated beside this paths file so it remains
                // inside the Turbopack project when <DATA_DIR> is external.
                "@data-registry/*": [
                    "./*"
                ],
                "@sheet-delver/sdk": ["../src/shared/sdk"],
                // SDK subpath entry points (ADR-0027 decision 2).
                "@sheet-delver/sdk/react": ["../src/shared/sdk/entry-react"],
                "@sheet-delver/sdk/server": ["../src/shared/sdk/entry-server"],
                "@sheet-delver/sdk/testing": ["../src/shared/sdk/testing"]
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

      // Local-dev modules live under <DATA_DIR>/local/modules (gitignored, so Tailwind v4
      // auto-detection skips them). Scan them explicitly so module utility classes are not
      // purged (ADR-0027 decision 33, layer 1). Honors $SHEET_DELVER_LOCAL_MODULES.
      const LOCAL_MODULES = process.env.SHEET_DELVER_LOCAL_MODULES
        || (DATA_DIR ? path.join(DATA_DIR, 'local', 'modules') : '${localModulesDir}');
      if (LOCAL_MODULES) {
        const relativeLocalPath = path.relative(currentDir, LOCAL_MODULES);
        root.prepend(\`@source "\${relativeLocalPath}/**/*.tsx";\`);
      }
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
