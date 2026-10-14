import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCombatStatAttributes, parseCombatStatSelection } from '@shared/contracts/combatStatAttributes';
import { validateModuleInfoShape } from '@modules/registry/lifecycle/validation';
import { CombatStatPreferenceStore, CombatStatPreferenceLimitError } from '@server/services/combats/CombatStatPreferenceStore';
import { discoverCombatStatFields, resolveCombatStatSelection, projectCombatStatFields } from '@server/services/combats/CombatStatDisplayService';
import { effectiveInitiativeFormula, validInitiativeFallback, validateInitiativeOverride } from '@server/services/combats/CombatInitiativeFormula';
import { NumberGenerator } from '@dice-roller/rpg-dice-roller';
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
    const many = Array.from({ length: 32 }, (_, index) => ({
        key: `stat${index}`, label: `Stat ${index}`, path: 'system.hp', kind: 'number',
    }));
    assert.equal(parseCombatStatSelection(many)?.length, 32, 'GM-selected stats have no eight/16 count cap');
    assert.equal(parseCombatStatAttributes(many.slice(0, 16))?.length, 16, 'module metadata remains independently bounded');
    assert.equal(parseCombatStatAttributes(many.slice(0, 17)), null);
    const notes = { key: 'notes', label: 'Notes', path: 'system.notes', kind: 'textarea' as const,
        layout: { columnSpan: 3, rowSpan: 2, textRows: 4 } };
    assert.deepEqual(parseCombatStatSelection([notes]), [notes]);
    assert.equal(parseCombatStatAttributes([notes]), null, 'textarea does not broaden module metadata');
    for (const layout of [{ ...notes.layout, columnSpan: 4 }, { ...notes.layout, rowSpan: 0 },
        { ...notes.layout, textRows: 13 }, { ...notes.layout, rowSpan: 1.5 },
        { ...notes.layout, css: 'position:fixed' }]) {
        assert.equal(parseCombatStatSelection([{ ...notes, layout }]), null, 'layout values/keys are validated');
    }
    assert.equal(parseCombatStatSelection([{ ...notes, editable: true }]), null);
    assert.equal(parseCombatStatSelection([{ ...notes, health: true }]), null);
    assert.equal(parseCombatStatSelection([{ ...notes, showInRoster: true }]), null, 'multiline text stays out of roster pills');
    const longText = '<script>not executable</script>\n' + 'Long paragraph\n'.repeat(200);
    const projected = projectCombatStatFields({ type: 'npc', system: { notes: longText }, derived: {} } as any, [notes]);
    assert.deepEqual(projected, [{ title: 'Notes', value: longText, multiline: true, layout: notes.layout }],
        'textarea preserves plain content/newlines instead of the old 48-character truncation');
    assert.equal(projectCombatStatFields({ type: 'npc', system: { notes: 12 }, derived: {} } as any, [notes]).length, 0);
    assert.equal(projectCombatStatFields({ type: 'npc', system: { notes: '' }, derived: {} } as any, [notes])[0]?.value, '');

    const manifest = { id: 'test-system', title: 'Test', manifest: { ui: 'module/ui', logic: 'module/logic' } };
    assert.equal(validateModuleInfoShape({ ...manifest, combatTracking: { attributes: [hp, ac] } }).valid, true);
    assert.equal(validateModuleInfoShape({ ...manifest, combatTracking: { attributes: [{ ...ac, path: 'derived.constructor' }] } }).valid, false);
    assert.deepEqual(resolveCombatStatSelection(null, [hp]), { source: 'module', attributes: [hp] });
    assert.deepEqual(resolveCombatStatSelection([], [hp]), { source: 'saved', attributes: [] });
    assert.deepEqual(resolveCombatStatSelection(null, []), { source: 'none', attributes: [] });
    assert.equal(resolveCombatStatSelection(null, many.slice(0, 16) as any).attributes.length, 16,
        'defaults do not silently truncate module suggestions at eight');
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
    assert.deepEqual(effectiveInitiativeFormula(new BaseSystemAdapter(), prepared, null), {
        source: 'core', formula: '1d20', rollAvailable: true, advantageAvailable: true,
    }, 'Core has a usable d20 fallback when neither module nor GM supplies a formula');
    assert.equal(effectiveInitiativeFormula({ getInitiativeFormula: () => '1d6+2' } as any, prepared,
        '1d20').source, 'gm', 'explicit GM override takes precedence over a module');
    assert.deepEqual(effectiveInitiativeFormula({ getInitiativeFormula: () => '1d6+2' } as any,
        prepared, null), { source: 'module', formula: '1d6+2', rollAvailable: true,
        advantageAvailable: false }, 'non-d20 initiative must not offer advantage');
    assert.deepEqual(effectiveInitiativeFormula({ getInitiativeFormula: () => '1d6+@system.attributes.init.value' } as any,
        prepared, null), { source: 'module', formula: '1d6+@system.attributes.init.value',
        rollAvailable: true, advantageAvailable: false },
    'Core does not rewrite a module-supplied formula reference');
    assert.equal(effectiveInitiativeFormula({ getInitiativeFormula: () => '' } as any, prepared,
        '1d20').source, 'gm', 'the GM override is independent of the module formula');
    assert.deepEqual(effectiveInitiativeFormula({ getInitiativeFormula: () => {
        throw new Error('module formula unavailable');
    } } as any, prepared, null), { source: 'module', formula: '', rollAvailable: false,
        advantageAvailable: false }, 'a failing module hook must not silently become a GM roll');
    assert.equal(effectiveInitiativeFormula({ getInitiativeFormula: () => {
        throw new Error('must not be called');
    } } as any, prepared, '1d20').source, 'gm');
    assert.equal(effectiveInitiativeFormula({ getInitiativeFormula: () => '1d6+2' } as any, prepared,
        '1d20+@system.missing').rollAvailable, false, 'a broken explicit override never falls back');
    const priorEngine = NumberGenerator.generator.engine;
    try {
        NumberGenerator.generator.engine = { next: () => { throw new Error('Validation consumed RNG'); } };
        assert.equal(validateInitiativeOverride('1d20+@system.attributes.init.value', prepared), '1d20-2');
        assert.equal(validateInitiativeOverride('1d20+@system.zero', { system: { zero: 0 } } as any), '1d20+0');
        assert.equal(validateInitiativeOverride('1d20+@derived.init', { derived: { init: 2.5 } } as any), '1d20+2.5');
        assert.equal(validateInitiativeOverride('1d20'), '1d20');
        for (const value of [null, '3', Infinity, NaN, {}, 1e15]) {
            assert.throws(() => validateInitiativeOverride('1d20+@system.init', { system: { init: value } } as any));
        }
        assert.throws(() => validateInitiativeOverride('1d20+@system.missing', prepared), /Missing or non-numeric/);
        assert.throws(() => validateInitiativeOverride('1d20/0'), /Use dice/);
    } finally { NumberGenerator.generator.engine = priorEngine; }

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
    assert.equal(discovered.find(field => field.path === 'system.attributes.hp.value')?.kind, 'number');
    assert.equal(discovered.find(field => field.path === 'system.attributes.hp.max')?.kind, 'number');
    assert.equal(discovered.find(field => field.path === 'system.attributes.stamina.max'), undefined,
        'resource maximum paths are discovered only if they actually exist');
    assert.equal(discovered.some(field => field.path.includes('__proto__')), false);
    assert.equal(discoverCombatStatFields([{ type: 'npc', system: { notes: longText }, derived: {} }] as any)
        .find(field => field.path === 'system.notes')?.kind, 'textarea', 'long/multiline fields are discoverable for GM display');
    const initiativeFields = discoverCombatStatFields([{ type: 'npc', system: {
        attributes: { some: { thing: 0 } }, text: 'Not a numeric reference',
    }, derived: { initiative: { value: -2, advantage: 0 } } }] as any);
    assert.equal(initiativeFields.find(field => field.path === 'system.attributes.some.thing')?.kind, 'number');
    assert.equal(initiativeFields.find(field => field.path === 'derived.initiative.value')?.kind, 'number');
    assert.equal(initiativeFields.find(field => field.path === 'derived.initiative.advantage')?.kind, 'number',
        'numeric siblings are retained even when the parent resembles a resource');
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
        first.set('textarea-world', 'test-system', [notes]);
        first.setInitiativeFormula('world-one', 'test-system', '1d20+@system.attributes.init.value');
        const reopened = new CombatStatPreferenceStore(filePath);
        assert.deepEqual(reopened.get('textarea-world', 'test-system'), [notes], 'layout/kind persist without altering old record defaults');
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
        first.set('world-many', 'test-system', many as any);
        assert.deepEqual(new CombatStatPreferenceStore(filePath).get('world-many', 'test-system'), many,
            'more than eight/16 selections persist and reload without truncation');
        const beforeOversized = fs.readFileSync(filePath, 'utf8');
        assert.throws(() => first.set('world-many', 'test-system', Array.from({ length: 5000 }, (_, index) => ({
            key: `stat${index}`, label: `Stat ${index}`, path: 'system.hp', kind: 'number' as const,
        }))), (error: unknown) => error instanceof CombatStatPreferenceLimitError && error.status === 413);
        assert.equal(fs.readFileSync(filePath, 'utf8'), beforeOversized,
            'the existing byte safety limit rejects before replacing a readable file');
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
