import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import patch from '../../../../patches/next-16.3.8-webpack-hmr-sync.json';

export type NextDevPatchResult = 'applied' | 'already-applied' | 'restored' | 'already-original';
const digest = (source: string) => createHash('sha256').update(source).digest('hex');

/** ADR-0062: reproducible dependency preparation, before any dev child starts. */
export function prepareNextDev(nextPackageJsonPath?: string, restore = false): NextDevPatchResult {
    const packagePath = nextPackageJsonPath ?? createRequire(path.resolve('package.json')).resolve('next/package.json');
    const metadata = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { version?: string };
    if (metadata.version !== patch.version) {
        throw new Error(`Next development HMR correction requires ${patch.version}; installed ${metadata.version ?? 'unknown'}. Review ADR-0062 before changing the patch or Next version.`);
    }
    const target = path.join(path.dirname(packagePath), patch.target);
    const source = fs.readFileSync(target, 'utf8');
    const originalHash = restore ? patch.patchedSha256 : patch.originalSha256;
    const nextHash = restore ? patch.originalSha256 : patch.patchedSha256;
    const hash = digest(source);
    if (hash === nextHash) return restore ? 'already-original' : 'already-applied';
    if (hash !== originalHash) {
        throw new Error('Next development HMR target has unexpected contents. No patch was written; reinstall the pinned dependency or review ADR-0062.');
    }
    const before = restore ? patch.after : patch.before;
    const after = restore ? patch.before : patch.after;
    if (source.split(before).length !== 2) throw new Error('Next development HMR correction must match exactly one send site.');
    const updated = source.replace(before, after);
    if (digest(updated) !== nextHash) throw new Error('Next development HMR correction checksum mismatch; no patch was written.');
    fs.writeFileSync(target, updated);
    return restore ? 'restored' : 'applied';
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    try {
        const args = process.argv.slice(2);
        if (args.some(arg => arg !== '--restore' && !arg.startsWith('--next-package='))) {
            throw new Error('Usage: prepare-next-dev.ts [--restore] [--next-package=/path/to/next/package.json]');
        }
        const packageArg = args.find(arg => arg.startsWith('--next-package='));
        const result = prepareNextDev(packageArg?.slice('--next-package='.length), args.includes('--restore'));
        console.info(`[Next dev] HMR synchronization correction: ${result}.`);
    } catch (error) {
        console.error(`[Next dev] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}
