import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import * as tar from 'tar';
import { getDistArchivesDir, getModulesDataDir } from '@core/paths';
import { parseModuleId } from '@shared/security/moduleId';
import { discoverMigrations, migrationSummary } from '../migrations/catalog';
import type { SystemModuleInfo } from '../core/types';
import { validatePackagedModuleArtifact, type ModuleArtifactHealthResult } from '../lifecycle/artifactHealth';
import { evaluateModuleCompatibility, type ModuleCompatibilityResult, validateModuleInfoShape } from '../lifecycle/validation';
import {
    isValidModuleReleaseVersion,
    validateModuleReleaseManifest,
    type ModuleReleaseManifest,
} from './releaseManifest';

const MEBIBYTE = 1024 * 1024;

export interface ModuleArchiveLimits {
    maxArchiveBytes: number;
    maxExtractedBytes: number;
    maxFileBytes: number;
    maxEntries: number;
    maxPathBytes: number;
    maxDepth: number;
    maxDecompressionRatio: number;
    maxManifestBytes: number;
}

export const DEFAULT_MODULE_ARCHIVE_LIMITS: Readonly<ModuleArchiveLimits> = Object.freeze({
    maxArchiveBytes: 64 * MEBIBYTE,
    maxExtractedBytes: 256 * MEBIBYTE,
    maxFileBytes: 64 * MEBIBYTE,
    maxEntries: 10_000,
    maxPathBytes: 240,
    maxDepth: 32,
    maxDecompressionRatio: 100,
    maxManifestBytes: MEBIBYTE,
});

export interface ModuleArchiveInspection {
    entryCount: number;
    fileCount: number;
    extractedBytes: number;
    paths: string[];
}

export interface PrepareModuleArchiveOptions {
    archivePath: string;
    expectedModuleId?: string;
    releaseManifest?: ModuleReleaseManifest;
    limits?: Partial<ModuleArchiveLimits>;
    stagingRoot?: string;
    coreVersion?: string;
}

export interface PreparedModuleArchive {
    transactionDirectory: string;
    archivePath: string;
    moduleDirectory: string;
    info: SystemModuleInfo;
    archiveSize: number;
    integrity: string;
    inspection: ModuleArchiveInspection;
    artifactHealth: ModuleArtifactHealthResult;
    compatibility: ModuleCompatibilityResult;
}

export interface ModuleArchivePromotion {
    moduleId: string;
    targetDirectory: string;
    replacedExisting: boolean;
    previousDirectory: string;
    commit(): void;
    rollback(): void;
}

function resolveLimits(overrides?: Partial<ModuleArchiveLimits>): ModuleArchiveLimits {
    const limits = { ...DEFAULT_MODULE_ARCHIVE_LIMITS, ...overrides };
    for (const [name, value] of Object.entries(limits)) {
        if (!Number.isSafeInteger(value) || value <= 0) {
            throw new Error(`Archive limit "${name}" must be a positive integer`);
        }
    }
    return limits;
}

function ensurePlainDirectory(directoryPath: string): void {
    fs.mkdirSync(directoryPath, { recursive: true });
    const stat = fs.lstatSync(directoryPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Archive directory must be a physical directory: ${directoryPath}`);
    }
}

function normalizeArchivePath(value: string): string {
    if (!value || value.includes('\0') || value.includes('\\')) {
        throw new Error(`Archive contains an invalid path: ${JSON.stringify(value)}`);
    }
    if (path.posix.isAbsolute(value) || /^[A-Za-z]:\//.test(value)) {
        throw new Error(`Archive contains an absolute path: ${value}`);
    }

    const withoutTrailingSlash = value.endsWith('/') ? value.slice(0, -1) : value;
    const segments = withoutTrailingSlash.split('/');
    if (segments.length === 0 || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
        throw new Error(`Archive contains an unconfined path: ${value}`);
    }
    return segments.join('/');
}

export function inspectModuleArchive(
    archivePath: string,
    limitOverrides?: Partial<ModuleArchiveLimits>,
): ModuleArchiveInspection {
    const limits = resolveLimits(limitOverrides);
    const sourceStat = fs.lstatSync(archivePath);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
        throw new Error('Module archive must be a regular file, not a link or special file');
    }
    if (sourceStat.size <= 0 || sourceStat.size > limits.maxArchiveBytes) {
        throw new Error(`Module archive size must be between 1 and ${limits.maxArchiveBytes} bytes`);
    }

    let entryCount = 0;
    let fileCount = 0;
    let extractedBytes = 0;
    const paths: string[] = [];
    const seenPaths = new Set<string>();

    tar.list({
        file: archivePath,
        sync: true,
        strict: true,
        maxDecompressionRatio: limits.maxDecompressionRatio,
        onReadEntry(entry) {
            if (entry.meta) return;
            entryCount += 1;
            if (entryCount > limits.maxEntries) {
                throw new Error(`Archive exceeds the ${limits.maxEntries} entry limit`);
            }

            const entryPath = normalizeArchivePath(entry.path);
            if (Buffer.byteLength(entryPath, 'utf8') > limits.maxPathBytes) {
                throw new Error(`Archive path exceeds the ${limits.maxPathBytes} byte limit: ${entryPath}`);
            }
            if (entryPath.split('/').length > limits.maxDepth) {
                throw new Error(`Archive path exceeds the ${limits.maxDepth} segment depth limit: ${entryPath}`);
            }
            if (seenPaths.has(entryPath)) {
                throw new Error(`Archive contains a duplicate path: ${entryPath}`);
            }
            seenPaths.add(entryPath);
            paths.push(entryPath);

            if (entry.type !== 'File' && entry.type !== 'OldFile' && entry.type !== 'Directory') {
                throw new Error(`Archive entry type "${entry.type}" is not allowed: ${entryPath}`);
            }
            if (entry.type === 'Directory') return;
            if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > limits.maxFileBytes) {
                throw new Error(`Archive file exceeds the ${limits.maxFileBytes} byte limit: ${entryPath}`);
            }
            fileCount += 1;
            extractedBytes += entry.size;
            if (!Number.isSafeInteger(extractedBytes) || extractedBytes > limits.maxExtractedBytes) {
                throw new Error(`Archive exceeds the ${limits.maxExtractedBytes} extracted byte limit`);
            }
        },
    });

    if (fileCount === 0) throw new Error('Module archive contains no files');
    if (!seenPaths.has('info.json')) {
        throw new Error('Module archive must contain info.json at its root');
    }

    return { entryCount, fileCount, extractedBytes, paths };
}

function assertExtractedTreeIsPlain(root: string): void {
    const pending = [root];
    while (pending.length > 0) {
        const directory = pending.pop()!;
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const entryPath = path.join(directory, entry.name);
            const stat = fs.lstatSync(entryPath);
            if (stat.isSymbolicLink()) {
                throw new Error(`Extracted module contains a symbolic link: ${path.relative(root, entryPath)}`);
            }
            if (stat.isDirectory()) {
                pending.push(entryPath);
                continue;
            }
            if (!stat.isFile()) {
                throw new Error(`Extracted module contains a special file: ${path.relative(root, entryPath)}`);
            }
        }
    }
}

function readModuleInfo(moduleDirectory: string, limits: ModuleArchiveLimits): SystemModuleInfo {
    const infoPath = path.join(moduleDirectory, 'info.json');
    const stat = fs.lstatSync(infoPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limits.maxManifestBytes) {
        throw new Error(`Archive info.json must be a regular file no larger than ${limits.maxManifestBytes} bytes`);
    }

    let info: unknown;
    try {
        info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
    } catch {
        throw new Error('Archive info.json is not valid JSON');
    }

    const shape = validateModuleInfoShape(info);
    if (!shape.valid) throw new Error(`Archive info.json is invalid: ${shape.errors.join('; ')}`);
    const moduleInfo = info as SystemModuleInfo;
    if (!isValidModuleReleaseVersion(moduleInfo.version)) {
        throw new Error('Archive info.json must declare a safe non-empty version');
    }
    return moduleInfo;
}

function assertReleaseManifestMatches(
    releaseManifest: ModuleReleaseManifest,
    info: SystemModuleInfo,
    archiveSize: number,
    integrity: string,
): void {
    const validation = validateModuleReleaseManifest(releaseManifest);
    if (!validation.valid) {
        throw new Error(`Release manifest is invalid: ${validation.errors.join('; ')}`);
    }
    if (releaseManifest.artifact.size !== archiveSize || releaseManifest.artifact.integrity !== integrity) {
        throw new Error('Archive size or digest does not match the release manifest');
    }

    const expected = releaseManifest.module;
    const comparisons: Array<[string, unknown, unknown]> = [
        ['id', expected.id, info.id],
        ['version', expected.version, info.version],
        ['compatibility', expected.compatibility, info.compatibility],
        ['permissions', expected.permissions, info.permissions],
        ['dependencies', expected.dependencies, info.dependencies],
        ['conflicts', expected.conflicts, info.conflicts],
        ['worldSettings', expected.worldSettings, info.worldSettings],
    ];
    for (const [field, expectedValue, actualValue] of comparisons) {
        if (!isDeepStrictEqual(expectedValue, actualValue)) {
            throw new Error(`Archive info.json field "${field}" does not match the release manifest`);
        }
    }
}

export async function prepareModuleArchive(options: PrepareModuleArchiveOptions): Promise<PreparedModuleArchive> {
    const limits = resolveLimits(options.limits);
    const stagingRoot = path.resolve(options.stagingRoot ?? getDistArchivesDir());
    ensurePlainDirectory(stagingRoot);
    const transactionDirectory = fs.mkdtempSync(path.join(stagingRoot, '.module-install-'));

    try {
        const sourcePath = path.resolve(options.archivePath);
        const sourceStat = fs.lstatSync(sourcePath);
        if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
            throw new Error('Module archive source must be a regular file');
        }
        if (sourceStat.size <= 0 || sourceStat.size > limits.maxArchiveBytes) {
            throw new Error(`Module archive size must be between 1 and ${limits.maxArchiveBytes} bytes`);
        }

        const snapshotPath = path.join(transactionDirectory, 'module.tgz');
        fs.copyFileSync(sourcePath, snapshotPath, fs.constants.COPYFILE_EXCL);
        const inspection = inspectModuleArchive(snapshotPath, limits);
        const archiveBuffer = fs.readFileSync(snapshotPath);
        const integrity = `sha256:${crypto.createHash('sha256').update(archiveBuffer).digest('hex')}`;
        const archiveSize = archiveBuffer.length;

        const moduleDirectory = path.join(transactionDirectory, 'module');
        fs.mkdirSync(moduleDirectory);
        await tar.extract({
            file: snapshotPath,
            cwd: moduleDirectory,
            strict: true,
            preservePaths: false,
            preserveOwner: false,
            noMtime: true,
            maxDepth: limits.maxDepth,
            maxDecompressionRatio: limits.maxDecompressionRatio,
        });
        assertExtractedTreeIsPlain(moduleDirectory);

        const info = readModuleInfo(moduleDirectory, limits);
        const moduleId = parseModuleId(info.id)!;
        if (options.expectedModuleId && parseModuleId(options.expectedModuleId) !== moduleId) {
            throw new Error(`Archive module id "${moduleId}" does not match expected id "${options.expectedModuleId}"`);
        }
        if (options.releaseManifest) {
            assertReleaseManifestMatches(options.releaseManifest, info, archiveSize, integrity);
            if (!isDeepStrictEqual(options.releaseManifest.migrations, migrationSummary(discoverMigrations(moduleDirectory, info)))) {
                throw new Error('Release migration summary does not match packaged catalog');
            }
        }

        const artifactHealth = validatePackagedModuleArtifact(moduleDirectory, info);
        if (artifactHealth.hasErrors) {
            const reasons = artifactHealth.diagnostics
                .filter((diagnostic) => diagnostic.severity === 'error')
                .map((diagnostic) => diagnostic.message);
            throw new Error(`Packaged module health check failed: ${reasons.join('; ')}`);
        }

        const compatibility = evaluateModuleCompatibility(info, options.coreVersion ?? '0.0.0');
        return {
            transactionDirectory,
            archivePath: snapshotPath,
            moduleDirectory,
            info,
            archiveSize,
            integrity,
            inspection,
            artifactHealth,
            compatibility,
        };
    } catch (error) {
        fs.rmSync(transactionDirectory, { recursive: true, force: true });
        throw error;
    }
}

export function discardPreparedModuleArchive(prepared: PreparedModuleArchive): void {
    fs.rmSync(prepared.transactionDirectory, { recursive: true, force: true });
}

function syncPromotionDirectory(directory: string): void {
    if (process.platform === 'win32') return;
    const descriptor = fs.openSync(directory, 'r');
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}
function syncPromotionTree(directory: string): void {
    if (process.platform === 'win32') return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error('Unexpected promotion symlink');
        if (entry.isDirectory()) syncPromotionTree(file);
        else {
            const descriptor = fs.openSync(file, 'r');
            try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
        }
    }
    syncPromotionDirectory(directory);
}

export function promotePreparedModuleArchive(
    prepared: PreparedModuleArchive,
    modulesRoot = getModulesDataDir(),
    onTransition?: (phase: 'intent' | 'previous-retained' | 'promoted', paths: { targetDirectory: string; previousDirectory: string }) => void,
): ModuleArchivePromotion {
    const moduleId = parseModuleId(prepared.info.id);
    if (!moduleId) throw new Error('Prepared archive has an invalid module id');
    ensurePlainDirectory(modulesRoot);

    const stagingDevice = fs.statSync(prepared.moduleDirectory).dev;
    const modulesDevice = fs.statSync(modulesRoot).dev;
    if (stagingDevice !== modulesDevice) {
        throw new Error('Archive staging and managed modules must be on the same filesystem for atomic promotion');
    }

    const targetDirectory = path.join(path.resolve(modulesRoot), moduleId);
    const backupDirectory = path.join(prepared.transactionDirectory, 'previous');
    const targetExists = fs.existsSync(targetDirectory);
    if (onTransition) syncPromotionTree(prepared.moduleDirectory);
    onTransition?.('intent', { targetDirectory, previousDirectory: backupDirectory });
    if (targetExists) {
        const targetStat = fs.lstatSync(targetDirectory);
        if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
            throw new Error(`Managed module target is not a physical directory: ${targetDirectory}`);
        }
        fs.renameSync(targetDirectory, backupDirectory);
        if (onTransition) { syncPromotionDirectory(modulesRoot); syncPromotionDirectory(prepared.transactionDirectory); }
    }
    onTransition?.('previous-retained', { targetDirectory, previousDirectory: backupDirectory });

    try {
        fs.renameSync(prepared.moduleDirectory, targetDirectory);
        if (onTransition) { syncPromotionDirectory(modulesRoot); syncPromotionDirectory(prepared.transactionDirectory); }
        onTransition?.('promoted', { targetDirectory, previousDirectory: backupDirectory });
    } catch (error) {
        if (targetExists && fs.existsSync(backupDirectory)) {
            fs.renameSync(backupDirectory, targetDirectory);
        }
        throw error;
    }

    let closed = false;
    return {
        moduleId,
        targetDirectory,
        replacedExisting: targetExists,
        previousDirectory: backupDirectory,
        commit() {
            if (closed) return;
            fs.rmSync(prepared.transactionDirectory, { recursive: true, force: true });
            closed = true;
        },
        rollback() {
            if (closed) return;
            if (fs.existsSync(targetDirectory)) {
                const targetStat = fs.lstatSync(targetDirectory);
                if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
                    throw new Error(`Cannot roll back unexpected managed target: ${targetDirectory}`);
                }
                fs.rmSync(targetDirectory, { recursive: true, force: true });
            }
            if (targetExists) {
                if (!fs.existsSync(backupDirectory)) {
                    throw new Error(`Cannot roll back module "${moduleId}": backup is missing`);
                }
                fs.renameSync(backupDirectory, targetDirectory);
            }
            fs.rmSync(prepared.transactionDirectory, { recursive: true, force: true });
            closed = true;
        },
    };
}
