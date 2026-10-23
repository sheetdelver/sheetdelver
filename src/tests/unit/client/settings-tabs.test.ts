import assert from 'node:assert/strict';
import { eligibleSettingsTabs, resolveSettingsTabs } from '@client/ui/components/Settings/settingsTabs';
import { createModuleSettingsStore, moduleSettingsValues } from '@shared/sdk/module-settings-store';
import type { ModuleSettingDeclaration, ModuleSettingsTab, UIModuleManifest } from '@shared/sdk';

const load: ModuleSettingsTab['load'] = async () => ({ default: () => null });
const tab: ModuleSettingsTab = { id: 'sheet', label: ' Sheet ', load };
const manifest = (settingsTabs?: ModuleSettingsTab[]): UIModuleManifest => ({
    info: { id: 'test', title: 'Test', manifest: { ui: '', logic: '' } }, sheet: load, settingsTabs,
});

export function run() {
    assert.deepEqual(resolveSettingsTabs(manifest()), { tabs: [], rejected: 0 });
    assert.deepEqual(resolveSettingsTabs(manifest([])), { tabs: [], rejected: 0 });
    assert.equal(resolveSettingsTabs(manifest(null as never)).rejected, 1);
    const resolved = resolveSettingsTabs(manifest([tab, { ...tab, id: 'gm', audience: 'gm' }]));
    assert.equal(resolved.tabs[0].label, 'Sheet');
    assert.deepEqual(eligibleSettingsTabs(resolved.tabs, 2).map(row => row.id), ['sheet']);
    assert.deepEqual(eligibleSettingsTabs(resolved.tabs, 3).map(row => row.id), ['sheet', 'gm']);
    for (const invalid of [null, {}, { ...tab, id: 'A' }, { ...tab, id: ' sheet' }, { ...tab, id: 'x'.repeat(65) },
        { ...tab, id: 'x/y' }, { ...tab, label: ' ' }, { ...tab, label: 'x'.repeat(81) },
        { ...tab, load: 1 }, { ...tab, audience: null }, { ...tab, audience: 'player' }]) {
        assert.equal(resolveSettingsTabs(manifest([invalid as never])).rejected, 1);
    }
    assert.equal(resolveSettingsTabs(manifest([tab, tab])).rejected, 1);
    assert.equal(resolveSettingsTabs(manifest(Array.from({ length: 100 }, (_, i) => ({ ...tab, id: `tab${i}` })))).tabs.length, 8);

    const data = new Map<string, string>();
    let denyRead = false, denyWrite = false, failRemoval: string | null = null;
    const storage: Storage = {
        get length() { if (denyRead) throw Error('read denied'); return data.size; },
        key: i => [...data.keys()][i] ?? null,
        getItem: key => { if (denyRead) throw Error('read denied'); return data.get(key) ?? null; },
        setItem: (key, value) => { if (denyWrite) throw Error('write denied'); data.set(key, value); },
        removeItem: key => { if (failRemoval === key) throw Error('remove denied'); data.delete(key); },
        clear: () => data.clear(),
    };
    const schema: ModuleSettingDeclaration[] = [
        { key: 'enabled', type: 'boolean', default: false },
        { key: 'size', type: 'number', min: 1, max: 5, default: 3 },
        { key: 'name', type: 'string', minLength: 1, maxLength: 8, default: 'Name' },
        { key: 'view', type: 'select', default: 'simple', options: [{ value: 'simple', label: 'Simple' }, { value: 'advanced', label: 'Advanced' }] },
    ];
    const ns = 'sheetdelver:settings:world:module';
    data.set(`${ns}:size`, '"wrong"');
    data.set(`${ns}:view`, '"unknown"');
    data.set(`${ns}:legacy`, '42');
    data.set(`${ns}:broken`, '{');
    data.set('sheetdelver:settings:other:module:enabled', 'true');
    const store = createModuleSettingsStore(ns, () => storage);
    let updates = 0;
    const dispose = store.subscribe(() => { updates++; });
    assert.deepEqual(moduleSettingsValues(store.getSnapshot().values, schema), { legacy: 42, enabled: false, size: 3, name: 'Name', view: 'simple' });
    assert.equal(data.get(`${ns}:size`), '"wrong"', 'reads never migrate invalid storage');
    for (const [key, value] of [['enabled', 1], ['size', Infinity], ['size', NaN], ['size', 0], ['size', 6], ['name', ''], ['name', 'x'.repeat(9)], ['view', 'unknown'], ['unknown', 1]]) {
        assert.throws(() => store.set(String(key), value, schema), /Invalid module setting/);
    }
    store.set('enabled', true, schema);
    assert.equal(updates, 1);
    assert.equal(store.getSnapshot().values.enabled, true);
    denyWrite = true;
    assert.throws(() => store.set('enabled', false, schema), /write denied/);
    assert.equal(store.getSnapshot().values.enabled, true, 'a failed write does not publish its proposed value');
    assert.match(store.getSnapshot().error!.message, /write denied/);
    denyWrite = false;
    store.set('size', 5, schema);
    store.set('view', 'advanced', schema);
    assert.equal(store.getSnapshot().error, null);
    assert.throws(() => store.reset(undefined), /requires/);
    assert.throws(() => store.reset(['legacy'], schema), /schema/);
    assert.throws(() => store.reset(['enabled', 'legacy'], schema), /schema/);
    assert.equal(store.getSnapshot().values.enabled, true, 'validate all reset keys before removing anything');
    store.reset(['view'], schema);
    assert.equal(moduleSettingsValues(store.getSnapshot().values, schema).view, 'simple');
    assert.equal(store.getSnapshot().values.size, 5, 'per-panel reset isolation');
    failRemoval = `${ns}:size`;
    assert.throws(() => store.reset(['enabled', 'size'], schema), /remove denied/);
    assert.equal(store.getSnapshot().values.enabled, undefined, 'publish a successful partial removal');
    assert.equal(store.getSnapshot().values.size, 5, 'preserve overrides which could not be removed');
    assert.equal(data.has(`${ns}:enabled`), false);
    failRemoval = null;
    store.reset(undefined, schema);
    assert.equal(store.getSnapshot().values.legacy, 42);
    assert.equal(data.get('sheetdelver:settings:other:module:enabled'), 'true');
    const otherModule = createModuleSettingsStore('sheetdelver:settings:world:other', () => storage);
    otherModule.set('enabled', true, schema);
    store.reset(undefined, schema);
    assert.equal(otherModule.getSnapshot().values.enabled, true);
    store.set('legacy', { nested: [1] });
    assert.deepEqual(store.getSnapshot().values.legacy, { nested: [1] }, 'schema-less callers remain supported');
    assert.throws(() => store.set('legacy', undefined), /cannot be stored/);
    denyRead = true;
    const denied = createModuleSettingsStore(ns, () => storage);
    assert.match(denied.getSnapshot().error!.message, /read denied/);
    assert.throws(() => denied.set('enabled', true, schema), /read denied/);
    assert.equal(denied.getSnapshot().values.enabled, undefined);
    denyRead = false;
    denied.read();
    assert.equal(denied.getSnapshot().error, null);
    dispose();
    console.log('Settings tabs and browser persistence tests passed');
}

if (import.meta.url === `file://${process.argv[1]}`) run();
