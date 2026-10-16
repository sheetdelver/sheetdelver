import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';
import type { SystemModuleInfo } from '@modules/registry/core/types';
import { discoverMigrations, confinedMigrationFile } from '@modules/registry/migrations/catalog';

/** Also used by isolated Core fixtures; never changes an author's source tree. */
export async function packageMigrations(source: string, destination: string, info: SystemModuleInfo): Promise<void> {
    const catalog = discoverMigrations(source, info, true);
    if (!catalog) return;
    fs.writeFileSync(path.join(destination, 'migration.json'), JSON.stringify(catalog.catalog));
    for (const { directory, definition } of catalog.definitions) {
        const output = structuredClone(definition);
        fs.mkdirSync(path.join(destination, directory), { recursive: true });
        for (const step of output.steps) for (const hook of ['check', 'plan', 'verify'] as const) {
            const entry = confinedMigrationFile(source, `${directory}/${step.hooks[hook]}`);
            const outfile = `${step.id}.${hook}.cjs`;
            await esbuild.build({ entryPoints: [entry], outfile: path.join(destination, directory, outfile), bundle: true,
                platform: 'browser', format: 'cjs', target: 'es2022', logLevel: 'silent',
                plugins: [{ name: 'confined-pure-migration', setup(build) {
                    build.onLoad({ filter: /.*/ }, args => {
                        if (args.namespace === 'file') confinedMigrationFile(source, path.relative(source, args.path).split(path.sep).join('/'));
                        return undefined;
                    });
                    build.onResolve({ filter: /.*/ }, args => {
                        if (args.kind === 'entry-point') return undefined;
                        if (!args.path.startsWith('.')) throw new Error('Migration hooks may import only confined relative pure helpers');
                        const candidate = path.resolve(args.resolveDir, args.path);
                        if (!candidate.startsWith(path.resolve(source) + path.sep)) throw new Error('Migration import escapes module');
                        return undefined;
                    });
                } }],
            });
            step.hooks[hook] = outfile;
        }
        fs.writeFileSync(path.join(destination, directory, 'definition.json'), JSON.stringify(output));
    }
    discoverMigrations(destination, info);
}
