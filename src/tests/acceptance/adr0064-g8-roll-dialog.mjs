/** Actual SDK-injected RollDialog; external browser tooling, no live services. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-g8-roll-'));
const bundle = await build({ stdin: { contents: `
import React,{useState,useRef} from 'react';import{createRoot}from'react-dom/client';
import{SDKComponentsContext,useSDKComponents}from'./src/shared/sdk/react';
import RollDialog from './src/client/ui/components/RollDialog';import{useModalFocus}from'./src/client/ui/hooks/useModalFocus';
function Parent({close}){const ref=useRef(null),[open,setOpen]=useState(false);useModalFocus(ref,true,close);const{RollDialog:R}=useSDKComponents();return <div ref={ref} role="dialog" aria-label="Resource card" tabIndex={-1}><button onClick={()=>setOpen(true)}>Card roll</button><R isOpen={open} type="ability" title="Nested roll" onClose={()=>setOpen(false)} onConfirm={()=>setOpen(false)}/></div>}
function App(){const[open,setOpen]=useState(false),[parent,setParent]=useState(false),[kind,setKind]=useState('ability');window.removeInvoker=()=>document.querySelector('#open').remove();return <SDKComponentsContext.Provider value={{RollDialog}}><div className="sd-ui-scope" data-theme={window.theme}><button id="open" onClick={()=>setOpen(true)}>Open roll</button><button onClick={()=>setParent(true)}>Open card</button><button onClick={()=>{setKind('initiative');setOpen(true)}}>Open initiative</button><button>Outside</button><RollDialog isOpen={open} type={kind} title="Test roll" combatantName="Hero" formula="1d20+0" source="module" audience="public" rollAvailable advantageAvailable manualAvailable defaults={{abilityBonus:2}} onClose={()=>setOpen(false)} onConfirm={value=>{window.result=value;setOpen(false)}}/>{parent&&<Parent close={()=>setParent(false)}/>}</div></SDKComponentsContext.Provider>};const root=createRoot(document.getElementById('root'));window.unmount=()=>root.unmount();root.render(<App/>);`, sourcefile: 'roll-fixture.tsx', resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env': '{"NODE_ENV":"development"}' } });
const css = await postcss([tailwind({ base: process.cwd() })]).process(fs.readFileSync('src/app/globals.css', 'utf8').replace('@import "tailwindcss";', '@import "tailwindcss" source(none);\n@source "../client/ui/components";'), { from: path.resolve('src/app/globals.css') });
const { chromium } = await import(process.env.SD_PLAYWRIGHT_MODULE);
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-background-networking'] });
const styles={};
try {
    for (const width of [320,390,820,1440]) for (const theme of ['light','dark']) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        await page.route('**/*', route => { assert.equal(new URL(route.request().url()).hostname, '127.0.0.1'); return route.fulfill({ contentType:'text/html', body:`<html><head><style>${css.css}</style></head><body data-sd-appearance="${theme}"><div id="root"></div><script>window.theme=${JSON.stringify(theme)}</script><script>${bundle.outputFiles[0].text}</script></body></html>` }); });
        await page.goto('http://127.0.0.1:31997/');
        const invoker=page.getByRole('button',{name:'Open roll',exact:true}); await invoker.focus(); await page.keyboard.press('Enter');
        const dialog=page.getByRole('dialog',{name:'Test roll',exact:true}); await dialog.waitFor();
        assert.ok(await dialog.evaluate(e=>e.contains(document.activeElement)), 'CR64-26 focus enters the shared sheet roller');
        for(const key of ['Tab','Shift+Tab']) for(let i=0;i<16;i++){await page.keyboard.press(key);assert.ok(await dialog.evaluate(e=>e.contains(document.activeElement)),key+' contained');}
        styles[theme]=await dialog.evaluate(e=>getComputedStyle(e).backgroundColor);assert.notEqual(styles[theme],'rgba(0, 0, 0, 0)');
        await page.screenshot({path:path.join(output,theme+'-'+width+'.png')});
        await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});assert.ok(await invoker.evaluate(e=>e===document.activeElement));
        await invoker.click(); await dialog.getByRole('button',{name:'Manual Input',exact:true}).click();
        await dialog.getByPlaceholder('Enter result...').fill('7');await dialog.getByRole('button',{name:'Send Result',exact:true}).click();
        assert.equal(await page.evaluate(()=>window.result.manualValue),7);assert.equal(await page.evaluate(()=>window.result.abilityBonus),2);
        await page.getByRole('button',{name:'Open initiative',exact:true}).click();await dialog.waitFor();
        for(let i=0;i<12;i++){await page.keyboard.press('Tab');assert.ok(await dialog.evaluate(e=>e.contains(document.activeElement)));}
        await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});
        await page.getByRole('button',{name:'Open card',exact:true}).click();const parent=page.getByRole('dialog',{name:'Resource card',exact:true});
        await parent.getByRole('button',{name:'Card roll',exact:true}).click();const nested=page.getByRole('dialog',{name:'Nested roll',exact:true});
        await nested.waitFor();await page.keyboard.press('Escape');await nested.waitFor({state:'detached'});assert.ok(await parent.isVisible());
        assert.equal(await parent.getByRole('button',{name:'Card roll',exact:true}).evaluate(e=>e===document.activeElement),true);
        await page.keyboard.press('Escape');await parent.waitFor({state:'detached'});
        assert.equal(await page.evaluate(()=>document.body.style.overflow),'');
        await page.reload();await page.getByRole('button',{name:'Open roll',exact:true}).click();await page.evaluate(()=>window.removeInvoker());
        await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});assert.equal(await page.evaluate(()=>document.body.style.overflow),'');
        await page.getByRole('button',{name:'Open card',exact:true}).click();await parent.getByRole('button',{name:'Card roll',exact:true}).click();await nested.waitFor();
        await page.evaluate(()=>window.unmount());assert.equal(await page.evaluate(()=>document.body.style.overflow),'','unmounting nested dialogs restores body scroll');
        await page.close();
    }
    assert.notEqual(styles.light,styles.dark,'both actual player themes activated');
    console.log('PASS: SDK RollDialog entry, bidirectional trap, Escape/return, manual, initiative, nested card, disconnected invoker; eight width/theme cases. '+output);
} finally { await browser.close(); }
