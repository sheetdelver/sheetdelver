import { strict as assert } from 'node:assert';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import GenericSheet, { GenericItemDetails } from '@client/ui/components/GenericSheet';

export function run() {
    const foundryUrl = 'http://127.0.0.1:30000';
    const item = {
        _id: 'item-1',
        name: 'Probe Armor',
        type: 'armor',
        img: '/systems/probe/armor.webp',
        system: {
            equipped: true,
            armor: { value: 3 },
            bonuses: [{ label: 'Evasion', value: 2 }],
            tags: ['Light'],
            empty: [],
            description: 'A description longer than the old truncated field can display.',
        },
    };
    const original = structuredClone(item);
    const html = renderToStaticMarkup(createElement(GenericItemDetails, { item, foundryUrl }));
    assert.ok(html.includes(`src="${foundryUrl}/systems/probe/armor.webp"`));
    assert.ok(html.includes('<details'));
    assert.ok(html.includes('aria-label="equipped"'));
    assert.ok(html.includes('disabled=""'));
    assert.ok(html.includes('checked=""'));
    assert.ok(html.includes('Evasion'));
    assert.ok(html.includes('Light'));
    assert.ok(html.includes('None'));
    assert.ok(html.includes(item.system.description));
    assert.ok(!html.includes('<textarea'));
    assert.deepEqual(item, original, 'rendering never mutates the embedded Item');

    for (const img of ['https://assets.example/armor.webp', 'data:image/png;base64,AAAA']) {
        const absoluteHtml = renderToStaticMarkup(createElement(GenericItemDetails, {
            item: { ...item, img }, foundryUrl,
        }));
        assert.ok(absoluteHtml.includes(`src="${img}"`), 'resolved and inline images remain unchanged');
    }

    const fallbackHtml = renderToStaticMarkup(createElement(GenericItemDetails, {
        item: { ...item, img: null }, foundryUrl,
    }));
    assert.ok(fallbackHtml.includes(`src="${foundryUrl}/icons/svg/item-bag.svg"`));

    let updates = 0;
    const sheetHtml = renderToStaticMarkup(createElement(GenericSheet, {
        actor: { name: 'Probe', type: 'character', foundryUrl, system: { equipped: false } },
        onUpdate: () => { updates += 1; },
    }));
    assert.ok(sheetHtml.includes(`src="${foundryUrl}/icons/svg/mystery-man.svg"`));
    assert.ok(!sheetHtml.includes('disabled=""'), 'Actor flags remain editable when an update handler is supplied');
    assert.equal(updates, 0, 'rendering never sends updates');

    console.log('  - Generic sheet item data and images: all checks passed');
}

if (import.meta.url === `file://${process.argv[1]}`) run();
