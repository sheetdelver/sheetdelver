import fs from 'node:fs';
import path from 'node:path';
import { getDistArchivesDir, getModulesDataDir } from '@core/paths';
import { discoverMigrations, migrationDirectoryDigest } from '@modules/registry/migrations/catalog';
import { migrationSourceDigest, assertMigrationSource } from '@modules/registry/migrations/sourceInspection';
import { packageMigrations } from '@modules/registry/migrations/compile';
import type { SystemModuleInfo } from '@modules/registry/core/types';
import type { UpgradeCandidate } from './ModuleUpgradeCoordinator';
import { ModuleSourceCategory } from '@shared/types/modules';
import { getModuleLifecycleState, switchModuleSource } from '@modules/registry/server';
import { createHostUpgradeCoordinator, getUpgradeJournal } from './ModuleUpgradeService';
import { getDefaultLifecycleStateFilePath } from '@modules/registry/lifecycle/lifecycle';
import { getDefaultArtifactStoreFilePath } from '@modules/registry/distribution/artifactStore';
import { validateModuleInfoShape, evaluateModuleCompatibility } from '@modules/registry/lifecycle/validation';
import { getCoreVersion } from '@modules/registry/core/internals';
import { beginMigrationEvidence } from './migrationEvidence';
import { migrationAttentionFrame, assertMigrationAttentionFrame } from './migrationAttention';

/** Core-owned compiled snapshot. Author source directories are never rewritten. */
export async function prepareSourceCandidate(directory: string, info: SystemModuleInfo, category: 'local' | 'managed'): Promise<UpgradeCandidate> {
    if (!validateModuleInfoShape(info).valid || !evaluateModuleCompatibility(info, getCoreVersion()).compatible) throw new Error('Source manifest/host compatibility checks failed');
    const catalog = discoverMigrations(directory, info, category === 'local');
    if (!catalog) throw new Error('Source has no declared migration catalog');
    const sourceDigest = migrationSourceDigest(directory, category);
    const staging = getDistArchivesDir(); fs.mkdirSync(staging, { recursive: true });
    const root = fs.mkdtempSync(path.join(staging, '.source-upgrade-'));
    try {
        if (category === 'local') await packageMigrations(directory, root, info);
        else {
            // Packaged hooks are immutable historical artifacts, not compiler
            // inputs. Rebundling changes their bytes even at the same version.
            fs.copyFileSync(path.join(directory, 'migration.json'), path.join(root, 'migration.json'));
            for (const entry of catalog.definitions) {
                fs.mkdirSync(path.join(root, entry.directory), { recursive: true });
                fs.copyFileSync(path.join(directory, entry.directory, 'definition.json'), path.join(root, entry.directory, 'definition.json'));
                for (const step of entry.definition.steps) for (const file of Object.values(step.hooks)) {
                    const relative = path.join(entry.directory, file);
                    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
                    fs.copyFileSync(path.join(directory, relative), path.join(root, relative));
                }
            }
            if (discoverMigrations(root, info)?.digest !== catalog.digest) throw new Error('Packaged migration snapshot changed');
        }
        fs.writeFileSync(path.join(root, 'info.json'), JSON.stringify(info));
        if (migrationSourceDigest(directory, category, sourceDigest) !== sourceDigest) throw new Error('Source changed while compiling migration snapshot');
        return { moduleId: info.id, version: info.version ?? '', info, root,
            artifactDigest: migrationDirectoryDigest(root), sourceDirectory: directory, sourceDigest, sourceCategory: category };
    } catch (error) { fs.rmSync(root, { recursive: true, force: true }); throw error; }
}
export async function previewModuleSource(moduleId: string, category: 'local' | 'managed') {
    const record = getModuleLifecycleState().find(row => row.moduleId === moduleId);
    const directory = category === 'local' ? record?.localDirectory : record ? path.join(getModulesDataDir(), moduleId) : undefined;
    if (!directory) throw new Error('Selected source is unavailable');
    const info = JSON.parse(fs.readFileSync(path.join(directory, 'info.json'), 'utf8')) as SystemModuleInfo;
    const frame = migrationAttentionFrame();
    const observation = frame.world ? beginMigrationEvidence({ moduleId, source: category, directory, version: info.version }, frame.world,
        () => assertMigrationAttentionFrame(frame.revision)) : null;
    let candidate: UpgradeCandidate | undefined;
    try {
        candidate = await prepareSourceCandidate(directory, info, category);
        const preview = await createHostUpgradeCoordinator().preview(candidate);
        await getUpgradeJournal().saveSourceCandidate(preview.id, candidate);
        observation?.finish({ state: preview.plan.blockers.length ? 'blocked' : preview.plan.operations.length ? 'required' : 'up-to-date',
            reason: preview.plan.blockers[0] || (preview.plan.operations.length ? 'Fresh checks propose world-data changes. Review before entering maintenance.' : 'Fresh advisory checks propose no world-data changes for this source.'),
            checked: preview.plan.checked, proposedWrites: preview.plan.operations.length, previewId: preview.id,
            artifactDigest: candidate.artifactDigest, catalogDigest: preview.catalogDigest }, () => {
            assertMigrationAttentionFrame(frame.revision);
            if (Date.now() > preview.expiresAt) throw new Error('Advisory evidence expired');
        });
        return preview;
    } catch (error) {
        observation?.finish({ state: 'blocked', reason: error instanceof Error ? error.message : 'Source checks unavailable' });
        if (candidate) fs.rmSync(candidate.root, { recursive: true, force: true });
        throw error;
    }
}
export async function applyModuleSource(planId: string, administrator: string, backupAcknowledged: boolean) {
    const candidate = (await getUpgradeJournal().sourceCandidate(planId));
    if (!candidate.sourceDirectory) throw new Error('Source is unavailable; rerun preview');
    assertMigrationSource(candidate);
    const journal = getUpgradeJournal();
    return createHostUpgradeCoordinator({
        promote: async job => {
            job.registryBackups = [getDefaultLifecycleStateFilePath(), getDefaultArtifactStoreFilePath()]
                .map(file => ({ path: file, contents: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null }));
            job.targetDirectory = candidate.sourceDirectory;
            job.fileTransition = 'intent'; await journal.save(job);
            const category = candidate.sourceCategory === 'local' ? ModuleSourceCategory.Local : ModuleSourceCategory.Managed;
            const result = switchModuleSource(candidate.moduleId, category, () => {
                journal.assertLease(job);
                assertMigrationSource(candidate);
            });
            if (!result.success) throw new Error(result.error);
            job.fileTransition = 'registered'; await journal.save(job);
        },
        restart: () => {},
    }).approve(candidate, { planId, idempotencyKey: planId, administrator, backupAcknowledged });
}
