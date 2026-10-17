import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveModuleCompatibility } from '../lifecycle/compatibilityResolver';
import { MIGRATION_CATALOG_SCHEMA, MIGRATION_DEFINITION_SCHEMA, type MigrationCatalog,
    type MigrationDefinition, type MigrationStep } from '@shared/sdk/migrations';
import type { SystemModuleInfo } from '../core/types';
import { isWorldValue } from '@shared/sdk/world';
import { WORLD_MIGRATION_API_MINIMUM, MIGRATION_RELATIONS_API_MINIMUM } from '@shared/sdk/contractVersions';

export function migrationDigest(value: string | Uint8Array): string {
    return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
export function migrationDirectoryDigest(root: string): string {
    const entries: Array<[string, string]> = [];
    let bytes = 0;
    function walk(directory: string, prefix: string): void {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            if (entry.name === '.git' || entry.name === 'node_modules') continue;
            const relative = `${prefix}${entry.name}`;
            if (entry.isSymbolicLink()) throw new Error('Candidate symlinks are forbidden');
            if (entry.isDirectory()) walk(path.join(directory, entry.name), `${relative}/`);
            else if (entry.isFile()) {
                const file = confinedMigrationFile(root, relative);
                bytes += fs.statSync(file).size;
                if (entries.length >= 20_000 || bytes > 512 * 1024 * 1024) throw new Error('Candidate tree exceeds inspection bounds');
                entries.push([relative, migrationDigest(fs.readFileSync(file))]);
            }
            else throw new Error('Candidate contains a special file');
        }
    }
    walk(root, '');
    return migrationDigest(canonicalJson(entries));
}
export function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
}
export function confinedMigrationFile(root: string, relative: string): string {
    if (!relative || relative.includes('\\') || relative.includes('\0') || relative.includes(':') || path.isAbsolute(relative)
        || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unconfined migration path');
    const parts = relative.split('/');
    let cursor = root;
    for (const part of parts) {
        cursor = path.join(cursor, part);
        const stat = fs.lstatSync(cursor);
        if (stat.isSymbolicLink()) throw new Error('Migration symlinks are forbidden');
    }
    if (!fs.statSync(cursor).isFile()) throw new Error('Migration entry must be a file');
    return cursor;
}
function read(root: string, relative: string): string {
    const file = confinedMigrationFile(root, relative);
    if (fs.statSync(file).size > 1_048_576) throw new Error('Migration entry exceeds byte bound');
    return fs.readFileSync(file, 'utf8');
}
function exactKeys(value: object, allowed: string[]): void {
    if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unknown migration declaration field');
}
function range(value: unknown): value is string {
    return typeof value === 'string' && /^(?:(?:>=|<=|>|<|=)?\d+\.\d+\.\d+\s*)+$/.test(value);
}
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
export interface ResolvedMigrationStep extends MigrationStep {
    milestone: string;
    digest: string;
    entries: Record<'check' | 'plan' | 'verify', { path: string; digest: string }>;
}
export interface ResolvedMigrationCatalog {
    worldSettings: NonNullable<SystemModuleInfo['worldSettings']>;
    digest: string;
    catalog: MigrationCatalog;
    steps: ResolvedMigrationStep[];
    definitions: Array<{ milestone: string; directory: string; definition: MigrationDefinition }>;
}
export interface MigrationSummary { schemaVersion: typeof MIGRATION_CATALOG_SCHEMA; catalogDigest: string; steps: number }
export function discoverMigrations(root: string, info: SystemModuleInfo, source = false): ResolvedMigrationCatalog | null {
    try { fs.lstatSync(path.join(root, 'migration.json')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    const catalog = JSON.parse(read(root, 'migration.json')) as MigrationCatalog;
    exactKeys(catalog, ['schemaVersion', 'systemVersions']);
    if (catalog.schemaVersion !== MIGRATION_CATALOG_SCHEMA || !catalog.systemVersions || Array.isArray(catalog.systemVersions)
        || Object.keys(catalog.systemVersions).length > 100) throw new Error('Invalid migration catalog');
    // Older hosts must reject this package through a contract they already understand.
    const minimum = info.compatibility?.apiContracts?.['module-api'];
    const explicitFloor = minimum?.split(/[\s,]+/).some(token => {
        const match = token.match(/^(>=|>|=)?(\d+\.\d+\.\d+)$/);
        return match && !token.startsWith('<') && resolveModuleCompatibility({ coreVersion: match[2], requiredCoreVersion: `>=${WORLD_MIGRATION_API_MINIMUM}`, providedApiContracts: {} }).compatible;
    });
    if (!minimum || !explicitFloor) throw new Error('Migration packages must exclude module-api 1.4 and older with an explicit supported lower bound');
    const steps: ResolvedMigrationStep[] = [];
    const definitions: ResolvedMigrationCatalog['definitions'] = [];
    for (const [milestone, directory] of Object.entries(catalog.systemVersions)) {
        if (!/^\d+\.\d+\.\d+$/.test(milestone) || directory !== `migrations/${milestone}`) throw new Error('Migration directory must name its native system milestone');
        const definition = JSON.parse(read(root, `${directory}/definition.json`)) as MigrationDefinition;
        exactKeys(definition, ['schemaVersion', 'dataReadVersion', 'steps']);
        if (definition.schemaVersion !== MIGRATION_DEFINITION_SCHEMA || !range(definition.dataReadVersion)
            || !Array.isArray(definition.steps) || definition.steps.length > 100) throw new Error('Invalid migration definition');
        definitions.push({ milestone, directory, definition });
        for (const step of definition.steps) {
            exactKeys(step, ['id', 'revision', 'description', 'dependencies', 'systemVersion', 'foundryGenerations', 'required', 'targets', 'paths', 'hooks', 'parameters', 'parameterSchema', 'reads']);
            if (step.parameters !== undefined && (!step.parameters || typeof step.parameters !== 'object' || Array.isArray(step.parameters)
                || JSON.stringify(step.parameters).length > 65_536)) throw new Error('Invalid bounded migration parameters');
            if (step.parameters || step.parameterSchema) {
                if (!step.parameterSchema || !step.parameters || Object.keys(step.parameterSchema).length > 64
                    || Object.keys(step.parameters).some(key => !Object.hasOwn(step.parameterSchema!, key))
                    || Object.entries(step.parameterSchema).some(([key, schema]) => !schema || !isWorldValue(step.parameters![key], schema))) throw new Error('Migration parameters do not match declared schema');
            }
            if (step.reads) {
                exactKeys(step.reads, ['targets', 'packs', 'settings', 'relations']);
                if (step.reads.relations !== undefined) {
                    if (!Array.isArray(step.reads.relations) || step.reads.relations.length > 3
                        || new Set(step.reads.relations.map(row => row.relation)).size !== step.reads.relations.length) throw new Error('Invalid migration relations');
                    const supportsRelations = minimum.split(/[\s,]+/).some(token => {
                        const match = token.match(/^(>=|>|=)?(\d+\.\d+\.\d+)$/);
                        return match && resolveModuleCompatibility({ coreVersion: match[2], requiredCoreVersion: `>=${MIGRATION_RELATIONS_API_MINIMUM}`, providedApiContracts: {} }).compatible;
                    });
                    if (!supportsRelations) throw new Error('Migration relations require an explicit module-api 1.6 lower bound');
                    for (const relation of step.reads.relations) {
                        exactKeys(relation, ['relation', 'forKinds', 'fields', 'required']);
                        if (!['parent', 'ancestors', 'baseActor'].includes(relation.relation)
                            || relation.required !== undefined && typeof relation.required !== 'boolean'
                            || relation.forKinds !== undefined && (!Array.isArray(relation.forKinds) || !relation.forKinds.length
                                || relation.forKinds.some(kind => !['Actor', 'Item', 'ActiveEffect', 'ActorDelta'].includes(kind)))
                            || !Array.isArray(relation.fields) || !relation.fields.length || relation.fields.length > 64
                            || relation.fields.some(field => typeof field !== 'string' || field.length > 256
                                || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(field)
                                || field.split('.').some(part => ['__proto__', 'constructor', 'prototype'].includes(part))
                                || ['items', 'effects'].includes(field.split('.')[0]))) throw new Error('Invalid bounded migration relation projection');
                    }
                }
                if (step.reads.targets && (!Array.isArray(step.reads.targets) || step.reads.targets.some(kind => !['Actor', 'Item', 'ActiveEffect', 'ActorDelta', 'WorldPack'].includes(kind)))
                    || step.reads.packs && (!Array.isArray(step.reads.packs) || step.reads.packs.length > 100 || step.reads.packs.some(pack => typeof pack !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(pack)))
                    || step.reads.settings && (!Array.isArray(step.reads.settings) || step.reads.settings.some(key => !info.worldSettings?.some(row => row.key === key)))) throw new Error('Undeclared migration read dependency');
            }
            if (!ID.test(step.id) || !Number.isSafeInteger(step.revision) || step.revision < 1 || typeof step.description !== 'string'
                || step.description.length > 1000 || !range(step.systemVersion) || typeof step.required !== 'boolean'
                || !Array.isArray(step.dependencies) || step.dependencies.some(id => !ID.test(id))
                || !Array.isArray(step.foundryGenerations) || !step.foundryGenerations.length || step.foundryGenerations.some(n => n !== 13 && n !== 14)
                || !Array.isArray(step.targets) || !step.targets.length || step.targets.some(kind => !['Actor', 'Item', 'ActiveEffect', 'ActorDelta', 'WorldPack'].includes(kind))
                || !Array.isArray(step.paths) || !step.paths.length || step.paths.length > 100) throw new Error('Invalid migration step');
            for (const field of step.paths) {
                if (!/^(?:system(?:\.[a-zA-Z0-9_-]+)*|changes|disabled|statuses|flags\.[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)+)$/.test(field)
                    || field.split('.').some(part => ['__proto__', 'prototype', 'constructor'].includes(part))
                    || field.startsWith('flags.core.') || field.startsWith('flags.sheet-delver.')) throw new Error('Unsafe migration write path');
                if (field.startsWith('flags.') && ![info.id, ...(info.aliases ?? [])].includes(field.split('.')[1])) throw new Error('Undeclared migration flag namespace');
            }
            const entries = {} as ResolvedMigrationStep['entries'];
            exactKeys(step.hooks, ['check', 'plan', 'verify']);
            for (const hook of ['check', 'plan', 'verify'] as const) {
                const relative = `${directory}/${step.hooks[hook]}`;
                if (!(source ? /\.(ts|cjs|js)$/ : /\.cjs$/).test(step.hooks[hook])) throw new Error('Packaged migration hooks must be compiled .cjs files');
                const contents = read(root, relative);
                entries[hook] = { path: relative, digest: migrationDigest(contents) };
            }
            steps.push({ ...step, milestone, entries, digest: migrationDigest(canonicalJson({ step, entries })) });
        }
    }
    if (steps.length > 500 || new Set(steps.map(step => step.id)).size !== steps.length) throw new Error('Duplicate or excessive migration step IDs');
    const byId = new Map(steps.map(step => [step.id, step]));
    const ordered: ResolvedMigrationStep[] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();
    function visit(step: ResolvedMigrationStep): void {
        if (visited.has(step.id)) return;
        if (visiting.has(step.id)) throw new Error('Migration dependency cycle');
        visiting.add(step.id);
        for (const id of step.dependencies) {
            const dependency = byId.get(id);
            if (!dependency) throw new Error(`Missing migration dependency: ${id}`);
            visit(dependency);
        }
        visiting.delete(step.id); visited.add(step.id); ordered.push(step);
    }
    [...steps].sort((a, b) => a.id.localeCompare(b.id)).forEach(visit);
    return { catalog, definitions, steps: ordered, worldSettings: info.worldSettings ?? [],
        digest: migrationDigest(canonicalJson({ catalog, definitions, steps: ordered })) };
}
export function migrationSummary(catalog: ResolvedMigrationCatalog | null): MigrationSummary | undefined {
    return catalog ? { schemaVersion: MIGRATION_CATALOG_SCHEMA, catalogDigest: catalog.digest, steps: catalog.steps.length } : undefined;
}
export function applicableMigrationSteps(catalog: ResolvedMigrationCatalog, systemVersion: string, generation: number): ResolvedMigrationStep[] {
    const matches = (constraint: string) => resolveModuleCompatibility({ coreVersion: systemVersion,
        requiredCoreVersion: constraint, providedApiContracts: {} }).compatible;
    const selected = new Set<string>();
    function include(step: ResolvedMigrationStep): void {
        if (selected.has(step.id)) return;
        if (!step.foundryGenerations.includes(generation as 13 | 14) || !matches(step.systemVersion)) throw new Error('Unsupported required migration chain');
        selected.add(step.id);
        for (const id of step.dependencies) include(catalog.steps.find(row => row.id === id)!);
    }
    for (const step of catalog.steps) if (matches(step.systemVersion)) {
        if (!step.required && !step.foundryGenerations.includes(generation as 13 | 14)) continue;
        include(step);
    }
    if (!catalog.definitions.some(row => matches(row.definition.dataReadVersion))) throw new Error('Unsupported native source data-read version');
    return catalog.steps.filter(step => selected.has(step.id));
}
