import type { ModuleSettingsTab, UIModuleManifest } from '@shared/sdk';

const MAX_TABS = 8;
const TAB_ID = /^[a-z][a-z0-9_-]{0,63}$/;

/** Bounded host validation, including manifests loaded from managed ESM. */
export function resolveSettingsTabs(manifest: UIModuleManifest): { tabs: ModuleSettingsTab[]; rejected: number } {
    const raw = manifest.settingsTabs;
    if (raw === undefined) return { tabs: [], rejected: 0 };
    if (!Array.isArray(raw)) return { tabs: [], rejected: 1 };
    const tabs: ModuleSettingsTab[] = [];
    const seen = new Set<string>();
    let rejected = Math.max(0, raw.length - MAX_TABS);
    for (const candidate of raw.slice(0, MAX_TABS) as unknown[]) {
        if (!candidate || typeof candidate !== 'object') { rejected++; continue; }
        const row = candidate as Record<string, unknown>;
        const label = typeof row.label === 'string' ? row.label.trim() : '';
        if (typeof row.id !== 'string' || !TAB_ID.test(row.id) || seen.has(row.id)
            || !label || label.length > 80 || typeof row.load !== 'function'
            || (row.audience !== undefined && row.audience !== 'all' && row.audience !== 'gm')) {
            rejected++;
            continue;
        }
        seen.add(row.id);
        tabs.push({ id: row.id, label, audience: row.audience as ModuleSettingsTab['audience'], load: row.load as ModuleSettingsTab['load'] });
    }
    return { tabs, rejected };
}

export function eligibleSettingsTabs(tabs: ModuleSettingsTab[], role: number): ModuleSettingsTab[] {
    return tabs.filter(tab => tab.audience !== 'gm' || role >= 3);
}
