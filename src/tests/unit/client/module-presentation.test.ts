import assert from 'node:assert/strict';
import { applyModulePresentation } from '../../../client/ui/context/modulePresentation';
import type { AppSystemInfo } from '../../../shared/interfaces';
import type { UIModuleManifest } from '../../../shared/sdk';

export function run() {
    const source: AppSystemInfo = {
        id: 'test', config: { other: true, componentStyles: { chat: { container: 'old' } } },
    };
    const styles = { chat: { msgContainer: (roll: boolean) => roll ? 'roll' : 'text' } };
    const manifest: UIModuleManifest = {
        info: { id: 'test', title: 'Test', version: '1', manifest: { ui: 'module/ui', logic: 'module/logic' } },
        sheet: async () => ({ default: null }), componentStyles: styles,
    };
    const result = applyModulePresentation(source, manifest)!;
    assert.equal(result.config.componentStyles.chat.msgContainer(true), 'roll');
    assert.equal(result.componentStyles?.chat?.msgContainer?.(false), 'text');
    assert.equal(result.config.other, true);
    assert.equal(source.config.componentStyles.chat.container, 'old', 'Wire state stays unchanged');
    assert.equal(applyModulePresentation(source, null), source, 'Old manifests keep their fallback');
    assert.equal(applyModulePresentation(null, manifest), null);
    assert.equal(applyModulePresentation(source, { ...manifest, info: { ...manifest.info, id: 'other' } }), source,
        'A retiring module must not theme the next world');
    assert.equal(applyModulePresentation(source, { ...manifest, componentStyles: undefined }), source);
    console.log('Module presentation tests passed');
}

if (import.meta.url === `file://${process.argv[1]}`) run();
