import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { logger } from '../../../shared/utils/logger';

import { extractReleaseNotes, versionFromReleaseTag } from './release-notes.mjs';
export { extractReleaseNotes, versionFromReleaseTag } from './release-notes.mjs';

export interface PreparedRelease {
    version: string;
    notes: string;
}

export function prepareRelease(tag: string, packageVersion: string, changelog: string): PreparedRelease {
    const version = versionFromReleaseTag(tag);
    if (version !== packageVersion) {
        throw new Error(
            'Release tag ' + tag + ' does not match package.json version ' + packageVersion + '.',
        );
    }
    return {
        version,
        notes: extractReleaseNotes(changelog, version),
    };
}

function main(): void {
    const [tag, outputPath] = process.argv.slice(2);
    if (!tag || !outputPath) {
        throw new Error('Usage: npm run release:prepare -- <vMAJOR.MINOR.PATCH> <output-file>');
    }

    const root = process.cwd();
    const packageDocument = JSON.parse(
        fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
    ) as { version?: unknown };
    if (typeof packageDocument.version !== 'string') {
        throw new Error('package.json must contain a string version.');
    }

    const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    const release = prepareRelease(tag, packageDocument.version, changelog);
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    fs.writeFileSync(outputPath, release.notes + '\n', 'utf8');
    logger.info(
        '[Release] Prepared notes for ' + tag + ' from CHANGELOG.md at ' + path.resolve(outputPath),
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    try {
        main();
    } catch (error: unknown) {
        logger.error('[Release] ' + (error instanceof Error ? error.message : String(error)));
        process.exitCode = 1;
    }
}
