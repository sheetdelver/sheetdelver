import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseModuleId, requireModuleId } from '@shared/security/moduleId';
import {
    readWildcardPath,
    resolveConfinedDirectory,
    resolveConfinedFile,
    resolveConfinedModuleEntry,
    resolveModuleDirectory,
} from '@server/security/modulePath';

export function run(): void {
    assert.equal(parseModuleId('ShadowDark'), 'shadowdark');
    assert.equal(parseModuleId('valid-module-2'), 'valid-module-2');
    for (const invalid of ['../secret', '..%2fsecret', 'a/b', 'a\\b', 'C:\\temp', '.hidden', '-bad', 'bad-', 'two words', 'módulo', '', 'a'.repeat(65)]) {
        assert.equal(parseModuleId(invalid), null, `expected invalid module ID: ${invalid}`);
    }
    assert.throws(() => requireModuleId('../secret'), /valid module ID/);
    assert.equal(readWildcardPath(['icons', 'sheet.png']), 'icons/sheet.png');

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-delver-module-path-'));
    const modulesRoot = path.join(tempRoot, 'modules');
    const moduleRoot = path.join(modulesRoot, 'safe-module');
    const assetsRoot = path.join(moduleRoot, 'assets');
    const siblingRoot = path.join(moduleRoot, 'assets-private');
    const outsideRoot = path.join(tempRoot, 'outside');

    try {
        fs.mkdirSync(assetsRoot, { recursive: true });
        fs.mkdirSync(siblingRoot, { recursive: true });
        fs.mkdirSync(outsideRoot, { recursive: true });
        fs.writeFileSync(path.join(assetsRoot, 'inside.txt'), 'inside');
        fs.mkdirSync(path.join(moduleRoot, 'module'), { recursive: true });
        fs.writeFileSync(path.join(moduleRoot, 'module', 'server.ts'), 'export const apiRoutes = {};');
        fs.writeFileSync(path.join(siblingRoot, 'secret.txt'), 'sibling');
        fs.writeFileSync(path.join(outsideRoot, 'secret.txt'), 'outside');

        assert.equal(resolveModuleDirectory(modulesRoot, 'SAFE-MODULE'), fs.realpathSync(moduleRoot));
        assert.equal(resolveConfinedDirectory(moduleRoot, 'assets'), fs.realpathSync(assetsRoot));
        assert.equal(resolveConfinedFile(assetsRoot, 'inside.txt'), fs.realpathSync(path.join(assetsRoot, 'inside.txt')));
        assert.equal(resolveConfinedFile(assetsRoot, '../assets-private/secret.txt'), null);
        assert.equal(resolveConfinedFile(assetsRoot, 'C:\\outside.txt'), null);
        assert.equal(resolveConfinedFile(assetsRoot, 'missing.txt'), null);
        assert.equal(resolveConfinedFile(assetsRoot, 'nested'), null);
        assert.equal(
            resolveConfinedModuleEntry(moduleRoot, 'module/server'),
            fs.realpathSync(path.join(moduleRoot, 'module', 'server.ts')),
        );
        assert.equal(resolveConfinedModuleEntry(moduleRoot, 'module/missing'), null);

        const escapedLink = path.join(assetsRoot, 'escaped.txt');
        fs.symlinkSync(path.join(outsideRoot, 'secret.txt'), escapedLink);
        assert.equal(resolveConfinedFile(assetsRoot, 'escaped.txt'), null);

        const escapedEntry = path.join(moduleRoot, 'module', 'escaped.ts');
        fs.symlinkSync(path.join(outsideRoot, 'secret.txt'), escapedEntry);
        assert.equal(resolveConfinedModuleEntry(moduleRoot, 'module/escaped'), null);

        const moduleLink = path.join(modulesRoot, 'linked-module');
        fs.symlinkSync(outsideRoot, moduleLink, 'dir');
        assert.equal(resolveModuleDirectory(modulesRoot, 'linked-module'), null);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run();
    console.log('module-path-security.test.ts passed');
}
