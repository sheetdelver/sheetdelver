import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as esbuild from 'esbuild';

import { initDataDir, resolveDataDir, getLocalModulesDataDir } from '../../../server/core/paths';
import { validateModuleInfoShape, evaluateModuleCompatibility } from '../../../modules/registry/lifecycle/validation';
import type { SystemModuleInfo } from '../../../modules/registry/core/types';

// ---------------------------------------------------------------------------
// Build configuration mirrors module packaging, but writes to a disposable temp dir.
// ---------------------------------------------------------------------------

const LOGIC_EXTERNALS = ['@sheet-delver/sdk'];
const UI_EXTERNALS = ['@sheet-delver/sdk', 'react', 'react-dom', 'react/jsx-runtime'];

const ENTRIES = [
    { key: 'logic', outName: 'logic.js', externals: LOGIC_EXTERNALS, platform: 'node' as const, jsx: false, required: true },
    { key: 'ui', outName: 'ui.js', externals: UI_EXTERNALS, platform: 'browser' as const, jsx: true, required: true },
    { key: 'server', outName: 'server.js', externals: LOGIC_EXTERNALS, platform: 'node' as const, jsx: false, required: false },
];

const FORBIDDEN_IMPORT_PREFIXES = ['@shared/', '@client/', '@server/', '@core/', '@modules/', '@/'];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs']);

const IMPORT_MIGRATION_HINTS: Array<{ test: RegExp; hint: string }> = [
    {
        test: /^@shared\/sdk(?:\/.*)?$/,
        hint: 'Use @sheet-delver/sdk instead of the internal @shared/sdk alias.',
    },
    {
        test: /^@modules\/registry\/types$/,
        hint: 'Use SDK types from @sheet-delver/sdk, such as UIModuleManifest and ModuleInfo.',
    },
    {
        test: /^@client\/ui\/components\/(LoadingModal|RollDialog|ConfirmationModal|RichTextEditor|SharedContentModal)$/,
        hint: 'Use useSDKComponents() from @sheet-delver/sdk and read the platform component from that hook.',
    },
    {
        test: /^@client\/ui\/context\//,
        hint: 'Use useSDK() from @sheet-delver/sdk for platform context instead of importing client internals.',
    },
    {
        test: /^@shared\/utils\/logger$/,
        hint: 'Use context.logger in adapters, useSDK().logger in UI, or avoid direct logging in server route handlers.',
    },
    {
        test: /^@shared\/utils\/errors$/,
        hint: 'Use getErrorMessage from @sheet-delver/sdk.',
    },
    {
        test: /^@shared\/utils\//,
        hint: 'Check @sheet-delver/sdk utilities first. If no SDK export exists, the module needs a new SDK surface before using this platform utility.',
    },
    {
        test: /^@server\//,
        hint: 'Server internals are not module API. Use ModuleServerRequest, req.foundryClient, or ModuleContext from @sheet-delver/sdk.',
    },
    {
        test: /^@core\//,
        hint: 'Core internals are not module API. Use ModuleContext platform services or req.foundryClient from @sheet-delver/sdk.',
    },
    {
        test: /^@client\//,
        hint: 'Client internals are not module API. Use useSDK() and useSDKComponents() from @sheet-delver/sdk.',
    },
    {
        test: /^@modules\//,
        hint: 'Registry/module internals are not module API. Use @sheet-delver/sdk exports only.',
    },
    {
        test: /^@\//,
        hint: 'The root @ alias points at platform internals. Module code should import from @sheet-delver/sdk or local relative paths.',
    },
];

interface CheckContext {
    moduleId: string;
    modulePath: string;
    info: SystemModuleInfo;
    entries: Partial<Record<'logic' | 'ui' | 'server', string>>;
    failures: string[];
    warnings: string[];
}

function fail(ctx: Pick<CheckContext, 'failures'>, message: string): void {
    ctx.failures.push(message);
    console.log(`  ✗ ${message}`);
}

function warn(ctx: Pick<CheckContext, 'warnings'>, message: string): void {
    ctx.warnings.push(message);
    console.log(`  ! ${message}`);
}

function pass(message: string): void {
    console.log(`  ✓ ${message}`);
}

function readJson(filePath: string): unknown {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function resolveEntry(modulePath: string, manifestEntry: string): string | null {
    const base = path.join(modulePath, manifestEntry);
    for (const ext of ['.ts', '.tsx', '.js', '.mjs']) {
        if (fs.existsSync(base + ext)) return base + ext;
    }
    return fs.existsSync(base) ? base : null;
}

function walkFiles(root: string): string[] {
    const files: string[] = [];
    if (!fs.existsSync(root)) return files;

    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
        const fullPath = path.join(root, entry.name);
        if (entry.isDirectory()) {
            files.push(...walkFiles(fullPath));
        } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
            files.push(fullPath);
        }
    }
    return files;
}

function extractImportSpecifiers(source: string): string[] {
    const specs: string[] = [];
    const patterns = [
        /\bimport\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
        /\bexport\s+(?:type\s+)?[^'"]*?\s+from\s+['"]([^'"]+)['"]/g,
        /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ];

    for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) {
            specs.push(match[1]);
        }
    }
    return specs;
}

function checkRelativeImport(modulePath: string, filePath: string, specifier: string): string | null {
    if (!specifier.startsWith('.')) return null;
    const resolved = path.resolve(path.dirname(filePath), specifier);
    const moduleRoot = path.resolve(modulePath);
    if (!resolved.startsWith(moduleRoot + path.sep) && resolved !== moduleRoot) {
        return `${path.relative(modulePath, filePath)} imports outside module root: ${specifier}`;
    }
    return null;
}

function getMigrationHint(specifier: string): string | null {
    return IMPORT_MIGRATION_HINTS.find((entry) => entry.test.test(specifier))?.hint ?? null;
}

function checkImportBoundaries(ctx: CheckContext): void {
    const files = walkFiles(ctx.modulePath);
    let issueCount = 0;

    for (const filePath of files) {
        const source = fs.readFileSync(filePath, 'utf8');
        for (const specifier of extractImportSpecifiers(source)) {
            const forbidden = FORBIDDEN_IMPORT_PREFIXES.find((prefix) => specifier === prefix.slice(0, -1) || specifier.startsWith(prefix));
            if (forbidden) {
                const hint = getMigrationHint(specifier);
                fail(ctx, [
                    `${path.relative(ctx.modulePath, filePath)} imports internal platform alias "${specifier}"`,
                    hint ? `    Hint: ${hint}` : null,
                ].filter(Boolean).join('\n'));
                issueCount += 1;
            }

            const relativeIssue = checkRelativeImport(ctx.modulePath, filePath, specifier);
            if (relativeIssue) {
                fail(ctx, relativeIssue);
                issueCount += 1;
            }
        }
    }

    if (issueCount === 0) pass(`import boundary clean (${files.length} source files scanned)`);
}

function checkPackageIncludes(ctx: CheckContext): void {
    const includes = ctx.info.package?.include ?? [];
    let issueCount = 0;
    if (!Array.isArray(includes)) {
        fail(ctx, 'Manifest field "package.include" must be an array when provided');
        return;
    }

    for (const includePath of includes) {
        if (typeof includePath !== 'string' || includePath.trim() === '') {
            fail(ctx, 'Manifest field "package.include" entries must be non-empty strings');
            issueCount += 1;
            continue;
        }
        if (!fs.existsSync(path.join(ctx.modulePath, includePath))) {
            fail(ctx, `package.include path "${includePath}" does not exist`);
            issueCount += 1;
        }
    }

    if (issueCount === 0) {
        pass(includes.length ? `package.include paths exist (${includes.length})` : 'no package.include paths declared');
    }
}

function checkTypeScript(ctx: CheckContext): void {
    const moduleTsconfig = path.join(ctx.modulePath, 'tsconfig.json');
    const args = fs.existsSync(moduleTsconfig)
        ? ['tsc', '--noEmit', '--project', moduleTsconfig]
        : ['tsc', '--noEmit'];

    const result = spawnSync('npx', args, {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (result.status === 0) {
        pass(fs.existsSync(moduleTsconfig) ? 'TypeScript check passed (module tsconfig)' : 'TypeScript check passed (root tsconfig)');
        return;
    }

    const output = `${result.stdout}${result.stderr}`.trim();
    fail(ctx, `TypeScript check failed${output ? `:\n${output}` : ''}`);
}

async function dryBundle(ctx: CheckContext): Promise<void> {
    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), `sd-check-${ctx.moduleId}-`));
    try {
        for (const entry of ENTRIES) {
            const entryFile = ctx.entries[entry.key as keyof CheckContext['entries']];
            if (!entryFile) continue;

            try {
                await esbuild.build({
                    entryPoints: [entryFile],
                    bundle: true,
                    format: 'esm',
                    outfile: path.join(stagingDir, entry.outName),
                    external: entry.externals,
                    platform: entry.platform,
                    target: 'es2022',
                    jsx: entry.jsx ? 'automatic' : undefined,
                    loader: { '.json': 'json' },
                    logLevel: 'silent',
                    write: true,
                });
                pass(`dry bundle passed for ${entry.key}`);
            } catch (error) {
                fail(ctx, `dry bundle failed for ${entry.key}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    } finally {
        fs.rmSync(stagingDir, { recursive: true, force: true });
    }
}

function checkEntries(ctx: CheckContext): void {
    for (const entry of ENTRIES) {
        const manifestEntry = ctx.info.manifest?.[entry.key as keyof SystemModuleInfo['manifest']];
        if (!manifestEntry) {
            if (entry.required) fail(ctx, `manifest.${entry.key} is required`);
            continue;
        }

        const entryFile = resolveEntry(ctx.modulePath, manifestEntry);
        if (!entryFile) {
            fail(ctx, `manifest.${entry.key} entry "${manifestEntry}" could not be resolved`);
            continue;
        }

        ctx.entries[entry.key as keyof CheckContext['entries']] = entryFile;
        pass(`manifest.${entry.key} resolves to ${path.relative(ctx.modulePath, entryFile)}`);
    }
}

function checkEntryExports(ctx: CheckContext): void {
    const logic = ctx.entries.logic;
    if (logic) {
        const source = fs.readFileSync(logic, 'utf8');
        if (/\bexport\s+(?:default\s+)?class\s+Adapter\b/.test(source) || /\bexport\s*\{[^}]*\bas\s+Adapter\b[^}]*\}/.test(source) || /\bexport\s*\{[^}]*\bAdapter\b[^}]*\}/.test(source)) {
            pass('logic entry exports Adapter');
        } else {
            fail(ctx, 'logic entry must export an Adapter class or Adapter alias');
        }
    }

    const ui = ctx.entries.ui;
    if (ui) {
        const source = fs.readFileSync(ui, 'utf8');
        if (/\bexport\s+default\b/.test(source)) {
            pass('ui entry has default export');
        } else {
            fail(ctx, 'ui entry must default-export a UIModuleManifest');
        }
    }

    const server = ctx.entries.server;
    if (server) {
        const source = fs.readFileSync(server, 'utf8');
        if (/\bexport\s+const\s+apiRoutes\b/.test(source) || /\bexport\s*\{[^}]*\bapiRoutes\b[^}]*\}/.test(source)) {
            pass('server entry exports apiRoutes');
        } else {
            fail(ctx, 'server entry must export named apiRoutes');
        }
    }
}

function checkCompatibility(ctx: CheckContext): void {
    try {
        const packageJson = readJson(path.join(process.cwd(), 'package.json')) as { version?: string };
        const coreVersion = packageJson.version ?? '0.0.0';
        const result = evaluateModuleCompatibility(ctx.info, coreVersion);
        if (result.compatible) {
            pass('compatibility constraints satisfied');
        } else {
            fail(ctx, `compatibility constraints failed: ${result.reason ?? 'unknown reason'}`);
        }
    } catch (error) {
        warn(ctx, `compatibility check skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function loadModuleContext(moduleId: string): CheckContext | null {
    initDataDir(resolveDataDir());

    const modulePath = path.join(getLocalModulesDataDir(), moduleId);
    if (!fs.existsSync(modulePath)) {
        console.error(`Module "${moduleId}" not found in ${getLocalModulesDataDir()}`);
        return null;
    }

    const infoPath = path.join(modulePath, 'info.json');
    if (!fs.existsSync(infoPath)) {
        console.error(`info.json not found in ${modulePath}`);
        return null;
    }

    let rawInfo: unknown;
    try {
        rawInfo = readJson(infoPath);
    } catch (error) {
        console.error(`Failed to parse info.json: ${error instanceof Error ? error.message : String(error)}`);
        return null;
    }

    const ctx: CheckContext = {
        moduleId,
        modulePath,
        info: rawInfo as SystemModuleInfo,
        entries: {},
        failures: [],
        warnings: [],
    };

    const shape = validateModuleInfoShape(rawInfo);
    if (shape.valid) {
        pass('info.json shape valid');
    } else {
        for (const error of shape.errors) fail(ctx, error);
    }

    if (ctx.info.id && ctx.info.id !== moduleId) {
        warn(ctx, `info.json id "${ctx.info.id}" differs from requested module id "${moduleId}"`);
    }

    return ctx;
}

async function checkModule(): Promise<void> {
    const moduleId = process.argv[2];
    if (!moduleId) {
        console.error('Usage: npm run module:check <moduleId>');
        process.exit(1);
    }

    console.log(`\nChecking module "${moduleId}"...`);

    const ctx = loadModuleContext(moduleId);
    if (!ctx) process.exit(1);

    checkEntries(ctx);
    checkEntryExports(ctx);
    checkPackageIncludes(ctx);
    checkCompatibility(ctx);
    checkImportBoundaries(ctx);
    checkTypeScript(ctx);
    await dryBundle(ctx);

    console.log('');
    if (ctx.failures.length > 0) {
        console.error(`Module check failed with ${ctx.failures.length} issue(s).`);
        process.exit(1);
    }

    const warningText = ctx.warnings.length > 0 ? ` (${ctx.warnings.length} warning(s))` : '';
    console.log(`Module check passed${warningText}.`);
}

checkModule().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
