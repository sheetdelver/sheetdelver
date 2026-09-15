import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { requireModuleId } from '../../../shared/security/moduleId';
import { compareReleaseVersions } from '../../../shared/utils/releaseVersion';
import {
    MODULE_RELEASE_HISTORY_SCHEMA_VERSION,
    MAX_MODULE_RELEASE_HISTORY_ENTRIES,
    validateModuleReleaseHistory,
    type ModuleReleaseHistoryDocument,
    type ModuleReleaseHistoryEntry,
} from '../../../modules/registry/distribution/releaseHistory';
import {
    validateModuleReleaseManifest,
    type ModuleReleaseManifest,
} from '../../../modules/registry/distribution/releaseManifest';

interface GenerateReleaseHistoryOptions {
    moduleId: string;
    repository: string;
    currentManifestPath: string;
    currentTag: string;
    previousDirectory?: string;
    outputPath: string;
    now?: () => number;
}

function readOption(args: string[], name: string, required = true): string | undefined {
    const index = args.indexOf(name);
    const value = index >= 0 ? args[index + 1] : undefined;
    if (required && (!value || value.startsWith('--'))) {
        throw new Error(`${name} is required`);
    }
    return value;
}

function readReleaseManifest(filePath: string): ModuleReleaseManifest {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    const validation = validateModuleReleaseManifest(value);
    if (!validation.valid) {
        throw new Error(`Invalid release manifest ${filePath}: ${validation.errors.join('; ')}`);
    }
    return value as ModuleReleaseManifest;
}

function requireGithubRepository(value: string): URL {
    const repository = new URL(value);
    if (
        repository.protocol !== 'https:'
        || repository.hostname !== 'github.com'
        || repository.username
        || repository.password
        || repository.search
        || repository.hash
        || repository.pathname.split('/').filter(Boolean).length !== 2
    ) {
        throw new Error('Repository must identify one public https://github.com owner/repository');
    }
    return repository;
}

function manifestEntry(repository: URL, tag: string, manifest: ModuleReleaseManifest): ModuleReleaseHistoryEntry {
    const expectedVersion = tag.startsWith('v') ? tag.slice(1) : tag;
    if (manifest.module.version !== expectedVersion) {
        throw new Error(
            `Release tag ${tag} does not match manifest version ${manifest.module.version}`,
        );
    }
    const base = repository.href.replace(/\/$/, '');
    return {
        version: manifest.module.version,
        manifest: `${base}/releases/download/${encodeURIComponent(tag)}/sheet-delver-manifest.json`,
        ...(manifest.module.compatibility
            ? { compatibility: manifest.module.compatibility }
            : {}),
    };
}

export function generateReleaseHistory(options: GenerateReleaseHistoryOptions): ModuleReleaseHistoryDocument {
    const moduleId = requireModuleId(options.moduleId);
    const repository = requireGithubRepository(options.repository);
    const current = readReleaseManifest(options.currentManifestPath);
    if (current.module.id !== moduleId) {
        throw new Error(`Current release manifest belongs to ${current.module.id}, expected ${moduleId}`);
    }

    const candidates: Array<{ entry: ModuleReleaseHistoryEntry; publishedAt: number }> = [{
        entry: manifestEntry(repository, options.currentTag, current),
        publishedAt: current.publishedAt,
    }];
    if (options.previousDirectory && fs.existsSync(options.previousDirectory)) {
        const releases = fs.readdirSync(options.previousDirectory, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .sort((left, right) => left.name.localeCompare(right.name));
        for (const release of releases) {
            const manifestPath = path.join(
                options.previousDirectory,
                release.name,
                'sheet-delver-manifest.json',
            );
            if (!fs.existsSync(manifestPath)) continue;
            const manifest = readReleaseManifest(manifestPath);
            if (manifest.module.id !== moduleId) {
                throw new Error(`Historical release ${release.name} belongs to ${manifest.module.id}, expected ${moduleId}`);
            }
            candidates.push({
                entry: manifestEntry(repository, release.name, manifest),
                publishedAt: manifest.publishedAt,
            });
        }
    }

    candidates.sort((left, right) => {
        if (left.entry.version === current.module.version) return -1;
        if (right.entry.version === current.module.version) return 1;
        return right.publishedAt - left.publishedAt
            || compareReleaseVersions(right.entry.version, left.entry.version);
    });
    const releases = candidates
        .filter((candidate, index, all) => (
            all.findIndex((entry) => entry.entry.version === candidate.entry.version) === index
        ))
        .slice(0, MAX_MODULE_RELEASE_HISTORY_ENTRIES)
        .map((candidate) => candidate.entry);
    const history: ModuleReleaseHistoryDocument = {
        schemaVersion: MODULE_RELEASE_HISTORY_SCHEMA_VERSION,
        moduleId,
        generatedAt: (options.now || Date.now)(),
        releases,
    };
    const validation = validateModuleReleaseHistory(history);
    if (!validation.valid) {
        throw new Error(`Generated release history is invalid: ${validation.errors.join('; ')}`);
    }
    fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
    fs.writeFileSync(options.outputPath, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
    return history;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    try {
        const args = process.argv.slice(2);
        const history = generateReleaseHistory({
            moduleId: readOption(args, '--module-id')!,
            repository: readOption(args, '--repository')!,
            currentManifestPath: readOption(args, '--current-manifest')!,
            currentTag: readOption(args, '--current-tag')!,
            previousDirectory: readOption(args, '--previous-directory', false),
            outputPath: readOption(args, '--output')!,
        });
        console.log(`Generated ${history.releases.length} release history entries for ${history.moduleId}.`);
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}
