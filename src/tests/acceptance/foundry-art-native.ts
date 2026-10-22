/** Source-only native comparison. Pass --reference=/path/to/compendium-art.mjs.
 * Evaluates the selected native methods with controlled documents, never a server.
 * Native copyrighted source is read locally, not copied into the repository.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {FoundryPackageService} from '../../server/services/world/FoundryPackageService';
import type {ModuleWorldContext} from '../../shared/sdk/world';
const reference=process.argv.find(value=>value.startsWith('--reference='))?.slice(12);
assert.ok(reference,'--reference required');
const source=fs.readFileSync(reference,'utf8');
const methodSource=source.replace(/^import .*;\r?\n/gm,'').replace('export default class CompendiumArt','globalThis.CompendiumArt = class CompendiumArt');
const generation=source.includes('applyArt(documentClass')?14:13;
const uuid='Compendium.fixture.monsters.Actor.monster';
const modules=['first','second'].map(id=>({id,title:id,active:true,flags:{compendiumArtMappings:{fixture:{mapping:`modules/${id}/mapping.json`}}}}));
const mappings=Object.fromEntries(modules.map(pkg=>[`modules/${pkg.id}/mapping.json`,{'fixture.monsters':{monster:{actor:`modules/${pkg.id}/portrait.webp`,token:{texture:{src:`modules/${pkg.id}/token.webp`}}}}}]));
let cases=0;
for(const preferences of [{},{second:{priority:-10}},{first:{portraits:false}},{first:{tokens:false}},{first:{portraits:false,tokens:false}},{first:{priority:2},second:{priority:1}}]){
 for(const kind of ['image','token'] as const){
  class System {id='fixture';flags={};}
  const entries=new Map([[uuid,{uuid,img:'default'}]]);
  const game={system:new System(),modules:Object.assign([...modules],{get:(id: string)=>modules.find(pkg=>pkg.id===id)}),settings:{get:()=>structuredClone(preferences)},packs:new Map([['fixture.monsters',{documentName:'Actor',getUuid:()=>uuid,index:new Map([['monster',entries.get(uuid)]])}]])};
  const failures: unknown[]=[];
  const context=vm.createContext({game,foundry:{packages:{System},utils:{mergeObject:Object.assign,fetchJsonWithTimeout:async (key: keyof typeof mappings)=>structuredClone(mappings[key])}},CONST:{SORT_INTEGER_DENSITY:100000},Hooks:{onError:(_name: string,error: unknown)=>failures.push(error)},fromUuidSync:(id: string)=>entries.get(id)});
  vm.runInContext(methodSource,context);const native=new context.CompendiumArt();await native._registerArt();assert.deepEqual(failures,[]);
  const service=new FoundryPackageService({isReady:()=>true,getValueByKey:()=>preferences},{listPackMetadata:()=>[],getPackMetadata:()=>({id:'fixture.monsters',type:'Actor'})},async url=>Response.json(mappings[new URL(String(url)).pathname.slice(1) as keyof typeof mappings]));
  service.configure('https://fixture.example/',{world:{id:'w'},system:{id:'fixture'},modules});
  const handle=service.handle({snapshot:()=>({identity:{contextRevision:1,foundryGeneration:generation}}),assertRevision:()=>{}} as unknown as ModuleWorldContext);
  const actual=await handle.resolve(uuid,kind), expected=kind==='image'?(generation===13?native.get(uuid)?.actor:native.get(uuid)?.img):native.get(uuid)?.token?.texture?.src;
  assert.equal(actual.status,expected?'resolved':'none');if(actual.status==='resolved')assert.equal(actual.src,`https://fixture.example/${expected}`);
  cases++;
 }
}
console.log(JSON.stringify({reference,generation,sha256:createHash('sha256').update(source).digest('hex'),cases,nativeConnection:false}));
