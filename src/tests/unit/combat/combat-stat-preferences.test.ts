import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCombatStatAttributes, parseCombatStatSelection } from '@shared/contracts/combatStatAttributes';
import { validateModuleInfoShape } from '@modules/registry/lifecycle/validation';
import { CombatStatPreferenceStore } from '@server/services/combats/CombatStatPreferenceStore';
import { discoverCombatStatFields, resolveCombatStatSelection } from '@server/services/combats/CombatStatDisplayService';
import { effectiveInitiativeFormula, validInitiativeFallback } from '@server/services/combats/CombatInitiativeFormula';
import { BaseSystemAdapter } from '@shared/sdk';

export function run(): void {
    const hp = { key: 'hp', label: 'HP', path: 'system.attributes.hp', kind: 'resource' as const };
    const ac = { key: 'ac', label: 'AC', path: 'derived.ac', kind: 'number' as const };
    assert.deepEqual(parseCombatStatAttributes([hp, ac]), [hp, ac]);
    assert.deepEqual(parseCombatStatAttributes([{ ...hp, showInRoster: true }]), [{ ...hp, showInRoster: true }]);
    assert.equal(parseCombatStatAttributes([{ ...hp, showInRoster: 'yes' }]), null);
    assert.deepEqual(parseCombatStatAttributes([{ ...hp, editable: true }]), [hp],
        'module suggestions never grant edit permission');
    assert.deepEqual(parseCombatStatSelection([{ ...hp, editable: true }]), [{ ...hp, editable: true }]);
    assert.deepEqual(parseCombatStatSelection([{ ...hp, editable: true, health: true }]),
        [{ ...hp, editable: true, health: true }]);
    assert.equal(parseCombatStatSelection([{ ...hp, health: true }]), null,
        'default health must also be editable');
    assert.equal(parseCombatStatSelection([{ ...hp, editable: true, health: true },
        { key: 'stamina', label: 'Stamina', path: 'system.stamina', kind: 'number', editable: true, health: true }]), null,
    'only one stat may be default health');
    assert.equal(parseCombatStatSelection([{ ...ac, editable: true }]), null);
    assert.equal(parseCombatStatSelection([{ ...hp, kind: 'text', editable: true }]), null);
    assert.equal(parseCombatStatSelection([{ ...hp, editable: 'yes' }]), null);
    assert.equal(parseCombatStatAttributes([{ ...hp, path: 'system.__proto__.value' }]), null);
    assert.equal(parseCombatStatAttributes([hp, { ...hp, label: 'Duplicate' }]), null);
    assert.equal(parseCombatStatAttributes(Array.from({ length: 9 }, (_, index) => ({
        key: `stat${index}`, label: `Stat ${index}`, path: 'system.hp', kind: 'number',
    }))), null);

    const manifest = { id: 'test-system', title: 'Test', manifest: { ui: 'module/ui', logic: 'module/logic' } };
    assert.equal(validateModuleInfoShape({ ...manifest, combatTracking: { attributes: [hp, ac] } }).valid, true);
    assert.equal(validateModuleInfoShape({ ...manifest, combatTracking: { attributes: [{ ...ac, path: 'derived.constructor' }] } }).valid, false);
    assert.deepEqual(resolveCombatStatSelection(null, [hp]), { source: 'module', attributes: [hp] });
    assert.deepEqual(resolveCombatStatSelection([], [hp]), { source: 'saved', attributes: [] });
    assert.deepEqual(resolveCombatStatSelection(null, []), { source: 'none', attributes: [] });
    const prepared = { type: 'npc', system: { attributes: { init: { value: -2 } } }, derived: {} } as any;
    assert.equal(validInitiativeFallback('1d20 + @system.attributes.init.value'), true);
    assert.equal(validInitiativeFallback('1d20 + @system.__proto__.value'), false);
    assert.equal(validInitiativeFallback('1d20 * 2'), false);
    assert.equal(validInitiativeFallback('1000d6'), false);
    assert.equal(validInitiativeFallback('100d6+1d6'), false);
    assert.deepEqual(effectiveInitiativeFormula(new BaseSystemAdapter(), prepared,
        '1d20+@system.attributes.init.value'), {
        source: 'gm', formula: '1d20-2', rollAvailable: true, advantageAvailable: true,
    });
    assert.equal(effectiveInitiativeFormula(new BaseSystemAdapter(), prepared,
        '1d20+@system.missing').rollAvailable, false);
    assert.equal(effectiveInitiativeFormula(new BaseSystemAdapter(), prepared, null).source, 'core');
    assert.equal(effectiveInitiativeFormula({ getInitiativeFormula: () => '1d6+2' } as any, prepared,
        '1d20').source, 'module', 'module-supplied initiative always wins');
    assert.deepEqual(effectiveInitiativeFormula({ getInitiativeFormula: () => '1d6+@system.attributes.init.value' } as any,
        prepared, '1d20'), { source: 'module', formula: '1d6+@system.attributes.init.value',
        rollAvailable: true, advantageAvailable: false },
    'Core does not rewrite a module-supplied formula reference');
    assert.equal(effectiveInitiativeFormula({ getInitiativeFormula: () => '' } as any, prepared,
        '1d20').source, 'gm', 'an empty module formula permits the saved fallback');

    const discovered = discoverCombatStatFields([
        { type: 'npc', system: { attributes: { hp: { value: 12, max: 20 }, armorClass: 15,
            stamina: { value: 4 } }, ...Object.fromEntries([['__proto__', { unsafe: 1 }]]) },
        derived: { threatLevel: 3 } },
        { type: 'character', system: { attributes: { hp: { value: 8, max: 12 }, armorClass: 13 } }, derived: {} },
    ] as any);
    assert.deepEqual(discovered.find(field => field.path === 'system.attributes.hp'), {
        key: 'field0', label: 'HP', path: 'system.attributes.hp', kind: 'resource',
        observedActorTypes: ['npc', 'character'],
    });
    assert.equal(discovered.find(field => field.path === 'system.attributes.armorClass')?.label, 'Attributes · Armor Class');
    assert.equal(discovered.find(field => field.path === 'derived.threatLevel')?.kind, 'number');
    assert.equal(discovered.find(field => field.path === 'system.attributes.stamina')?.kind, 'resource');
    assert.equal(discovered.some(field => field.path.includes('__proto__')), false);
    const context = discoverCombatStatFields([{ type: 'npc', system: {
        armor: { mod: 2 }, attack: { mod: 4 }, defense: { base: 10 },
    }, derived: {} }] as any);
    assert.deepEqual(context.map(field => field.label), ['Armor · Mod', 'Attack · Mod', 'Defense · Base']);
    const collisions = discoverCombatStatFields([{ type: 'npc', system: {
        abilities: { str: { mod: 2 } }, saves: { str: { mod: 4 } },
    }, derived: {} }] as any);
    assert.deepEqual(collisions.map(field => field.label), ['Abilities · Str · Mod', 'Saves · Str · Mod']);

    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-combat-stat-pref-'));
    const filePath = path.join(testDir, 'gm-combat-stats.json');
    try {
        const first = new CombatStatPreferenceStore(filePath);
        assert.equal(first.get('world-one', 'test-system'), null);
        first.set('world-one', 'test-system', [{ ...hp, showInRoster: true, editable: true, health: true }]);
        first.set('world-two', 'test-system', [ac]);
        first.set('world-one', 'other-system', []);
        first.setInitiativeFormula('world-one', 'test-system', '1d20+@system.attributes.init.value');
        const reopened = new CombatStatPreferenceStore(filePath);
        assert.equal(reopened.getInitiativeFormula('world-one', 'test-system'), '1d20+@system.attributes.init.value');
        assert.deepEqual(reopened.get('world-one', 'test-system'), [{ ...hp, showInRoster: true, editable: true, health: true }],
            'selection and roster placement survive a new store instance');
        assert.deepEqual(reopened.get('world-one', 'other-system'), [], 'explicit empty differs from missing');
        assert.deepEqual(reopened.get('world-two', 'test-system'), [ac], 'world scope is isolated');
        reopened.reset('world-one', 'test-system');
        assert.equal(first.get('world-one', 'test-system'), null);
        assert.equal(first.getInitiativeFormula('world-one', 'test-system'), '1d20+@system.attributes.init.value',
            'resetting display stats preserves the separate initiative fallback');
        reopened.setInitiativeFormula('world-one', 'test-system', null);
        assert.equal(first.getInitiativeFormula('world-one', 'test-system'), null);
        assert.deepEqual(first.get('world-two', 'test-system'), [ac]);
        assert.throws(() => first.set('world-one', 'test-system', [{ ...hp, path: 'derived.__proto__' }]));
        assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
        fs.writeFileSync(filePath, '{malformed');
        assert.throws(() => first.get('world-two', 'test-system'), /not valid JSON/);
        assert.throws(() => first.set('world-two', 'test-system', [hp]), /not valid JSON/,
            'corrupt persisted state is not silently overwritten');
    } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
    }
    console.log('  - GM combat stat preferences: validation and durable scope checks passed');
}

if (import.meta.url === `file://${process.argv[1]}`) run();
