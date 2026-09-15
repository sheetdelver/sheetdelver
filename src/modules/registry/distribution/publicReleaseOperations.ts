import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDistArchivesDir } from '@core/paths';
import { ModuleTrustTier, type ModuleTrustTier as ModuleTrustTierValue } from '@shared/types/modules';
import { parseModuleId } from '@shared/security/moduleId';
import { logger } from '@shared/utils/logger';
import { compareReleaseVersions } from '@shared/utils/releaseVersion';
import {
    applyLocalModuleArchive,
    dryRunLocalModuleArchive,
    type DryRunLocalModuleArchiveResult,
    type ModuleArchiveOperation,
} from '../core/archiveOperations';
import { operationFailure, type ManagerOperationResult } from '../core/manager';
import { getArtifact, loadArtifactStore } from './artifactStore';
import { getCoreVersion } from '../core/internals';
import { evaluateModuleCompatibility } from '../lifecycle/validation';
import { DEFAULT_MODULE_ARCHIVE_LIMITS } from './archiveTransaction';
import {
    PublicDistributionError,
    fetchPublicDistributionJson,
    fetchPublicDistributionResource,
    type PublicDistributionDependencies,
    type PublicDistributionPolicy,
    type PublicDistributionResponse,
} from './publicDistributionClient';
import {
    validateModuleReleaseManifest,
    type ModuleReleaseManifest,
} from './releaseManifest';
import {
    resolveModuleReleaseHistoryEntry,
    validateModuleReleaseHistory,
    type ModuleReleaseHistoryDocument,
    type ModuleReleaseHistoryEntry,
} from './releaseHistory';

export interface PublicModuleReleaseInput {
    manifestUrl: string;
    expectedModuleId: string;
    expectedVersion?: string;
    policy: PublicDistributionPolicy;
    sourceTrustTier?: ModuleTrustTierValue;
    sourceProfileId?: string;
    approveTrustOverride?: boolean;
    approvePermissionEscalation?: boolean;
    approveDowngrade?: boolean;
}

export interface PublicModuleReleaseSummary {
    moduleId: string;
    version: string;
    manifestUrl: string;
    artifactUrl: string;
    archiveSize: number;
    integrity: string;
    trustTier: ModuleTrustTierValue;
}

export interface DryRunPublicModuleReleaseResult {
    success: true;
    operation: 'dry-run-install' | 'dry-run-upgrade';
    wouldProceed: boolean;
    blockingReasons: string[];
    release?: PublicModuleReleaseSummary;
    archive?: DryRunLocalModuleArchiveResult['archive'];
    governance?: DryRunLocalModuleArchiveResult['governance'];
}

export interface ApplyPublicModuleReleaseResult extends ManagerOperationResult {
    release?: PublicModuleReleaseSummary;
}

interface AcquiredPublicRelease {
    archivePath: string;
    manifest: ModuleReleaseManifest;
    summary: PublicModuleReleaseSummary;
}

export interface InspectedPublicModuleRelease {
    manifest: ModuleReleaseManifest;
    summary: PublicModuleReleaseSummary;
}

export interface PublicModuleReleaseHistorySummary {
    historyAvailable: boolean;
    historyUrl: string;
    historyError?: string;
    releases: ModuleReleaseHistoryEntry[];
    compatibleReleases: ModuleReleaseHistoryEntry[];
    latest: PublicModuleReleaseSummary;
}

function ensureArchiveStagingDirectory(): string {
    const directory = getDistArchivesDir();
    fs.mkdirSync(directory, { recursive: true });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error('Distribution archive staging path must be a physical directory');
    }
    return directory;
}

function resolveManifestIdentityUrl(response: PublicDistributionResponse): string {
    for (let index = response.redirectChain.length - 1; index >= 0; index -= 1) {
        const candidate = new URL(response.redirectChain[index]);
        if (candidate.hostname === 'github.com' && /\/releases\/download\/[^/]+\/[^/]+$/.test(candidate.pathname)) {
            return candidate.href;
        }
    }
    return response.finalUrl;
}

function resolveArtifactUrl(
    manifest: ModuleReleaseManifest,
    manifestResponse: PublicDistributionResponse,
): string {
    try {
        return new URL(manifest.artifact.url, resolveManifestIdentityUrl(manifestResponse)).href;
    } catch {
        throw new PublicDistributionError('invalid-url', 'Release manifest artifact URL is invalid');
    }
}

export function resolvePublicGithubRepositoryManifestUrl(repository: string): string {
    let owner: string;
    let name: string;
    if (repository.startsWith('github://')) {
        let parsed: URL;
        try {
            parsed = new URL(repository);
        } catch {
            throw new PublicDistributionError('invalid-url', 'GitHub repository shortcut is invalid');
        }
        owner = parsed.hostname;
        name = parsed.pathname.replace(/^\//, '');
    } else {
        let parsed: URL;
        try {
            parsed = new URL(repository);
        } catch {
            throw new PublicDistributionError('invalid-url', 'GitHub repository shortcut is invalid');
        }
        if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.username || parsed.password) {
            throw new PublicDistributionError('invalid-url', 'GitHub repository shortcut must use public https://github.com');
        }
        const segments = parsed.pathname.split('/').filter(Boolean);
        if (segments.length !== 2 || parsed.search || parsed.hash) {
            throw new PublicDistributionError('invalid-url', 'GitHub repository shortcut must identify exactly one owner and repository');
        }
        [owner, name] = segments;
    }
    name = name.replace(/\.git$/, '');
    if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name)) {
        throw new PublicDistributionError('invalid-url', 'GitHub owner or repository name is invalid');
    }
    return `https://github.com/${owner}/${name}/releases/latest/download/sheet-delver-manifest.json`;
}

export function resolvePublicModuleReleaseHistoryUrl(manifestUrl: string): string {
    try {
        return new URL('sheet-delver-releases.json', manifestUrl).href;
    } catch {
        throw new PublicDistributionError('invalid-url', 'Release manifest URL is invalid');
    }
}

function getDowngradeBlockReason(
    release: PublicModuleReleaseSummary,
    approved: boolean | undefined,
): string | undefined {
    const artifact = getArtifact(loadArtifactStore(), release.moduleId);
    if (
        artifact
        && compareReleaseVersions(release.version, artifact.version) < 0
        && approved !== true
    ) {
        return 'Downgrade from v' + artifact.version + ' to v' + release.version
            + ' requires explicit approval';
    }
    return undefined;
}

function removeStagedArchive(archivePath?: string): void {
    if (!archivePath || !fs.existsSync(archivePath)) return;
    try {
        fs.unlinkSync(archivePath);
    } catch (error) {
        logger.warn(`Failed to remove staged public release archive ${path.basename(archivePath)}: ${String(error)}`);
    }
}

async function acquirePublicRelease(
    input: PublicModuleReleaseInput,
    dependencies: PublicDistributionDependencies,
): Promise<AcquiredPublicRelease> {
    const inspected = await inspectPublicModuleRelease(input, dependencies);
    const { manifest, summary } = inspected;
    const artifactResponse = await fetchPublicDistributionResource(summary.artifactUrl, {
        accept: 'application/gzip, application/octet-stream',
        maxBytes: manifest.artifact.size,
        contentType: 'archive',
    }, input.policy, dependencies);
    if (artifactResponse.body.length !== manifest.artifact.size) {
        throw new Error(
            `Release archive size mismatch: expected ${manifest.artifact.size}, received ${artifactResponse.body.length}`,
        );
    }
    const integrity = `sha256:${crypto.createHash('sha256').update(artifactResponse.body).digest('hex')}`;
    if (integrity !== manifest.artifact.integrity) {
        throw new Error('Release archive SHA-256 does not match the release manifest');
    }

    const archivePath = path.join(
        ensureArchiveStagingDirectory(),
        `.public-release-${crypto.randomUUID()}.tgz`,
    );
    const descriptor = fs.openSync(archivePath, 'wx', 0o600);
    try {
        fs.writeFileSync(descriptor, artifactResponse.body);
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
    } catch (error) {
        try { fs.closeSync(descriptor); } catch { /* descriptor may already be closed */ }
        try { fs.unlinkSync(archivePath); } catch { /* original write error remains authoritative */ }
        throw error;
    }

    return {
        archivePath,
        manifest,
        summary: {
            ...summary,
            artifactUrl: artifactResponse.finalUrl,
            archiveSize: artifactResponse.body.length,
            integrity,
        },
    };
}

export async function inspectPublicModuleRelease(
    input: PublicModuleReleaseInput,
    dependencies: PublicDistributionDependencies = {},
): Promise<InspectedPublicModuleRelease> {
    const expectedModuleId = parseModuleId(input.expectedModuleId);
    if (!expectedModuleId) throw new Error('Invalid expected module ID');

    const { response: manifestResponse, value: manifest } = await fetchPublicDistributionJson<ModuleReleaseManifest>(
        input.manifestUrl,
        input.policy,
        validateModuleReleaseManifest,
        dependencies,
        { allowOctetStream: true },
    );
    if (manifest.module.id !== expectedModuleId) {
        throw new Error(`Release manifest module id "${manifest.module.id}" does not match expected id "${expectedModuleId}"`);
    }
    if (input.expectedVersion && manifest.module.version !== input.expectedVersion) {
        throw new Error(
            `Release manifest version "${manifest.module.version}" does not match selected version "${input.expectedVersion}"`,
        );
    }
    if (manifest.artifact.size > DEFAULT_MODULE_ARCHIVE_LIMITS.maxArchiveBytes) {
        throw new PublicDistributionError(
            'response-too-large',
            `Release archive exceeds ${DEFAULT_MODULE_ARCHIVE_LIMITS.maxArchiveBytes} bytes`,
        );
    }

    const artifactUrl = resolveArtifactUrl(manifest, manifestResponse);
    const manifestUrl = resolveManifestIdentityUrl(manifestResponse);
    return {
        manifest,
        summary: {
            moduleId: expectedModuleId,
            version: manifest.module.version,
            manifestUrl,
            artifactUrl,
            archiveSize: manifest.artifact.size,
            integrity: manifest.artifact.integrity,
            trustTier: input.sourceTrustTier || ModuleTrustTier.Unverified,
        },
    };
}

function isReleaseCompatible(entry: ModuleReleaseHistoryEntry): boolean {
    return evaluateModuleCompatibility({
        id: 'release-history-entry',
        title: 'Release history entry',
        manifest: { ui: 'dist/ui.js', logic: 'dist/logic.js' },
        compatibility: entry.compatibility,
    }, getCoreVersion()).compatible;
}

export async function inspectPublicModuleReleaseHistory(
    input: PublicModuleReleaseInput,
    dependencies: PublicDistributionDependencies = {},
): Promise<PublicModuleReleaseHistorySummary> {
    const latest = await inspectPublicModuleRelease(
        { ...input, expectedVersion: undefined },
        dependencies,
    );
    const historyUrl = resolvePublicModuleReleaseHistoryUrl(input.manifestUrl);
    try {
        const { value: history } = await fetchPublicDistributionJson<ModuleReleaseHistoryDocument>(
            historyUrl,
            input.policy,
            validateModuleReleaseHistory,
            dependencies,
            { allowOctetStream: true },
        );
        if (history.moduleId !== latest.summary.moduleId) {
            throw new Error(
                `Release history module id "${history.moduleId}" does not match expected id "${latest.summary.moduleId}"`,
            );
        }
        if (!resolveModuleReleaseHistoryEntry(history, latest.summary.version)) {
            throw new Error(
                `Release history does not include current release "${latest.summary.version}"`,
            );
        }

        const latestEntry: ModuleReleaseHistoryEntry = {
            version: latest.summary.version,
            manifest: latest.summary.manifestUrl,
            ...(latest.manifest.module.compatibility
                ? { compatibility: latest.manifest.module.compatibility }
                : {}),
        };
        const releases = [
            latestEntry,
            ...history.releases.filter((entry) => entry.version !== latest.summary.version),
        ];
        return {
            historyAvailable: true,
            historyUrl,
            releases,
            compatibleReleases: releases.filter(isReleaseCompatible),
            latest: latest.summary,
        };
    } catch (error) {
        return {
            historyAvailable: false,
            historyUrl,
            historyError: error instanceof Error ? error.message : String(error),
            releases: [{
                version: latest.summary.version,
                manifest: latest.summary.manifestUrl,
                ...(latest.manifest.module.compatibility
                    ? { compatibility: latest.manifest.module.compatibility }
                    : {}),
            }],
            compatibleReleases: latest.manifest.module.compatibility
                && !isReleaseCompatible({
                    version: latest.summary.version,
                    manifest: latest.summary.manifestUrl,
                    compatibility: latest.manifest.module.compatibility,
                })
                ? []
                : [{
                    version: latest.summary.version,
                    manifest: latest.summary.manifestUrl,
                    ...(latest.manifest.module.compatibility
                        ? { compatibility: latest.manifest.module.compatibility }
                        : {}),
                }],
            latest: latest.summary,
        };
    }
}

export function resolvePublicModuleReleaseTarget(
    history: PublicModuleReleaseHistorySummary,
    version?: string,
): ModuleReleaseHistoryEntry {
    const selected = version
        ? history.compatibleReleases.find((release) => release.version === version)
        : history.compatibleReleases[0];
    if (!selected) {
        const detail = version ? `version "${version}"` : 'any published version';
        throw new Error(
            `Module "${history.latest.moduleId}" does not provide ${detail} compatible with this Sheet Delver release`,
        );
    }
    return selected;
}

function archiveInput(input: PublicModuleReleaseInput, acquired: AcquiredPublicRelease) {
    return {
        archivePath: acquired.archivePath,
        expectedModuleId: acquired.summary.moduleId,
        releaseManifest: acquired.manifest,
        sourceTrustTier: acquired.summary.trustTier,
        approveTrustOverride: input.approveTrustOverride,
        approvePermissionEscalation: input.approvePermissionEscalation,
        artifactSource: acquired.summary.manifestUrl,
        sourceProfileId: input.sourceProfileId,
        preverifiedArtifact: true,
    };
}

export async function dryRunPublicModuleRelease(
    operation: ModuleArchiveOperation,
    input: PublicModuleReleaseInput,
    dependencies: PublicDistributionDependencies = {},
): Promise<DryRunPublicModuleReleaseResult> {
    let acquired: AcquiredPublicRelease | undefined;
    try {
        acquired = await acquirePublicRelease(input, dependencies);
        const preview = await dryRunLocalModuleArchive(operation, archiveInput(input, acquired));
        const downgradeBlock = operation === 'upgrade'
            ? getDowngradeBlockReason(acquired.summary, input.approveDowngrade)
            : undefined;
        const blockingReasons = [
            ...preview.blockingReasons,
            ...(downgradeBlock ? [downgradeBlock] : []),
        ];
        return {
            success: true,
            operation: preview.operation,
            wouldProceed: preview.wouldProceed && !downgradeBlock,
            blockingReasons,
            release: acquired.summary,
            archive: preview.archive,
            governance: preview.governance,
        };
    } catch (error) {
        return {
            success: true,
            operation: operation === 'install' ? 'dry-run-install' : 'dry-run-upgrade',
            wouldProceed: false,
            blockingReasons: [error instanceof Error ? error.message : String(error)],
        };
    } finally {
        removeStagedArchive(acquired?.archivePath);
    }
}

export async function applyPublicModuleRelease(
    operation: ModuleArchiveOperation,
    input: PublicModuleReleaseInput,
    dependencies: PublicDistributionDependencies = {},
): Promise<ApplyPublicModuleReleaseResult> {
    let acquired: AcquiredPublicRelease | undefined;
    try {
        acquired = await acquirePublicRelease(input, dependencies);
        const downgradeBlock = operation === 'upgrade'
            ? getDowngradeBlockReason(acquired.summary, input.approveDowngrade)
            : undefined;
        if (downgradeBlock) {
            return operationFailure(
                acquired.summary.moduleId,
                operation,
                downgradeBlock,
                undefined,
                'precondition-failed',
            );
        }
        const result = await applyLocalModuleArchive(operation, archiveInput(input, acquired));
        return { ...result, release: acquired.summary };
    } catch (error) {
        return operationFailure(
            parseModuleId(input.expectedModuleId) || 'invalid',
            operation,
            error instanceof Error ? error.message : String(error),
            undefined,
            'source-resolution-failed',
        );
    } finally {
        removeStagedArchive(acquired?.archivePath);
    }
}
