import fs from 'node:fs';
import path from 'node:path';
import { getModulesDataDir } from '@core/paths';
import { LegacyModuleSourceCategory, ModuleLifecycleStatus, ModuleSourceCategory } from '@shared/types/modules';
import type { ModuleContractDiagnostic, ModuleCoreConstraintDiagnostic } from './compatibilityResolver';
import { parseModuleId, requireModuleId } from '@shared/security/moduleId';

export type { ModuleLifecycleStatus };

/** Admin-visible packaged-artifact diagnostic from the managed install audit. */
export interface ModuleArtifactHealthDiagnostic {
    code: string;
    message: string;
    severity: 'warning' | 'error';
}

/**
 * Validation is stored both on the active lifecycle record and per source.
 * Artifact diagnostics live here so the admin can compare local vs managed state.
 */
export interface ModuleLifecycleValidation {
    manifestValid: boolean;
    validationErrors?: string[];
    compatible: boolean;
    coreVersion: string;
    requiredCoreVersion?: string;
    requiredApiContracts?: Record<string, string>;
    providedApiContracts?: Record<string, string>;
    coreDiagnostics?: ModuleCoreConstraintDiagnostic[];
    contractDiagnostics?: ModuleContractDiagnostic[];
    /** Warning-only drift stays loadable; error diagnostics block enable/switch. */
    artifactDiagnostics?: ModuleArtifactHealthDiagnostic[];
}

export interface ModuleSourceState {
    status: ModuleLifecycleStatus;
    enabled: boolean;
    reason?: string;
    validation?: ModuleLifecycleValidation;
    health?: {
        errorCount: number;
        lastError: string;
        lastErrorAt: number;
    };
}

export interface ModuleLifecycleRecord {
    moduleId: string;
    title: string;
    directory: string;
    /** Which source is currently active: ModuleSourceCategory.Managed = managed install, ModuleSourceCategory.Local = dev source. */
    activeSource?: ModuleSourceCategory;
    /** Path to the local dev version, if one exists alongside a managed install. */
    localDirectory?: string;
    /** Persisted enabled state for each source — preserved when switching between them. */
    localEnabled?: boolean;
    managedEnabled?: boolean;
    status: ModuleLifecycleStatus;
    enabled: boolean;
    trust?: { tier: string };
    reason?: string;
    validation?: ModuleLifecycleValidation;
    health?: {
        errorCount: number;
        lastError: string;
        lastErrorAt: number;
    };
    sourceStates?: Partial<Record<ModuleSourceCategory, ModuleSourceState>>;
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
    return parseModuleId(record.moduleId) !== null
        && typeof record.title === 'string'
        && typeof record.directory === 'string'
        && isValidStatus(record.status)
        && typeof record.enabled === 'boolean'
        && (record.trust === undefined || (typeof record.trust === 'object' && typeof record.trust.tier === 'string'))
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

function normalizeSourceCategory(value: unknown): ModuleSourceCategory | undefined {
    if (value === ModuleSourceCategory.Local) return ModuleSourceCategory.Local;
    if (value === ModuleSourceCategory.Managed || value === LegacyModuleSourceCategory.ManagedData) {
        return ModuleSourceCategory.Managed;
    }
    // "built-in" was an old registry source that no longer maps to a runtime module location.
    return undefined;
}

function normalizeSourceStates(
    sourceStates: ModuleLifecycleRecord['sourceStates'] | Record<string, ModuleSourceState> | undefined,
): ModuleLifecycleRecord['sourceStates'] | undefined {
    if (!sourceStates) return undefined;

    const normalized: Partial<Record<ModuleSourceCategory, ModuleSourceState>> = {};
    const localState = sourceStates[ModuleSourceCategory.Local];
    const managedState = sourceStates[ModuleSourceCategory.Managed]
        ?? (sourceStates as Record<string, ModuleSourceState | undefined>)[LegacyModuleSourceCategory.ManagedData];

    if (localState) normalized[ModuleSourceCategory.Local] = localState;
    if (managedState) normalized[ModuleSourceCategory.Managed] = managedState;

    return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeLifecycleRecord(record: ModuleLifecycleRecord): ModuleLifecycleRecord {
    return {
        ...record,
        activeSource: normalizeSourceCategory(record.activeSource),
        sourceStates: normalizeSourceStates(record.sourceStates),
    };
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
    artifactDiagnostics?: ModuleArtifactHealthDiagnostic[];
    activeSource?: ModuleSourceCategory;
    clearHealth?: boolean;
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
            const canonicalKey = parseModuleId(id);
            const canonicalRecordId = isValidRecord(record) ? parseModuleId(record.moduleId) : null;
            if (canonicalKey && canonicalRecordId && canonicalKey === canonicalRecordId) {
                modules[canonicalKey] = normalizeLifecycleRecord({ ...record, moduleId: canonicalRecordId });
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
    const moduleId = requireModuleId(discovered.moduleId);
    const existing = store.modules[moduleId];

    if (existing) {
        const next: ModuleLifecycleRecord = {
            ...existing,
            title: discovered.title,
            directory: discovered.directory,
            lastSeenAt: now,
            updatedAt: now
        };
        store.modules[moduleId] = next;
        return next;
    }

    const created: ModuleLifecycleRecord = {
        moduleId,
        title: discovered.title,
        directory: discovered.directory,
        status: ModuleLifecycleStatus.Discovered,
        enabled: true,
        firstSeenAt: now,
        lastSeenAt: now,
        updatedAt: now
    };

    store.modules[moduleId] = created;
    return created;
}

export { ModuleSourceCategory };

export function applyLifecycleClassification(
    store: ModuleLifecycleStore,
    moduleId: string,
    source: ModuleSourceCategory,
    classification: ModuleLifecycleClassificationInput,
    now = Date.now()
): ModuleLifecycleRecord | null {
    const id = parseModuleId(moduleId);
    if (!id) return null;
    const existing = store.modules[id];
    if (!existing) return null;

    const sourceStates = existing.sourceStates || {};
    const existingSourceState = sourceStates[source] || ({} as Partial<ModuleSourceState>);
    
    const newSourceState: ModuleSourceState = {
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
            artifactDiagnostics: classification.artifactDiagnostics,
        },
        health: classification.clearHealth ? undefined : existingSourceState.health
    };

    const nextSourceStates = {
        ...sourceStates,
        [source]: newSourceState
    };

    const next: ModuleLifecycleRecord = {
        ...existing,
        sourceStates: nextSourceStates,
        updatedAt: now
    };

    const activeSource = classification.activeSource ?? existing.activeSource;
    next.activeSource = activeSource;
    
    if (source === activeSource) {
        next.status = classification.status;
        next.enabled = classification.enabled;
        next.reason = classification.reason;
        next.validation = newSourceState.validation;
        if (classification.clearHealth) {
            next.health = undefined;
        }
    }

    store.modules[id] = next;
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
    const id = parseModuleId(moduleId);
    if (!id) return null;
    const existing = store.modules[id];
    if (!existing) return null;

    const previousErrorCount = existing.health?.errorCount || 0;
    const newHealth = {
        errorCount: previousErrorCount + 1,
        lastError: errorMessage,
        lastErrorAt: now,
    };

    const next: ModuleLifecycleRecord = {
        ...existing,
        status: 'errored',
        enabled: false,
        reason: `Runtime failure: ${errorMessage}`,
        health: newHealth,
        updatedAt: now,
    };

    if (existing.activeSource) {
        const sourceStates = next.sourceStates || {};
        const existingSourceState = sourceStates[existing.activeSource] || {
            status: 'errored',
            enabled: false,
        };
        next.sourceStates = {
            ...sourceStates,
            [existing.activeSource]: {
                ...existingSourceState,
                status: 'errored',
                enabled: false,
                reason: `Runtime failure: ${errorMessage}`,
                health: newHealth
            }
        };
    }

    store.modules[id] = next;
    return next;
}
