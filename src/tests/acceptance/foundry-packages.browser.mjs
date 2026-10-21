/** Isolated mounted SDK-hook checks. No server or Foundry connection.
 * PLAYWRIGHT_MODULE=<development install> CHROME=<binary> node <this file>
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { build } from 'esbuild';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = process.cwd();
const bundle = await build({stdin:{resolveDir:root,loader:'tsx',contents:`
import React from 'react';import {createRoot} from 'react-dom/client';
import {useFoundryPackages} from '${root}/src/shared/sdk/client-hooks';
const listeners=new Map();window.pending=[];
window.sdk={worldId:'one',moduleId:'fixture',currentUser:{id:'p',role:1},isConnected:true,
 fetchWithAuth:(_url,options)=>new Promise(resolve=>window.pending.push({resolve,signal:options.signal})),
 events:{on:(key,fn)=>{if(!listeners.has(key))listeners.set(key,new Set());listeners.get(key).add(fn);return()=>listeners.get(key).delete(fn)}}};
window.emit=key=>listeners.get(key)?.forEach(fn=>fn({revision:2}));
window.answer=(index,world='one')=>window.pending[index].resolve(Response.json({status:'ready',worldId:world,revision:index,system:{id:'fixture'},modules:[]}));
function Probe(){const state=useFoundryPackages();return <output>{JSON.stringify(state)}</output>}
const root=createRoot(document.getElementById('root'));window.render=()=>root.render(<Probe/>);window.unmount=()=>root.unmount();window.render();
`},bundle:true,write:false,format:'iife',platform:'browser',plugins:[{name:'sdk-boundary',setup(b){
 b.onResolve({filter:/^\.\/react$/},args=>args.importer.endsWith('client-hooks.ts')?{path:'sdk',namespace:'test'}:undefined);
 b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export const useSDK=()=>window.sdk; export const useSDKComponents=()=>({});'}));
}}]});
const browser=await chromium.launch({headless:true,...(process.env.CHROME?{executablePath:process.env.CHROME}:{}),args:['--no-sandbox','--disable-background-networking']});
try {
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>r.abort());
 await page.setContent('<div id="root"></div>');await page.addScriptTag({content:bundle.outputFiles[0].text});
 const count=async n=>page.waitForFunction(n=>window.pending.length===n,n);
 const state=async status=>page.waitForFunction(status=>JSON.parse(document.querySelector('output').textContent).status===status,status);
 await count(1);await page.evaluate(()=>{window.emit('world:packagesChanged');});await count(2);
 assert.equal(await page.evaluate(()=>window.pending[0].signal.aborted),true);
 await page.evaluate(()=>window.answer(1));await state('ready');await page.evaluate(()=>window.answer(0));
 assert.equal(await page.locator('output').textContent().then(JSON.parse).then(x=>x.revision),1);
 await page.evaluate(()=>{window.sdk={...window.sdk,worldId:'two'};window.render()});await count(3);await state('unavailable');
 await page.evaluate(()=>window.answer(2,'one'));await state('unavailable');
 await page.evaluate(()=>window.emit('world:ready'));await count(4);await page.evaluate(()=>window.answer(3,'two'));await state('ready');
 await page.evaluate(()=>{window.sdk={...window.sdk,currentUser:{id:'other',role:1}};window.render()});await count(5);await state('unavailable');
 await page.evaluate(()=>{window.sdk={...window.sdk,currentUser:{id:'other',role:4}};window.render()});await count(6);
 assert.equal(await page.evaluate(()=>window.pending[4].signal.aborted),true);
 await page.evaluate(()=>window.answer(5,'two'));await state('ready');
 await page.evaluate(()=>window.emit('world:teardown'));await state('unavailable');
 await page.evaluate(()=>{window.sdk={...window.sdk,isConnected:false};window.render()});await state('unavailable');
 await page.evaluate(()=>{window.sdk={...window.sdk,isConnected:true};window.render()});await count(7);
 await page.evaluate(()=>window.answer(6,'two'));await state('ready');
 await page.evaluate(()=>window.emit('world:contextChanged'));await count(8);await page.evaluate(()=>window.unmount());
 assert.equal(await page.evaluate(()=>window.pending[7].signal.aborted),true);
 await page.evaluate(()=>{window.answer(7,'two');window.emit('world:packagesChanged')});assert.equal(await page.evaluate(()=>window.pending.length),8);
 assert.deepEqual(errors,[]);console.log('PASS: package hook refresh, abort, late response, world/user/role, teardown, reconnect, unmount (8 requests)');
} finally {await browser.close()}
