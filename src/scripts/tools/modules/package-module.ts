import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as tar from 'tar';
import * as esbuild from 'esbuild';
import { resolveDataDir, initDataDir, getModulesDataDir, getDistModulesDir } from '../../../server/core/paths';

// ---------------------------------------------------------------------------
// Build configuration
// ---------------------------------------------------------------------------

const LOGIC_EXTERNALS = ['@sheet-delver/sdk'];
const UI_EXTERNALS    = ['@sheet-delver/sdk', 'react', 'react-dom', 'react/jsx-runtime'];

const ENTRIES = [
    { key: 'logic',  outName: 'logic.js',  externals: LOGIC_EXTERNALS, platform: 'node'    as const, jsx: false },
    { key: 'ui',     outName: 'ui.js',     externals: UI_EXTERNALS,    platform: 'browser' as const, jsx: true  },
    { key: 'server', outName: 'server.js', externals: LOGIC_EXTERNALS, platform: 'node'    as const, jsx: false },
];

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

async function compile(
    entryFile: string,
    outFile: string,
    options: { externals: string[]; platform: 'node' | 'browser'; jsx: boolean }
): Promise<void> {
    await esbuild.build({
        entryPoints: [entryFile],
        bundle: true,
        format: 'esm',
        outfile: outFile,
        external: options.externals,
        platform: options.platform,
        target: 'es2022',
        jsx: options.jsx ? 'automatic' : undefined,
        loader: { '.json': 'json' },
        logLevel: 'warning',
    });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function packageModule() {
    initDataDir(resolveDataDir());

    const moduleId = process.argv[2];
    if (!moduleId) {
        console.error('Usage: npm run package:module <moduleId>');
        process.exit(1);
    }

    // Locate module source directory
    let modulePath = path.resolve('src/modules', moduleId);
    if (!fs.existsSync(modulePath)) {
        modulePath = path.join(getModulesDataDir(), moduleId);
        if (!fs.existsSync(modulePath)) {
            console.error(`Module "${moduleId}" not found in src/modules or ${getModulesDataDir()}`);
            process.exit(1);
        }
    }

    const infoPath = path.join(modulePath, 'info.json');
    if (!fs.existsSync(infoPath)) {
        console.error(`info.json not found in ${modulePath}`);
        process.exit(1);
    }

    const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
    const version: string = info.version || '0.0.0-dev';
    const manifest = info.manifest as Record<string, string>;

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
                await compile(entryFile, path.join(stagingDist, outName), { externals, platform, jsx });
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
