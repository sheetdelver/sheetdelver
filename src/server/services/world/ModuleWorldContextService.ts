import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { settingStore, type SettingStore } from '@server/core/documents/primary/settings/SettingStore';
import { freezeWorldValue, isWorldValue, validateWorldSettings, type ModuleWorldContext, type ModuleWorldSnapshot,
    type ModuleWorldIdentity, type WorldSettingDeclaration, type WorldSettingResult } from '@shared/sdk/world';
import { resolveModuleCompatibility } from '@modules/registry/lifecycle/compatibilityResolver';

export function versionMatches(version: string, range: string): boolean {
    return resolveModuleCompatibility({ coreVersion: version, requiredCoreVersion: range, providedApiContracts: {} }).compatible;
}

/** Cloned immutable snapshots, never raw Setting rows. Epoch handles retire on configure/clear. */
export class ModuleWorldContextService extends EventEmitter {
    private declarations: WorldSettingDeclaration[] = [];
    private current: Readonly<ModuleWorldSnapshot> | null = null;
    private epoch = 0;
    private revision = 0;
    constructor(private readonly store: SettingStore = settingStore) { super(); }
    configure(instanceUrl: string, identity: Omit<ModuleWorldIdentity, 'instanceId' | 'contextRevision'>,
        declarations: WorldSettingDeclaration[] = []): void {
        const errors = validateWorldSettings(declarations, [identity.systemId]);
        if (errors.length) throw new Error(errors.join('; '));
        if (!this.current || this.current.identity.worldId !== identity.worldId
            || this.current.identity.systemId !== identity.systemId || this.current.identity.runtimeEpoch !== identity.runtimeEpoch) this.epoch += 1;
        this.declarations = structuredClone(declarations);
        this.current = freezeWorldValue({ identity: { ...identity,
            instanceId: createHash('sha256').update(new URL(instanceUrl).origin + new URL(instanceUrl).pathname).digest('hex'),
            contextRevision: ++this.revision }, settings: this.resolve(identity.systemVersion) });
    }
    clear(): void { this.epoch += 1; this.current = null; this.declarations = []; }
    touchDependencies(): void {
        if (!this.current) throw new Error('World context unavailable');
        this.current = freezeWorldValue({ ...this.current, identity: { ...this.current.identity, contextRevision: ++this.revision } });
    }
    markUnavailable(): void {
        if (!this.current) return;
        this.current = freezeWorldValue({ identity: { ...this.current.identity, contextRevision: ++this.revision },
            settings: Object.fromEntries(this.declarations.map(row => [row.key, { status: 'unavailable' as const, reason: 'not-ready' as const }])) });
    }
    refresh(): { changedKeys: string[]; affectsPreparation: boolean } {
        if (!this.current) throw new Error('World context unavailable');
        const settings = this.resolve(this.current.identity.systemVersion);
        const changedKeys = Object.keys(settings).filter(key => JSON.stringify(settings[key]) !== JSON.stringify(this.current!.settings[key]));
        if (changedKeys.length) {
            this.current = freezeWorldValue({ identity: { ...this.current.identity, contextRevision: ++this.revision }, settings });
        }
        return { changedKeys, affectsPreparation: this.declarations.some(row => row.affectsPreparation && changedKeys.includes(row.key)) };
    }
    snapshot(): Readonly<ModuleWorldSnapshot> {
        if (!this.current) throw new Error('World context unavailable');
        return this.current;
    }
    handle(): ModuleWorldContext {
        const epoch = this.epoch;
        const snapshot = () => {
            if (epoch !== this.epoch) throw new Error('World context retired');
            return this.snapshot();
        };
        return Object.freeze({ snapshot, settings: Object.freeze({ get: (key: string) => snapshot().settings[key]
            ?? Object.freeze({ status: 'unavailable' as const, reason: 'undeclared' as const }) }),
        assertRevision: (revision: number) => {
            if (snapshot().identity.contextRevision !== revision) throw new Error('World context changed; refresh this action');
        } });
    }
    project(role: number): Readonly<ModuleWorldSnapshot> {
        const snapshot = this.snapshot();
        const settings = Object.fromEntries(this.declarations.filter(row => row.exposure === 'authenticated'
            || row.exposure === 'gm' && role >= 3).map(row => [row.key, snapshot.settings[row.key]]));
        return freezeWorldValue({ identity: { ...snapshot.identity }, settings: structuredClone(settings) });
    }
    publish(changedKeys: string[]): void { this.emit('changed', { revision: this.snapshot().identity.contextRevision,
        keys: this.declarations.filter(row => row.exposure !== 'server' && changedKeys.includes(row.key))
            .map(row => ({ key: row.key, exposure: row.exposure })) }); }
    private resolve(version: string): Record<string, WorldSettingResult> {
        return Object.fromEntries(this.declarations.map(row => {
            let result: WorldSettingResult;
            if (!this.store.isReady()) result = { status: 'unavailable', reason: 'not-ready' };
            else if (!versionMatches(version, row.systemVersion)) result = { status: 'unavailable', reason: 'unsupported-version' };
            else if (this.store.hasWorldKey(row.key)) {
                const value = this.store.getValueByKey(row.key);
                result = isWorldValue(value, row.schema) ? { status: 'world', value: structuredClone(value) }
                    : { status: 'unavailable', reason: 'invalid-value' };
            } else result = row.default && versionMatches(version, row.default.systemVersion)
                ? { status: 'registered-default', value: structuredClone(row.default.value) }
                : { status: 'unavailable', reason: 'unknown-default' };
            return [row.key, result];
        }));
    }
}
export const moduleWorldContext = new ModuleWorldContextService();
