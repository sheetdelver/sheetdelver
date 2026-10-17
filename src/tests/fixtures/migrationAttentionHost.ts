import fs from 'node:fs';
import path from 'node:path';
import { host } from '../integration/adr0064-corrections.test';
import { fixture } from '../unit/world/module-world-migrations.test';
import { refreshRegistry, enableModule, switchModuleSource } from '@modules/registry/server';
import { ModuleSourceCategory } from '@shared/types/modules';
import { worldStateStore } from '@server/core/world/WorldStateStore';

/** Real Core host/Stores/journal; only the upstream wire is controlled. */
export async function migrationAttentionHost(root: string) {
    const context = await host(root);
    context.data.world = { ...context.data.world, title: 'Lantern Vault' } as typeof context.data.world;
    worldStateStore.seed(context.data);
    const local = fixture(path.join(root, 'local/modules/fixture'));
    const managed = fixture(path.join(root, 'modules/fixture'));
    managed.info.version = managed.version = '2.0.0';
    fs.writeFileSync(path.join(managed.root, 'info.json'), JSON.stringify(managed.info));
    for (const candidate of [local, managed]) {
        fs.writeFileSync(path.join(candidate.root, 'logic.js'), 'export class Adapter {systemId="fixture";match(){return true}normalizeActorData(a){return {...a,id:a._id,derived:{}}}prepareActorData(a){return {...a,id:a._id,derived:{}}}}');
        fs.writeFileSync(path.join(candidate.root, 'ui.js'), 'export default {}');
    }
    fs.writeFileSync(path.join(managed.root, 'migrations/1.0.0/check.cjs'), 'module.exports=()=>({status:"current"})');
    fs.writeFileSync(path.join(managed.root, 'migrations/1.0.0/verify.cjs'), 'module.exports=()=>({valid:true})');
    refreshRegistry(); enableModule('fixture');
    // Fixture selection only; no migration approval or native mutation is made.
    const selection = switchModuleSource('fixture', ModuleSourceCategory.Local, () => {});
    if (!selection.success) throw new Error(selection.error);
    return { ...context, local, managed };
}
