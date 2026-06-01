/**
 * Shared module build configuration.
 *
 * `check-module.ts` (validation / dry bundle) and `package-module.ts` (release
 * packaging) MUST build modules the same way. Per ADR-0027 (decision 29 / Phase 0)
 * this single source removes the drift risk of duplicating the entry list,
 * externals, loaders, and target inline in both tools.
 *
 * Both tools import from here. Anything that affects how a module compiles —
 * entry points, externalized peers, esbuild loaders/target — lives here only.
 */

export type ModuleEntryKey = 'logic' | 'ui' | 'server';

/** Peers externalized from logic/server bundles (Node). */
export const LOGIC_EXTERNALS: readonly string[] = ['@sheet-delver/sdk'];

/** Peers externalized from the UI bundle (browser): SDK + the host React runtime. */
export const UI_EXTERNALS: readonly string[] = [
    '@sheet-delver/sdk',
    'react',
    'react-dom',
    'react/jsx-runtime',
];

export interface ModuleBuildEntry {
    key: ModuleEntryKey;
    outName: string;
    externals: readonly string[];
    platform: 'node' | 'browser';
    jsx: boolean;
    /** A missing required entry is a hard failure; optional entries are skipped. */
    required: boolean;
}

/** The module entry points, in build order. */
export const ENTRIES: readonly ModuleBuildEntry[] = [
    { key: 'logic', outName: 'logic.js', externals: LOGIC_EXTERNALS, platform: 'node', jsx: false, required: true },
    { key: 'ui', outName: 'ui.js', externals: UI_EXTERNALS, platform: 'browser', jsx: true, required: true },
    { key: 'server', outName: 'server.js', externals: LOGIC_EXTERNALS, platform: 'node', jsx: false, required: false },
];

/** esbuild target shared by validation and packaging. */
export const BUILD_TARGET = 'es2022';

/** esbuild loaders shared by validation and packaging. */
export const BUILD_LOADER: Record<string, 'json'> = { '.json': 'json' };

/** Import prefixes that module source may not reach into (enforced by the checker). */
export const FORBIDDEN_IMPORT_PREFIXES: readonly string[] = [
    '@shared/',
    '@client/',
    '@server/',
    '@core/',
    '@modules/',
    '@/',
];

/** Source file extensions scanned for the import-boundary check. */
export const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs']);
