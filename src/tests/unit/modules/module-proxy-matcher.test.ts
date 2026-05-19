import { strict as assert } from 'node:assert';
import { compileModuleRoutePattern } from '@server/services/modules/ModuleProxyService';

export function run() {
    const standardDynamic = compileModuleRoutePattern('actors/[id]/items');
    assert.equal(standardDynamic.test('actors/abc123/items'), true);
    assert.equal(standardDynamic.test('actors/abc123/items/extra'), false);

    const escapedStatic = compileModuleRoutePattern('spell.table+v2/(draft)?/[id]');
    assert.equal(escapedStatic.test('spell.table+v2/(draft)?/table-1'), true);
    assert.equal(escapedStatic.test('spellxtable+v2/(draft)?/table-1'), false);
    assert.equal(escapedStatic.test('spell.table+v2/draft/table-1'), false);

    const multiDynamic = compileModuleRoutePattern('fetch/[pack]/document/[uuid]');
    assert.equal(multiDynamic.test('fetch/core-items/document/Compendium.foo.bar.Baz'), true);
    assert.equal(multiDynamic.test('fetch/core-items/document'), false);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    try {
        run();
        console.log('module-proxy-matcher.test.ts passed');
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
}
