import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MigrationSourceStatus } from '../../../app/(admin)/components/MigrationAttentionNotice';
import type { AdminMigrationStatus } from '../../../shared/types/adminMigration';
export function run() {
    const status: AdminMigrationStatus = {
        moduleId: 'fixture', title: 'Fixture', source: 'managed', version: '1.0.0', selectedSource: true, activeWorld: true,
        world: { worldId: 'w', title: 'World', systemId: 'fixture', systemVersion: '4.1.2', foundryGeneration: 14 },
        state: 'blocked', label: 'Migration check blocked', reason: 'Native system 4.1.2 exceeds the old declaration.',
        nextStep: 'Install an updated module, then retry world preparation. <script> must remain text.',
        scopeKey: 'scope', catalogDeclared: true, action: { kind: 'none', label: '', href: null },
    };
    const html = renderToStaticMarkup(createElement(MigrationSourceStatus, { status, collapsible: false }));
    assert.match(html, /How to resolve:/);
    assert.match(html, /Install an updated module, then retry world preparation/);
    assert.match(html, /Native system: fixture 4.1.2.*Foundry 14/);
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(renderToStaticMarkup(createElement(MigrationSourceStatus, { status: { ...status, nextStep: undefined } })), /How to resolve:/);
    console.log('Migration recovery rendering passed');
}
