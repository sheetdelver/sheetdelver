import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as esbuild from 'esbuild';

import { __resetDataDirForTests, initDataDir, resolveDataDir } from '@server/core/paths';
import { validateModuleInfoShape } from '@modules/registry/validation';
import { initModule } from '../../scripts/tools/modules/init-module';

const FORBIDDEN_IMPORT_PREFIXES = ['@shared/', '@client/', '@server/', '@core/', '@modules/', '@/'];

function resolveEntry(modulePath: string, manifestEntry: string): string {
    const base = path.join(modulePath, manifestEntry);
    for (const ext of ['.ts', '.tsx', '.js', '.mjs']) {
        if (fs.existsSync(base + ext)) return base + ext;
    }
    if (fs.existsSync(base)) return base;
    throw new Error(`Entry not found: ${manifestEntry}`);
}

function walkSourceFiles(root: string): string[] {
    const files: string[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const fullPath = path.join(root, entry.name);
        if (entry.isDirectory()) {
            files.push(...walkSourceFiles(fullPath));
        } else if (/\.(tsx?|mjs|jsx?)$/.test(entry.name)) {
            files.push(fullPath);
        }
    }
    return files;
}

function extractImportSpecifiers(source: string): string[] {
    const specs: string[] = [];
    const patterns = [
        /\bimport\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
        /\bexport\s+(?:type\s+)?[^'"]*?\s+from\s+['"]([^'"]+)['"]/g,
        /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ];

    for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) {
            specs.push(match[1]);
        }
    }
    return specs;
}

async function dryBundle(entryFile: string, outfile: string, options: { platform: 'node' | 'browser'; external: string[]; jsx?: boolean }) {
    await esbuild.build({
        entryPoints: [entryFile],
        outfile,
        bundle: true,
        format: 'esm',
        platform: options.platform,
        external: options.external,
        target: 'es2022',
        jsx: options.jsx ? 'automatic' : undefined,
        loader: { '.json': 'json' },
        logLevel: 'silent',
    });
}

export async function run() {
    const testDataDir = path.join(process.cwd(), 'temp', 'module-init-scaffold-test');
    fs.rmSync(testDataDir, { recursive: true, force: true });
    __resetDataDirForTests(null);
    initDataDir(resolveDataDir(['--data-dir', testDataDir]));

    const moduleId = 'sdk-check-test';
    initModule(moduleId, 'SDK Check Test');

    const modulePath = path.join(testDataDir, 'local', 'modules', moduleId);
    const infoPath = path.join(modulePath, 'info.json');
    const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));

    const validation = validateModuleInfoShape(info);
    assert.equal(validation.valid, true, validation.errors.join('\n'));

    const logicEntry = resolveEntry(modulePath, info.manifest.logic);
    const uiEntry = resolveEntry(modulePath, info.manifest.ui);
    const serverEntry = resolveEntry(modulePath, info.manifest.server);

    const logicEntrySource = fs.readFileSync(logicEntry, 'utf8');
    const adapterSource = fs.readFileSync(path.join(modulePath, 'src', 'logic', 'adapter.ts'), 'utf8');
    const uiEntrySource = fs.readFileSync(uiEntry, 'utf8');
    const serverEntrySource = fs.readFileSync(serverEntry, 'utf8');

    assert.match(logicEntrySource, /export \{ SdkCheckTestAdapter as Adapter \}/);
    assert.match(adapterSource, /export class SdkCheckTestAdapter extends BaseSystemAdapter/);
    assert.match(adapterSource, /systemId = 'sdk-check-test'/);
    assert.doesNotMatch(adapterSource, /return \{\};/);
    assert.match(uiEntrySource, /import type \{ ModuleInfo, UIModuleManifest \} from '@sheet-delver\/sdk'/);
    assert.match(serverEntrySource, /export \{ apiRoutes \}/);

    for (const filePath of walkSourceFiles(modulePath)) {
        const source = fs.readFileSync(filePath, 'utf8');
        for (const specifier of extractImportSpecifiers(source)) {
            const forbidden = FORBIDDEN_IMPORT_PREFIXES.find((prefix) => specifier === prefix.slice(0, -1) || specifier.startsWith(prefix));
            assert.equal(forbidden, undefined, `${path.relative(modulePath, filePath)} imports forbidden alias ${specifier}`);
        }
    }

    const typecheck = spawnSync('npx', ['tsc', '--noEmit', '--project', path.join(modulePath, 'tsconfig.json')], {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(typecheck.status, 0, `${typecheck.stdout}${typecheck.stderr}`);

    const bundleDir = path.join(testDataDir, 'bundle');
    fs.mkdirSync(bundleDir, { recursive: true });
    await dryBundle(logicEntry, path.join(bundleDir, 'logic.js'), {
        platform: 'node',
        external: ['@sheet-delver/sdk'],
    });
    await dryBundle(uiEntry, path.join(bundleDir, 'ui.js'), {
        platform: 'browser',
        external: ['@sheet-delver/sdk', 'react', 'react-dom', 'react/jsx-runtime'],
        jsx: true,
    });
    await dryBundle(serverEntry, path.join(bundleDir, 'server.js'), {
        platform: 'node',
        external: ['@sheet-delver/sdk'],
    });

    console.log('module-init-scaffold: PASS');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
