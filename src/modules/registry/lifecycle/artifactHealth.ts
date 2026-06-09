import fs from 'node:fs';
import path from 'node:path';
import type { SystemModuleInfo } from '../core/types';
import type { ModuleArtifactHealthDiagnostic } from './lifecycle';

/**
 * Result of the installed-artifact audit. `hasErrors` is the only blocking bit;
 * warning-only drift is intentionally surfaced to the admin while remaining loadable.
 */
export interface ModuleArtifactHealthResult {
    diagnostics: ModuleArtifactHealthDiagnostic[];
    hasErrors: boolean;
    hasWarnings: boolean;
}

// Must stay aligned with server/routes/modules/rewriteModuleImports.ts GLOBAL_MAP.
// Anything else in the UI bundle is not resolvable by the browser ESM loader.
const BROWSER_GLOBAL_IMPORTS = new Set([
    'react',
    'react/jsx-runtime',
    'react-dom',
    '@sheet-delver/sdk',
    '@sheet-delver/sdk/react',
]);

// Legacy SDK symbols are warnings, not hard failures. Old bundles may still run if
// the import graph resolves; these diagnostics tell the admin what should be upgraded.
const DEPRECATED_PATTERNS: Array<{ code: string; pattern: RegExp; message: string }> = [
    {
        code: 'artifact.deprecated.onActorChanged',
        pattern: /\bonActorChanged\b/,
        message: 'Packaged UI references deprecated actor-only realtime callback "onActorChanged"; upgrade to SDK events.',
    },
    {
        code: 'artifact.deprecated.foundryClient',
        pattern: /\bfoundryClient\b/,
        message: 'Packaged code references the removed broad Foundry client surface; use req.runtime / SDK document services.',
    },
    {
        code: 'artifact.deprecated.useFoundry',
        pattern: /\buseFoundry\b/,
        message: 'Packaged UI references legacy useFoundry naming; use useSDK() from @sheet-delver/sdk/react.',
    },
    {
        code: 'artifact.deprecated.useUI',
        pattern: /\buseUI\b/,
        message: 'Packaged UI references legacy useUI naming; use useSDKComponents() or the platform SDK context.',
    },
    {
        code: 'artifact.deprecated.useNotifications',
        pattern: /\buseNotifications\b/,
        message: 'Packaged UI references legacy useNotifications naming; use useSDK().addNotification.',
    },
    {
        code: 'artifact.deprecated.useConfig',
        pattern: /\buseConfig\b/,
        message: 'Packaged UI references legacy useConfig naming; use host-provided SDK context values.',
    },
    {
        code: 'artifact.deprecated.moduleFoundryClient',
        pattern: /\bModuleFoundryClient\b/,
        message: 'Packaged code references the removed ModuleFoundryClient type/surface.',
    },
];

// Server/logic entries run in Node, so private/external imports are audit warnings
// unless a later runtime load actually fails. They are still out-of-spec.
const NODE_PRIVATE_IMPORT_PREFIXES = [
    '@shared/',
    '@client/',
    '@server/',
    '@core/',
    '@modules/',
    '@/',
];

function add(
    diagnostics: ModuleArtifactHealthDiagnostic[],
    severity: ModuleArtifactHealthDiagnostic['severity'],
    code: string,
    message: string,
): void {
    diagnostics.push({ severity, code, message });
}

function resolveInsideModule(modulePath: string, relPath: string): string | null {
    const root = path.resolve(modulePath);
    const resolved = path.resolve(root, relPath);
    // Manifest paths are package-relative only; never follow paths outside the module.
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
    return resolved;
}

function readIfFile(filePath: string | null): string | null {
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
    return fs.readFileSync(filePath, 'utf8');
}

function extractImportSpecifiers(source: string): string[] {
    const specs: string[] = [];
    // This audit is intentionally lightweight: enough to catch static/dynamic bare
    // imports in packaged output without running the full module checker or bundler.
    const patterns = [
        /\bimport\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
        /\bexport\s+[^'"]*?\s+from\s+['"]([^'"]+)['"]/g,
        /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ];

    for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) specs.push(match[1]);
    }
    return specs;
}

function normalizeStylesheetList(value: unknown): string[] {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string');
    return [];
}

function checkRequiredEntry(
    diagnostics: ModuleArtifactHealthDiagnostic[],
    modulePath: string,
    entryKind: 'logic' | 'ui',
    relPath: string,
): string | null {
    // Required UI/logic entries are blocking because the selected module cannot load
    // if the registry points at a missing or escaped file.
    const resolved = resolveInsideModule(modulePath, relPath);
    if (!resolved) {
        add(diagnostics, 'error', `artifact.entry.${entryKind}.outside-root`, `manifest.${entryKind} points outside the module directory: ${relPath}`);
        return null;
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        add(diagnostics, 'error', `artifact.entry.${entryKind}.missing`, `Required packaged ${entryKind} entry is missing: ${relPath}`);
        return null;
    }
    return resolved;
}

function checkOptionalFile(
    diagnostics: ModuleArtifactHealthDiagnostic[],
    modulePath: string,
    relPath: string,
    code: string,
    label: string,
): void {
    // Optional artifacts affect quality/styling/server extras, but an old package can
    // still be useful without them, so missing optional files warn rather than block.
    const resolved = resolveInsideModule(modulePath, relPath);
    if (!resolved) {
        add(diagnostics, 'warning', `${code}.outside-root`, `${label} points outside the module directory: ${relPath}`);
        return;
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        add(diagnostics, 'warning', `${code}.missing`, `${label} is declared but missing from the packaged artifact: ${relPath}`);
    }
}

function checkBrowserImports(
    diagnostics: ModuleArtifactHealthDiagnostic[],
    source: string,
): void {
    for (const specifier of extractImportSpecifiers(source)) {
        if (specifier.startsWith('.') || specifier.startsWith('/')) continue;
        if (BROWSER_GLOBAL_IMPORTS.has(specifier)) continue;
        // The installed UI route rewrites only known globals. Other bare imports fail
        // before React can render a fallback, so the managed source is not enableable.
        add(
            diagnostics,
            'error',
            'artifact.ui.unsupported-import',
            `Packaged UI imports "${specifier}", which the runtime browser loader cannot resolve.`,
        );
    }
}

function checkNodeImports(
    diagnostics: ModuleArtifactHealthDiagnostic[],
    source: string,
    entryKind: 'logic' | 'server',
): void {
    for (const specifier of extractImportSpecifiers(source)) {
        if (specifier.startsWith('.') || specifier.startsWith('/')) continue;
        if (specifier === '@sheet-delver/sdk' || specifier.startsWith('@sheet-delver/sdk/')) continue;
        if (NODE_PRIVATE_IMPORT_PREFIXES.some(prefix => specifier.startsWith(prefix))) {
            // Private imports are an authoring violation, but Node may still resolve a
            // stale package in-place; report drift without preventing admin recovery.
            add(
                diagnostics,
                'warning',
                `artifact.${entryKind}.private-import`,
                `Packaged ${entryKind} imports private platform module "${specifier}"; upgrade to the public SDK surface.`,
            );
            continue;
        }
        add(
            diagnostics,
            'warning',
            `artifact.${entryKind}.external-import`,
            `Packaged ${entryKind} imports external module "${specifier}"; verify the host can resolve it.`,
        );
    }
}

function checkDeprecatedPatterns(
    diagnostics: ModuleArtifactHealthDiagnostic[],
    source: string,
): void {
    for (const entry of DEPRECATED_PATTERNS) {
        // Deduplicate per code so minified/repeated references do not flood the panel.
        if (entry.pattern.test(source) && !diagnostics.some(existing => existing.code === entry.code)) {
            add(diagnostics, 'warning', entry.code, entry.message);
        }
    }
}

/**
 * Lightweight health check for installed packaged modules (`<DATA_DIR>/modules/*`).
 *
 * This is deliberately not `module:check`: older packages should remain loadable
 * when drift is survivable. Only findings that make the selected package unable to
 * load are errors; compatibility drift and stale conventions are warnings.
 */
export function validatePackagedModuleArtifact(
    modulePath: string,
    info: SystemModuleInfo,
): ModuleArtifactHealthResult {
    const diagnostics: ModuleArtifactHealthDiagnostic[] = [];

    // Missing required entries are the primary "totally breaking" packaged state.
    const logicPath = checkRequiredEntry(diagnostics, modulePath, 'logic', info.manifest.logic);
    const uiPath = checkRequiredEntry(diagnostics, modulePath, 'ui', info.manifest.ui);

    // The server entry is optional in the manifest; a missing one is actionable drift.
    if (typeof info.manifest.server === 'string') {
        const serverPath = resolveInsideModule(modulePath, info.manifest.server);
        if (!serverPath) {
            add(diagnostics, 'warning', 'artifact.entry.server.outside-root', `manifest.server points outside the module directory: ${info.manifest.server}`);
        } else if (!fs.existsSync(serverPath) || !fs.statSync(serverPath).isFile()) {
            add(diagnostics, 'warning', 'artifact.entry.server.missing', `Optional packaged server entry is declared but missing: ${info.manifest.server}`);
        }
    }

    if (typeof info.compiledStyles === 'string') {
        checkOptionalFile(diagnostics, modulePath, info.compiledStyles, 'artifact.styles.compiled', 'compiledStyles');
    }

    const stylesheetPaths = normalizeStylesheetList((info as SystemModuleInfo & { stylesheet?: unknown }).stylesheet);
    for (const sheet of stylesheetPaths) {
        checkOptionalFile(diagnostics, modulePath, sheet, 'artifact.stylesheet', 'stylesheet');
    }

    const uiSource = readIfFile(uiPath);
    if (uiSource) {
        // Browser bundles are strict because only the host global map can satisfy bare imports.
        checkBrowserImports(diagnostics, uiSource);
        checkDeprecatedPatterns(diagnostics, uiSource);
    }

    const logicSource = readIfFile(logicPath);
    if (logicSource) {
        // Logic/server diagnostics are softer because runtime loading will provide the
        // definitive failure if Node cannot actually resolve the package.
        checkNodeImports(diagnostics, logicSource, 'logic');
        checkDeprecatedPatterns(diagnostics, logicSource);
    }

    if (typeof info.manifest.server === 'string') {
        const serverSource = readIfFile(resolveInsideModule(modulePath, info.manifest.server));
        if (serverSource) {
            checkNodeImports(diagnostics, serverSource, 'server');
            checkDeprecatedPatterns(diagnostics, serverSource);
        }
    }

    return {
        diagnostics,
        hasErrors: diagnostics.some(diagnostic => diagnostic.severity === 'error'),
        hasWarnings: diagnostics.some(diagnostic => diagnostic.severity === 'warning'),
    };
}
