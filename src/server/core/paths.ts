/**
 * Unified Data Directory Resolver
 *
 * Provides a single source of truth for all data storage paths in the application.
 * All persistent data (config, cache, security, modules, logs) lives under a single
 * configurable data directory.
 *
 * Resolution order (first match wins):
 *   1. --data-dir=<path> CLI argument
 *   2. SHEET_DELVER_DATA environment variable
 *   3. DATA_DIR environment variable (alias)
 *   4. USER_DATA environment variable (alias)
 *   5. ./data/ relative to CWD (development default)
 *   6. ~/.sheet-delver/ (XDG-style home directory)
 *   7. Falls back to ./data/ and creates it
 *
 * Usage:
 *   // At startup (once, before any other module):
 *   const dir = resolveDataDir(process.argv);
 *   initDataDir(dir);
 *
 *   // Anywhere else:
 *   import { getCacheDir, getConfigFilePath } from '@core/paths';
 *   const cachePath = getCacheDir();
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// ─── Internal State ────────────────────────────────────────────────

/** Resolved absolute data directory path. null until resolveDataDir() is called. */
let _dataDir: string | null = null;

/** For unit testing: reset the internal data directory state. */
export function __resetDataDirForTests(dir: string | null = null): void {
    _dataDir = dir;
}

// ─── Constants ─────────────────────────────────────────────────────

/** Subdirectory names within the data directory. */
const SUBDIRS = [
    'config',
    'cache',
    'security',
    'modules',
    'logs',
    'dist',
    'dist/modules',
    'dist/archives'
] as const;

/** Settings file name within the config subdirectory. */
const SETTINGS_FILENAME = 'settings.yaml';

/** Home directory folder name for user-level data storage. */
const HOME_DIR_NAME = '.sheet-delver';

/** Local directory name for project-level data storage (development default). */
const LOCAL_DIR_NAME = 'data';

// ─── Resolution ────────────────────────────────────────────────────

/**
 * Resolves the data directory path from CLI arguments, environment variables,
 * or well-known default locations.
 *
 * @param args - Command-line arguments (defaults to process.argv)
 * @returns Absolute path to the data directory
 */
export function resolveDataDir(args: string[] = process.argv): string {
    // 1. CLI argument: --data-dir=/some/path or --data-dir /some/path
    const dataDirArg = parseDataDirArg(args);
    if (dataDirArg) {
        const resolved = path.resolve(dataDirArg);
        _dataDir = resolved;
        return resolved;
    }

    // 2. Environment variables (priority order)
    const envVarNames = ['SHEET_DELVER_DATA', 'DATA_DIR', 'USER_DATA'];
    for (const varName of envVarNames) {
        const envValue = process.env[varName];
        if (envValue && envValue.trim().length > 0) {
            const resolved = path.resolve(envValue.trim());
            _dataDir = resolved;
            return resolved;
        }
    }

    // 3. Local ./data/ directory (adjacent to CWD)
    const localDir = path.resolve(process.cwd(), LOCAL_DIR_NAME);
    if (fs.existsSync(localDir)) {
        _dataDir = localDir;
        return localDir;
    }

    // 4. Home directory ~/.sheet-delver/
    const homeDir = path.join(os.homedir(), HOME_DIR_NAME);
    if (fs.existsSync(homeDir)) {
        _dataDir = homeDir;
        return homeDir;
    }

    // 5. Default: create ./data/ relative to CWD
    _dataDir = localDir;
    return localDir;
}

/**
 * Parses the --data-dir argument from the command-line arguments.
 * Supports both --data-dir=/path and --data-dir /path formats.
 *
 * @param args - Command-line arguments array
 * @returns The parsed path string, or null if not found
 */
function parseDataDirArg(args: string[]): string | null {
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        // --data-dir=/some/path (equals syntax)
        if (arg.startsWith('--data-dir=')) {
            const value = arg.slice('--data-dir='.length).trim();
            if (value.length > 0) return value;
        }

        // --data-dir /some/path (space-separated)
        if (arg === '--data-dir' && i + 1 < args.length) {
            const value = args[i + 1].trim();
            if (value.length > 0 && !value.startsWith('--')) return value;
        }
    }
    return null;
}

// ─── Initialization ────────────────────────────────────────────────

/**
 * Creates the data directory and all required subdirectories.
 * Safe to call multiple times (uses recursive mkdir).
 *
 * @param dir - Absolute path to the data directory (from resolveDataDir)
 */
export function initDataDir(dir: string): void {
    _dataDir = dir;

    // Create base directory and all subdirectories
    for (const subdir of SUBDIRS) {
        const subdirPath = path.join(dir, subdir);
        if (!fs.existsSync(subdirPath)) {
            fs.mkdirSync(subdirPath, { recursive: true });
        }
    }
}

/**
 * Checks for legacy data paths at CWD and returns migration messages if found.
 * Does NOT auto-migrate — returns instructions for the operator.
 *
 * @returns Array of warning/error messages, empty if no legacy paths found
 */
export function checkLegacyPaths(): string[] {
    const messages: string[] = [];
    const cwd = process.cwd();
    const dataDir = getDataDir();

    // Check for legacy .data/ directory
    const legacyDataDir = path.join(cwd, '.data');
    if (fs.existsSync(legacyDataDir)) {
        messages.push(
            `[MIGRATION REQUIRED] Found legacy .data/ directory at ${cwd}.`,
            `Move contents to the new data directory at ${dataDir}:`,
            `  mv ${legacyDataDir}/cache/*    ${dataDir}/cache/`,
            `  mv ${legacyDataDir}/security/* ${dataDir}/security/`,
            `  mv ${legacyDataDir}/modules/*  ${dataDir}/modules/`,
            `  rm -rf ${legacyDataDir}/`,
        );
    }

    // Check for legacy settings.yaml in CWD (only if it's not in the data dir)
    const legacySettings = path.join(cwd, SETTINGS_FILENAME);
    const dataSettings = getConfigFilePath();
    if (fs.existsSync(legacySettings) && legacySettings !== dataSettings) {
        messages.push(
            `[MIGRATION REQUIRED] Found legacy settings.yaml at ${cwd}.`,
            `Move to the data directory:`,
            `  mv ${legacySettings} ${dataSettings}`,
        );
    }

    // Check for legacy flat files
    const legacyFiles = ['.foundry-cache.json', '.foundry-session.json'];
    for (const file of legacyFiles) {
        const legacyPath = path.join(cwd, file);
        if (fs.existsSync(legacyPath)) {
            messages.push(
                `[CLEANUP] Found legacy file ${file} at ${cwd}. This file is no longer used and can be removed.`,
            );
        }
    }

    return messages;
}

// ─── Path Getters ──────────────────────────────────────────────────

/**
 * Guard that ensures the data directory has been resolved before use.
 * Throws if resolveDataDir() has not been called.
 */
function ensureResolved(): string {
    if (!_dataDir) {
        throw new Error(
            'Data directory not initialized. Call resolveDataDir() before accessing paths.'
        );
    }
    return _dataDir;
}

/** Returns the base data directory path. */
export function getDataDir(): string {
    return ensureResolved();
}

/** Returns the config subdirectory path (<DATA_DIR>/config). */
export function getConfigDir(): string {
    return path.join(ensureResolved(), 'config');
}

/** Returns the full path to settings.yaml (<DATA_DIR>/config/settings.yaml). */
export function getConfigFilePath(): string {
    return path.join(ensureResolved(), 'config', SETTINGS_FILENAME);
}

/** Returns the cache subdirectory path (<DATA_DIR>/cache). */
export function getCacheDir(): string {
    return path.join(ensureResolved(), 'cache');
}

/** Returns the security subdirectory path (<DATA_DIR>/security). */
export function getSecurityDir(): string {
    return path.join(ensureResolved(), 'security');
}

/** Returns the modules data subdirectory path (<DATA_DIR>/modules). */
export function getModulesDataDir(): string {
    return path.join(ensureResolved(), 'modules');
}

/** Return the local dev modules data subdirectory path (<DATA_DIR>/local/modules) */
export function getLocalModulesDataDir(): string {
    return path.join(ensureResolved(), 'local', 'modules');
}

/**
 * Returns the local (dev) modules directory.
 * This is the scan-only location for locally developed modules.
 * Modules here are never touched by the lifecycle install/upgrade/uninstall system.
 *
 * Override via SHEET_DELVER_LOCAL_MODULES env var.
 * Defaults to <DATA_DIR>/dev-modules if that directory exists, otherwise null.
 */
export function getLocalModulesDir(): string | null {
    const envOverride = process.env.SHEET_DELVER_LOCAL_MODULES;
    if (envOverride && envOverride.trim()) {
        return path.resolve(envOverride.trim());
    }
    const defaultPath = path.join(ensureResolved(), 'local', 'modules');
    return fs.existsSync(defaultPath) ? defaultPath : null;
}

/** Returns the dist/modules subdirectory path (<DATA_DIR>/dist/modules). */
export function getDistModulesDir(): string {
    return path.join(ensureResolved(), 'dist', 'modules');
}

/** Returns the dist/archives subdirectory path (<DATA_DIR>/dist/archives). */
export function getDistArchivesDir(): string {
    return path.join(ensureResolved(), 'dist', 'archives');
}

/** Returns the logs subdirectory path (<DATA_DIR>/logs). */
export function getLogsDir(): string {
    return path.join(ensureResolved(), 'logs');
}
