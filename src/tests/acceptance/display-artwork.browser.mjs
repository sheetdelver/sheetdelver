/** Actual Core image consumer with controlled auth/realtime boundary; no server. */
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=process.cwd();
const bundle=await build({stdin:{resolveDir:root,loader:'tsx',contents:`
import React from 'react';import{createRoot}from'react-dom/client';
import{DisplayArtwork}from'${root}/src/client/ui/components/DisplayArtwork';
const listeners=new Map();window.calls=[];
window.foundry={worldId:'w',step:'dashboard',currentUser:{_id:'p',role:3},appSocket:{connected:true,on:(key,fn)=>{if(!listeners.has(key))listeners.set(key,new Set());listeners.get(key).add(fn)},off:(key,fn)=>listeners.get(key)?.delete(fn)}};
window.emit=(key,value={})=>listeners.get(key)?.forEach(fn=>fn(value));
window.fetch=(_url,options)=>new Promise(resolve=>window.calls.push({resolve,signal:options.signal}));
window.props={src:'https://fixture/original.png',actorId:'a',combatId:'c',combatantId:'r',purpose:'combat-portrait'};
window.answer=(index,src='https://fixture/replacement.png',original='https://fixture/original.png')=>window.calls[index].resolve(Response.json({status:'resolved',src,original}));
const root=createRoot(document.getElementById('root'));window.render=()=>root.render(<DisplayArtwork {...window.props} fallback={<span>Fallback icon</span>}/>);window.unmount=()=>root.unmount();window.render();
`},bundle:true,write:false,format:'iife',platform:'browser',plugins:[{name:'test-foundry',setup(b){
 b.onResolve({filter:/context\/FoundryContext$/},()=>({path:'foundry',namespace:'test'}));
 b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export const useFoundry=()=>window.foundry;'}));
}}]});
const browser=await chromium.launch({headless:true,...(process.env.CHROME?{executablePath:process.env.CHROME}:{}),args:['--no-sandbox','--disable-background-networking']});
try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>'}));
 await page.setContent('<div id="root"></div>');await page.addScriptTag({content:bundle.outputFiles[0].text});
 const count=async n=>page.waitForFunction(n=>window.calls.length===n,n);
 const src=async value=>page.waitForFunction(value=>document.querySelector('img')?.src===value,value);
 await count(1);await src('https://fixture/original.png');
 await page.evaluate(()=>window.answer(0));await src('https://fixture/replacement.png');
 await page.locator('img').dispatchEvent('error');await src('https://fixture/original.png');
 await page.locator('img').dispatchEvent('error');assert.equal(await page.locator('img').count(),0);assert.match(await page.locator('body').innerText(),/Fallback icon/);
 await page.evaluate(()=>window.emit('worldPackagesChanged'));await count(2);await src('https://fixture/original.png');
 await page.evaluate(()=>{window.props={...window.props,src:'https://fixture/custom.png'};window.render()});await count(3);
 assert.equal(await page.evaluate(()=>window.calls[1].signal.aborted),true);
 await page.evaluate(()=>window.answer(1));await src('https://fixture/custom.png');
 await page.evaluate(()=>window.answer(2,'https://fixture/replacement.png'));await src('https://fixture/custom.png');
 await page.evaluate(()=>{window.foundry={...window.foundry,currentUser:{id:'other',role:1}};window.render()});await count(4);
 await page.evaluate(()=>window.answer(3,'https://fixture/other.png','https://fixture/custom.png'));await src('https://fixture/other.png');
 await page.evaluate(()=>window.emit('disconnect'));await src('https://fixture/custom.png');
 await page.evaluate(()=>window.emit('connect'));await count(5);
 await page.evaluate(()=>{window.foundry={...window.foundry,worldId:'next'};window.render()});await count(6);
 await page.evaluate(()=>{window.answer(4,'https://fixture/old-world.png','https://fixture/custom.png');window.unmount()});
 assert.equal(await page.evaluate(()=>window.calls[5].signal.aborted),true);assert.deepEqual(errors,[]);
 console.log('PASS: immediate original, replacement, two-stage failure, settings, source mismatch, user/world, disconnect/reconnect and unmount (6 requests)');
}finally{await browser.close()}
