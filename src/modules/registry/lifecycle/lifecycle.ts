import fs from 'node:fs';
import path from 'node:path';
import { getModulesDataDir } from '@core/paths';
import type { ModuleContractDiagnostic, ModuleCoreConstraintDiagnostic } from './compatibilityResolver';

export type ModuleLifecycleStatus =
    | 'discovered'
    | 'installed'
    | 'validated'
    | 'enabled'
    | 'disabled'
    | 'incompatible'
    | 'errored'
    | 'upgrading'
    | 'uninstalling'
    | 'removed';

export interface ModuleLifecycleRecord {
    moduleId: string;
    title: string;
    directory: string;
    status: ModuleLifecycleStatus;
    enabled: boolean;
    reason?: string;
    validation?: {
        manifestValid: boolean;
        validationErrors?: string[];
        compatible: boolean;
        coreVersion: string;
        requiredCoreVersion?: string;
        requiredApiContracts?: Record<string, string>;
        providedApiContracts?: Record<string, string>;
        coreDiagnostics?: ModuleCoreConstraintDiagnostic[];
        contractDiagnostics?: ModuleContractDiagnostic[];
    };
    health?: {
        errorCount: number;
        lastError: string;
        lastErrorAt: number;
    };
    firstSeenAt: number;
    lastSeenAt: number;
    updatedAt: number;
}

export interface ModuleLifecycleStore {
    version: 1;
    modules: Record<string, ModuleLifecycleRecord>;
}

export interface DiscoveredModuleInput {
    moduleId: string;
    title: string;
    directory: string;
}

export function createEmptyLifecycleStore(): ModuleLifecycleStore {
    return {
        version: 1,
        modules: {}
    };
}

export function getDefaultLifecycleStateFilePath(): string {
    return path.join(getModulesDataDir(), 'state.json');
}

function isValidStatus(value: unknown): value is ModuleLifecycleStatus {
    return value === 'discovered'
    || value === 'installed'
        || value === 'validated'
        || value === 'enabled'
        || value === 'disabled'
        || value === 'incompatible'
    || value === 'errored'
    || value === 'upgrading'
    || value === 'uninstalling'
    || value === 'removed';
}

function isValidRecord(value: unknown): value is ModuleLifecycleRecord {
    if (!value || typeof value !== 'object') return false;

    const record = value as Partial<ModuleLifecycleRecord>;
    return typeof record.moduleId === 'string'
        && typeof record.title === 'string'
        && typeof record.directory === 'string'
        && isValidStatus(record.status)
        && typeof record.enabled === 'boolean'
        && (
            record.health === undefined
            || (
                typeof record.health === 'object'
                && record.health !== null
                && typeof record.health.errorCount === 'number'
                && typeof record.health.lastError === 'string'
                && typeof record.health.lastErrorAt === 'number'
            )
        )
        && typeof record.firstSeenAt === 'number'
        && typeof record.lastSeenAt === 'number'
        && typeof record.updatedAt === 'number';
}

export interface ModuleLifecycleClassificationInput {
    status: ModuleLifecycleStatus;
    enabled: boolean;
    reason?: string;
    manifestValid: boolean;
    validationErrors?: string[];
    compatible: boolean;
    coreVersion: string;
    requiredCoreVersion?: string;
    requiredApiContracts?: Record<string, string>;
    providedApiContracts?: Record<string, string>;
    coreDiagnostics?: ModuleCoreConstraintDiagnostic[];
    contractDiagnostics?: ModuleContractDiagnostic[];
}

export function loadLifecycleStore(stateFilePath = getDefaultLifecycleStateFilePath()): ModuleLifecycleStore {
    if (!fs.existsSync(stateFilePath)) {
        return createEmptyLifecycleStore();
    }

    try {
        const raw = fs.readFileSync(stateFilePath, 'utf8');
        const parsed = JSON.parse(raw) as Partial<ModuleLifecycleStore>;

        if (parsed.version !== 1 || !parsed.modules || typeof parsed.modules !== 'object') {
            return createEmptyLifecycleStore();
        }

        const modules: Record<string, ModuleLifecycleRecord> = {};
        for (const [id, record] of Object.entries(parsed.modules)) {
            if (isValidRecord(record)) {
                modules[id] = record;
            }
        }

        return {
            version: 1,
            modules
        };
    } catch {
        return createEmptyLifecycleStore();
    }
}

export function saveLifecycleStore(
    store: ModuleLifecycleStore,
    stateFilePath = getDefaultLifecycleStateFilePath()
): void {
    const dir = path.dirname(stateFilePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(stateFilePath, JSON.stringify(store, null, 2), 'utf8');
}

export function upsertDiscoveredModule(
    store: ModuleLifecycleStore,
    discovered: DiscoveredModuleInput,
    now = Date.now()
): ModuleLifecycleRecord {
    const existing = store.modules[discovered.moduleId];

    if (existing) {
        const next: ModuleLifecycleRecord = {
            ...existing,
            title: discovered.title,
            directory: discovered.directory,
            lastSeenAt: now,
            updatedAt: now
        };
        store.modules[discovered.moduleId] = next;
        return next;
    }

    const created: ModuleLifecycleRecord = {
        moduleId: discovered.moduleId,
        title: discovered.title,
        directory: discovered.directory,
        status: 'discovered',
        enabled: true,
        firstSeenAt: now,
        lastSeenAt: now,
        updatedAt: now
    };

    store.modules[discovered.moduleId] = created;
    return created;
}

export function applyLifecycleClassification(
    store: ModuleLifecycleStore,
    moduleId: string,
    classification: ModuleLifecycleClassificationInput,
    now = Date.now()
): ModuleLifecycleRecord | null {
    const existing = store.modules[moduleId];
    if (!existing) return null;

    const next: ModuleLifecycleRecord = {
        ...existing,
        status: classification.status,
        enabled: classification.enabled,
        reason: classification.reason,
        validation: {
            manifestValid: classification.manifestValid,
            validationErrors: classification.validationErrors,
            compatible: classification.compatible,
            coreVersion: classification.coreVersion,
            requiredCoreVersion: classification.requiredCoreVersion,
            requiredApiContracts: classification.requiredApiContracts,
            providedApiContracts: classification.providedApiContracts,
            coreDiagnostics: classification.coreDiagnostics,
            contractDiagnostics: classification.contractDiagnostics,
        },
        updatedAt: now
    };

    store.modules[moduleId] = next;
    return next;
}

export function getLifecycleRecords(store: ModuleLifecycleStore): ModuleLifecycleRecord[] {
    return Object.values(store.modules).sort((a, b) => a.moduleId.localeCompare(b.moduleId));
}

export function recordLifecycleRuntimeFailure(
    store: ModuleLifecycleStore,
    moduleId: string,
    errorMessage: string,
    now = Date.now()
): ModuleLifecycleRecord | null {
    const id = moduleId.toLowerCase();
    const existing = store.modules[id];
    if (!existing) return null;

    const previousErrorCount = existing.health?.errorCount || 0;
    const next: ModuleLifecycleRecord = {
        ...existing,
        status: 'errored',
        enabled: false,
        reason: `Runtime failure: ${errorMessage}`,
        health: {
            errorCount: previousErrorCount + 1,
            lastError: errorMessage,
            lastErrorAt: now,
        },
        updatedAt: now,
    };

    store.modules[id] = next;
    return next;
}
