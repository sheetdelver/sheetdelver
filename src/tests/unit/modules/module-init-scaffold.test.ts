import { strict as assert } from 'node:assert';
import fs from 'node:fs';
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

    const result = await checkModule(moduleId, { dataDir: testDataDir, silent: true });
    assert.equal(result.passed, true, result.failures.map((issue) => issue.message).join('\n'));
    assert.equal(result.warnings.length, 0, result.warnings.map((issue) => issue.message).join('\n'));
    assert.ok(result.passes.includes('info.json shape valid'));
    assert.ok(result.passes.includes('logic entry exports Adapter'));
    assert.ok(result.passes.includes('server entry exports apiRoutes'));

    console.log('module-init-scaffold: PASS');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    run().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
