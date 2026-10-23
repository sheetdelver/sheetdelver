/** Actual shared header, isolated browser and SDK seam. No app/Foundry service. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
const root=process.cwd(), out=process.argv[2]??'/tmp/sd-page-header';
await fs.mkdir(out,{recursive:true});
const {chromium}=await import(process.env.SHADOWDARK_PLAYWRIGHT_MODULE??'playwright');
const css=(await postcss([tailwind({base:root})]).process(await fs.readFile('src/app/globals.css','utf8'),{from:path.join(root,'src/app/globals.css')})).css;
const bundle=await build({stdin:{resolveDir:root,loader:'tsx',contents:`
import React from 'react';import{createRoot}from'react-dom/client';
import PageHeader from './src/client/ui/components/PageHeader';
import{SDKContext}from './src/shared/sdk/react';
const root=createRoot(document.getElementById('root'));window.props={};window.calls=[];
window.render=()=>root.render(<SDKContext.Provider value={{navigate:p=>window.calls.push(p)}}><PageHeader {...window.props}/></SDKContext.Provider>);
window.tool=theme=>{window.props={context:'Creating a character',theme,heading:{title:'Create Character',subtitle:'System',icon:<svg/>,actions:<button onClick={()=>window.calls.push('roll')}>Roll</button>}};window.render()};window.render();
`},bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic'});
const browser=await chromium.launch({headless:true,...(process.env.SHADOWDARK_CHROME?{executablePath:process.env.SHADOWDARK_CHROME}:{}),args:['--no-sandbox','--disable-background-networking']});
try {
 for(const width of [390,1280]) {
  const page=await browser.newPage({viewport:{width,height:500}});await page.route('**/*',r=>r.abort());
  await page.setContent('<body class="sd-player-root" data-sd-appearance="dark"><div id="root"></div></body>');await page.addStyleTag({content:css});await page.addScriptTag({content:bundle.outputFiles[0].text});
  const back=page.getByRole('button',{name:'Back to Dashboard'});await back.focus();await page.keyboard.press('Enter');assert.deepEqual(await page.evaluate(()=>window.calls),['/']);assert.equal(await page.getByRole('heading').count(),0);
  for(const [name,theme,color]of [['core',{},'rgba(20, 36, 56, 0.94)'],['shadowdark',{background:'#171717',foreground:'#fff',muted:'#a3a3a3'},'rgb(23, 23, 23)'],['custom',{background:'#ffe900',foreground:'#000',muted:'#171717'},'rgb(255, 233, 0)']]) {
   await page.evaluate(theme=>window.tool(theme),theme);await page.getByRole('heading',{name:'Create Character'}).waitFor();
   assert.equal(await page.locator('.sd-page-header').evaluate(e=>getComputedStyle(e).backgroundColor),color);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   await page.getByRole('button',{name:'Roll',exact:true}).click();assert.equal(await page.evaluate(()=>window.calls.at(-1)),'roll');
   await page.screenshot({path:path.join(out,`${name}-${width}.png`)});
  }
  await page.evaluate(()=>{window.props={context:'Sheet',onBack:()=>window.calls.push('confirm')};window.render()});await back.click();assert.equal(await page.evaluate(()=>window.calls.at(-1)),'confirm');assert.equal(await page.getByRole('heading').count(),0);
  await page.evaluate(()=>{window.props={};window.render()});await back.click();assert.equal(await page.evaluate(()=>window.calls.at(-1)),'/');
  await page.close();
 }
 console.log('Shared header: navigation, keyboard, tool actions, theme fallback/isolation and 390/1280 layout passed.');
}finally{await browser.close()}
