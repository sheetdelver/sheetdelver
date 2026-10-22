/** Mounted actual manager + production CSS; controlled API, no Foundry connection. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = process.cwd();
const output = process.env.COMBAT_UI_OUTPUT || '/tmp/combat-manager-settings';
await fs.mkdir(output, { recursive: true });
const source = await fs.readFile('src/client/ui/pages/CombatManagerPage.tsx', 'utf8');
const apiNames = [...new Set([...source.matchAll(/api\.(\w+)/g)].map(match => match[1]))];
const css = await postcss([tailwind({ base: root })]).process(await fs.readFile('src/app/globals.css', 'utf8'), { from: `${root}/src/app/globals.css` });
const bundle = await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import CombatManagerPage from '${root}/src/client/ui/pages/CombatManagerPage';
const listeners=new Map(); window.calls=[];
window.foundry={worldId:'fixture',system:{id:'fixture'},step:'dashboard',token:'fixture',currentUser:{id:'gm',role:4},
 appSocket:{connected:true,on:(key,fn)=>{if(!listeners.has(key))listeners.set(key,new Set());listeners.get(key).add(fn)},off:(key,fn)=>listeners.get(key)?.delete(fn)}};
window.emit=()=>listeners.get('combatChanged')?.forEach(fn=>fn({combatId:'c'}));
window.foundry.activeUIModule={info:{id:'fixture'},referenceViews:{Actor:{load:async()=>({default:()=> <p>Reference card</p>})}}};
window.fetch=async url=>Response.json(String(url).includes('compendium-reference')?{status:'resolved',moduleId:'fixture',reference:{documentType:'Actor',uuid:'Compendium.fixture.monsters.n'},title:'Giant reference',model:{}}:{status:'unavailable'});
window.portrait='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="100"><rect width="80" height="100" fill="tan"/><circle cx="40" cy="30" r="20" fill="black"/></svg>');
window.encounters=[{id:'c',label:'Evening encounter',status:'active',keepHistory:false,deletionRequested:false,round:0,
 currentCombatantId:null,canNavigateTurns:true,autoSkipDefeatedEnemies:false,
 playerActions:{initiativeOpen:false,endTurnEnabled:true,eligible:1,scored:1},
 participants:[{id:'r',actorId:'a',source:'world',actorType:'Player',isNpc:false,name:'Roke',img:null,initiative:12,hidden:false,defeated:false,skip:false,isCurrent:false,
 resource:null,effects:[],stats:[{title:'HP',value:3,subValue:'/3',showInRoster:true},{title:'AC',value:11,showInRoster:true}],
 initiativeRoll:{formula:'2d20kh1 + 3',source:'module',rollAvailable:true,advantageAvailable:true}}]}];
window.encounters[0].participants.push({...structuredClone(window.encounters[0].participants[0]),id:'n',actorId:'monster',actorType:'NPC',isNpc:false,name:'Giant',img:window.portrait,
 stats:[{title:'HP',value:34,subValue:'/34',showInRoster:true},{title:'Notes',value:'Monster description',multiline:true,layout:{columnSpan:3,rowSpan:2,textRows:8}}]});
window.preferences={source:'module',attributes:[],suggestions:[],available:[],initiativeFormula:null};
window.api={
 fetchManagedCombats:async()=>({encounters:structuredClone(window.encounters)}),
 fetchManagedActorPacks:async()=>({packs:[]}),
 searchManagedWorldActors:async()=>({actors:Array.from({length:20},(_,i)=>({id:'choice'+i,name:'Actor '+i,img:window.portrait,type:'NPC',source:'world'})),sortFields:[]}),
 postManagedInitiativeOne:async()=>({}),
 updateManagedCombatant:async(id,rowId,patch)=>Object.assign(window.encounters.find(e=>e.id===id).participants.find(r=>r.id===rowId),patch),
 fetchManagedStatPreferences:async()=>({preferences:structuredClone(window.preferences)}),
 saveManagedStatPreferences:async attributes=>{window.preferences={...window.preferences,attributes,source:'saved'};return {preferences:structuredClone(window.preferences)}},
 saveManagedInitiativeFallback:async formula=>{if(window.rejectFormula)throw Error('Fixture formula rejected');window.preferences.initiativeFormula=formula;return {preferences:structuredClone(window.preferences)}},
 updateManagedPlayerActions:async(id,patch)=>Object.assign(window.encounters.find(e=>e.id===id).playerActions,patch),
 updateManagedTurnPolicy:async(id,value)=>{window.encounters.find(e=>e.id===id).autoSkipDefeatedEnemies=value},
 createManagedCombat:async(label,keepHistory,autoSkipDefeatedEnemies)=>{if(window.rejectCreate)throw Error('Fixture creation rejected');const encounter={...structuredClone(window.encounters[0]),id:'new',label,keepHistory,autoSkipDefeatedEnemies,round:0,currentCombatantId:null,playerActions:{initiativeOpen:false,endTurnEnabled:true,eligible:0,scored:0},participants:[]};window.encounters.push(encounter);return {encounter}},
};
window.invoke=async(name,args)=>{window.calls.push({name,args});if(!window.api[name])throw Error('Unhandled fixture API '+name);return window.api[name](...args)};
const app=createRoot(document.getElementById('root')); window.render=()=>app.render(<CombatManagerPage/>);window.render();
` }, bundle: true, write: false, jsx: 'automatic', format: 'iife', platform: 'browser', plugins: [{ name: 'controlled-boundaries', setup(b) {
    b.onResolve({ filter: /(?:^|\/)FoundryContext$/ }, () => ({ path: 'foundry', namespace: 'fixture' }));
    b.onResolve({ filter: /api\/foundryApi$/ }, () => ({ path: 'api', namespace: 'fixture' }));
    b.onResolve({ filter: /^next\/link$/ }, () => ({ path: 'link', namespace: 'fixture' }));
    b.onResolve({ filter: /\/SurfaceHost$/ }, () => ({ path: 'surface', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ resolveDir: root, loader: 'tsx', contents: path === 'foundry'
        ? 'export const useFoundry=()=>window.foundry;'
        : path === 'surface' ? 'export const SurfaceHost=({children})=>children;'
        : path === 'api' ? apiNames.map(name => `export const ${name}=(...args)=>window.invoke('${name}',args);`).join('\n')
        : 'import React from "react"; export default function Link(props){return <a {...props}/>;}' }));
} }] });
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ['--no-sandbox','--disable-background-networking'] });
try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
    await page.setContent('<html><body data-sd-appearance="dark"><div id="root"></div></body></html>');
    await page.addStyleTag({ content: css.css }); await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const settings = page.getByRole('button', { name: 'Encounter settings', exact: true });
    const create = page.getByRole('button', { name: 'New encounter', exact: true });
    const dialog = page.getByRole('dialog');
    await page.getByRole('heading', { name: 'Initiative order', exact: true }).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Player participation' }).count(), 0);
    assert.equal(await page.getByLabel('Encounter name').count(), 0);
    assert.equal(await page.getByRole('heading', { name: 'Combat stat display' }).count(), 0);
    assert.ok((await page.getByRole('heading', { name: 'Initiative order' }).boundingBox()).y < 500, 'roster appears near the top');
    await page.screenshot({ path: `${output}/desktop-main.png` });
    // The GM's single-row choice is explicit even when the stored formula already has advantage.
    const reroll = page.getByRole('button', {name:'Reroll initiative for Roke',exact:true});
    assert.equal(await page.getByRole('button',{name:'Roll advantage',exact:true}).count(),0);
    assert.equal(await page.getByRole('link',{name:'Open Actor sheet ↗'}).count(),1);
    const initialCalls = await page.evaluate(()=>window.calls.filter(c=>c.name==='postManagedInitiativeOne').length);
    await reroll.click(); await dialog.waitFor();
    assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.name==='postManagedInitiativeOne').length),initialCalls);
    assert.equal(await dialog.getByLabel('Initiative formula').textContent(),'1d20 + 3');
    await page.screenshot({path:`${output}/initiative-dialog.png`});
    for (const [button,mode] of [['Roll normal','normal'],['Advantage','advantage'],['Disadvantage','disadvantage']]) {
        if (!await dialog.count()) await reroll.click();
        await dialog.getByRole('button',{name:button,exact:true}).click();
        await dialog.waitFor({state:'detached'});
        await page.waitForFunction(mode=>window.calls.filter(c=>c.name==='postManagedInitiativeOne').at(-1)?.args[2]===mode,mode);
        assert.deepEqual(await page.evaluate(()=>window.calls.filter(c=>c.name==='postManagedInitiativeOne').at(-1).args),['c','r',mode,{initiative:12,formula:'2d20kh1 + 3'}]);
    }
    await reroll.click(); await dialog.getByRole('button',{name:'Input Manually'}).click();
    await dialog.getByLabel('Final initiative total').fill('8.5');
    await dialog.getByRole('button',{name:'Submit total'}).click();
    await page.waitForFunction(()=>window.encounters[0].participants[0].initiative===8.5);
    assert.deepEqual(await page.evaluate(()=>window.calls.filter(c=>c.name==='updateManagedCombatant').at(-1).args),['c','r',{initiative:8.5,expectedInitiative:12}]);
    for (const field of ['formula','initiative']) {
        await reroll.click(); await dialog.waitFor();
        await page.evaluate(field=>{const row=window.encounters[0].participants[0];if(field==='formula')row.initiativeRoll.formula='1d20 + 4';else row.initiative=14;window.emit()},field);
        await dialog.waitFor({state:'detached'});
    }
    await page.evaluate(()=>{Object.assign(window.encounters[0].participants[0].initiativeRoll,{formula:'',rollAvailable:false,advantageAvailable:false});window.emit()});
    await reroll.click(); await dialog.getByLabel('Final initiative total').waitFor();
    assert.equal(await dialog.getByRole('button',{name:'Roll normal',exact:true}).count(),0);
    assert.equal(await dialog.getByRole('button',{name:'Advantage',exact:true}).count(),0);
    await page.keyboard.press('Escape');
    await page.getByRole('button').filter({hasText:'Giant'}).first().click();
    await page.getByRole('button',{name:'View reference',exact:true}).waitFor();
    assert.equal(await page.getByRole('link',{name:'Open Actor sheet ↗'}).count(),0,'owned NPC does not gain a character sheet link');
    const ref=page.getByRole('button',{name:'View reference',exact:true});
    const remove=page.getByRole('button',{name:'Remove participant',exact:true});
    assert.ok(Math.abs((await ref.boundingBox()).y-(await remove.boundingBox()).y)<5,'reference and removal share the detail header');
    await remove.click(); await page.getByRole('button',{name:'Cancel',exact:true}).waitFor(); await page.getByRole('button',{name:'Cancel',exact:true}).click();
    await page.getByLabel('Actor picker').locator('img').first().waitFor();
    const pickerBox=await page.getByLabel('Actor picker').boundingBox();
    assert.ok(pickerBox.height>320,'picker expands to the participant detail column');
    const giantSelect=page.getByRole('button').filter({hasText:'Giant'}).first();
    const imageBox=await giantSelect.locator('img').boundingBox();
    assert.ok(Math.abs(imageBox.height-(await giantSelect.boundingBox()).height)<=2.1,'portrait fills roster identity height inside its border');
    await page.screenshot({path:`${output}/desktop-roster.png`,fullPage:true});
    await page.setViewportSize({width:360,height:900});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile roster has no horizontal overflow');
    await page.getByRole('heading',{name:'Initiative order',exact:true}).scrollIntoViewIfNeeded();
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await page.screenshot({path:`${output}/mobile-roster.png`});
    await giantSelect.scrollIntoViewIfNeeded();
    assert.ok(await giantSelect.evaluate(node=>{const r=node.getBoundingClientRect();return node.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}),'mobile roster is not obscured');
    await page.setViewportSize({width:1440,height:1000});
    await settings.click(); await dialog.waitFor();
    assert.equal(await dialog.getByRole('heading', { name: 'Player participation' }).count(), 1);
    await dialog.getByRole('button', { name: 'Open player initiative', exact: true }).click();
    await dialog.getByRole('button', { name: 'Close player initiative', exact: true }).waitFor();
    await dialog.getByLabel('Allow owners to end their turn').uncheck();
    await page.waitForFunction(()=>window.encounters[0].playerActions.endTurnEnabled===false);
    await dialog.getByLabel('Skip defeated enemies automatically').check();
    await page.waitForFunction(()=>window.encounters[0].autoSkipDefeatedEnemies===true);
    await dialog.getByRole('button', { name: 'Configure stats', exact: true }).click();
    await dialog.getByRole('button', { name: 'Save', exact: true }).first().click();
    await page.waitForFunction(()=>window.preferences.source==='saved');
    await dialog.getByLabel('GM initiative override formula').fill('1d20 + 2');
    await page.evaluate(()=>window.rejectFormula=true);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await dialog.getByRole('alert').filter({hasText:'Fixture formula rejected'}).first().waitFor();
    await page.evaluate(()=>window.rejectFormula=false);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForFunction(()=>window.preferences.initiativeFormula==='1d20 + 2');
    // A realtime Begin removes the pre-start switch without closing settings.
    await page.evaluate(()=>{window.encounters[0].round=1;window.encounters[0].playerActions.initiativeOpen=false;window.emit()});
    await dialog.getByText(/including players added after it began/).waitFor();
    assert.equal(await dialog.getByRole('button', { name: /player initiative/ }).count(), 0);
    await page.screenshot({ path: `${output}/desktop-settings.png` });
    await page.keyboard.press('Escape'); await dialog.waitFor({state:'detached'});
    assert.equal(await settings.evaluate(node=>document.activeElement===node),true);
    await create.click(); await dialog.getByLabel('Encounter name').fill('Evening encounter');
    assert.equal(await dialog.getByRole('button', { name: 'Create', exact: true }).isDisabled(),true);
    await dialog.getByLabel('Encounter name').fill('Next encounter');
    await page.evaluate(()=>window.rejectCreate=true);
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await dialog.getByRole('alert').filter({hasText:'Fixture creation rejected'}).waitFor();
    await page.evaluate(()=>window.rejectCreate=false);
    await dialog.getByLabel('Keep for history').check();
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await dialog.waitFor({state:'detached'});
    assert.equal(await page.getByLabel('Encounter', {exact:true}).inputValue(),'new');
    assert.equal(await page.evaluate(()=>window.encounters[1].keepHistory),true);
    for (const width of [360,820]) {
        await page.setViewportSize({width,height:900}); await settings.click();
        await dialog.getByRole('heading', { name: 'Combat stat display' }).waitFor();
        await dialog.getByRole('button', { name: 'Configure stats', exact: true }).click();
        assert.ok(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth+1), `${width}: settings do not overflow horizontally`);
        await dialog.evaluate(node=>node.scrollTop=0);
        await page.screenshot({ path: `${output}/${width}-settings.png` });
        const controls=dialog.locator('button:visible:not(:disabled), input:visible:not(:disabled), select:visible:not(:disabled), textarea:visible:not(:disabled), a[href]:visible');
        await controls.last().focus(); await page.keyboard.press('Tab');
        assert.equal(await controls.first().evaluate(node=>document.activeElement===node),true);
        await page.keyboard.press('Escape'); await dialog.waitFor({state:'detached'});
        await create.click(); await dialog.waitFor();
        assert.ok(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth+1));
        await page.screenshot({path:`${output}/${width}-create.png`});
        await page.keyboard.press('Escape'); await dialog.waitFor({state:'detached'});
    }
    await settings.click();
    await page.evaluate(()=>{window.foundry={...window.foundry,worldId:'replacement'};window.render()});
    await dialog.waitFor({state:'detached'});
    assert.deepEqual(errors,[]);
    console.log('PASS: roster/reference/picker, manual/normal/advantage/disadvantage, stale initiative/formula, unsupported manual fallback; compact main, settings scopes, participation, realtime Begin, save/errors, creation/collision, focus/Tab/Escape, world retirement, 360/820/1440 layouts');
} finally { await browser.close(); }
