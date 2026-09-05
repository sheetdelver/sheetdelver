import { strict as assert } from 'node:assert';
import {
    resolveFoundryHtml,
    resolveFoundryUrl,
} from '@server/shared/utils/foundryUrl';

const BASE_URL = 'http://foundry.test:30000';

export function run() {
    runResolveFoundryUrlCases();
    runResolveFoundryHtmlCases();
    console.log('  - foundryUrl: all checks passed');
}

function runResolveFoundryUrlCases() {
    assert.equal(resolveFoundryUrl('', BASE_URL), '');
    assert.equal(
        resolveFoundryUrl('https://cdn.example.test/icons/foo.png', BASE_URL),
        'https://cdn.example.test/icons/foo.png'
    );
    assert.equal(
        resolveFoundryUrl('data:image/png;base64,abc123', BASE_URL),
        'data:image/png;base64,abc123'
    );
    assert.equal(
        resolveFoundryUrl('/icons/foo.png', BASE_URL),
        'http://foundry.test:30000/icons/foo.png'
    );
    assert.equal(
        resolveFoundryUrl('icons/foo.png', `${BASE_URL}/`),
        'http://foundry.test:30000/icons/foo.png'
    );
}

function runResolveFoundryHtmlCases() {
    assert.equal(resolveFoundryHtml('', BASE_URL), '');

    const html = [
        '<img src="icons/foo.png">',
        '<img src="/icons/bar.png">',
        '<img src="https://cdn.example.test/icons/baz.png">',
        '<img src="data:image/png;base64,abc123">',
        '<a href="journal/entry">Entry</a>',
        '<a href="/journal/rooted">Rooted</a>',
        '<a href="https://example.test/outside">Outside</a>',
        '<a href="data:text/plain,hello">Data</a>',
        '<a href="#local-anchor">Jump</a>',
    ].join('');

    assert.equal(
        resolveFoundryHtml(html, `${BASE_URL}/`),
        [
            '<img src="http://foundry.test:30000/icons/foo.png">',
            '<img src="http://foundry.test:30000/icons/bar.png">',
            '<img src="https://cdn.example.test/icons/baz.png">',
            '<img src="data:image/png;base64,abc123">',
            '<a href="http://foundry.test:30000/journal/entry">Entry</a>',
            '<a href="http://foundry.test:30000/journal/rooted">Rooted</a>',
            '<a href="https://example.test/outside">Outside</a>',
            '<a href="data:text/plain,hello">Data</a>',
            '<a href="#local-anchor">Jump</a>',
        ].join('')
    );
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run();
    console.log('foundry-url.test.ts passed');
}
