import type { ModuleSettingDeclaration } from './interfaces';

export interface ModuleSettingsSnapshot {
    values: Record<string, unknown>;
    error: Error | null;
}

export function validSettingValue(declaration: ModuleSettingDeclaration, value: unknown): boolean {
    switch (declaration.type) {
        case 'boolean': return typeof value === 'boolean';
        case 'number': return typeof value === 'number' && Number.isFinite(value)
            && (declaration.min === undefined || value >= declaration.min)
            && (declaration.max === undefined || value <= declaration.max);
        case 'string': return typeof value === 'string'
            && (declaration.minLength === undefined || value.length >= declaration.minLength)
            && (declaration.maxLength === undefined || value.length <= declaration.maxLength);
        case 'select': return typeof value === 'string' && Boolean(declaration.options?.some(option => option.value === value));
        default: return false;
    }
}

/** Invalid persisted overrides fall back without rewriting storage. Unknown legacy keys survive. */
export function moduleSettingsValues(values: Record<string, unknown>, schema?: ModuleSettingDeclaration[]): Record<string, unknown> {
    const result = { ...values };
    for (const declaration of schema ?? []) {
        if (Object.hasOwn(values, declaration.key) && validSettingValue(declaration, values[declaration.key])) continue;
        delete result[declaration.key];
        if (declaration.default !== undefined && validSettingValue(declaration, declaration.default)) {
            Object.defineProperty(result, declaration.key, { value: declaration.default, enumerable: true, configurable: true, writable: true });
        }
    }
    return result;
}

/** Internal store, independent of React so storage faults can be tested deterministically. */
export function createModuleSettingsStore(ns: string, storage: () => Storage | undefined) {
    let snapshot: ModuleSettingsSnapshot = { values: {}, error: null };
    const listeners = new Set<() => void>();
    const publish = (values: Record<string, unknown>, error: Error | null) => {
        snapshot = { values, error };
        listeners.forEach(listener => listener());
    };
    const failure = (error: unknown) => error instanceof Error ? error : new Error('Browser settings storage is unavailable.');
    const read = () => {
        try {
            const target = storage();
            const values: Record<string, unknown> = Object.create(null);
            if (target) {
                const prefix = `${ns}:`;
                for (let i = 0; i < target.length; i++) {
                    const key = target.key(i);
                    if (!key?.startsWith(prefix)) continue;
                    const raw = target.getItem(key);
                    if (raw === null) continue;
                    try { values[key.slice(prefix.length)] = JSON.parse(raw); } catch { /* Invalid JSON is an invalid override. */ }
                }
            }
            if (snapshot.error || JSON.stringify(values) !== JSON.stringify(snapshot.values)) publish(values, null);
        } catch (error) { publish(snapshot.values, failure(error)); }
    };
    const writableStorage = () => {
        // Recover a failed initial read before modifying its incomplete snapshot.
        if (snapshot.error) { read(); if (snapshot.error) throw snapshot.error; }
        const target = storage();
        if (!target) throw new Error('Browser settings storage is unavailable.');
        return target;
    };
    const set = (key: string, value: unknown, schema?: ModuleSettingDeclaration[]) => {
        if (schema) {
            const declaration = schema.find(row => row.key === key);
            if (!declaration || !validSettingValue(declaration, value)) throw new Error(`Invalid module setting: ${key}`);
        }
        try {
            const encoded = JSON.stringify(value);
            if (encoded === undefined) throw new Error(`Module setting cannot be stored: ${key}`);
            writableStorage().setItem(`${ns}:${key}`, encoded);
            // Publish exactly the JSON value which survived persistence.
            publish({ ...snapshot.values, [key]: JSON.parse(encoded) }, null);
        } catch (error) { publish(snapshot.values, failure(error)); throw snapshot.error; }
    };
    const reset = (keys: readonly string[] | undefined, schema?: ModuleSettingDeclaration[]) => {
        if (!schema) throw new Error('Reset requires a module settings schema.');
        const declared = new Set(schema.map(row => row.key));
        const selected = keys ?? [...declared];
        if (selected.some(key => !declared.has(key))) throw new Error('Reset keys must belong to the module settings schema.');
        let remaining = snapshot.values;
        try {
            const target = writableStorage();
            remaining = { ...snapshot.values };
            for (const key of new Set(selected)) {
                target.removeItem(`${ns}:${key}`);
                delete remaining[key];
            }
            publish(remaining, null);
        } catch (error) {
            // Successful removals are real even if a subsequent removal failed.
            publish(remaining, failure(error));
            throw snapshot.error;
        }
    };
    read();
    return { getSnapshot: () => snapshot, read, set, reset,
        subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
}

