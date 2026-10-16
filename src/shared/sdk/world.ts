/** JSON-only native world-setting contract. Client preferences are a separate API. */
export interface WorldValueSchema {
    type: 'boolean' | 'number' | 'string' | 'object' | 'array' | 'null';
    nullable?: boolean;
    enum?: unknown[];
    minimum?: number;
    maximum?: number;
    maxLength?: number;
}
export interface WorldSettingDeclaration {
    key: string;
    scope: 'world';
    systemVersion: string;
    schema: WorldValueSchema;
    default?: { value: unknown; source: string; systemVersion: string };
    affectsPreparation: boolean;
    exposure: 'server' | 'authenticated' | 'gm';
}
export type WorldSettingResult =
    | { status: 'world' | 'registered-default'; value: unknown }
    | { status: 'unavailable'; reason: 'not-ready' | 'undeclared' | 'unsupported-version' | 'invalid-value' | 'unknown-default' };
export interface ModuleWorldIdentity {
    instanceId: string;
    worldId: string;
    systemId: string;
    systemVersion: string;
    foundryGeneration: number;
    foundryBuild: string;
    runtimeEpoch: number;
    contextRevision: number;
}
export interface ModuleWorldSnapshot {
    identity: Readonly<ModuleWorldIdentity>;
    settings: Readonly<Record<string, WorldSettingResult>>;
}
export interface ModuleWorldContext {
    snapshot(): Readonly<ModuleWorldSnapshot>;
    settings: { get(key: string): Readonly<WorldSettingResult> };
    /** Fence an action/dialog against changed rule inputs. */
    assertRevision(revision: number): void;
}

export function isWorldValue(value: unknown, schema: WorldValueSchema): boolean {
    if (schema.enum && !schema.enum.some(entry => JSON.stringify(entry) === JSON.stringify(value))) return false;
    if (value === null) return schema.type === 'null' || schema.nullable === true;
    if (schema.type === 'array' ? !Array.isArray(value)
        : schema.type === 'object' ? typeof value !== 'object' || Array.isArray(value)
            : typeof value !== schema.type) return false;
    if (typeof value === 'number' && (!Number.isFinite(value)
        || (schema.minimum !== undefined && value < schema.minimum)
        || (schema.maximum !== undefined && value > schema.maximum))) return false;
    if (typeof value === 'string' && schema.maxLength !== undefined && value.length > schema.maxLength) return false;
    try { return JSON.stringify(value).length <= 65_536; } catch { return false; }
}

export function validateWorldSettings(value: unknown, systemIds: string[]): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 64) return ['worldSettings must be a bounded array'];
    const keys = new Set<string>();
    const errors: string[] = [];
    const range = (input: unknown) => typeof input === 'string' && /^(?:(?:>=|<=|>|<|=)?\d+\.\d+\.\d+\s*)+$/.test(input);
    for (const row of value as WorldSettingDeclaration[]) {
        if (!row || typeof row.key !== 'string' || !/^[a-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(row.key)
            || !systemIds.includes(row.key.split('.')[0]) || keys.has(row.key)) {
            errors.push('worldSettings requires unique exact native-system keys'); continue;
        }
        keys.add(row.key);
        if (row.scope !== 'world' || !range(row.systemVersion)
            || !row.schema || !['boolean', 'number', 'string', 'object', 'array', 'null'].includes(row.schema.type)
            || typeof row.affectsPreparation !== 'boolean' || !['server', 'authenticated', 'gm'].includes(row.exposure)
            || row.schema.minimum !== undefined && !Number.isFinite(row.schema.minimum)
            || row.schema.maximum !== undefined && !Number.isFinite(row.schema.maximum)
            || row.schema.maxLength !== undefined && (!Number.isSafeInteger(row.schema.maxLength) || row.schema.maxLength < 0)
            || row.schema.enum !== undefined && (!Array.isArray(row.schema.enum) || row.schema.enum.length > 100)) {
            errors.push(`Invalid world setting declaration: ${row.key}`); continue;
        }
        if (row.default && (typeof row.default.source !== 'string' || !row.default.source.trim() || !range(row.default.systemVersion)
            || !isWorldValue(row.default.value, row.schema))) errors.push(`Invalid proven default: ${row.key}`);
    }
    return errors;
}

export function freezeWorldValue<T>(value: T): Readonly<T> {
    if (value && typeof value === 'object') {
        for (const child of Object.values(value)) freezeWorldValue(child);
        Object.freeze(value);
    }
    return value;
}
