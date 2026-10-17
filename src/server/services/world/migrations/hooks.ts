import fs from 'node:fs';
import vm from 'node:vm';
import { confinedMigrationFile, migrationDigest, type ResolvedMigrationStep } from '@modules/registry/migrations/catalog';
import type { MigrationHookInput } from '@shared/sdk/migrations';

/** Pure separately bundled hooks, isolated from active adapter state. Not an OS sandbox. */
export function runMigrationHook<T>(root: string, step: ResolvedMigrationStep, hook: 'check' | 'plan' | 'verify', input: MigrationHookInput): T {
    return createMigrationHookRunner(root)<T>(step, hook, input);
}

/** Job-local immutable code cache; each call still receives a new isolated VM. */
export function createMigrationHookRunner(root: string) {
    const scripts = new Map<string, vm.Script>();
    return function run<T>(step: ResolvedMigrationStep, hook: 'check' | 'plan' | 'verify', input: MigrationHookInput): T {
    const entry = step.entries[hook];
    const json = JSON.stringify(input);
    if (json.length > 16_777_216) throw new Error('Migration hook input exceeds byte bound');
    const globals = Object.assign(Object.create(null), { __input: json });
    const context = vm.createContext(globals, { codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate' });
    let script = scripts.get(entry.digest);
    if (!script) {
    const code = fs.readFileSync(confinedMigrationFile(root, entry.path), 'utf8');
    if (migrationDigest(code) !== entry.digest) throw new Error('Migration hook digest changed');
    // No host functions, filesystem, network, runtime, clock, timer or random supplied.
    script = new vm.Script(`"use strict";const module={exports:{}};const exports=module.exports;
        Object.defineProperty(globalThis,'Date',{value:undefined,writable:false,configurable:false});
        Object.defineProperty(globalThis,'Intl',{value:undefined,writable:false,configurable:false});
        Math.random=()=>{throw Error('Random is forbidden')};Object.freeze(Math);
        ${code}\nconst input=JSON.parse(__input);delete globalThis.__input;
        const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x)}return x};
        const fn=module.exports.default??module.exports;const output=fn(freeze(input));
        if(output&&typeof output.then==='function')throw Error('Migration hooks must be synchronous');
        JSON.stringify(output);`, { filename: entry.path });
    scripts.set(entry.digest, script);
    }
    const result = script.runInContext(context, { timeout: 1000 }) as unknown;
    if (typeof result !== 'string' || result.length > 1_048_576) throw new Error('Invalid or excessive migration hook output');
    return JSON.parse(result) as T;
    };
}
