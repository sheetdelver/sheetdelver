import { settingStore } from '@server/core/documents/primary/settings/SettingStore';

/** Native authority/pack configuration plus the module's declared rule inputs.
 * Unrelated clocks and UI preferences are not migration source dependencies. */
export function migrationSettingsRevision(keys: readonly string[]): string {
    return settingStore.getWorldKeysRevision(['core.permissions', 'core.compendiumConfiguration', ...keys]);
}
