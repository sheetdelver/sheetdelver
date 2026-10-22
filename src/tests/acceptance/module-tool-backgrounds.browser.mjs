/** Isolated shared player canvas, actual dashboard/combat/tool pages and SurfaceHost.
 * Registry, dashboard content, SDK and world are fixtures; no live Foundry.
 * SD_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs SD_CHROME=/path/to/chromium node src/tests/acceptance/module-tool-backgrounds.browser.mjs
 * --baseline renders HEAD's pre-correction host/router to establish the regression.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
const { chromium } = await import(process.env.SD_PLAYWRIGHT_MODULE || 'playwright');
const stubs = new Map([
    ['@client/ui/context/FoundryContext', 'export const useFoundry=()=>window.world;'],
    ['@client/ui/providers/SDKProvider', 'export const SDKProvider=({children})=>children;'],
    ['@client/ui/components/LoadingModal', 'export default function Loading(){return <p role="status">Loading tool</p>}'],
    ['@client/ui/context/ActorCombatContext', 'export const useActorCombat=()=>({ownedActors:[],fetchActors(){}});'],
    ['@client/ui/context/ConfigContext', 'export const useConfig=()=>({});'],
    ['./views/DashboardView', 'export const DashboardView=()=> <p>Dashboard content fixture</p>;'],
    ['next/link', 'export default function Link({children,...props}){return <a {...props}>{children}</a>}'],
    ['next/navigation', 'export const useRouter=()=>({push(){}});'],
    ['@modules/registry/client', 'export const getUIModule=()=>new Promise(resolve=>window.resolveManifest=resolve);'],
]);
const bundle = await build({ stdin: { contents: `
import React from 'react';import {createRoot} from 'react-dom/client';
import Tool from './src/client/ui/pages/ToolPageRouter';
import {PlayerPageBackground} from './src/client/ui/components/PlayerPageBackground';
import {SurfaceHost} from './src/client/ui/components/SurfaceHost';
import Dashboard from './src/client/ui/main/MainPage';
import CombatManager from './src/client/ui/pages/CombatManagerPage';
const NativeImage=window.Image;window.imageLoads=0;window.Image=class extends NativeImage{constructor(){super();window.imageLoads++}};
window.world={worldId:'a',step:'dashboard',system:{status:'active'},users:[],currentUser:{id:'p',role:1}};
const root=createRoot(document.getElementById('root'));let params=Promise.resolve({systemId:'fixture',toolId:'one'});
window.render=()=>root.render(<PlayerPageBackground>{window.mode==='new'?<article id="new-page" style={{height:5000}}>New page without background code</article>:window.mode==='actor'?<SurfaceHost moduleId="fixture" surface="actorPage"><article>Module sheet fixture</article></SurfaceHost>:window.mode==='dashboard'?<Dashboard/>:window.mode==='combat'?<CombatManager/>:<Tool params={params}/>}</PlayerPageBackground>);
window.tool=()=>Promise.resolve({default:()=> <main id="tool">Ready tool</main>});
window.route=()=>{params=Promise.resolve({systemId:'fixture',toolId:'missing'});window.render()};
window.render();`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' }, plugins: [{ name: 'controlled-host', setup(b) {
        b.onResolve({ filter: /.*/ }, a => stubs.has(a.path) ? { path: a.path, namespace: 'fixture' } : undefined);
        b.onLoad({ filter: /.*/, namespace: 'fixture' }, a => ({ contents: stubs.get(a.path), loader: 'tsx', resolveDir: process.cwd() }));
        if (process.argv.includes('--baseline')) b.onLoad({ filter: /(?:SurfaceHost|ToolPageRouter)\.tsx$/ }, a => ({ contents: execFileSync('git', ['show', `HEAD:${path.relative(process.cwd(), a.path)}`], {encoding:'utf8'}), loader:'tsx', resolveDir:path.dirname(a.path) }));
    } }],
});
const css = await postcss([tailwind({base:process.cwd()})]).process(fs.readFileSync('src/app/globals.css','utf8').replace('@import "tailwindcss";', '@import "tailwindcss" source(none);\n@source "../client/ui/components";\n@source "../client/ui/pages";'), {from:path.resolve('src/app/globals.css')});
const browser=await chromium.launch({executablePath:process.env.SD_CHROME,headless:true,args:['--no-sandbox','--disable-background-networking']});
try {
    const page=await browser.newPage();
    await page.route('**/*',r=>r.abort());
    await page.setContent(`<style>${css.css}</style><style id="module-color"></style><div class="sd-player-root" data-sd-appearance="dark"><div id="root"></div></div>`);
    await page.addScriptTag({content:bundle.outputFiles[0].text});
    await page.waitForFunction(()=>typeof window.resolveManifest==='function');
    const canvas=page.locator('[data-sd-surface="tools"]');
    assert.equal(await canvas.count(),1,'loading tools must have the shared background');
    const background=()=>canvas.evaluate(e=>({color:getComputedStyle(e).backgroundColor,image:getComputedStyle(e).backgroundImage}));
    assert.equal((await background()).color,'rgb(16, 32, 55)');
    await page.evaluate(()=>window.resolveManifest({tools:{one:window.tool}}));
    await page.locator('#tool').waitFor();
    assert.equal((await background()).color,'rgb(16, 32, 55)');
    await page.evaluate(()=>document.querySelector('[data-sd-appearance]').dataset.sdAppearance='light');
    assert.equal((await background()).color,'rgb(234, 241, 248)');
    await page.evaluate(()=>document.querySelector('#module-color').textContent='.sdk-module--fixture { --sd-module-page-background: #492345; }');
    assert.equal((await background()).color,'rgb(73, 35, 69)');
    const art='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="red"/><rect width="400" height="600" fill="blue"/><circle cx="400" cy="300" r="120" fill="gold"/></svg>');
    await page.evaluate(art=>{window.world.system.worldBackground=art;window.render()},art);
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('[data-sd-surface="tools"]')).backgroundImage.includes('data:image'));
    assert.equal((await background()).color,'rgb(73, 35, 69)','module color remains below world artwork');
    // The same viewport must show the same image, regardless of document height.
    // A nonuniform image catches cover zoom/cropping that a solid color cannot.
    for (const viewport of [{width:1280,height:800},{width:390,height:844}]) {
        await page.setViewportSize(viewport);
        await page.locator('#tool').evaluate(e=>{e.style.visibility='hidden';e.style.height='20px'});
        await page.evaluate(()=>window.scrollTo(0,0));
        const short=await page.screenshot();
        await page.locator('#tool').evaluate(e=>e.style.height='5000px');
        const tall=await page.screenshot();
        assert.ok(short.equals(tall),`world artwork must not zoom when content grows (${viewport.width}px)`);
        await page.evaluate(()=>window.scrollTo(0,2100));
        await page.waitForFunction(()=>window.scrollY===2100);
        const scrolled=await page.screenshot();
        // Chromium can dither image edges differently after scrolling. Compare
        // decoded pixels with a sub-channel tolerance rather than PNG bytes.
        const difference=await page.evaluate(async images=>{
            const pixels=await Promise.all(images.map(async src=>{
                const image=new Image(); image.src=src; await image.decode();
                const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
                const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
                return ctx.getImageData(0,0,image.width,image.height).data;
            }));
            return pixels[0].reduce((sum,value,index)=>sum+Math.abs(value-pixels[1][index]),0)/pixels[0].length;
        },[short,scrolled].map(buffer=>'data:image/png;base64,'+buffer.toString('base64')));
        assert.ok(difference<0.2,`world artwork must stay viewport-sized while scrolling (${viewport.width}px; mean channel difference ${difference})`);
    }
    await page.locator('#tool').evaluate(e=>{e.style.visibility='visible';e.style.height='20px'});
    await page.evaluate(()=>window.scrollTo(0,0));
    const imageLoads=await page.evaluate(()=>window.imageLoads);
    for(const mode of ['dashboard','combat','actor','new']) {
        await page.evaluate(mode=>{window.mode=mode;window.render()},mode);
        await page.waitForFunction(mode=>mode==='actor'?!!document.querySelector('[data-sd-surface="actorPage"]'):mode==='new'?!!document.querySelector('#new-page'):!!document.querySelector('main'),mode);
        const shared=await page.locator('[data-sd-player-background]').evaluate(e=>({image:getComputedStyle(e).backgroundImage,attachment:getComputedStyle(e).backgroundAttachment}));
        assert.ok(shared.image.includes('data:image'),mode+' inherits world artwork');
        assert.ok(shared.attachment.split(',').every(value=>value.trim()==='fixed'),mode+' inherits viewport anchoring');
        if(mode==='actor') {
            assert.equal(await page.locator('[data-sd-surface="actorPage"]').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(73, 35, 69)','module sheet shares optional canvas color');
        } else if(mode!=='new') {
            assert.equal(await page.locator('main').evaluate(e=>getComputedStyle(e).backgroundImage),shared.image,mode+' canvas cannot obscure world artwork');
        }
        assert.equal(await page.evaluate(()=>window.imageLoads),imageLoads,'route changes must not create another background loader');
    }
    await page.evaluate(()=>{window.mode='tool';window.resolveManifest=null;window.render()});
    await page.waitForFunction(()=>typeof window.resolveManifest==='function');
    await page.evaluate(()=>window.resolveManifest({tools:{one:window.tool}}));
    await page.locator('#tool').waitFor();
    await page.evaluate(()=>{window.world={worldId:'b',step:'dashboard',system:{status:'active',worldBackground:'https://invalid.test/missing.png'}};window.render()});
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('[data-sd-surface="tools"]')).backgroundImage==='none');
    assert.equal((await background()).color,'rgb(73, 35, 69)','unavailable artwork falls back to module color');
    await page.evaluate(art=>{window.world.system.coreFallbackBackground=art;window.render()},art);
    assert.equal((await background()).image,'none','Foundry setup artwork must not replace the requested color fallback');
    await page.evaluate(art=>{window.world.system.worldBackground=art;window.render()},art);
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('[data-sd-surface="tools"]')).backgroundImage.includes('data:image'));
    await page.evaluate(()=>{window.world.system.status='setup';window.render()});
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('[data-sd-surface="tools"]')).backgroundImage==='none');
    await page.evaluate(()=>{window.resolveManifest=null;window.route()});
    await page.waitForFunction(()=>typeof window.resolveManifest==='function');
    await page.evaluate(()=>window.resolveManifest({tools:{}}));
    await page.getByText('Error Loading Tool',{exact:true}).waitFor();
    assert.equal((await background()).color,'rgb(73, 35, 69)','resolution errors retain the canvas');
    console.log('PASS tool backgrounds: loading, ready, light/dark, module color, world art, missing art, no Foundry setup-image substitution, world retirement, missing tool, short/long/scrolled viewport image parity, dashboard/combat/module sheet/new-route inheritance');
} finally {await browser.close()}
