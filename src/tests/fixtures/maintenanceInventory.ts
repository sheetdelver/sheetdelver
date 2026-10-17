import fs from 'node:fs';
import path from 'node:path';
import type { UpgradeCandidate } from '@server/services/world/migrations/ModuleUpgradeCoordinator';
import { migrationDirectoryDigest } from '@modules/registry/migrations/catalog';

export type FixtureDocument = Record<string, any>;
export function maintenanceInventory(actorCount = 30, itemsPerActor = 30, current = false) {
    const effect = (_id: string): FixtureDocument => ({ _id, name: 'Fixture effect', disabled: false, unknown: { retain: null }, changes: [
        { key: current ? 'system.current' : 'system.legacy', value: '3', mode: 2, priority: 17, phase: 'fixture' },
        { key: 'system.unrelated', value: '0', mode: 1, priority: 0 },
    ] });
    const item = (_id: string, withEffect: boolean): FixtureDocument => ({ _id, name: _id, type: 'Tool', system: { fixed: current, description: 'fixture '.repeat(100), unknown: { value: null } }, effects: withEffect ? [effect(`${_id}e`)] : [] });
    const actors: FixtureDocument[] = Array.from({ length: actorCount }, (_, a) => ({ _id: `a${a}`, name: `Actor ${a}`, type: a % 2 ? 'NPC' : 'Player',
        ownership: { default: 0, player: 3 }, system: { fixed: current, hp: 0, unknown: { keep: true } },
        items: Array.from({ length: itemsPerActor }, (_, i) => item(`i${a}x${i}`, i % 4 === 0)), effects: [effect(`e${a}x0`), effect(`e${a}x1`)] }));
    const items = [item('loose', true)];
    const scenes = [{ _id: 'scene', name: 'Fixture', tokens: [
        { _id: 'owned', actorId: 'a0', actorLink: false, delta: { _id: 'delta', system: { fixed: current, hp: null },
            items: [item('deltaItem', true), { _id: 'deletedItem', _tombstone: true }], effects: [effect('deltaEffect'), { _id: 'deletedEffect', _tombstone: true }], unknown: { keep: 0 } } },
        { _id: 'inherited', actorId: 'a0', actorLink: false, delta: null },
        { _id: 'linked', actorId: 'a0', actorLink: true, delta: null },
        { _id: 'actorless', actorId: null, actorLink: false, delta: null },
    ] }];
    const packs: Record<string, FixtureDocument[]> = {
        'world.unusualActors': [{ ...structuredClone(actors[0]), _id: 'packedActor', items: [item('packItem', true)] }],
        'world.unusualItems': [item('packedItem', true)],
        'fixture.readOnly': [item('packageItem', true)],
    };
    const metadata = Object.keys(packs).map(id => ({ id, collection: id, type: id.endsWith('Actors') ? 'Actor' : 'Item',
        packageType: id.startsWith('world.') ? 'world' : 'system', locked: !id.startsWith('world.'), ownership: { PLAYER: 'OBSERVER', ASSISTANT: 'OWNER' } }));
    return { actors, items, scenes, packs, metadata };
}

/** Independent source oracle: never invokes planner hooks or target expansion. */
export function expectedMaintenanceSource(input: ReturnType<typeof maintenanceInventory>) {
    const next = structuredClone(input);
    function visit(value: FixtureDocument, kind: string) {
        if (value._tombstone) return;
        if (kind === 'ActiveEffect') value.changes = value.changes.map((row: FixtureDocument) => ({ ...row, key: row.key === 'system.legacy' ? 'system.current' : row.key }));
        else value.system = { ...value.system, fixed: true };
        for (const child of value.items ?? []) visit(child, 'Item');
        for (const child of value.effects ?? []) visit(child, 'ActiveEffect');
    }
    next.actors.forEach(row => visit(row, 'Actor')); next.items.forEach(row => visit(row, 'Item'));
    for (const scene of next.scenes) for (const token of scene.tokens) if (!token.actorLink && token.delta) visit(token.delta, 'ActorDelta');
    for (const [pack, rows] of Object.entries(next.packs)) if (pack.startsWith('world.')) rows.forEach(row => visit(row, pack.endsWith('Actors') ? 'Actor' : 'Item'));
    return next;
}

export function maintenanceUuidOracle(input: ReturnType<typeof maintenanceInventory>): string[] {
    const uuids: string[] = [];
    function visit(row: FixtureDocument, uuid: string) {
        if (row._tombstone) return;
        uuids.push(uuid);
        for (const item of row.items ?? []) visit(item, `${uuid}.Item.${item._id}`);
        for (const effect of row.effects ?? []) visit(effect, `${uuid}.ActiveEffect.${effect._id}`);
    }
    input.actors.forEach(row => visit(row, `Actor.${row._id}`)); input.items.forEach(row => visit(row, `Item.${row._id}`));
    for (const scene of input.scenes) for (const token of scene.tokens) if (!token.actorLink && token.delta) visit(token.delta, `Scene.${scene._id}.Token.${token._id}.ActorDelta.${token.delta._id}`);
    for (const [pack, rows] of Object.entries(input.packs)) if (pack.startsWith('world.')) rows.forEach(row => visit(row, `Compendium.${pack}.${pack.endsWith('Actors') ? 'Actor' : 'Item'}.${row._id}`));
    return uuids.sort();
}

export function createMaintenanceCandidate(root: string, cumulative = false): UpgradeCandidate {
    const dir = path.join(root, 'migrations/1.0.0'); fs.mkdirSync(dir, { recursive: true });
    const info = { id: 'fixture', title: 'Core maintenance fixture', version: '1.0.0', manifest: { logic: 'logic.js', ui: 'ui.js' },
        compatibility: { apiContracts: { 'module-api': '>=1.6.0 <2.0.0' } } };
    fs.writeFileSync(path.join(root, 'info.json'), JSON.stringify(info));
    fs.writeFileSync(path.join(root, 'migration.json'), JSON.stringify({ schemaVersion: 'sheet-delver-migrations.v1', systemVersions: { '1.0.0': 'migrations/1.0.0' } }));
    const common = { revision: 1, dependencies: [], systemVersion: '>=1.0.0 <3.0.0', foundryGenerations: [13, 14], required: true, description: 'Core fixture, no system rules' };
    fs.writeFileSync(path.join(dir, 'definition.json'), JSON.stringify({ schemaVersion: 'sheet-delver-migration-definition.v1', dataReadVersion: '>=1.0.0 <3.0.0', steps: [
        { ...common, id: 'source-ready', targets: ['Actor', 'Item', 'ActorDelta', 'WorldPack'], paths: ['system.fixed'], hooks: { check: 'source.check.cjs', plan: 'source.plan.cjs', verify: 'source.verify.cjs' } },
        { ...common, id: 'effect-key', dependencies: ['source-ready'], targets: ['ActiveEffect', 'WorldPack'], paths: ['changes'],
            reads: { relations: [{ relation: 'ancestors', forKinds: ['ActiveEffect'], fields: ['type'], required: true },
                { relation: 'baseActor', forKinds: ['ActiveEffect', 'ActorDelta'], fields: ['type'] }] },
            hooks: { check: 'effect.check.cjs', plan: 'effect.plan.cjs', verify: 'effect.verify.cjs' } },
    ] }));
    fs.writeFileSync(path.join(dir, 'source.check.cjs'), "module.exports=({target})=>({status:target.kind==='ActiveEffect'||target.source.system.fixed===true?'current':'migration-needed'})");
    fs.writeFileSync(path.join(dir, 'source.plan.cjs'), "module.exports=()=>({status:'patch',updates:{'system.fixed':true}})");
    fs.writeFileSync(path.join(dir, 'source.verify.cjs'), "module.exports=({target})=>({valid:target.kind==='ActiveEffect'||target.source.system.fixed===true})");
    fs.writeFileSync(path.join(dir, 'effect.check.cjs'), "module.exports=({target,relations})=>target.kind!=='ActiveEffect'?{status:'current'}:!relations.ancestors.length?{status:'unresolved',reason:'Effect parent source is required'}:{status:target.source.changes.some(row=>row.key==='system.legacy')?'migration-needed':'current'}");
    fs.writeFileSync(path.join(dir, 'effect.plan.cjs'), "module.exports=({target})=>({status:'patch',updates:{changes:target.source.changes.map(row=>({...row,key:row.key==='system.legacy'?'system.current':row.key}))}})");
    fs.writeFileSync(path.join(dir, 'effect.verify.cjs'), "module.exports=({target})=>({valid:target.kind!=='ActiveEffect'||target.source.changes.every(row=>row.key!=='system.legacy')})");
    if (cumulative) {
        const definition = JSON.parse(fs.readFileSync(path.join(dir, 'definition.json'), 'utf8'));
        const effect = definition.steps.pop();
        const second = path.join(root, 'migrations/2.0.0'); fs.mkdirSync(second);
        for (const hook of Object.values(effect.hooks) as string[]) fs.copyFileSync(path.join(dir, hook), path.join(second, hook));
        fs.writeFileSync(path.join(dir, 'definition.json'), JSON.stringify(definition));
        fs.writeFileSync(path.join(second, 'definition.json'), JSON.stringify({ ...definition, steps: [effect] }));
        fs.writeFileSync(path.join(root, 'migration.json'), JSON.stringify({ schemaVersion: 'sheet-delver-migrations.v1', systemVersions: { '1.0.0': 'migrations/1.0.0', '2.0.0': 'migrations/2.0.0' } }));
    }
    return { moduleId: info.id, version: info.version, root, info, artifactDigest: migrationDirectoryDigest(root) };
}
