import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as tar from 'tar';
import * as esbuild from 'esbuild';
import { resolveDataDir, initDataDir, getModulesDataDir, getDistModulesDir, getLocalModulesDataDir } from '../../../server/core/paths';
import { ENTRIES, BUILD_TARGET, BUILD_LOADER } from './build-config';
import { checkModule, printModuleCheckSummary } from './check-module';

// Build configuration (ENTRIES, externals, target, loaders) is shared with
// check-module.ts via ./build-config so packaging and validation never drift
// (ADR-0027 decision 29).

// Optional files copied from the module root into the archive if they exist
const OPTIONAL_FILES = ['LICENSE', 'README.md'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveEntry(modulePath: string, manifestEntry: string): string | null {
    const base = path.join(modulePath, manifestEntry);
    for (const ext of ['.ts', '.tsx', '.js', '.mjs']) {
        if (fs.existsSync(base + ext)) return base + ext;
    }
    return fs.existsSync(base) ? base : null;
}

/**
 * Recursively copies a directory tree from src to dest.
 * Creates dest if it doesn't exist.
 */
function copyDirRecursive(src: string, dest: string): void {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDirRecursive(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

async function compile(
    entryFile: string,
    outFile: string,
    options: { externals: readonly string[]; platform: 'node' | 'browser'; jsx: boolean; sourcemap: boolean }
): Promise<void> {
    await esbuild.build({
        entryPoints: [entryFile],
        bundle: true,
        format: 'esm',
        outfile: outFile,
        external: [...options.externals],
        platform: options.platform,
        target: BUILD_TARGET,
        jsx: options.jsx ? 'automatic' : undefined,
        sourcemap: options.sourcemap ? 'linked' : false,
        loader: BUILD_LOADER,
        logLevel: 'warning',
    });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function packageModule() {
    initDataDir(resolveDataDir(process.argv));

    const args = process.argv.slice(2);
    let moduleId: string | undefined;
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === '--data-dir') {
            index += 1;
            continue;
        }
        if (arg.startsWith('--')) continue;
        moduleId = arg;
        break;
    }

    if (!moduleId) {
        console.error('Usage: npm run module:package <moduleId> [-- --data-dir <path> --sourcemap]');
        process.exit(1);
    }

    const sourceMap = process.argv.includes('--sourcemap');

    // Locate module local dev source directory
    let modulePath = path.join(getLocalModulesDataDir(), moduleId);
    if (!fs.existsSync(modulePath)) {
        console.error(`Module "${moduleId}" not found ${getLocalModulesDataDir()}`);
        process.exit(1);
    }

    const infoPath = path.join(modulePath, 'info.json');
    if (!fs.existsSync(infoPath)) {
        console.error(`info.json not found in ${modulePath}`);
        process.exit(1);
    }

    const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
    const version: string = info.version || '0.0.0-dev';
    const manifest = info.manifest as Record<string, string>;

    // Gate packaging on module:check — a non-conforming module is not packageable
    // (ADR-0027 decision 29). Same shared build config, so validation can't drift.
    console.log(`\nValidating ${moduleId} before packaging...`);
    const checkResult = await checkModule(moduleId);
    if (!checkResult.passed) {
        printModuleCheckSummary(checkResult);
        console.error(`\nRefusing to package "${moduleId}": module:check failed. Fix the issues above and retry.`);
        process.exit(1);
    }

    console.log(`\nPackaging ${moduleId} v${version}...`);
    console.log(`Source : ${modulePath}`);

    // Create an isolated staging directory — source tree is never touched
    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), `sd-pkg-${moduleId}-`));
    const stagingDist = path.join(stagingDir, 'dist');
    fs.mkdirSync(stagingDist);

    try {
        // -----------------------------------------------------------------------
        // Compile each entry point into staging/dist/
        // -----------------------------------------------------------------------

        const compiledManifest: Record<string, string> = {};

        for (const { key, outName, externals, platform, jsx } of ENTRIES) {
            if (!manifest[key]) continue;

            const entryFile = resolveEntry(modulePath, manifest[key]);
            if (!entryFile) {
                console.warn(`  ⚠ Entry "${manifest[key]}" declared but file not found — skipping`);
                continue;
            }

            process.stdout.write(`  Compiling ${key} (${path.relative(modulePath, entryFile)}) → dist/${outName} ... `);
            try {
                await compile(entryFile, path.join(stagingDist, outName), { externals, platform, jsx, sourcemap: sourceMap });
                compiledManifest[key] = `dist/${outName}`;
                console.log('✓');
            } catch (err: any) {
                console.log('✗');
                console.error(`\nCompilation failed for "${key}":\n${err.message ?? err}`);
                process.exit(1);
            }
        }

        if (Object.keys(compiledManifest).length === 0) {
            console.error('No entries compiled — nothing to package.');
            process.exit(1);
        }

        // -----------------------------------------------------------------------
        // Write patched info.json into staging root (source info.json untouched)
        // -----------------------------------------------------------------------

        const artifactInfo = { ...info, manifest: { ...manifest, ...compiledManifest } };
        fs.writeFileSync(
            path.join(stagingDir, 'info.json'),
            JSON.stringify(artifactInfo, null, 2)
        );

        // Copy optional files if present
        for (const file of OPTIONAL_FILES) {
            const src = path.join(modulePath, file);
            if (fs.existsSync(src)) fs.copyFileSync(src, path.join(stagingDir, file));
        }

        // -----------------------------------------------------------------------
        // Copy assets/ directory and custom package.include files
        // -----------------------------------------------------------------------

        // Auto-include the standard assets/ directory
        const assetsDir = path.join(modulePath, 'assets');
        if (fs.existsSync(assetsDir)) {
            copyDirRecursive(assetsDir, path.join(stagingDir, 'assets'));
            console.log('  Copied assets/ directory');
        }

        // Process developer-declared includes from info.json package.include
        // Use this for files/directories outside the standard assets/ convention.
        const includes: string[] = (info.package?.include ?? []) as string[];
        for (const includePath of includes) {
            const src = path.join(modulePath, includePath);
            if (!fs.existsSync(src)) {
                console.warn(`  ⚠ package.include path "${includePath}" not found — skipping`);
                continue;
            }
            const dest = path.join(stagingDir, includePath);
            if (fs.statSync(src).isDirectory()) {
                copyDirRecursive(src, dest);
            } else {
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                fs.copyFileSync(src, dest);
            }
            console.log(`  Included: ${includePath}`);
        }

        // -----------------------------------------------------------------------
        // Build archive from staging — source directory is read-only throughout
        // -----------------------------------------------------------------------

        const outDir = getDistModulesDir();
        fs.mkdirSync(outDir, { recursive: true });
        const outFile = path.join(outDir, `${moduleId}-${version}.tgz`);

        const filesToPack = fs.readdirSync(stagingDir);

        console.log(`\nCreating archive: ${path.relative(process.cwd(), outFile)}`);

        await tar.create(
            { gzip: true, file: outFile, cwd: stagingDir, portable: true },
            filesToPack
        );

        // Compute integrity hash
        const fileBuffer = fs.readFileSync(outFile);
        const hash = crypto.createHash('sha256');
        hash.update(fileBuffer);
        const integrity = `sha256:${hash.digest('hex')}`;

        console.log(`\n✅ ${moduleId} v${version} packaged successfully`);
        console.log(`   Archive : ${outFile}`);
        console.log(`   Size    : ${(fileBuffer.length / 1024).toFixed(1)} KB`);
        console.log(`   Sha256  : ${integrity}`);
        console.log(`\n   Compiled entries:`);
        for (const [key, dest] of Object.entries(compiledManifest)) {
            console.log(`     ${key.padEnd(8)} → ${dest}`);
        }
    } finally {
        // Always clean up the staging directory
        fs.rmSync(stagingDir, { recursive: true, force: true });
    }
}

packageModule();
