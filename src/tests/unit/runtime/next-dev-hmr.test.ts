import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import patch from '../../../../patches/next-16.4.2-webpack-hmr-sync.json';
import { prepareNextDev } from '../../../scripts/tools/development/prepare-next-dev';

interface Message { type: string; hash?: string; errors?: unknown[]; warnings?: unknown[] }
const compiler = () => ({ hooks: { invalid: { tap() {} }, done: { tap() {} } } });
const stats = (hash: string, errors: string[] = [], warnings: string[] = []) => ({
    hasErrors: () => errors.length > 0, toJson: () => ({ hash, errors, warnings }),
});
const client = () => ({ messages: [] as Message[], addEventListener() {},
    send(data: string) { this.messages.push(JSON.parse(data)); } });

export function run(): void {
    const requireNext = createRequire(path.resolve('package.json'));
    const installedPackage = requireNext.resolve('next/package.json');
    const installedTarget = path.join(path.dirname(installedPackage), patch.target);
    const installed = fs.readFileSync(installedTarget, 'utf8');
    const original = installed.includes(patch.after) ? installed.replace(patch.after, patch.before) : installed;
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-next-hmr-unit-'));
    const packagePath = path.join(fixture, 'package.json');
    const target = path.join(fixture, patch.target);
    try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(packagePath, JSON.stringify({ version: patch.version }));
        fs.writeFileSync(target, original);
        assert.equal(prepareNextDev(packagePath), 'applied');
        const corrected = fs.readFileSync(target, 'utf8');
        assert.equal(prepareNextDev(packagePath), 'already-applied');
        assert.equal(fs.readFileSync(target, 'utf8'), corrected);

        // Execute the actual corrected vendor middleware with real imports and fake
        // clients/compilers. No service, transport or installed dependency is modified.
        const module = { exports: {} as any };
        const vendorRequire = createRequire(installedTarget);
        vm.runInNewContext(corrected, { module, exports: module.exports,
            // Compiler-entry classification is not exercised here. Loading its
            // build-utils barrel would initialize unrelated Next server globals.
            require: (id: string) => id === '../../build/utils'
                ? { isMiddlewareFilename: () => false } : vendorRequire(id),
            console, process, Buffer }, { filename: target });
        const Middleware = module.exports.WebpackHotMiddleware;
        const middleware = new Middleware([compiler(), compiler(), compiler()], {}, undefined, { experimental: {} }, {}, Promise.resolve(false));
        const first = client(), second = client(), replacement = client();
        middleware.onClientDone(stats('A'));
        middleware.onHMR(first, 'first');
        middleware.onClientDone(stats('B'));
        middleware.onHMR(second, 'second');
        assert.deepEqual(first.messages.map(({ type, hash }) => [type, hash]), [['sync', 'A'], ['built', 'B']]);
        assert.deepEqual(second.messages.map(({ type, hash }) => [type, hash]), [['sync', 'B']]);
        middleware.onClientDone(stats('C', ['compile error'], ['compile warning']));
        assert.equal(first.messages.at(-1)?.hash, 'C');
        assert.equal(second.messages.at(-1)?.hash, 'C', 'normal compilation remains broadcast');
        middleware.onHMR(replacement, 'first');
        assert.deepEqual(replacement.messages[0].errors, ['compile error']);
        assert.deepEqual(replacement.messages[0].warnings, ['compile warning']);
        assert.equal(replacement.messages[0].hash, 'C', 'reconnecting client receives current synchronization');
        assert.equal(second.messages.length, 2, 'reconnection never sends another client a handshake');

        assert.equal(prepareNextDev(packagePath, true), 'restored');
        assert.equal(fs.readFileSync(target, 'utf8'), original);
        assert.equal(prepareNextDev(packagePath, true), 'already-original');
        fs.writeFileSync(packagePath, JSON.stringify({ version: 'other-version' }));
        assert.throws(() => prepareNextDev(packagePath), /requires 16\.4\.2/);
        assert.equal(fs.readFileSync(target, 'utf8'), original);
        fs.writeFileSync(packagePath, JSON.stringify({ version: patch.version }));
        fs.writeFileSync(target, `${original}\n// unexpected modification`);
        assert.throws(() => prepareNextDev(packagePath), /unexpected contents/);
        assert.equal(fs.readFileSync(target, 'utf8'), `${original}\n// unexpected modification`);
        assert.equal(fs.readFileSync(installedTarget, 'utf8'), installed, 'real installed dependency untouched');
        const manager = fs.readFileSync('src/scripts/start-server.ts', 'utf8');
        assert.match(manager, /if \(command === 'dev' && !restricted\) \{\s*const patchResult = prepareNextDev\(\);/);
        assert.ok(manager.indexOf('const patchResult = prepareNextDev();') < manager.indexOf("coreProcess = spawn('npx'"));
        console.log('next-dev-hmr: scoped sync, broadcasts, reconnect, idempotence, restore and mismatch guards PASS');
    } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
}

if (import.meta.url === `file://${process.argv[1]}`) run();
