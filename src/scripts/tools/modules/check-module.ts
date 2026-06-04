import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import postcss from 'postcss';

import { initDataDir, resolveDataDir, getLocalModulesDataDir } from '../../../server/core/paths';
import { validateModuleInfoShape, evaluateModuleCompatibility } from '../../../modules/registry/lifecycle/validation';
import type { SystemModuleInfo } from '../../../modules/registry/core/types';
import {
    ENTRIES,
    BUILD_TARGET,
    BUILD_LOADER,
    FORBIDDEN_IMPORT_PREFIXES,
    SOURCE_EXTENSIONS,
} from './build-config';

// Build configuration is shared with package-module.ts via ./build-config so
// validation and packaging can never drift (ADR-0027 decision 29).

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
        hint: 'Server internals are not module API. Use ModuleServerRequest or ModuleRuntime services from @sheet-delver/sdk.',
    },
    {
        test: /^@core\//,
        hint: 'Core internals are not module API. Use ModuleRuntime services (documents, dataStore, compendium) from @sheet-delver/sdk.',
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

export type ModuleCheckIssueKind =
    | 'manifest'
    | 'entry'
    | 'export'
    | 'package'
    | 'compatibility'
    | 'import-boundary'
    | 'typecheck'
    | 'bundle'
    | 'style-scope'
    | 'filesystem';

export interface ModuleCheckIssue {
    kind: ModuleCheckIssueKind;
    message: string;
    hint?: string;
}

export interface ModuleCheckResult {
    moduleId: string;
    modulePath: string;
    passed: boolean;
    failures: ModuleCheckIssue[];
    warnings: ModuleCheckIssue[];
    passes: string[];
}

export interface ModuleCheckOptions {
    dataDir?: string;
    silent?: boolean;
}

interface ModuleCheckCliOptions {
    moduleId: string;
    json: boolean;
    dataDir?: string;
}

interface CheckContext {
    moduleId: string;
    modulePath: string;
    info: SystemModuleInfo;
    entries: Partial<Record<'logic' | 'ui' | 'server', string>>;
    failures: ModuleCheckIssue[];
    warnings: ModuleCheckIssue[];
    passes: string[];
    silent: boolean;
}

function fail(ctx: Pick<CheckContext, 'failures' | 'silent'>, kind: ModuleCheckIssueKind, message: string, hint?: string): void {
    ctx.failures.push({ kind, message, hint });
    if (!ctx.silent) {
        console.log(`  ✗ ${message}`);
        if (hint) console.log(`    Hint: ${hint}`);
    }
}

function warn(ctx: Pick<CheckContext, 'warnings' | 'silent'>, kind: ModuleCheckIssueKind, message: string, hint?: string): void {
    ctx.warnings.push({ kind, message, hint });
    if (!ctx.silent) {
        console.log(`  ! ${message}`);
        if (hint) console.log(`    Hint: ${hint}`);
    }
}

function pass(ctx: Pick<CheckContext, 'passes' | 'silent'>, message: string): void {
    ctx.passes.push(message);
    if (!ctx.silent) console.log(`  ✓ ${message}`);
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

function resolveRelativeSourceImport(filePath: string, specifier: string): string | null {
    if (!specifier.startsWith('.')) return null;

    const base = path.resolve(path.dirname(filePath), specifier);
    const candidates = [
        base,
        ...Array.from(SOURCE_EXTENSIONS, (ext) => base + ext),
        ...Array.from(SOURCE_EXTENSIONS, (ext) => path.join(base, `index${ext}`)),
    ];

    for (const candidate of candidates) {
        if (!SOURCE_EXTENSIONS.has(path.extname(candidate))) continue;
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    return null;
}

/**
 * Follow the declared UI entry's local imports so server-only SDK imports are rejected
 * from every source file that can enter the browser bundle, including plain `.ts` helpers.
 */
function collectUiBundleFiles(ctx: CheckContext): Set<string> {
    const uiEntry = ctx.entries.ui;
    if (!uiEntry) return new Set();

    const files = new Set<string>();
    const pending = [path.resolve(uiEntry)];
    while (pending.length > 0) {
        const filePath = pending.pop()!;
        if (files.has(filePath)) continue;
        files.add(filePath);

        const source = fs.readFileSync(filePath, 'utf8');
        for (const specifier of extractImportSpecifiers(source)) {
            if (checkRelativeImport(ctx.modulePath, filePath, specifier)) continue;
            const importedFile = resolveRelativeSourceImport(filePath, specifier);
            if (importedFile && !files.has(importedFile)) pending.push(importedFile);
        }
    }
    return files;
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
    const uiBundleFiles = collectUiBundleFiles(ctx);
    let issueCount = 0;

    for (const filePath of files) {
        const source = fs.readFileSync(filePath, 'utf8');
        // The server entry point must not be pulled into the browser bundle through a
        // component, a plain TypeScript helper, or a lazy dynamic import.
        const isUiFile = uiBundleFiles.has(path.resolve(filePath));
        for (const specifier of extractImportSpecifiers(source)) {
            const forbidden = FORBIDDEN_IMPORT_PREFIXES.find((prefix) => specifier === prefix.slice(0, -1) || specifier.startsWith(prefix));
            if (forbidden) {
                const hint = getMigrationHint(specifier);
                fail(ctx, 'import-boundary', `${path.relative(ctx.modulePath, filePath)} imports internal platform alias "${specifier}"`, hint ?? undefined);
                issueCount += 1;
            }

            if (isUiFile && (specifier === '@sheet-delver/sdk/server' || specifier.startsWith('@sheet-delver/sdk/server/'))) {
                fail(
                    ctx,
                    'import-boundary',
                    `${path.relative(ctx.modulePath, filePath)} imports the server entry "@sheet-delver/sdk/server" from the UI bundle`,
                    'Server runtime types/helpers are not available in UI bundles. Use @sheet-delver/sdk/react and the data hooks instead.',
                );
                issueCount += 1;
            }

            const relativeIssue = checkRelativeImport(ctx.modulePath, filePath, specifier);
            if (relativeIssue) {
                fail(ctx, 'import-boundary', relativeIssue);
                issueCount += 1;
            }
        }
    }

    if (issueCount === 0) pass(ctx, `import boundary clean (${files.length} source files scanned)`);
}

function walkCssFiles(root: string): string[] {
    const files: string[] = [];
    if (!fs.existsSync(root)) return files;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
        const fullPath = path.join(root, entry.name);
        if (entry.isDirectory()) {
            files.push(...walkCssFiles(fullPath));
        } else if (path.extname(entry.name) === '.css') {
            files.push(fullPath);
        }
    }
    return files;
}

/** A selector is scoped iff it begins with the module root class as a whole token. */
function isScopedSelector(selector: string, scopeClass: string): boolean {
    const s = selector.trim();
    if (!s.startsWith(scopeClass)) return false;
    const next = s.charAt(scopeClass.length);
    // The char after the scope class must end the identifier (combinator / pseudo /
    // attribute / class / comma / end) — not an identifier char that would make it a
    // different class (e.g. `.sdk-module--dnd5edark`).
    return next === '' || !/[A-Za-z0-9_-]/.test(next);
}

/**
 * Style-isolation lint (ADR-0027 decision 28): every selector in the module's CSS must be
 * scoped under the host-generated `.sdk-module--<id>` root. `@keyframes` step rules,
 * `@font-face`, `@import`, and `@charset` are exempt (global by necessity); `@media` /
 * `@supports` / `@container` are descended into. There is no build-time CSS rewrite — this
 * only validates authoring, so dev and packaged stay identical.
 */
function checkStyleScoping(ctx: CheckContext): void {
    const scopeClass = `.sdk-module--${ctx.moduleId}`;
    const cssFiles = walkCssFiles(ctx.modulePath);
    if (cssFiles.length === 0) return;

    const leaks: string[] = [];

    const insideKeyframes = (node: postcss.Node | undefined): boolean => {
        let parent = node?.parent as postcss.Container | undefined;
        while (parent) {
            if (parent.type === 'atrule' && /keyframes$/i.test((parent as postcss.AtRule).name)) return true;
            parent = parent.parent as postcss.Container | undefined;
        }
        return false;
    };

    for (const file of cssFiles) {
        const rel = path.relative(ctx.modulePath, file);
        let root: postcss.Root;
        try {
            root = postcss.parse(fs.readFileSync(file, 'utf8'), { from: file });
        } catch (error) {
            fail(ctx, 'style-scope', `${rel}: failed to parse CSS`, error instanceof Error ? error.message : String(error));
            continue;
        }

        root.walkRules((rule) => {
            if (insideKeyframes(rule)) return;
            for (const selector of rule.selectors) {
                if (!isScopedSelector(selector, scopeClass)) {
                    leaks.push(`${rel}: "${selector.trim()}"`);
                }
            }
        });
    }

    if (leaks.length > 0) {
        const sample = leaks.slice(0, 6).join('; ') + (leaks.length > 6 ? ` … (+${leaks.length - 6} more)` : '');
        fail(
            ctx,
            'style-scope',
            `module CSS has ${leaks.length} selector(s) not scoped under ${scopeClass} (global style leak)`,
            `Prefix each selector with ${scopeClass}. Leaks: ${sample}`,
        );
    } else {
        pass(ctx, `module CSS scoped under ${scopeClass} (${cssFiles.length} file(s))`);
    }
}

function checkPackageIncludes(ctx: CheckContext): void {
    const includes = ctx.info.package?.include ?? [];
    let issueCount = 0;
    if (!Array.isArray(includes)) {
        fail(ctx, 'package', 'Manifest field "package.include" must be an array when provided');
        return;
    }

    for (const includePath of includes) {
        if (typeof includePath !== 'string' || includePath.trim() === '') {
            fail(ctx, 'package', 'Manifest field "package.include" entries must be non-empty strings');
            issueCount += 1;
            continue;
        }
        if (!fs.existsSync(path.join(ctx.modulePath, includePath))) {
            fail(ctx, 'package', `package.include path "${includePath}" does not exist`);
            issueCount += 1;
        }
    }

    if (issueCount === 0) {
        pass(ctx, includes.length ? `package.include paths exist (${includes.length})` : 'no package.include paths declared');
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
        pass(ctx, fs.existsSync(moduleTsconfig) ? 'TypeScript check passed (module tsconfig)' : 'TypeScript check passed (root tsconfig)');
        return;
    }

    const output = `${result.stdout}${result.stderr}`.trim();
    fail(ctx, 'typecheck', `TypeScript check failed${output ? `:\n${output}` : ''}`);
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
                    external: [...entry.externals],
                    platform: entry.platform,
                    target: BUILD_TARGET,
                    jsx: entry.jsx ? 'automatic' : undefined,
                    loader: BUILD_LOADER,
                    logLevel: 'silent',
                    write: true,
                });
                pass(ctx, `dry bundle passed for ${entry.key}`);
            } catch (error) {
                fail(ctx, 'bundle', `dry bundle failed for ${entry.key}: ${error instanceof Error ? error.message : String(error)}`);
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
            if (entry.required) fail(ctx, 'entry', `manifest.${entry.key} is required`);
            continue;
        }

        const entryFile = resolveEntry(ctx.modulePath, manifestEntry);
        if (!entryFile) {
            fail(ctx, 'entry', `manifest.${entry.key} entry "${manifestEntry}" could not be resolved`);
            continue;
        }

        ctx.entries[entry.key as keyof CheckContext['entries']] = entryFile;
        pass(ctx, `manifest.${entry.key} resolves to ${path.relative(ctx.modulePath, entryFile)}`);
    }
}

function checkEntryExports(ctx: CheckContext): void {
    const logic = ctx.entries.logic;
    if (logic) {
        const source = fs.readFileSync(logic, 'utf8');
        if (/\bexport\s+(?:default\s+)?class\s+Adapter\b/.test(source) || /\bexport\s*\{[^}]*\bas\s+Adapter\b[^}]*\}/.test(source) || /\bexport\s*\{[^}]*\bAdapter\b[^}]*\}/.test(source)) {
            pass(ctx, 'logic entry exports Adapter');
        } else {
            fail(ctx, 'export', 'logic entry must export an Adapter class or Adapter alias');
        }
    }

    const ui = ctx.entries.ui;
    if (ui) {
        const source = fs.readFileSync(ui, 'utf8');
        if (/\bexport\s+default\b/.test(source)) {
            pass(ctx, 'ui entry has default export');
        } else {
            fail(ctx, 'export', 'ui entry must default-export a UIModuleManifest');
        }
    }

    const server = ctx.entries.server;
    if (server) {
        const source = fs.readFileSync(server, 'utf8');
        // Reject wildcard re-export: the server entry must expose a named static
        // `apiRoutes` table — there is no `createApiRoutes` factory and `export *`
        // would obscure the contract (ADR-0027 decision 29).
        if (/\bexport\s*\*/.test(source)) {
            fail(ctx, 'export', 'server entry must not use `export *`; export a named static `apiRoutes` table');
        } else if (/\bexport\s+const\s+apiRoutes\b/.test(source) || /\bexport\s*\{[^}]*\bapiRoutes\b[^}]*\}/.test(source)) {
            pass(ctx, 'server entry exports apiRoutes');
        } else {
            fail(ctx, 'export', 'server entry must export named apiRoutes');
        }
    }
}

function checkCompatibility(ctx: CheckContext): void {
    try {
        const packageJson = readJson(path.join(process.cwd(), 'package.json')) as { version?: string };
        const coreVersion = packageJson.version ?? '0.0.0';
        const result = evaluateModuleCompatibility(ctx.info, coreVersion);
        if (result.compatible) {
            pass(ctx, 'compatibility constraints satisfied');
        } else {
            fail(ctx, 'compatibility', `compatibility constraints failed: ${result.reason ?? 'unknown reason'}`);
        }
    } catch (error) {
        warn(ctx, 'compatibility', `compatibility check skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function loadModuleContext(moduleId: string, options: ModuleCheckOptions = {}): CheckContext {
    initDataDir(resolveDataDir(options.dataDir ? ['--data-dir', options.dataDir] : undefined));

    const modulePath = path.join(getLocalModulesDataDir(), moduleId);
    if (!fs.existsSync(modulePath)) {
        throw new Error(`Module "${moduleId}" not found in ${getLocalModulesDataDir()}`);
    }

    const infoPath = path.join(modulePath, 'info.json');
    if (!fs.existsSync(infoPath)) {
        throw new Error(`info.json not found in ${modulePath}`);
    }

    let rawInfo: unknown;
    try {
        rawInfo = readJson(infoPath);
    } catch (error) {
        throw new Error(`Failed to parse info.json: ${error instanceof Error ? error.message : String(error)}`);
    }

    const ctx: CheckContext = {
        moduleId,
        modulePath,
        info: rawInfo as SystemModuleInfo,
        entries: {},
        failures: [],
        warnings: [],
        passes: [],
        silent: options.silent ?? false,
    };

    const shape = validateModuleInfoShape(rawInfo);
    if (shape.valid) {
        pass(ctx, 'info.json shape valid');
    } else {
        for (const error of shape.errors) fail(ctx, 'manifest', error);
    }

    if (ctx.info.id && ctx.info.id !== moduleId) {
        warn(ctx, 'manifest', `info.json id "${ctx.info.id}" differs from requested module id "${moduleId}"`);
    }

    return ctx;
}

export async function checkModule(moduleId: string, options: ModuleCheckOptions = {}): Promise<ModuleCheckResult> {
    const ctx = loadModuleContext(moduleId, options);

    checkEntries(ctx);
    checkEntryExports(ctx);
    checkPackageIncludes(ctx);
    checkCompatibility(ctx);
    checkImportBoundaries(ctx);
    checkStyleScoping(ctx);
    checkTypeScript(ctx);
    await dryBundle(ctx);

    return {
        moduleId: ctx.moduleId,
        modulePath: ctx.modulePath,
        passed: ctx.failures.length === 0,
        failures: ctx.failures,
        warnings: ctx.warnings,
        passes: ctx.passes,
    };
}

export function printModuleCheckSummary(result: ModuleCheckResult): void {
    console.log('');
    if (!result.passed) {
        console.error(`Module check failed with ${result.failures.length} issue(s).`);
        printIssueSummary(result.failures, 'Failure summary');
        if (result.warnings.length > 0) printIssueSummary(result.warnings, 'Warning summary');
        return;
    }

    const warningText = result.warnings.length > 0 ? ` (${result.warnings.length} warning(s))` : '';
    console.log(`Module check passed${warningText}.`);
    if (result.warnings.length > 0) printIssueSummary(result.warnings, 'Warning summary');
}

function countIssuesByKind(issues: ModuleCheckIssue[]): Partial<Record<ModuleCheckIssueKind, number>> {
    return issues.reduce<Partial<Record<ModuleCheckIssueKind, number>>>((counts, issue) => {
        counts[issue.kind] = (counts[issue.kind] ?? 0) + 1;
        return counts;
    }, {});
}

function printIssueSummary(issues: ModuleCheckIssue[], title: string): void {
    const entries = Object.entries(countIssuesByKind(issues)).sort(([a], [b]) => a.localeCompare(b));
    if (entries.length === 0) return;

    console.log('');
    console.log(`${title}:`);
    for (const [kind, count] of entries) {
        console.log(`  ${kind}: ${count}`);
    }
}

function parseCliArgs(argv: string[]): ModuleCheckCliOptions | null {
    const args = argv.slice(2);
    const json = args.includes('--json');
    let dataDir: string | undefined;
    let moduleId: string | undefined;

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === '--json') continue;
        if (arg === '--data-dir') {
            dataDir = args[index + 1];
            index += 1;
            continue;
        }
        if (arg.startsWith('--data-dir=')) {
            dataDir = arg.slice('--data-dir='.length);
            continue;
        }
        if (!arg.startsWith('--') && !moduleId) moduleId = arg;
    }

    return moduleId ? { moduleId, json, dataDir } : null;
}

async function runCli(): Promise<void> {
    const options = parseCliArgs(process.argv);
    if (!options) {
        console.error('Usage: npm run module:check <moduleId> [-- --json --data-dir <path>]');
        process.exit(1);
    }

    if (!options.json) console.log(`\nChecking module "${options.moduleId}"...`);

    const result = await checkModule(options.moduleId, { dataDir: options.dataDir, silent: options.json });
    if (options.json) {
        console.log(JSON.stringify(result, null, 2));
    } else {
        printModuleCheckSummary(result);
    }
    if (!result.passed) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    runCli().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    });
}
