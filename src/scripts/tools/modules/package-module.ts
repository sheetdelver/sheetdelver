import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as tar from 'tar';
import { resolveDataDir, initDataDir, getModulesDataDir, getDistModulesDir } from '../../../server/core/paths';

async function packageModule() {
    initDataDir(resolveDataDir());
    const moduleId = process.argv[2];
    if (!moduleId) {
        console.error('Usage: npm run package:module <moduleId>');
        process.exit(1);
    }

    let modulePath = path.resolve('src/modules', moduleId);
    if (!fs.existsSync(modulePath)) {
        modulePath = path.join(getModulesDataDir(), moduleId);
        if (!fs.existsSync(modulePath)) {
            console.error(`Module ${moduleId} not found in src/modules or ${getModulesDataDir()}`);
            process.exit(1);
        }
    }

    const infoPath = path.join(modulePath, 'info.json');
    if (!fs.existsSync(infoPath)) {
        console.error(`info.json not found in ${modulePath}`);
        process.exit(1);
    }

    const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
    const outDir = getDistModulesDir();
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }

    const outFile = path.join(outDir, `${moduleId}-${info.version}.tgz`);

    console.log(`Packaging module ${moduleId} v${info.version}...`);

    // We only pack the contents of the module directory.
    // E.g., info.json, src/, etc.
    const files = fs.readdirSync(modulePath).filter(f => f !== 'node_modules' && f !== '.git');

    try {
        await tar.create(
            {
                gzip: true,
                file: outFile,
                cwd: modulePath,
                portable: true,
            },
            files
        );

        const hash = crypto.createHash('sha256');
        const fileBuffer = fs.readFileSync(outFile);
        hash.update(fileBuffer);
        const integrity = `sha256:${hash.digest('hex')}`;

        console.log(`\n✅ Successfully packaged ${moduleId} v${info.version}`);
        console.log(`Output: ${outFile}`);
        console.log(`Size: ${(fileBuffer.length / 1024).toFixed(2)} KB`);
        console.log(`Integrity: ${integrity}`);
    } catch (err) {
        console.error(`Failed to package module:`, err);
        process.exit(1);
    }
}

packageModule();
