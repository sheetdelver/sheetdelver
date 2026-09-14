import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import yaml from 'js-yaml';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { __resetDataDirForTests, initDataDir, resolveDataDir } from '@server/core/paths';
import { initModule } from '../../../scripts/tools/modules/init-module';
import { checkModule } from '../../../scripts/tools/modules/check-module';

function resolveEntry(modulePath: string, manifestEntry: string): string {
    const base = path.join(modulePath, manifestEntry);
    for (const ext of ['.ts', '.tsx', '.js', '.mjs']) {
        if (fs.existsSync(base + ext)) return base + ext;
    }
    if (fs.existsSync(base)) return base;
    throw new Error(`Entry not found: ${manifestEntry}`);
}

function walkFiles(root: string): string[] {
    const files: string[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const fullPath = path.join(root, entry.name);
        if (entry.isDirectory()) files.push(...walkFiles(fullPath));
        else if (entry.isFile()) files.push(fullPath);
    }
    return files;
}

export async function run() {
    const testDataDir = path.join(process.cwd(), 'temp', 'module-init-scaffold-test');
    fs.rmSync(testDataDir, { recursive: true, force: true });
    __resetDataDirForTests(null);
    initDataDir(resolveDataDir(['--data-dir', testDataDir]));

    const moduleId = 'sdk-check-test';
    const coreRef = 'v9.8.7';
    initModule(moduleId, 'SDK Check Test', { coreRef });

    const modulePath = path.join(testDataDir, 'local', 'modules', moduleId);
    const scaffoldPath = path.join(process.cwd(), 'src', 'scripts', 'tools', 'modules', 'scaffolds', 'init-module');
    const infoPath = path.join(modulePath, 'info.json');
    const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));

    assert.equal(fs.existsSync(path.join(scaffoldPath, 'module', 'ui.tsx.tmpl')), true);
    assert.equal(fs.existsSync(path.join(scaffoldPath, 'src', 'server', 'server.ts.tmpl')), true);
    const ciWorkflowPath = path.join(modulePath, '.github', 'workflows', `ci-${moduleId}.yaml`);
    const releaseWorkflowPath = path.join(modulePath, '.github', 'workflows', `release-${moduleId}.yaml`);
    assert.equal(fs.existsSync(ciWorkflowPath), true);
    assert.equal(fs.existsSync(releaseWorkflowPath), true);
    const ciWorkflowSource = fs.readFileSync(ciWorkflowPath, 'utf8');
    const releaseWorkflowSource = fs.readFileSync(releaseWorkflowPath, 'utf8');
    assert.doesNotThrow(() => yaml.load(ciWorkflowSource));
    assert.doesNotThrow(() => yaml.load(releaseWorkflowSource));
    assert.match(ciWorkflowSource, /repository: sheetdelver\/sheetdelver/);
    assert.match(ciWorkflowSource, /ref: 'v9\.8\.7'/);
    assert.match(ciWorkflowSource, /npm run module:check/);
    assert.match(ciWorkflowSource, /npm run module:package/);
    assert.doesNotMatch(ciWorkflowSource, /settings\.yaml|npm install|actions\/checkout@v3/);
    assert.match(
        releaseWorkflowSource,
        /uses: sheetdelver\/sheetdelver\/\.github\/workflows\/module-release\.yml@v9\.8\.7/,
    );
    assert.match(releaseWorkflowSource, /module_id: 'sdk-check-test'/);
    assert.match(releaseWorkflowSource, /core_ref: 'v9\.8\.7'/);
    assert.throws(
        () => initModule('invalid-ref-test', 'Invalid Ref Test', { coreRef: 'main\ncontents: write' }),
        /Invalid Sheet Delver core ref/,
    );
    const generatedFiles = walkFiles(modulePath);
    assert.equal(generatedFiles.some((file) => file.endsWith('.tmpl')), false);
    for (const file of generatedFiles) {
        assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /%[A-Z][A-Z0-9_]*%/, path.relative(modulePath, file));
    }

    const logicEntry = resolveEntry(modulePath, info.manifest.logic);
    const uiEntry = resolveEntry(modulePath, info.manifest.ui);
    const serverEntry = resolveEntry(modulePath, info.manifest.server);

    const logicEntrySource = fs.readFileSync(logicEntry, 'utf8');
    const adapterSource = fs.readFileSync(path.join(modulePath, 'src', 'logic', 'adapter.ts'), 'utf8');
    const uiEntrySource = fs.readFileSync(uiEntry, 'utf8');
    const serverEntrySource = fs.readFileSync(serverEntry, 'utf8');
    const sheetPath = path.join(modulePath, 'src', 'ui', 'Sheet.tsx');
    const sheetSource = fs.readFileSync(sheetPath, 'utf8');
    const serverSource = fs.readFileSync(path.join(modulePath, 'src', 'server', 'server.ts'), 'utf8');
    const stylesSource = fs.readFileSync(path.join(modulePath, 'assets', 'styles.css'), 'utf8');

    assert.match(logicEntrySource, /export \{ SdkCheckTestAdapter as Adapter \}/);
    assert.match(adapterSource, /export class SdkCheckTestAdapter extends BaseSystemAdapter/);
    assert.match(adapterSource, /systemId = 'sdk-check-test'/);
    assert.doesNotMatch(adapterSource, /return \{\};/);
    assert.match(uiEntrySource, /import type \{ ModuleInfo, UIModuleManifest \} from '@sheet-delver\/sdk'/);
    assert.doesNotMatch(uiEntrySource, /^\s*actorPage:/m);
    assert.match(sheetSource, /ActorSheetProps/);
    assert.match(sheetSource, /assetUrl\('icon\.svg'\)/);
    assert.equal(fs.existsSync(path.join(modulePath, 'src', 'ui', 'ActorPage.tsx')), false);
    assert.equal(fs.existsSync(path.join(modulePath, 'assets', 'icon.svg')), true);
    assert.match(stylesSource, /\.sdk-module--sdk-check-test \.sheet-root/);
    assert.match(serverEntrySource, /export \{ apiRoutes \}/);
    assert.match(serverSource, /type ModuleRouteTable/);
    assert.match(serverSource, /documents\.items\.create/);
    assert.match(serverSource, /\{ type: 'Actor', id: actorId \}/);
    assert.match(serverSource, /return json\(\{ success: true, item \}, \{ status: 201 \}\)/);
    assert.doesNotMatch(serverSource, /documents\.create\('item'/);

    const result = await checkModule(moduleId, { dataDir: testDataDir, silent: true });
    assert.equal(result.passed, true, result.failures.map((issue) => issue.message).join('\n'));
    assert.equal(result.warnings.length, 0, result.warnings.map((issue) => issue.message).join('\n'));
    assert.ok(result.passes.includes('info.json shape valid'));
    assert.ok(result.passes.includes('logic entry exports Adapter'));
    assert.ok(result.passes.includes('server entry exports apiRoutes'));

    // Static CSS is copied into managed artifacts without a rewrite. The package
    // checker must reject dependencies that would disappear or violate host CSP.
    const stylesWithInvalidAssets = `${stylesSource}\n@import url("https://fonts.example.invalid/module.css");\n@font-face { font-family: "Missing"; src: url("./fonts/missing.woff2"); }\n`;
    fs.writeFileSync(path.join(modulePath, 'assets', 'styles.css'), stylesWithInvalidAssets, 'utf8');
    const invalidAssetResult = await checkModule(moduleId, { dataDir: testDataDir, silent: true });
    const assetFailure = invalidAssetResult.failures.find((issue) =>
        issue.kind === 'package'
        && issue.message.includes('unpackageable asset reference')
        && issue.hint?.includes('remote dependency')
        && issue.hint.includes('referenced asset is missing')
    );
    assert.ok(assetFailure, invalidAssetResult.failures.map((issue) => issue.message).join('\n'));
    fs.writeFileSync(path.join(modulePath, 'assets', 'styles.css'), stylesSource, 'utf8');

    // A hard internal navigation tears down the host providers and proxied
    // realtime socket. Modules must use the host-owned SDK router instead.
    fs.writeFileSync(
        sheetPath,
        sheetSource.replace('return (', `window.location.href = '/tools/sdk-check-test/generator';\n    return (`),
        'utf8',
    );
    const hardNavigationResult = await checkModule(moduleId, { dataDir: testDataDir, silent: true });
    const navigationFailure = hardNavigationResult.failures.find((issue) =>
        issue.kind === 'navigation'
        && issue.message.includes('performs hard browser navigation')
    );
    assert.ok(navigationFailure, hardNavigationResult.failures.map((issue) => issue.message).join('\n'));
    fs.writeFileSync(sheetPath, sheetSource, 'utf8');

    // Managed UI artifacts execute as native browser ESM outside Next's build graph.
    // Importing host framework helpers can bundle CommonJS dynamic requires that fail
    // only after installation, so the checker must reject the coupling at source.
    fs.writeFileSync(
        sheetPath,
        sheetSource.replace(
            `import { useSDK } from '@sheet-delver/sdk/react';`,
            `import { useSDK } from '@sheet-delver/sdk/react';\nimport dynamic from 'next/dynamic';`,
        ),
        'utf8',
    );
    const frameworkImportResult = await checkModule(moduleId, { dataDir: testDataDir, silent: true });
    const frameworkImportFailure = frameworkImportResult.failures.find((issue) =>
        issue.kind === 'import-boundary'
        && issue.message.includes('host framework dependency "next/dynamic"')
        && issue.hint?.includes('outside the Next.js build')
    );
    assert.ok(
        frameworkImportFailure,
        frameworkImportResult.failures.map((issue) => issue.message).join('\n'),
    );
    fs.writeFileSync(sheetPath, sheetSource, 'utf8');

    // A plain TypeScript helper becomes UI-side when the declared UI entry imports it.
    // The checker must reject server-only SDK imports anywhere in that browser graph.
    const helpersDir = path.join(modulePath, 'src', 'helpers');
    fs.mkdirSync(helpersDir, { recursive: true });
    fs.writeFileSync(
        path.join(helpersDir, 'server-leak.ts'),
        `import type { ModuleServerRequest } from '@sheet-delver/sdk/server';\nexport type BrowserLeak = ModuleServerRequest;\n`,
        'utf8',
    );
    fs.writeFileSync(
        sheetPath,
        sheetSource.replace(
            `import { useSDK } from '@sheet-delver/sdk/react';`,
            `import { useSDK } from '@sheet-delver/sdk/react';\nimport type { BrowserLeak } from '../helpers/server-leak';`,
        ),
        'utf8',
    );

    const leakResult = await checkModule(moduleId, { dataDir: testDataDir, silent: true });
    const leakFailure = leakResult.failures.find((issue) =>
        issue.kind === 'import-boundary'
        && issue.message.includes('src/helpers/server-leak.ts')
        && issue.message.includes('UI bundle')
    );
    assert.ok(leakFailure, leakResult.failures.map((issue) => issue.message).join('\n'));

    console.log('module-init-scaffold: PASS');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    run().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
