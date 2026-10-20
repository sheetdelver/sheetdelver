#!/usr/bin/env node
// Core publication deliberately has no dependency installation, tests or build.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { identity, restoreBundle, digest } from './ci-artifacts.mjs';

export function publishCore(id, directory, env = process.env, run = (program, args) => execFileSync(program, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) {
    const tag = `v${id.version}`;
    if (id.product !== 'core' || env.GITHUB_REF !== `refs/tags/${tag}`) throw new Error('Core tag must match package.json version.');
    const pages = JSON.parse(run('gh', ['api', '--paginate', '--slurp', `repos/${id.repository}/releases?per_page=100`]));
    if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) throw new Error('Invalid releases response.');
    if (pages.flat().some(release => release.tag_name === tag)) throw new Error(`Release ${tag} already exists; refusing to overwrite it.`);
    const refs = run('git', ['ls-remote', `https://github.com/${id.repository}.git`, `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
    const entries = new Map(refs.trim().split('\n').map(line => line.split('\t')));
    if (![...entries].some(([sha, ref]) => ref === `refs/tags/${tag}^{}` && sha === id.commit)) throw new Error('Remote annotated release tag changed.');
    const name = `sheet-delver-${tag}.cdx.json`;
    const sbom = fs.readFileSync(path.join(directory, 'sheet-delver.cdx.json'));
    fs.writeFileSync(path.join(directory, name), sbom);
    fs.writeFileSync(path.join(directory, 'SHA256SUMS'), `${digest(sbom)}  ${name}\n`);
    run('gh', ['release', 'create', tag, path.join(directory, name), path.join(directory, 'SHA256SUMS'),
        '--repo', id.repository, '--title', `SheetDelver ${tag}`, '--notes-file', path.join(directory, 'release-notes.md'), '--verify-tag']);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    try {
        const id = identity();
        if (process.env.GITHUB_REF !== `refs/tags/v${id.version}`) throw new Error('Core tag must match package.json version.');
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'core-publication-'));
        try { await restoreBundle(id, directory, { required: true }); publishCore(id, directory); }
        finally { fs.rmSync(directory, { recursive: true, force: true }); }
    } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
