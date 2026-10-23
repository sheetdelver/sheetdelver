import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import PageHeader from '../../../client/ui/components/PageHeader';
import { MockSDKProvider } from '../../../shared/sdk/testing';
import type { PageHeaderProps } from '../../../shared/sdk/page-header';

export function run() {
    const render = (props: PageHeaderProps) => renderToStaticMarkup(createElement(MockSDKProvider, null, createElement(PageHeader, props)));
    const sheet = render({ context: 'Character <name>' });
    assert.match(sheet, /aria-label="Page navigation"/);
    assert.match(sheet, /Character &lt;name&gt;/);
    assert.doesNotMatch(sheet, /<header|<h1/);
    const tool = render({ heading: { title: 'Create <character>', subtitle: 'System', icon: createElement('svg'), actions: createElement('button', null, 'Roll') }, theme: { background: '#ffe900' } });
    assert.match(tool, /--sd-header-bg:#ffe900/);
    assert.equal((tool.match(/<nav /g) ?? []).length, 1);
    assert.equal((tool.match(/<h1>/g) ?? []).length, 1);
    assert.match(tool, /Create &lt;character&gt;/);
    assert.match(tool, /aria-hidden="true"><svg/);
    assert.match(tool, />Roll<\/button>/);
    console.log('Shared page header contract passed');
}
if (import.meta.url === `file://${process.argv[1]}`) run();
