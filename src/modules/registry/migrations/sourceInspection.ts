import fs from 'node:fs';
import path from 'node:path';
import { buildSync, type BuildOptions } from 'esbuild';
import type { SystemModuleInfo } from '../core/types';
import { canonicalJson, confinedMigrationFile, discoverMigrations, migrationDigest, migrationDirectoryDigest } from './catalog';
import { ENTRIES, BUILD_LOADER, BUILD_TARGET, TAILWIND_ENTRY_REL } from '../../../scripts/tools/modules/build-config';
import { resolveConfinedModuleEntry, hasModuleEntryCandidate } from '../../../server/security/modulePath';

// Version the selection policy inside the durable digest. Previously approved
// whole-directory identities must never silently acquire a narrower meaning.
const PREFIX = 'module-inputs-v1:';
const MAX_FILES = 20_000;
const MAX_BYTES = 512 * 1024 * 1024;

/** Discover executable inputs without importing/initializing any module code. */
export function inspectLocalModuleInputs(directory: string): { digest: string; files: string[]; resources: string[]; bytes: number } {
    const root = path.resolve(directory);
    const entries = new Map<string, string>();
    const configurations = new Set<string>();
    const builds: Array<[string, string]> = [];
    let bytes = 0;
    const include = (relative: string): void => {
        if (entries.has(relative)) return;
        const file = confinedMigrationFile(root, relative);
        const size = fs.statSync(file).size;
        if (entries.size >= MAX_FILES || bytes + size > MAX_BYTES) {
            throw new Error(`Module inputs exceed inspection bounds at ${relative} (${entries.size + 1} files, ${bytes + size} bytes; limits ${MAX_FILES} files / ${MAX_BYTES} bytes)`);
        }
        bytes += size;
        entries.set(relative, migrationDigest(fs.readFileSync(file)));
        if (['tsconfig.json', 'jsconfig.json'].includes(path.basename(relative))) configuration(relative);
    };
    const relativeToRoot = (file: string) => path.relative(root, file).split(path.sep).join('/');
    const configuration = (relative: string): void => {
        if (configurations.has(relative)) return;
        configurations.add(relative);
        // JSONC permits comments and trailing commas. Preserve quoted strings
        // while removing only those two extensions; never evaluate config code.
        const text = fs.readFileSync(confinedMigrationFile(root, relative), 'utf8')
            .replace(/("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (match, quoted: string | undefined) => quoted ?? '')
            .replace(/("(?:\\.|[^"\\])*")|,\s*(?=[}\]])/g, (match, quoted: string | undefined) => quoted ?? '');
        const config = JSON.parse(text.replace(/^\uFEFF/, '')) as { extends?: string | string[] };
        for (const base of typeof config.extends === 'string' ? [config.extends] : config.extends ?? []) {
            if (!base.startsWith('.') && !path.isAbsolute(base)) continue; // host/package configuration
            const file = path.resolve(root, path.dirname(relative), base);
            const local = relativeToRoot(file);
            if (local === '..' || local.startsWith('../') || path.isAbsolute(local)) continue;
            const resolved = [local, `${local}.json`].find(candidate => fs.existsSync(path.join(root, candidate)));
            if (!resolved) continue; // the compiler reports missing configuration
            include(resolved);
            configuration(resolved);
        }
    };
    const resource = (relative: string): void => {
        // Check each ancestor before traversing a declared directory.
        if (!relative || relative.includes('\\') || relative.includes(':') || relative.includes('\0')
            || path.isAbsolute(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) {
            throw new Error('Unconfined module resource path');
        }
        let cursor = root;
        for (const part of relative.split('/')) {
            cursor = path.join(cursor, part);
            if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Module input symlinks are forbidden');
        }
        if (fs.statSync(cursor).isDirectory()) {
            for (const entry of fs.readdirSync(cursor).sort()) resource(`${relative}/${entry}`);
        } else include(relative);
    };
    const optional = (relative: string) => {
        try { fs.lstatSync(path.join(root, relative)); } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
            throw error;
        }
        resource(relative);
    };
    const bundle = (name: string, entryPoints: string[], options: BuildOptions): void => {
        if (!entryPoints.length) return;
        const result = buildSync({
            absWorkingDir: root, entryPoints, outdir: path.join(root, '.module-inspection-output'),
            bundle: true, write: false, metafile: true, format: 'esm', target: BUILD_TARGET,
            loader: BUILD_LOADER, preserveSymlinks: true, logLevel: 'silent',
            logOverride: { 'unsupported-dynamic-import': 'warning', 'unsupported-require-call': 'warning' },
            ...options,
        });
        if (result.warnings.some(warning => ['unsupported-dynamic-import', 'unsupported-require-call'].includes(warning.id))) {
            throw new Error('Module code imports must be statically resolvable for migration source inspection');
        }
        for (const input of Object.keys(result.metafile!.inputs)) {
            const relative = relativeToRoot(path.resolve(root, input));
            include(relative);
            // Resolver configuration inside the module is part of its input.
            let parent = path.dirname(relative);
            while (parent !== '.') {
                for (const name of ['package.json', 'tsconfig.json', 'jsconfig.json']) optional(`${parent}/${name}`);
                parent = path.dirname(parent);
            }
        }
        // Compiler output also binds effective resolution/configuration. No
        // output is written and none of it is executed.
        builds.push([name, migrationDigest(canonicalJson(result.outputFiles!.map(file => [
            path.relative(path.join(root, '.module-inspection-output'), file.path), migrationDigest(file.contents),
        ])))]);
    };
    include('info.json');
    const info = JSON.parse(fs.readFileSync(path.join(root, 'info.json'), 'utf8')) as SystemModuleInfo;
    for (const config of ['package.json', 'package-lock.json', 'tsconfig.json', 'jsconfig.json']) optional(config);
    for (const entry of ENTRIES) {
        const declared = info.manifest[entry.key];
        if (!declared) continue;
        const resolved = resolveConfinedModuleEntry(root, declared);
        if (!resolved) {
            if (!entry.required && !hasModuleEntryCandidate(root, declared)) continue;
            throw new Error(`Module ${entry.key} entry is missing or unconfined: ${declared}`);
        }
        // Preserve the lexical path so a symlink cannot be hidden by realpath.
        const candidates = path.extname(declared) ? [declared] : [declared, ...['.ts', '.tsx', '.js', '.mjs'].map(ext => declared + ext)];
        include(candidates.find(candidate => fs.existsSync(path.join(root, candidate)))!);
        bundle(entry.key, [resolved], {
            platform: entry.platform, jsx: entry.jsx ? 'automatic' : undefined,
            external: [...entry.externals], packages: 'external',
        });
    }
    const catalog = discoverMigrations(root, info, true);
    if (catalog) {
        include('migration.json');
        const hooks = new Set<string>();
        for (const definition of catalog.definitions) include(`${definition.directory}/definition.json`);
        for (const step of catalog.steps) for (const hook of Object.values(step.entries)) {
            include(hook.path);
            hooks.add(path.join(root, hook.path));
        }
        bundle('migrations', [...hooks].sort(), { platform: 'browser' });
    }
    optional('assets');
    for (const relative of info.package?.include ?? []) resource(relative);
    if (info.compiledStyles) resource(info.compiledStyles);
    if (fs.existsSync(path.join(root, TAILWIND_ENTRY_REL))) {
        include(TAILWIND_ENTRY_REL);
        bundle('styles', [path.join(root, TAILWIND_ENTRY_REL)], { platform: 'browser', packages: 'external' });
    }
    const files = [...entries.keys()].sort();
    return { digest: PREFIX + migrationDigest(canonicalJson({ files: files.map(file => [file, entries.get(file)]), builds })),
        files, resources: ['assets', ...(info.package?.include ?? [])], bytes };
}

/** Managed archives and legacy approvals retain their original full-tree policy. */
export function migrationSourceDigest(directory: string, category: 'local' | 'managed' | undefined, expected?: string): string {
    if (expected !== undefined && !/^(?:module-inputs-v1:)?sha256:[a-f0-9]{64}$/.test(expected)) throw new Error('Unknown module source inspection policy');
    if (category !== 'local' || expected?.startsWith('sha256:')) return migrationDirectoryDigest(directory);
    return inspectLocalModuleInputs(directory).digest;
}

export function assertMigrationSource(candidate: { sourceDirectory?: string; sourceDigest?: string; sourceCategory?: 'local' | 'managed' }): void {
    if (!candidate.sourceDirectory) return;
    if (!candidate.sourceDigest || migrationSourceDigest(candidate.sourceDirectory, candidate.sourceCategory, candidate.sourceDigest) !== candidate.sourceDigest) {
        throw new Error('Approved module source changed; rerun review');
    }
}
