import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getCacheDir } from '@core/paths';
import { getCoreVersion } from '@modules/registry/core/internals';
import type { ResolvedMigrationCatalog } from '@modules/registry/migrations/catalog';
import type { UpgradeSourceSnapshot } from './ModuleUpgradeCoordinator';
import { computeWorldMigrations } from './compute';
import { sourceHash, type MigrationWorldPlan } from './planner';

// Invalidate when the check/verify semantics change within an unreleased Core.
const FORMAT = 1;
type SuccessfulCheck = Pick<MigrationWorldPlan, 'checked' | 'exclusions'>;
type CheckedSnapshot = UpgradeSourceSnapshot & { assertCurrent(): void };
interface StoredCheck { key: string; result: SuccessfulCheck; digest: string }

/** Caches computation, never native reads, authority, readiness or write approval.
 * One last successful input per installed source/world; no document data on disk.
 * Full identity (including epochs/revisions), dependencies and hook bytes matter.
 */
export function createCompatibilityCheck(root: string, catalog: ResolvedMigrationCatalog, sourceIdentity: unknown,
    compute = computeWorldMigrations) {
    const current = new Map<string, MigrationWorldPlan>();
    let persistedKey: string | undefined;
    const keyFor = (source: CheckedSnapshot) => sourceHash({ format: FORMAT, core: getCoreVersion(), sourceIdentity,
        catalog, world: source.world, inventory: sourceHash(source.targets), exclusions: source.exclusions ?? [] });
    const fileFor = (source: CheckedSnapshot) => path.join(getCacheDir(), 'migration-checks',
        `${sourceHash([sourceIdentity, source.world.identity.instanceId, source.world.identity.worldId]).slice(7)}.json`);
    const check = async (source: CheckedSnapshot) => {
        source.assertCurrent();
        const key = keyFor(source);
        const sameRun = current.get(key);
        if (sameRun) return { plan: sameRun, reused: true };
        try {
            const file = fileFor(source);
            if ((await fs.lstat(file)).isFile() && (await fs.stat(file)).size <= 1_048_576) {
                const stored = JSON.parse(await fs.readFile(file, 'utf8')) as StoredCheck;
                if (stored.key === key && stored.result && Number.isSafeInteger(stored.result.checked) && stored.result.checked >= 0
                    && Array.isArray(stored.result.exclusions) && stored.result.exclusions.every(row => typeof row === 'string')
                    && stored.digest === sourceHash([stored.key, stored.result])) {
                    source.assertCurrent();
                    const base = { world: source.world, catalogDigest: catalog.digest, inventoryHash: sourceHash(source.targets),
                        operations: [], blockers: [], checked: stored.result.checked, exclusions: stored.result.exclusions };
                    const plan: MigrationWorldPlan = { ...base, digest: sourceHash(base) };
                    current.set(key, plan);
                    persistedKey = key;
                    return { plan, reused: true };
                }
            }
        } catch { /* Missing, corrupt or inaccessible cache means a fresh check. */ }
        source.assertCurrent();
        const plan = await compute(root, catalog, source.world, source.targets, true, source.exclusions);
        source.assertCurrent();
        if (!plan.blockers.length && !plan.diagnostics?.length) current.set(key, plan);
        return { plan, reused: false };
    };
    const remember = async (source: CheckedSnapshot) => {
        source.assertCurrent();
        const key = keyFor(source), plan = current.get(key);
        if (!plan || key === persistedKey) return;
        const result = { checked: plan.checked, exclusions: plan.exclusions };
        const file = fileFor(source), temporary = `${file}.${randomUUID()}.tmp`;
        try {
            const text = JSON.stringify({ key, result, digest: sourceHash([key, result]) });
            if (text.length > 1_048_576) return;
            await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
            await fs.writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
            source.assertCurrent();
            await fs.rename(temporary, file);
        } catch { /* Optimization only. A cache failure cannot block the world. */ }
        finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
        source.assertCurrent();
    };
    return { check, remember };
}
