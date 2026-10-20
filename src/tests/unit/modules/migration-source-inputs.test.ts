import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectLocalModuleInputs, migrationSourceDigest, assertMigrationSource } from '@modules/registry/migrations/sourceInspection';
import { migrationDirectoryDigest } from '@modules/registry/migrations/catalog';

export function run(): void {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-module-inputs-'));
    const root = path.join(parent, 'module');
    const write = (relative: string, contents: string) => {
        fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
        fs.writeFileSync(path.join(root, relative), contents);
    };
    const info = { id: 'fixture', title: 'Input fixture', version: '1.0.0',
        manifest: { logic: 'module/logic', ui: 'module/ui.tsx' },
        package: { include: ['rules'] },
        compatibility: { apiContracts: { 'module-api': '>=1.6.0 <2.0.0' } } };
    try {
        write('info.json', JSON.stringify(info));
        write('module/logic.ts', "import {bonus} from '../rules-code/bonus'; globalThis.moduleInputExecuted = true; export default {bonus};");
        write('module/ui.tsx', "import React from 'react'; export default {sheet:()=>import('../views/sheet')};");
        write('views/sheet.tsx', "import React from 'react'; export default ()=><div>Sheet</div>;");
        write('rules-code/bonus.ts', 'export const bonus = 1;');
        write('rules/data.json', '{"value":1}');
        write('assets/icon.svg', '<svg/>');
        write('package.json', '{"type":"module"}');
        write('migration.json', JSON.stringify({ schemaVersion: 'sheet-delver-migrations.v1', systemVersions: { '1.0.0': 'migrations/1.0.0' } }));
        write('migrations/1.0.0/definition.json', JSON.stringify({ schemaVersion: 'sheet-delver-migration-definition.v1', dataReadVersion: '>=1.0.0 <2.0.0',
            steps: [{ id: 'example', revision: 1, description: 'Example', dependencies: [], systemVersion: '>=1.0.0 <2.0.0',
                foundryGenerations: [13, 14], required: true, targets: ['Actor'], paths: ['system.value'],
                hooks: { check: 'check.ts', plan: 'plan.ts', verify: 'verify.ts' } }] }));
        write('migrations/1.0.0/check.ts', "import {current} from '../helpers/current'; export default ()=>({status:current?'current':'migration-needed'});");
        write('migrations/1.0.0/plan.ts', "export default ()=>({status:'noop'});");
        write('migrations/1.0.0/verify.ts', 'export default ()=>({valid:true});');
        write('migrations/helpers/current.ts', 'export const current=true;');
        const baseline = inspectLocalModuleInputs(root);
        assert.ok(baseline.files.includes('views/sheet.tsx'), 'literal lazy UI dependencies are included');
        assert.ok(baseline.files.includes('migrations/helpers/current.ts'), 'transitive hook helpers are included');
        assert.ok(baseline.files.includes('rules-code/bonus.ts'), 'runtime helpers outside conventional src are included');
        assert.equal((globalThis as Record<string, unknown>).moduleInputExecuted, undefined, 'inspection never executes the candidate');
        for (const file of ['temp/report.txt', 'docs/audit.md', 'screenshots/page.png', 'src/tests/unused.test.ts', 'unused.ts', '.gitignore']) write(file, 'unrelated');
        fs.symlinkSync(path.join(parent, 'missing'), path.join(root, 'temp', 'unused-link'));
        assert.equal(inspectLocalModuleInputs(root).digest, baseline.digest, 'unreferenced workspace files do not affect identity');

        // Prove irrelevant directories are never traversed, including custom names.
        const readDirectory = fs.readdirSync;
        fs.readdirSync = ((file: fs.PathLike, options?: unknown) => {
            assert.ok(!/[/\\](temp|docs|screenshots)([/\\]|$)/.test(String(file)), 'scanner traversed unrelated workspace content');
            return readDirectory(file, options as never);
        }) as typeof fs.readdirSync;
        try { assert.equal(inspectLocalModuleInputs(root).digest, baseline.digest); } finally { fs.readdirSync = readDirectory; }

        const identity = { sourceDirectory: root, sourceCategory: 'local' as const, sourceDigest: baseline.digest };
        for (const file of ['rules-code/bonus.ts', 'views/sheet.tsx', 'migrations/helpers/current.ts',
            'migrations/1.0.0/check.ts', 'migrations/1.0.0/definition.json', 'migration.json',
            'rules/data.json', 'assets/icon.svg', 'info.json', 'package.json']) {
            const original = fs.readFileSync(path.join(root, file), 'utf8');
            write(file, `${original}\n `);
            assert.throws(() => assertMigrationSource(identity), /source changed/, `${file} must invalidate the approval`);
            write(file, original);
        }
        write('rules-code/bonus.js', 'export const bonus = 99;');
        assert.equal(inspectLocalModuleInputs(root).digest, baseline.digest, 'lower-priority unreferenced resolution candidate is irrelevant');
        fs.renameSync(path.join(root, 'rules-code/bonus.ts'), path.join(root, 'unused-bonus.ts'));
        assert.notEqual(inspectLocalModuleInputs(root).digest, baseline.digest, 'dependency resolution changes are bound');
        fs.renameSync(path.join(root, 'unused-bonus.ts'), path.join(root, 'rules-code/bonus.ts'));
        fs.unlinkSync(path.join(root, 'rules-code/bonus.js'));
        write('assets/added.svg', '<svg/>');
        assert.throws(() => assertMigrationSource(identity), /source changed/, 'resource additions invalidate approval');
        fs.unlinkSync(path.join(root, 'assets/added.svg'));
        fs.renameSync(path.join(root, 'rules/data.json'), path.join(root, 'unused-data.json'));
        assert.throws(() => assertMigrationSource(identity), /source changed/, 'resource removals invalidate approval');
        fs.renameSync(path.join(root, 'unused-data.json'), path.join(root, 'rules/data.json'));

        write('temp/needed.ts', 'export const bonus=2;');
        const logic = fs.readFileSync(path.join(root, 'module/logic.ts'), 'utf8');
        write('module/logic.ts', logic.replace('../rules-code/bonus', '../temp/needed'));
        const referenced = inspectLocalModuleInputs(root);
        assert.ok(referenced.files.includes('temp/needed.ts'), 'referenced inputs are included regardless of folder name');
        write('temp/needed.ts', 'export const bonus=3;');
        assert.notEqual(inspectLocalModuleInputs(root).digest, referenced.digest);
        write('module/logic.ts', logic);
        write('tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { 'local-bonus': ['./rules-code/bonus.ts'] } } }));
        write('module/logic.ts', logic.replace('../rules-code/bonus', 'local-bonus'));
        assert.ok(inspectLocalModuleInputs(root).files.includes('rules-code/bonus.ts'), 'local compiler aliases resolve to inspected module inputs');
        write('module/logic.ts', logic);
        write('tsconfig.json', '{ // local inheritance\n "extends":"./configuration/base", }');
        write('configuration/base.json', '{ "compilerOptions": { "target":"ES2022", }, }');
        const inherited = inspectLocalModuleInputs(root);
        assert.ok(inherited.files.includes('configuration/base.json'), 'local inherited JSONC configuration is an input');
        write('configuration/base.json', '{ "compilerOptions": { "target":"ES2022" } }\n ');
        assert.notEqual(inspectLocalModuleInputs(root).digest, inherited.digest);
        fs.unlinkSync(path.join(root, 'tsconfig.json'));
        write('module/logic.ts', 'export const load = (filename) => import(filename);');
        assert.throws(() => inspectLocalModuleInputs(root), /statically resolvable/, 'computed code imports cannot silently escape the input identity');
        write('module/logic.ts', logic);
        fs.renameSync(path.join(root, 'rules-code/bonus.ts'), path.join(root, 'rules-code/original.ts'));
        fs.symlinkSync('./original.ts', path.join(root, 'rules-code/bonus.ts'));
        assert.throws(() => inspectLocalModuleInputs(root), /symlink/, 'reachable symlinks remain forbidden');
        fs.unlinkSync(path.join(root, 'rules-code/bonus.ts'));
        fs.renameSync(path.join(root, 'rules-code/original.ts'), path.join(root, 'rules-code/bonus.ts'));
        fs.writeFileSync(path.join(parent, 'outside.ts'), 'export const bonus=3;');
        write('module/logic.ts', logic.replace('../rules-code/bonus', '../../outside'));
        assert.throws(() => inspectLocalModuleInputs(root), /Unconfined/, 'relative imports cannot escape the module');
        write('module/logic.ts', logic);
        write('info.json', JSON.stringify({ ...info, package: { include: ['../outside.ts'] } }));
        assert.throws(() => inspectLocalModuleInputs(root), /Unconfined/, 'declared resources cannot escape');
        write('info.json', JSON.stringify(info));

        // Same source policy survives restart; legacy durable approvals retain
        // the exact whole-tree semantics they originally authorized.
        fs.unlinkSync(path.join(root, 'temp/unused-link'));
        const legacy = migrationDirectoryDigest(root);
        assert.equal(migrationSourceDigest(root, 'local', legacy), legacy);
        assert.equal(migrationSourceDigest(root, 'managed'), legacy);
        write('docs/audit.md', 'changed human report');
        assert.notEqual(migrationSourceDigest(root, 'local', legacy), legacy);
        assert.equal(migrationSourceDigest(root, 'local', baseline.digest), baseline.digest);
        assert.throws(() => migrationSourceDigest(root, 'local', 'module-inputs-v2:unknown'), /Unknown/);

        const oversized = fs.openSync(path.join(root, 'assets/huge.bin'), 'w');
        try { fs.ftruncateSync(oversized, 513 * 1024 * 1024); } finally { fs.closeSync(oversized); }
        assert.throws(() => inspectLocalModuleInputs(root), /Module inputs exceed.*assets\/huge.bin/, 'real inputs retain explicit bounds');
    } finally { fs.rmSync(parent, { recursive: true, force: true }); }
    console.log('migration-source-inputs.test.ts passed');
}

if (import.meta.url === `file://${process.argv[1]}`) run();
