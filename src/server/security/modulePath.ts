import fs from 'node:fs';
import path from 'node:path';
import { parseModuleId } from '@shared/security/moduleId';

function isStrictDescendant(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function realpathIfType(candidate: string, type: 'directory' | 'file'): string | null {
    try {
        const real = fs.realpathSync(candidate);
        const stat = fs.statSync(real);
        if (type === 'directory' ? !stat.isDirectory() : !stat.isFile()) return null;
        return real;
    } catch {
        return null;
    }
}

/** Resolve a canonical direct-child module directory without following escapes. */
export function resolveModuleDirectory(root: string, value: unknown): string | null {
    const moduleId = parseModuleId(value);
    const rootReal = realpathIfType(root, 'directory');
    if (!moduleId || !rootReal) return null;

    const candidateReal = realpathIfType(path.join(rootReal, moduleId), 'directory');
    if (!candidateReal || !isStrictDescendant(rootReal, candidateReal)) return null;
    return candidateReal;
}

function isSafeRelativePath(relativePath: string): boolean {
    if (!relativePath || relativePath.includes('\\') || relativePath.includes('\0') || path.isAbsolute(relativePath)) return false;
    return relativePath.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

/** Resolve a regular file and prove its real path remains below the real root. */
export function resolveConfinedFile(root: string, relativePath: string): string | null {
    if (!isSafeRelativePath(relativePath)) return null;
    const rootReal = realpathIfType(root, 'directory');
    if (!rootReal) return null;

    const candidate = path.resolve(rootReal, relativePath);
    if (!isStrictDescendant(rootReal, candidate)) return null;
    const candidateReal = realpathIfType(candidate, 'file');
    if (!candidateReal || !isStrictDescendant(rootReal, candidateReal)) return null;
    return candidateReal;
}

export function resolveConfinedDirectory(root: string, relativePath: string): string | null {
    if (!isSafeRelativePath(relativePath)) return null;
    const rootReal = realpathIfType(root, 'directory');
    if (!rootReal) return null;

    const candidateReal = realpathIfType(path.resolve(rootReal, relativePath), 'directory');
    if (!candidateReal || !isStrictDescendant(rootReal, candidateReal)) return null;
    return candidateReal;
}

/** Express 5 wildcard parameters may be a string or an array of path segments. */
export function readWildcardPath(value: unknown): string | null {
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && value.every((segment) => typeof segment === 'string')) return value.join('/');
    return null;
}
