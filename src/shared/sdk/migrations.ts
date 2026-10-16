import type { ModuleWorldSnapshot } from './world';
import type { WorldValueSchema } from './world';

export const MIGRATION_CATALOG_SCHEMA = 'sheet-delver-migrations.v1' as const;
export const MIGRATION_DEFINITION_SCHEMA = 'sheet-delver-migration-definition.v1' as const;
export interface MigrationCatalog {
    schemaVersion: typeof MIGRATION_CATALOG_SCHEMA;
    systemVersions: Record<string, string>;
}
export type MigrationTargetKind = 'Actor' | 'Item' | 'ActiveEffect' | 'ActorDelta' | 'WorldPack';
export interface MigrationStep {
    id: string;
    revision: number;
    description: string;
    dependencies: string[];
    systemVersion: string;
    foundryGenerations: Array<13 | 14>;
    required: boolean;
    targets: MigrationTargetKind[];
    /** Only update operations on declared source fields are supported. */
    paths: string[];
    hooks: { check: string; plan: string; verify: string };
    parameters?: Record<string, unknown>;
    parameterSchema?: Record<string, WorldValueSchema>;
    /** Omitted dependencies expose no cross-document/setting input. */
    reads?: { targets?: MigrationTargetKind[]; packs?: string[]; settings?: string[] };
}
export interface MigrationDefinition {
    schemaVersion: typeof MIGRATION_DEFINITION_SCHEMA;
    /** Native system shapes this module can read after all required steps. */
    dataReadVersion: string;
    steps: MigrationStep[];
}
export interface MigrationTarget {
    uuid: string;
    kind: Exclude<MigrationTargetKind, 'WorldPack'>;
    source: Record<string, unknown>;
    pack?: string;
    baseActorUuid?: string;
    /** Declared package/system references may be read, never migration targets. */
    readOnly?: boolean;
}
export interface MigrationHookInput {
    world: Readonly<ModuleWorldSnapshot>;
    target: Readonly<MigrationTarget>;
    /** Host supplied references only; never a runtime/transport. */
    references: readonly MigrationTarget[];
    parameters: Readonly<Record<string, unknown>>;
}
export interface MigrationCheckResult {
    status: 'current' | 'migration-needed' | 'unresolved';
    reason?: string;
}
export interface MigrationPlanResult {
    status: 'patch' | 'no-op' | 'unresolved';
    updates?: Record<string, unknown>;
    reason?: string;
}
/** Hooks are synchronous, pure and bounded; separately compiled CommonJS default exports. */
export type MigrationCheckHook = (input: MigrationHookInput) => MigrationCheckResult;
export type MigrationPlanHook = (input: MigrationHookInput) => MigrationPlanResult;
export type MigrationVerifyHook = (input: MigrationHookInput) => { valid: boolean; reason?: string };
