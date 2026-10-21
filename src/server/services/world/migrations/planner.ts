import { canonicalJson, migrationDigest, applicableMigrationSteps, type ResolvedMigrationCatalog,
    type ResolvedMigrationStep } from '@modules/registry/migrations/catalog';
import type { MigrationCheckResult, MigrationPlanResult, MigrationTarget, MigrationHookInput } from '@shared/sdk/migrations';
import type { ModuleWorldSnapshot } from '@shared/sdk/world';
import { createMigrationHookRunner } from './hooks';
import { deepMerge } from '@server/core/documents/primary/base/PrimaryDocumentStore';
import type { MigrationSourceTarget } from './targets';

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
    diagnostics?: MigrationDiagnostic[];
}
export interface MigrationDiagnostic { stepId: string; target: string; phase: string; classification: string; reason: string }
export function migrationReason(error: unknown): string {
    return String(error instanceof Error ? error.message : error || 'Unavailable').replace(/[\x00-\x1f\x7f]/g, ' ')
        .replace(/(password|authorization|cookie|secret|access[_-]?token)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
        .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1[redacted]@').slice(0, 800);
}
const indexes = new WeakMap<MigrationTarget[], Map<string, MigrationTarget>>();
function index(sources: MigrationTarget[]): Map<string, MigrationTarget> {
    let value = indexes.get(sources);
    if (!value) { value = new Map(sources.map(row => [row.uuid, row])); indexes.set(sources, value); }
    return value;
}
function ancestors(target: MigrationTarget, sources: MigrationTarget[]): MigrationTarget[] {
    const result: MigrationTarget[] = []; const lookup = index(sources);
    let uuid = target.uuid;
    while (uuid.includes('.')) { uuid = uuid.slice(0, uuid.lastIndexOf('.')); uuid = uuid.slice(0, Math.max(0, uuid.lastIndexOf('.')));
        const row = lookup.get(uuid); if (row) result.push(row); }
    return result;
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
    for (const ancestor of ancestors(target, sources)) {
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
/** Copy only the rows changed by a bounded native batch; all other inputs stay immutable. */
export function migrationSimulation(sources: MigrationTarget[], uuids: string[]): MigrationTarget[] {
    const changed = new Set(uuids.flatMap(uuid => {
        const target = index(sources).get(uuid);
        return target ? [uuid, ...ancestors(target, sources).map(row => row.uuid)] : [];
    }));
    return sources.map(row => changed.has(row.uuid) ? structuredClone(row) : row);
}
export function simulateMigrationOperation(sources: MigrationTarget[], operation: PlannedMigrationTarget): void {
    const target = index(sources).get(operation.uuid);
    if (!target) throw new Error('Approved migration target removed');
    target.source = applyMigrationPatch(target.source, operation.updates);
    syncSimulatedAncestors(target, sources);
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
    const relations: NonNullable<MigrationHookInput['relations']> = {};
    for (const declaration of step.reads?.relations ?? []) {
        if (declaration.forKinds && !declaration.forKinds.includes(target.kind)) continue;
        const related = declaration.relation === 'baseActor' ? [index(references).get(target.baseActorUuid ?? '')].filter((row): row is MigrationTarget => !!row)
            : declaration.relation === 'parent' ? ancestors(target, references).slice(0, 1) : ancestors(target, references);
        if (declaration.required && !related.length) throw new Error(`Required ${declaration.relation} relation unavailable for ${target.uuid}`);
        const projected = related.map(row => {
            const source: Record<string, unknown> = {};
            for (const field of declaration.fields) {
                const parts = field.split('.'); let value: unknown = row.source; let cursor = source;
                for (const part of parts) value = value && typeof value === 'object' && Object.hasOwn(value, part) ? (value as Record<string, unknown>)[part] : undefined;
                if (value === undefined) continue; // absent stays absent, not null/default
                for (const part of parts.slice(0, -1)) cursor = (cursor[part] ??= {}) as Record<string, unknown>;
                cursor[parts.at(-1)!] = structuredClone(value);
            }
            return { ...row, source };
        });
        if (declaration.relation === 'ancestors') relations.ancestors = projected;
        else if (projected[0]) relations[declaration.relation] = projected[0];
    }
    return { world: { identity: world.identity, settings }, target, ...(step.reads?.relations ? { relations } : {}),
        references: references.filter(row => row.pack ? step.reads?.packs?.includes(row.pack) : step.reads?.targets?.includes(row.kind)), parameters: step.parameters ?? {} };
}
export function migrationInputHashes(world: Readonly<ModuleWorldSnapshot>, target: MigrationTarget, sources: MigrationTarget[], step: ResolvedMigrationStep): Record<string, string> {
    const input = hookInput(world, target, sources, step);
    const related = [...(input.relations?.ancestors ?? []), input.relations?.parent, input.relations?.baseActor].filter((row): row is MigrationTarget => !!row);
    return Object.fromEntries([target, ...input.references, ...related.map(row => index(sources).get(row.uuid)!)].map(row => [row.uuid, migrationTargetHash(row)]));
}
export function migrationTargetHash(target: MigrationSourceTarget): string {
    return sourceHash({ kind: target.kind, pack: target.pack ?? null, baseActorUuid: target.baseActorUuid ?? null,
        readOnly: target.readOnly ?? false, ...(target.writeBlockedReason ? { writeBlockedReason: target.writeBlockedReason } : {}), source: targetSourceHash(target.source) });
}
export function planWorldMigrations(root: string, catalog: ResolvedMigrationCatalog, world: Readonly<ModuleWorldSnapshot>, sources: MigrationSourceTarget[], checkOnly = false, scopeExclusions: string[] = [], progress?: (value: { checked: number; total: number; planned: number; stepId: string; discovered: number; remaining: number; phase: string }) => void): MigrationWorldPlan {
    const steps = applicableMigrationSteps(catalog, world.identity.systemVersion, world.identity.foundryGeneration);
    const operations: PlannedMigrationTarget[] = [];
    const blockers: string[] = [];
    const exclusions: string[] = [...scopeExclusions];
    for (const step of catalog.steps) if (!step.required && !step.foundryGenerations.includes(world.identity.foundryGeneration as 13 | 14)) exclusions.push(`${step.id}: advisory step unsupported on this Foundry generation`);
    if (steps.some(step => step.targets.includes('WorldPack'))) exclusions.push('System/package packs are intentionally excluded. Readable world-owned Actor/Item packs are checked; only unlocked packs can be written.');
    let checked = 0;
    const diagnostics: MigrationDiagnostic[] = [];
    const total = steps.reduce((sum, step) => sum + sources.filter(target => !target.readOnly && (target.pack ? step.targets.includes('WorldPack') : step.targets.includes(target.kind))).length, 0);
    const run = createMigrationHookRunner(root);
    // Every target is visited. Bound each invocation rather than silently truncate inventory.
    const simulated = structuredClone(sources);
    for (const step of steps) for (const target of simulated) {
        if (target.readOnly || !(target.pack ? step.targets.includes('WorldPack') : step.targets.includes(target.kind))) continue;
        checked += 1;
        let previousSource: Record<string, unknown> | undefined;
        let phase = 'check';
        try {
            const check = run<MigrationCheckResult>(step, 'check', hookInput(world, target, simulated, step));
            if (!['current', 'migration-needed', 'unresolved'].includes(check.status)) throw new Error('Invalid check result');
            if (check.status === 'unresolved') throw new Error(check.reason || 'Required source shape unresolved');
            if (check.status === 'current') {
                phase = 'verify';
                const verified = run<{ valid: boolean; reason?: string }>(step, 'verify', hookInput(world, target, simulated, step));
                if (verified.valid !== true) throw new Error(verified.reason || 'Current source postcondition failed');
                continue;
            }
            if (target.writeBlockedReason) throw new Error(target.writeBlockedReason);
            if (checkOnly) { (step.required ? blockers : exclusions).push(`${step.id}: ${target.uuid}: maintenance required${check.reason ? `: ${migrationReason(check.reason)}` : ''}`); continue; }
            phase = 'plan';
            const plan = run<MigrationPlanResult>(step, 'plan', hookInput(world, target, simulated, step));
            if (plan.status !== 'patch') throw new Error(plan.reason || 'Required plan unresolved');
            validateMigrationPatch(step, plan.updates);
            const dependencies = migrationInputHashes(world, target, simulated, step);
            const affected = [target, ...ancestors(target, simulated)];
            const beforeHashes = new Map(affected.map(row => [row.uuid, migrationTargetHash(row)]));
            previousSource = target.source;
            target.source = applyMigrationPatch(target.source, plan.updates);
            syncSimulatedAncestors(target, simulated);
            phase = 'verify';
            const verification = run<{ valid: boolean; reason?: string }>(step, 'verify', hookInput(world, target, simulated, step));
            if (verification.valid !== true) throw new Error(verification.reason || 'Planned postcondition failed');
            const effects = Object.fromEntries(affected.filter(row => beforeHashes.get(row.uuid) !== migrationTargetHash(row)).map(row => [row.uuid, migrationTargetHash(row)]));
            operations.push({ stepId: step.id, stepDigest: step.digest, uuid: target.uuid, sourceHash: targetSourceHash(previousSource), updates: plan.updates, dependencies, effects });
        } catch (error) {
            if (previousSource) { target.source = previousSource; syncSimulatedAncestors(target, simulated); }
            const reason = migrationReason(error);
            diagnostics.push({ stepId: step.id, target: target.uuid, phase, classification: /timed out/.test(reason) ? 'hook-timeout' : /Invalid|exceeds|Unsafe/.test(reason) ? 'invalid-output' : phase === 'verify' ? 'verification-failed' : 'unresolved', reason });
            (step.required ? blockers : exclusions).push(`${step.id}: ${target.uuid}: ${phase}: ${reason}`);
        } finally { if (checked % 10 === 0 || checked === total) progress?.({ checked, total, planned: operations.length, stepId: step.id, discovered: sources.length, remaining: total - checked, phase: 'checking' }); }
    }
    const base = { world, catalogDigest: catalog.digest, inventoryHash: sourceHash(sources), operations, blockers, exclusions, checked };
    return { ...base, digest: sourceHash(base), ...(diagnostics.length ? { diagnostics } : {}) };
}
