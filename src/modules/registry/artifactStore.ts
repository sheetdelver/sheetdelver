import fs from 'node:fs';
import path from 'node:path';
import { getModulesDataDir } from '@core/paths';
import type { ModuleArtifactMetadata } from './manager';
import type { ArtifactVerificationOutcome } from './artifactVerification';

export interface ModuleArtifactStore {
    version: 1;
    artifacts: Record<string, ModuleArtifactMetadata>;
    verifications: Record<string, ArtifactVerificationOutcome>;
}

export function getDefaultArtifactStoreFilePath(): string {
    return path.join(getModulesDataDir(), 'artifacts.json');
}

function createEmptyArtifactStore(): ModuleArtifactStore {
    return { version: 1, artifacts: {}, verifications: {} };
}

function isValidArtifact(value: unknown): value is ModuleArtifactMetadata {
    if (!value || typeof value !== 'object') return false;
    const a = value as Partial<ModuleArtifactMetadata>;
    const permissions = a.permissions as Record<string, unknown> | undefined;
    return (
        typeof a.moduleId === 'string' &&
        typeof a.version === 'string' &&
        typeof a.source === 'string' &&
        typeof a.installedAt === 'number' &&
        (
            permissions === undefined
            || typeof permissions === 'object'
        )
    );
}

function isValidVerification(value: unknown): value is ArtifactVerificationOutcome {
    if (!value || typeof value !== 'object') return false;
    const v = value as Partial<ArtifactVerificationOutcome>;
    return (
        typeof v.moduleId === 'string'
        && (v.operation === 'install' || v.operation === 'upgrade')
        && (v.status === 'verified' || v.status === 'failed' || v.status === 'skipped')
        && typeof v.verified === 'boolean'
        && typeof v.source === 'string'
        && typeof v.checkedAt === 'number'
        && (v.reason === undefined || typeof v.reason === 'string')
        && (v.integrity === undefined || typeof v.integrity === 'string')
        && (v.signature === undefined || typeof v.signature === 'string')
    );
}

export function loadArtifactStore(
    filePath = getDefaultArtifactStoreFilePath()
): ModuleArtifactStore {
    if (!fs.existsSync(filePath)) return createEmptyArtifactStore();

    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw) as Partial<ModuleArtifactStore>;

        if (parsed.version !== 1 || !parsed.artifacts || typeof parsed.artifacts !== 'object') {
            return createEmptyArtifactStore();
        }

        const artifacts: Record<string, ModuleArtifactMetadata> = {};
        for (const [id, artifact] of Object.entries(parsed.artifacts)) {
            if (isValidArtifact(artifact)) {
                artifacts[id] = artifact;
            }
        }

        const verifications: Record<string, ArtifactVerificationOutcome> = {};
        if (parsed.verifications && typeof parsed.verifications === 'object') {
            for (const [id, verification] of Object.entries(parsed.verifications)) {
                if (isValidVerification(verification)) {
                    verifications[id] = verification;
                }
            }
        }

        return { version: 1, artifacts, verifications };
    } catch {
        return createEmptyArtifactStore();
    }
}

export function saveArtifactStore(
    store: ModuleArtifactStore,
    filePath = getDefaultArtifactStoreFilePath()
): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(store, null, 2), 'utf8');
}

export function upsertArtifact(
    store: ModuleArtifactStore,
    artifact: ModuleArtifactMetadata
): void {
    store.artifacts[artifact.moduleId] = artifact;
}

export function removeArtifact(store: ModuleArtifactStore, moduleId: string): void {
    delete store.artifacts[moduleId];
}

export function getArtifact(
    store: ModuleArtifactStore,
    moduleId: string
): ModuleArtifactMetadata | undefined {
    return store.artifacts[moduleId];
}

export function upsertArtifactVerification(
    store: ModuleArtifactStore,
    outcome: ArtifactVerificationOutcome
): void {
    store.verifications[outcome.moduleId] = outcome;
}

export function getArtifactVerification(
    store: ModuleArtifactStore,
    moduleId: string
): ArtifactVerificationOutcome | undefined {
    return store.verifications[moduleId];
}
