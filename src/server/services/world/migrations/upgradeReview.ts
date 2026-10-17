import type { UpgradePreview } from './UpgradeJournal';

/** Reviews retain every proposed target/patch and the exact logical digest.
 * Dependency proofs remain server-owned, not quadratically duplicated over HTTP.
 */
export function upgradeReview<T extends UpgradePreview>(record: T) {
    return { ...record, plan: { ...record.plan, operations: record.plan.operations.map(({ dependencies: _dependencies, effects: _effects, ...operation }) => operation) } };
}
export function archiveUpgradeReview<T extends { migration?: UpgradePreview }>(record: T) {
    return { ...record, ...(record.migration ? { migration: upgradeReview(record.migration) } : {}) };
}
