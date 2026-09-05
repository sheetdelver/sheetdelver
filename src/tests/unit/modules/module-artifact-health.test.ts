import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validatePackagedModuleArtifact } from '@modules/registry/lifecycle/artifactHealth';
import type { SystemModuleInfo } from '@modules/registry/core/types';

function mkModuleDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-delver-artifact-health-'));
}

function writeFile(root: string, relativePath: string, contents: string): void {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents, 'utf8');
}

function baseInfo(overrides: Partial<SystemModuleInfo> = {}): SystemModuleInfo {
    return {
        id: 'sample',
        title: 'Sample Module',
        version: '1.0.0',
        manifest: {
            ui: 'dist/ui.js',
            logic: 'dist/logic.js',
        },
        ...overrides,
    };
}

export function run(): void {
    {
        const moduleDir = mkModuleDir();
        try {
            // Warning-only drift: optional generated CSS is absent and a legacy SDK
            // symbol is present, but required entries and browser imports are viable.
            writeFile(moduleDir, 'dist/ui.js', "import React from 'react'; const onActorChanged = true; export { React, onActorChanged };");
            writeFile(moduleDir, 'dist/logic.js', 'export default class Adapter {}');

            const result = validatePackagedModuleArtifact(moduleDir, baseInfo({
                compiledStyles: 'assets/missing.css',
            }));

            assert.equal(result.hasErrors, false, 'warning-only drift should not be blocking');
            assert.equal(result.hasWarnings, true, 'missing optional styles and deprecated callbacks should warn');
            assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 'artifact.styles.compiled.missing'));
            assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 'artifact.deprecated.onActorChanged'));
        } finally {
            fs.rmSync(moduleDir, { recursive: true, force: true });
        }
    }

    {
        const moduleDir = mkModuleDir();
        try {
            // Required entry missing: this is the "do not onboard/enable" class.
            writeFile(moduleDir, 'dist/logic.js', 'export default class Adapter {}');

            const result = validatePackagedModuleArtifact(moduleDir, baseInfo());

            assert.equal(result.hasErrors, true, 'missing required UI entry should block');
            assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 'artifact.entry.ui.missing'));
        } finally {
            fs.rmSync(moduleDir, { recursive: true, force: true });
        }
    }

    {
        const moduleDir = mkModuleDir();
        try {
            // Browser-only load blocker: the runtime import rewriter cannot satisfy
            // arbitrary bare imports from an installed UI artifact.
            writeFile(moduleDir, 'dist/ui.js', "import pick from 'lodash/pick'; export { pick };");
            writeFile(moduleDir, 'dist/logic.js', 'export default class Adapter {}');

            const result = validatePackagedModuleArtifact(moduleDir, baseInfo());

            assert.equal(result.hasErrors, true, 'unsupported browser imports should block packaged UI loading');
            assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 'artifact.ui.unsupported-import'));
        } finally {
            fs.rmSync(moduleDir, { recursive: true, force: true });
        }
    }

    console.log('module-artifact-health: PASS');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    try {
        run();
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
}
