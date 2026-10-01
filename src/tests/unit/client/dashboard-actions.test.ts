import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DashboardActionSection } from '@client/ui/components/DashboardActionSection';
import { dashboardToolHref, resolveDashboardActions } from '@client/ui/components/dashboardActions';
import type { ModuleDashboardAction, UIModuleManifest } from '@shared/sdk';

const tool = async () => ({ default: () => null });
const dialog = async () => ({ default: (_props: { onClose: () => void }) => null });

function manifest(dashboardActions?: ModuleDashboardAction[]): UIModuleManifest {
    return {
        info: { id: 'test-system', title: 'Test System', manifest: { ui: 'module/ui', logic: 'module/logic' } },
        sheet: tool,
        tools: { generator: tool },
        ...(dashboardActions === undefined ? {} : { dashboardActions }),
    };
}

export function run() {
    const actions: ModuleDashboardAction[] = [
        { id: 'generate', label: ' Generate Character ', description: ' Open the generator ', kind: 'tool', toolId: 'generator' },
        { id: 'import', label: 'Import Character', kind: 'dialog', dialog },
    ];
    const resolved = resolveDashboardActions(manifest(actions));
    assert.equal(resolved.rejected, 0);
    assert.deepEqual(resolved.actions.map(row => row.id), ['generate', 'import']);
    assert.equal(resolved.actions[0].label, 'Generate Character');
    assert.equal(resolved.actions[0].description, 'Open the generator');
    assert.equal(resolveDashboardActions(manifest()).actions.length, 0);
    assert.equal(resolveDashboardActions(manifest([])).actions.length, 0);
    assert.equal(resolveDashboardActions({ ...manifest(), dashboardActions: null as never }).rejected, 1);

    const invalid = resolveDashboardActions(manifest([
        actions[0],
        { ...actions[0], label: 'Duplicate' },
        { id: 'missing', label: 'Missing route', kind: 'tool', toolId: 'missing' },
        { id: 'constructor', label: 'Inherited route', kind: 'tool', toolId: 'constructor' },
        { id: 'bad/path', label: 'Unsafe', kind: 'dialog', dialog },
        { id: 'wrong', label: 'Bad dialog', kind: 'dialog', dialog: null as never },
    ]));
    assert.deepEqual(invalid.actions.map(row => row.id), ['generate']);
    assert.equal(invalid.rejected, 5);
    assert.equal(resolveDashboardActions(manifest(Array.from({ length: 13 }, (_, index) => ({
        id: `tool${index}`, label: `Tool ${index}`, kind: 'tool' as const, toolId: 'generator',
    })))).rejected, 1);

    assert.equal(dashboardToolHref('test-system', 'generator'), '/tools/test-system/generator');
    assert.equal(dashboardToolHref('a b', 'tool'), '/tools/a%20b/tool');
    const html = renderToStaticMarkup(createElement(DashboardActionSection, {
        systemId: 'test-system', actions: resolved.actions, onOpenDialog: () => {},
    }));
    assert.match(html, /sd-ui-panel-raised/);
    assert.match(html, /sd-ui-accent/);
    assert.match(html, /\/tools\/test-system\/generator/);
    assert.match(html, /aria-haspopup="dialog"/);
    assert.doesNotMatch(html, /sdk-module--/);
    console.log('Dashboard action contract tests passed');
}

if (import.meta.url === `file://${process.argv[1]}`) run();
