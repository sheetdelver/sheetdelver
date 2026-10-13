import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import RollDialog from '@client/ui/components/RollDialog';
import type { InitiativeRollModalProps } from '@shared/sdk/ui';

export function run() {
    const props: InitiativeRollModalProps = {
        isOpen: true, type: 'initiative', title: 'Roll Initiative',
        combatantName: 'Visible Hero', formula: '1d20+3', source: 'module',
        rollAvailable: true, advantageAvailable: true, manualAvailable: true,
        audience: 'public', onConfirm: () => {}, onClose: () => {},
    };
    const html = renderToStaticMarkup(createElement(RollDialog, props));
    assert.match(html, /role="dialog"/);
    assert.match(html, /1d20\+3/);
    assert.match(html, /System module/);
    assert.match(html, /Roll initiative/);
    assert.match(html, /Advantage/);
    assert.match(html, /Manual total/);
    assert.doesNotMatch(html, /Ability Bonus|Private GM Roll|name="formula"/);
    const noAdvantage = renderToStaticMarkup(createElement(RollDialog, {
        ...props, advantageAvailable: false, audience: 'gm', source: 'gm',
    }));
    assert.match(noAdvantage, /Audience: GMs/);
    assert.doesNotMatch(noAdvantage, />Advantage</);
    console.log('  - InitiativeRollDialog: bounded presentation passed');
}

if (import.meta.url === `file://${process.argv[1]}`) run();
