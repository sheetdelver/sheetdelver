import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import RollDialog from '@client/ui/components/RollDialog';
import type { InitiativeRollModalProps } from '@shared/sdk/ui';
import { applyInitiativeMode } from '@shared/contracts/initiativeMode';
import { insertInitiativeAttribute } from '@client/ui/pages/combatInitiativeDraft';

export function run() {
    const path = 'system.abilities.dex.mod';
    assert.equal(insertInitiativeAttribute('1d20', path).value, `1d20 + @${path}`);
    assert.equal(insertInitiativeAttribute('1d20 + ', path).value, `1d20 + @${path}`);
    const draft = '1d20 + @system.old + 2';
    const inserted = insertInitiativeAttribute(draft, path, { start: 7, end: 18 });
    assert.equal(inserted.value, `1d20 + @${path} + 2`, 'replace the selected reference without duplicate operators');
    assert.equal(inserted.cursor, 8 + path.length);
    assert.equal(insertInitiativeAttribute('1d20', 'derived.initiative.value', { start: 0, end: 0 }).value,
        '@derived.initiative.value + 1d20');
    assert.equal(insertInitiativeAttribute('', path).value, `@${path}`, 'a blank draft does not invent system dice rules');
    assert.throws(() => insertInitiativeAttribute('1d20', 'system.__proto__.value'), /safe numeric/);
    assert.throws(() => insertInitiativeAttribute('1'.repeat(159), path), /160 characters/);
    assert.equal(applyInitiativeMode('2d20kh1+3'), '2d20kh1+3',
        'default execution retains a module-selected d20 rule');
    assert.equal(applyInitiativeMode('2d20kh1+3', 'normal'), '1d20+3');
    assert.equal(applyInitiativeMode('1d20+3', 'advantage'), '2d20kh1+3');
    assert.equal(applyInitiativeMode('1d20+3', 'disadvantage'), '2d20kl1+3');
    assert.equal(applyInitiativeMode('1d12+3', 'advantage'), '1d12+3',
        'non-d20 system formulas are not rewritten');
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
    assert.match(html, /2d20kh1\+3/);
    assert.match(html, /Input Manually/);
    assert.doesNotMatch(html, /Ability Bonus|Private GM Roll|name="formula"/);
    const noAdvantage = renderToStaticMarkup(createElement(RollDialog, {
        ...props, advantageAvailable: false, audience: 'gm', source: 'gm',
    }));
    assert.match(noAdvantage, /Private GM Roll/);
    assert.doesNotMatch(noAdvantage, />Advantage</);
    const manualOnly = renderToStaticMarkup(createElement(RollDialog, {
        ...props, formula: '', source: 'module', rollAvailable: false,
        advantageAvailable: false, audience: 'gm',
    }));
    assert.match(manualOnly, /aria-label="Initiative formula">Unavailable<\/code>/);
    assert.match(manualOnly, /Input Manually/);
    assert.doesNotMatch(manualOnly, />Roll initiative</);
    assert.doesNotMatch(manualOnly, />Advantage</);
    assert.doesNotMatch(manualOnly, />Disadvantage</);
    const theme = { container: 'module-sheet-frame', header: 'module-sheet-header',
        body: 'module-sheet-body', footer: 'module-sheet-footer', closeBtn: 'module-sheet-close',
        rollBtn: () => 'module-sheet-roll' };
    for (const dialogProps of [props, { isOpen: true, type: 'ability' as const, title: 'Ability Check',
        onClose: () => {}, onConfirm: () => {} }]) {
        const themed = renderToStaticMarkup(createElement(RollDialog, { ...dialogProps, theme }));
        assert.match(themed, /class="module-sheet-frame"/);
        assert.match(themed, /class="module-sheet-footer"/);
        assert.match(themed, /class="module-sheet-roll"/);
        assert.doesNotMatch(themed, /sd-ui-inset|rounded-2xl/, 'the shared frame never appends Core chrome to a module skin');
    }
    console.log('  - InitiativeRollDialog: bounded presentation passed');
}

if (import.meta.url === `file://${process.argv[1]}`) run();
