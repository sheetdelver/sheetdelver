import { canonicalJson, migrationDigest, applicableMigrationSteps, type ResolvedMigrationCatalog,
    type ResolvedMigrationStep } from '@modules/registry/migrations/catalog';
import type { MigrationCheckResult, MigrationPlanResult, MigrationTarget, MigrationHookInput } from '@shared/sdk/migrations';
import type { ModuleWorldSnapshot } from '@shared/sdk/world';
import { runMigrationHook } from './hooks';
import { deepMerge } from '@server/core/documents/primary/base/PrimaryDocumentStore';

export interface PlannedMigrationTarget {
    stepId: string;
    stepDigest: string;
    uuid: string;
    sourceHash: string;
    /** Exact pre-write read set, including membership and reference identities. */
    dependencies: Record<string, string>;
    /** Approved simulation changes, including embedded ancestors. */
    effects: Record<string, string>;
    updates: Record<string, unknown>;
}
export interface MigrationWorldPlan {
    world: Readonly<ModuleWorldSnapshot>;
    catalogDigest: string;
    inventoryHash: string;
    operations: PlannedMigrationTarget[];
    blockers: string[];
    exclusions: string[];
    checked: number;
    digest: string;
}
export function sourceHash(source: unknown): string { return migrationDigest(canonicalJson(source)); }
/** Native write timestamps are not rule/source predicates; document content still is. */
export function targetSourceHash(source: Record<string, unknown>): string {
    const copy = structuredClone(source);
    function strip(document: Record<string, unknown>): void {
        delete document._stats;
        for (const name of ['items', 'effects']) if (Array.isArray(document[name])) {
            for (const child of document[name]) if (child && typeof child === 'object') strip(child);
        }
    }
    strip(copy); return sourceHash(copy);
}
function syncSimulatedAncestors(target: MigrationTarget, sources: MigrationTarget[]): void {
    for (const ancestor of sources) {
        if (!target.uuid.startsWith(`${ancestor.uuid}.`)) continue;
        const parts = target.uuid.slice(ancestor.uuid.length + 1).split('.');
        let cursor = ancestor.source;
        for (let i = 0; i < parts.length; i += 2) {
            const collection = parts[i] === 'Item' ? 'items' : parts[i] === 'ActiveEffect' ? 'effects' : '';
            const rows = cursor[collection];
            if (!Array.isArray(rows)) break;
            const index = rows.findIndex(row => row?._id === parts[i + 1] || row?.id === parts[i + 1]);
            if (index < 0) break;
            if (i === parts.length - 2) rows[index] = structuredClone(target.source);
            else cursor = rows[index];
        }
    }
}
export function validateMigrationPatch(step: ResolvedMigrationStep, updates: unknown): asserts updates is Record<string, unknown> {
    if (!updates || typeof updates !== 'object' || Array.isArray(updates) || Object.keys(updates).length > 100
        || JSON.stringify(updates).length > 1_048_576) throw new Error('Invalid migration patch');
    for (const key of Object.keys(updates)) {
        if (!step.paths.some(path => key === path || key.startsWith(`${path}.`))
            || key.split('.').some(part => !/^[A-Za-z0-9_-]+$/.test(part) || ['__proto__', 'constructor', 'prototype'].includes(part))) throw new Error('Migration patch exceeds declared paths');
    }
    let nodes = 0;
    function safe(value: unknown, depth = 0): void {
        if (++nodes > 100_000 || depth > 32) throw new Error('Migration patch exceeds structural bounds');
        if (!value || typeof value !== 'object') return;
        for (const [key, entry] of Object.entries(value)) {
            if (key === '__type' || key.split('.').some(part => !/^[A-Za-z0-9_-]+$/.test(part)
                || ['__proto__', 'constructor', 'prototype'].includes(part))) throw new Error('Unsafe migration nested field/operator');
            safe(entry, depth + 1);
        }
    }
    safe(updates);
}
export function applyMigrationPatch(source: Record<string, unknown>, updates: Record<string, unknown>): Record<string, unknown> {
    const next = structuredClone(source);
    deepMerge(next, structuredClone(updates));
    return next;
}
export function hookInput(world: Readonly<ModuleWorldSnapshot>, target: MigrationTarget, references: MigrationTarget[], step: ResolvedMigrationStep): MigrationHookInput {
    const settings = Object.fromEntries(Object.entries(world.settings).filter(([key]) => step.reads?.settings?.includes(key)));
    return { world: { identity: world.identity, settings }, target,
        references: references.filter(row => row.pack ? step.reads?.packs?.includes(row.pack) : step.reads?.targets?.includes(row.kind)), parameters: step.parameters ?? {} };
}
export function migrationInputHashes(world: Readonly<ModuleWorldSnapshot>, target: MigrationTarget, sources: MigrationTarget[], step: ResolvedMigrationStep): Record<string, string> {
    const input = hookInput(world, target, sources, step);
    return Object.fromEntries([target, ...input.references].map(row => [row.uuid, migrationTargetHash(row)]));
}
export function migrationTargetHash(target: MigrationTarget): string {
    return sourceHash({ kind: target.kind, pack: target.pack ?? null, baseActorUuid: target.baseActorUuid ?? null,
        readOnly: target.readOnly ?? false, source: targetSourceHash(target.source) });
}
export function planWorldMigrations(root: string, catalog: ResolvedMigrationCatalog, world: Readonly<ModuleWorldSnapshot>, sources: MigrationTarget[], checkOnly = false, scopeExclusions: string[] = []): MigrationWorldPlan {
    const steps = applicableMigrationSteps(catalog, world.identity.systemVersion, world.identity.foundryGeneration);
    const operations: PlannedMigrationTarget[] = [];
    const blockers: string[] = [];
    const exclusions: string[] = [...scopeExclusions];
    for (const step of catalog.steps) if (!step.required && !step.foundryGenerations.includes(world.identity.foundryGeneration as 13 | 14)) exclusions.push(`${step.id}: advisory step unsupported on this Foundry generation`);
    if (steps.some(step => step.targets.includes('WorldPack'))) exclusions.push('System/package packs are intentionally excluded; only declared unlocked world-owned Actor/Item packs are eligible.');
    let checked = 0;
    const deadline = Date.now() + 5000;
    // Every target is visited. Bound each invocation rather than silently truncate inventory.
    const simulated = structuredClone(sources);
    for (const step of steps) for (const target of simulated) {
        if (Date.now() > deadline) throw new Error('Migration computation budget exceeded; no partial plan is approved');
        if (target.readOnly || !(target.pack ? step.targets.includes('WorldPack') : step.targets.includes(target.kind))) continue;
        checked += 1;
        let previousSource: Record<string, unknown> | undefined;
        try {
            const check = runMigrationHook<MigrationCheckResult>(root, step, 'check', hookInput(world, target, simulated, step));
            if (!['current', 'migration-needed', 'unresolved'].includes(check.status)) throw new Error('Invalid check result');
            if (check.status === 'unresolved') throw new Error('Required source shape unresolved');
            if (check.status === 'current') {
                const verified = runMigrationHook<{ valid: boolean }>(root, step, 'verify', hookInput(world, target, simulated, step));
                if (verified.valid !== true) throw new Error('Current source postcondition failed');
                continue;
            }
            if (checkOnly) { (step.required ? blockers : exclusions).push(`${step.id}: maintenance required`); continue; }
            const plan = runMigrationHook<MigrationPlanResult>(root, step, 'plan', hookInput(world, target, simulated, step));
            if (plan.status !== 'patch') throw new Error('Required plan unresolved');
            validateMigrationPatch(step, plan.updates);
            const dependencies = migrationInputHashes(world, target, simulated, step);
            const beforeHashes = new Map(simulated.map(row => [row.uuid, migrationTargetHash(row)]));
            previousSource = target.source;
            target.source = applyMigrationPatch(target.source, plan.updates);
            syncSimulatedAncestors(target, simulated);
            const verification = runMigrationHook<{ valid: boolean }>(root, step, 'verify', hookInput(world, target, simulated, step));
            if (verification.valid !== true) throw new Error('Planned postcondition failed');
            const effects = Object.fromEntries(simulated.filter(row => beforeHashes.get(row.uuid) !== migrationTargetHash(row))
                .map(row => [row.uuid, migrationTargetHash(row)]));
            operations.push({ stepId: step.id, stepDigest: step.digest, uuid: target.uuid, sourceHash: targetSourceHash(previousSource), updates: plan.updates, dependencies, effects });
        } catch {
            if (previousSource) { target.source = previousSource; syncSimulatedAncestors(target, simulated); }
            (step.required ? blockers : exclusions).push(`${step.id}: ${target.uuid}: source check/plan unavailable`);
        }
    }
    const base = { world, catalogDigest: catalog.digest, inventoryHash: sourceHash(sources), operations, blockers, exclusions, checked };
    return { ...base, digest: sourceHash(base) };
}
