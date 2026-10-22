import assert from 'node:assert/strict';
import { resolveDisplayArtwork, displayArtworkUrl } from '@server/services/artwork/DisplayArtworkService';
import { readDisplayArtworkContext } from '@server/routes/protected/registerDisplayArtworkRoutes';
import { actorStore } from '@server/core/documents/primary/actors/ActorStore';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import { combatStore } from '@server/core/documents/primary/combats/CombatStore';
import { sceneStore } from '@server/core/documents/primary/scenes/SceneStore';
import { combatEncounterReadModel } from '@server/core/documents/encounters/CombatEncounterReadModel';
import type { DisplayArtworkContext, DisplayArtworkRuntime } from '@shared/sdk';

export async function run() {
    let groups=0;
    const check=async(name:string,fn:()=>unknown|Promise<unknown>)=>{await fn();groups++;console.log(`  ✓ ${name}`);};
    const context={purpose:'actor-card',actor:{_id:'a',type:'npc',name:'Monster',img:'default.webp',items:[],system:{}},currentImage:'default.webp',imageSource:'actor'} as DisplayArtworkContext;
    const runtime={documents:{},access:{},compendium:{}} as Omit<DisplayArtworkRuntime,'signal'>;
    const options={isCurrent:()=>true,resolveUrl:(src:string)=>displayArtworkUrl(src,'https://foundry.example/game/','fixture')};
    await check('absent and declining hooks preserve existing images',async()=>{
        assert.equal(await resolveDisplayArtwork(null,context,runtime,options),null);
        assert.equal(await resolveDisplayArtwork({resolveDisplayArtwork:async()=>null},context,runtime,options),null);
    });
    await check('generic module-owned assets need no compendium mapping',async()=>{
        const before=structuredClone(context);
        const result=await resolveDisplayArtwork({resolveDisplayArtwork:async(input,caller)=>{
            assert.ok(Object.isFrozen(input.actor));assert.equal('rolls' in caller,false);assert.equal('dataStore' in caller,false);
            return {src:'/api/modules/fixture/assets/monster.webp',credit:'Artist'};
        }},context,runtime,options);
        assert.deepEqual(result,{src:'/api/modules/fixture/assets/monster.webp',credit:'Artist'});assert.deepEqual(context,before);
    });
    await check('invalid URLs and thrown hooks retain original',async()=>{
        for(const src of ['javascript:alert(1)','data:image/svg+xml,x','//other.example/art.webp','../secret','modules/a/%2e%2e%2fsecret','https://user:password@foundry.example/game/a.webp'])
            assert.equal(displayArtworkUrl(src,'https://foundry.example/game/','fixture'),null);
        assert.equal(await resolveDisplayArtwork({resolveDisplayArtwork:async()=>{throw Error('failed')}},context,runtime,options),null);
    });
    await check('changed caller/source/world rejects a pending result',async()=>{
        let current=true;
        assert.equal(await resolveDisplayArtwork({resolveDisplayArtwork:async()=>{current=false;return{src:'modules/a/art.webp'}}},context,runtime,{...options,isCurrent:()=>current}),null);
    });
    await check('deadline and disconnect abort optional hooks',async()=>{
        let signal:AbortSignal|undefined;
        assert.equal(await resolveDisplayArtwork({resolveDisplayArtwork:async(_ctx,caller)=>{signal=caller.signal;return new Promise(()=>{})}},context,runtime,{...options,timeoutMs:5}),null);
        assert.equal(signal?.aborted,true);
        const abort=new AbortController();abort.abort();let called=false;
        assert.equal(await resolveDisplayArtwork({resolveDisplayArtwork:async()=>{called=true;return null}},context,runtime,{...options,signal:abort.signal}),null);
        assert.equal(called,false);
    });
    try {
        await userStore.seed(async()=>[{_id:'gm',role:4},{_id:'p',role:1},{_id:'other',role:1}]);
        await actorStore.seed(async()=>[{_id:'a',name:'NPC',type:'npc',img:'portrait.webp',items:[],ownership:{p:2}}]);
        await sceneStore.seed(async()=>[{_id:'s',name:'Scene',tokens:[{_id:'t',actorId:'a',actorLink:false,texture:{src:'token.webp'}}]}]);
        const combat={_id:'c',scene:null,active:true,round:1,turn:0,combatants:[{_id:'r',actorId:'a',sceneId:'s',tokenId:'t',img:'combat.webp',initiative:10,hidden:false}],flags:{world:{sheetDelverCombat:{schemaVersion:1,mode:'tokenless',label:'Review',status:'active',keepHistory:true,folderId:null,copyIds:[]}}}};
        await combatStore.seed(async()=>[combat]);combatEncounterReadModel.clear();combatEncounterReadModel.rebuildAll();
        const target={purpose:'combat-token' as const,combatId:'c',combatantId:'r'};
        await check('authorized contexts retain manager/HUD precedence and minimal token fields',()=>{
            const hud=readDisplayArtworkContext('p',target)!;assert.equal(hud.currentImage,'combat.webp');assert.equal(hud.imageSource,'combatant');
            assert.deepEqual(hud.token,{id:'t',img:'token.webp',actorLink:false});
            const manager=readDisplayArtworkContext('gm',{...target,purpose:'combat-portrait'})!;assert.equal(manager.currentImage,'portrait.webp');assert.equal(manager.imageSource,'actor');
        });
        await check('manager retains the combat image fallback when Actor portrait is empty',async()=>{
            await actorStore.seed(async()=>[{_id:'a',name:'NPC',type:'npc',img:'',items:[],ownership:{p:2}}]);
            const manager=readDisplayArtworkContext('gm',{...target,purpose:'combat-portrait'})!;
            assert.equal(manager.currentImage,'combat.webp');assert.equal(manager.imageSource,'combatant');
        });
        await check('manager role and Actor authorization cannot be bypassed by combat visibility',()=>{
            assert.equal(readDisplayArtworkContext('p',{...target,purpose:'combat-portrait'}),null);
            assert.equal(readDisplayArtworkContext('other',target),null);
            assert.equal(readDisplayArtworkContext('unknown',{purpose:'actor-card',actorId:'a'}),null);
        });
        await check('encounter copies expose verified origin without rewriting Actor sources',async()=>{
            const uuid='Compendium.fixture.monsters.Actor.original';
            const copy={_id:'a',name:'Renamed #1',type:'npc',img:'portrait.webp',items:[],folder:'copies',ownership:{p:2},flags:{world:{sheetDelverCombatCopy:{combatId:'c',sourceUuid:uuid}}}};
            const encounter={...combat,flags:{world:{sheetDelverCombat:{...combat.flags.world.sheetDelverCombat,folderId:'copies',copyIds:['a']}}}};
            await actorStore.seed(async()=>[copy]);await combatStore.seed(async()=>[encounter]);combatEncounterReadModel.rebuildAll();
            const ctx=readDisplayArtworkContext('gm',{...target,purpose:'combat-portrait'})!;
            assert.equal((ctx as any).compendiumSourceUuid,uuid);
            assert.deepEqual(ctx.actor,actorStore.get('a'));assert.equal(ctx.actor._stats,undefined);
            for(const invalid of [
                {...copy,folder:'elsewhere'},
                {...copy,flags:{world:{sheetDelverCombatCopy:{combatId:'other',sourceUuid:uuid}}}},
                {...copy,flags:{world:{sheetDelverCombatCopy:{combatId:'c',sourceUuid:'Compendium.fixture.monsters.Item.original'}}}},
            ]) {
                await actorStore.seed(async()=>[invalid]);
                assert.equal((readDisplayArtworkContext('gm',target) as any)?.compendiumSourceUuid,undefined);
            }
            await actorStore.seed(async()=>[copy]);await combatStore.seed(async()=>[combat]);combatEncounterReadModel.rebuildAll();
            assert.equal((readDisplayArtworkContext('gm',target) as any)?.compendiumSourceUuid,undefined,'unregistered marker is not verified provenance');
        });
        await check('hidden and unstarted unauthorized combatants stay concealed',async()=>{
            await combatStore.seed(async()=>[{...combat,combatants:[{...combat.combatants[0],hidden:true}]}]);combatEncounterReadModel.rebuildAll();
            assert.equal(readDisplayArtworkContext('p',target),null);
            await combatStore.seed(async()=>[{...combat,round:0}]);combatEncounterReadModel.rebuildAll();
            assert.equal(readDisplayArtworkContext('p',target),null);
        });
    }finally{actorStore.clear();userStore.clear();sceneStore.clear();combatStore.clear();combatEncounterReadModel.clear();}
    console.log(`display-artwork: ${groups} groups passed`);
}
if(import.meta.url===`file://${process.argv[1]}`)run().catch(error=>{console.error(error);process.exitCode=1});
