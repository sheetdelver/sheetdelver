#!/usr/bin/env node
// Shared notes parser: usable by metadata-only CI without npm installation.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const STABLE_RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function versionFromReleaseTag(tag) {
    const match = STABLE_RELEASE_TAG.exec(tag);
    if (!match) {
        throw new Error('Release tag must use the stable vMAJOR.MINOR.PATCH format.');
    }
    return tag.slice(1);
}

export function extractReleaseNotes(changelog, version) {
    const heading = '## ' + version;
    const lines = changelog.replace(/\r\n/g, '\n').split('\n');
    const headingIndexes = lines
        .map((line, index) => line.trim() === heading ? index : -1)
        .filter((index) => index >= 0);

    if (headingIndexes.length === 0) {
        throw new Error('CHANGELOG.md is missing the exact heading "' + heading + '".');
    }
    if (headingIndexes.length > 1) {
        throw new Error('CHANGELOG.md contains duplicate headings for "' + heading + '".');
    }

    const start = headingIndexes[0] + 1;
    const nextHeading = lines.findIndex((line, index) => index >= start && /^##\s+/.test(line));
    const end = nextHeading >= 0 ? nextHeading : lines.length;
    const notes = lines.slice(start, end).join('\n').trim();

    if (!notes) {
        throw new Error('CHANGELOG.md section "' + heading + '" has no release notes.');
    }
    if (!notes.split('\n').some((line) => /^\s*-\s+\S/.test(line))) {
        throw new Error('CHANGELOG.md section "' + heading + '" must contain at least one bullet.');
    }

    return notes;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    try {
        const [outputPath] = process.argv.slice(2);
        if (!outputPath) throw new Error('Usage: release-notes.mjs OUTPUT');
        const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
        versionFromReleaseTag(`v${version}`);
        const notes = extractReleaseNotes(fs.readFileSync('CHANGELOG.md', 'utf8'), version);
        fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
        fs.writeFileSync(outputPath, `${notes}\n`);
    } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
