import fs from 'node:fs';
import path from 'node:path';

export type ExternalSecretReference =
    | { env: string }
    | { file: string };

export interface ResolvedSecret {
    value: string;
    source: 'environment' | 'file' | 'legacy-inline';
}

interface ResolveExternalSecretOptions {
    env?: Readonly<Record<string, string | undefined>>;
    dataDir?: string;
    requireOutsideDataDir?: boolean;
}

function isInside(parent: string, candidate: string): boolean {
    const relative = path.relative(path.resolve(parent), path.resolve(candidate));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function readSecretFile(filePath: string, label: string): string {
    if (!path.isAbsolute(filePath)) {
        throw new Error(`${label} file reference must be an absolute path`);
    }
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`${label} file reference must target a regular non-symlink file`);
    }
    if (stat.size > 16 * 1024) {
        throw new Error(`${label} file exceeds the 16 KiB secret limit`);
    }
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
        throw new Error(`${label} file must not grant group or other permissions`);
    }

    // Secret files commonly end in one line terminator. Remove only that
    // terminator so meaningful leading/trailing spaces are not rewritten.
    const value = fs.readFileSync(filePath, 'utf8').replace(/\r?\n$/, '');
    if (!value || value.includes('\0')) {
        throw new Error(`${label} file is empty or contains a NUL byte`);
    }
    return value;
}

/**
 * Resolve a structured environment/file reference. Plain strings remain a
 * migration-only compatibility form so existing installations still start.
 */
export function resolveExternalSecret(
    input: unknown,
    label: string,
    options: ResolveExternalSecretOptions = {},
): ResolvedSecret | undefined {
    if (input === undefined || input === null || input === '') return undefined;
    if (typeof input === 'string') {
        return { value: input, source: 'legacy-inline' };
    }
    if (typeof input !== 'object' || Array.isArray(input)) {
        throw new Error(`${label} must be a string or an { env } / { file } reference`);
    }

    const reference = input as Record<string, unknown>;
    const keys = Object.keys(reference);
    if (keys.length !== 1 || (keys[0] !== 'env' && keys[0] !== 'file')) {
        throw new Error(`${label} must contain exactly one env or file reference`);
    }

    if (keys[0] === 'env') {
        const variableName = reference.env;
        if (typeof variableName !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variableName)) {
            throw new Error(`${label} env reference has an invalid variable name`);
        }
        const value = (options.env ?? process.env)[variableName];
        if (!value) {
            throw new Error(`${label} environment variable ${variableName} is not set`);
        }
        return { value, source: 'environment' };
    }

    const configuredPath = reference.file;
    if (typeof configuredPath !== 'string' || !configuredPath.trim()) {
        throw new Error(`${label} file reference must be a non-empty path`);
    }
    if (!path.isAbsolute(configuredPath)) {
        throw new Error(`${label} file reference must be an absolute path`);
    }
    const resolvedPath = path.resolve(configuredPath);
    if (options.requireOutsideDataDir && options.dataDir && isInside(options.dataDir, resolvedPath)) {
        throw new Error(`${label} file must be outside <DATA_DIR>`);
    }
    return { value: readSecretFile(resolvedPath, label), source: 'file' };
}
