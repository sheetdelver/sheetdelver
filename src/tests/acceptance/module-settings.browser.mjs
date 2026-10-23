/** Actual settings dialog/SurfaceHost/confirmation with controlled providers; no Core or Foundry. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';

export async function settingsFixture() {
    const root = process.cwd();
    const css = await postcss([tailwind({ base: root })]).process(await fs.readFile('src/app/globals.css', 'utf8'), { from: `${root}/src/app/globals.css` });
    const bundle = await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
import React,{useState,useLayoutEffect} from 'react'; import {createRoot} from 'react-dom/client';
import {PlayerSettingsDialog} from '${root}/src/client/ui/components/Settings/PlayerSettingsDialog';
import {ConfirmationModal} from '${root}/src/client/ui/components/ConfirmationModal';
import * as sdk from '${root}/src/shared/sdk/index'; import * as sdkReact from '${root}/src/shared/sdk/entry-react';
import * as ReactJSX from 'react/jsx-runtime';
import {SDKProvider} from '${root}/src/client/ui/providers/SDKProvider';
window.__SD={React,ReactJSX,sdk,sdkReact};
window.sdkOverrides={};window.sdkComponents={LoadingModal:()=>null,RollDialog:()=>null,ConfirmationModal:()=>null,SharedContentModal:()=>null};
window.mountPilot=Component=>{const node=document.createElement('div');node.id='pilot';document.body.appendChild(node);createRoot(node).render(<SDKProvider moduleId="shadowdark"><Component actorId="pilot"/></SDKProvider>)};
window.state={isSettingsOpen:false,token:'fixture',step:'dashboard',sessionEpoch:1,currentUser:{id:'user',role:4},worldId:'world',system:{id:'fixture'}};
const listeners=new Map();window.state.appSocket={on:(key,fn)=>{if(!listeners.has(key))listeners.set(key,new Set());listeners.get(key).add(fn)},off:(key,fn)=>listeners.get(key)?.delete(fn)};
window.emit=(key,moduleId='fixture')=>listeners.get(key)?.forEach(fn=>fn({moduleId}));
window.setSettingsOpen=open=>{window.state.isSettingsOpen=open;window.render()};
window.loads=[];window.sessions=[];window.cleanup=[];
const schema=[{key:'enabled',type:'boolean',default:false}];
function Preferences({signal,onDirtyChange}) {
 const settings=sdkReact.useModuleSettings(schema);const context=sdkReact.useSDK();
 const [draft,setDraft]=useState('');const [error,setError]=useState('');
 useLayoutEffect(()=>{window.sessions.push({signal,onDirtyChange});return()=>window.cleanup.push({signal,aborted:signal.aborted})},[signal,onDirtyChange]);
 return <section><h3>Module preferences</h3><output data-testid="identity">{context.worldId+':'+context.moduleId}</output>
 <label><input type="checkbox" checked={settings.get('enabled',false)} onChange={e=>{if(!signal.aborted)try{settings.set('enabled',e.target.checked)}catch(e){setError(e.message)}}}/>Immediate preference</label>
 <input aria-label="Draft" value={draft} onChange={e=>{setDraft(e.target.value);onDirtyChange(true)}}/>
 <button onClick={()=>{window.finishSave=success=>{if(signal.aborted)return;if(success){onDirtyChange(false);setError('')}else setError('Save failed')};}}>Save draft</button>
 <button onClick={()=>{setDraft('');onDirtyChange(false)}}>Discard draft</button>
 <button onClick={()=>{if(!signal.aborted)try{settings.reset()}catch(e){setError(e.message)}}}>Reset preference</button>
 {(error||settings.error)&&<p role="alert">{error||settings.error.message}</p>}</section>;
}
function GMPanel(props){useLayoutEffect(()=>{window.sessions.push(props);return()=>window.cleanup.push({signal:props.signal,aborted:props.signal.aborted})},[props.signal]);if(window.crashPanel)throw Error('fixture crash');return <><h3>GM options</h3><input aria-label="GM draft" onChange={()=>props.onDirtyChange(true)}/></>}
window.defaultManifest={info:{id:'fixture',title:'Fixture System',manifest:{ui:'',logic:''}},sheet:async()=>({default:()=>null}),settingsTabs:[
 {id:'sheet',label:'Sheet',load:()=>{window.loads.push('sheet');return window.slowLoad?new Promise(resolve=>window.resolveSlow=()=>resolve({default:Preferences})):Promise.resolve({default:Preferences})}},
 {id:'gm',label:'GM Options',audience:'gm',load:async()=>{window.loads.push('gm');if(window.failLoad)throw Error('fixture import failed');return {default:GMPanel}}}]};
window.manifest=window.defaultManifest;
function App(){return <><button onClick={()=>window.setSettingsOpen(true)}>Open settings</button>
 <button onClick={()=>{window.state.ordinaryConfirmation=true;window.render()}}>Open ordinary confirmation</button>
 <PlayerSettingsDialog/><ConfirmationModal isOpen={!!window.state.ordinaryConfirmation} topLayer={!!window.state.ordinaryTopLayer}
 title="Ordinary confirmation" message="Confirm this action?" onConfirm={()=>{window.state.ordinaryConfirmation=false;window.render()}}
 onCancel={()=>{window.state.ordinaryConfirmation=false;window.render()}}/></>}
const app=createRoot(document.getElementById('root'));window.unmountFixture=()=>app.unmount();window.render=()=>app.render(<React.StrictMode><App/></React.StrictMode>);window.render();
` }, bundle: true, write: false, jsx: 'automatic', format: 'iife', platform: 'browser', plugins: [{ name: 'controlled-settings-boundaries', setup(b) {
        b.onResolve({ filter: /(?:^|\/)(UIContext|SessionContext|FoundryContext|ChatContext|PlayerAppearanceContext)$/ }, ({ path }) => ({ path: path.split('/').at(-1), namespace: 'fixture' }));
        b.onResolve({ filter: /^@modules\/registry\/client$/ }, () => ({ path: 'registry', namespace: 'fixture' }));
        b.onResolve({ filter: /\/SDKProvider$/ }, () => ({ path: 'sdk-provider', namespace: 'fixture' }));
        b.onResolve({ filter: /\/DiceSettingsPanel$/ }, () => ({ path: 'dice', namespace: 'fixture' }));
        b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ resolveDir: root, loader: 'tsx', contents:
            path === 'registry' ? 'export const getUIModule=async()=>window.manifest;'
            : path === 'sdk-provider' ? `import {SDKContext,SDKComponentsContext} from '${root}/src/shared/sdk/react';export const SDKProvider=({moduleId,children})=><SDKContext.Provider value={{worldId:window.state.worldId,moduleId,...window.sdkOverrides}}><SDKComponentsContext.Provider value={window.sdkComponents}>{children}</SDKComponentsContext.Provider></SDKContext.Provider>;`
            : path === 'UIContext' ? 'export const useUI=()=>({...window.state,setSettingsOpen:window.setSettingsOpen});'
            : path === 'SessionContext' ? 'export const useSession=()=>window.state;'
            : path === 'FoundryContext' ? 'export const useFoundry=()=>window.state;'
            : path === 'ChatContext' ? 'export const useChat=()=>({toastSettings:{enabled:true,durationMs:4000},setToastSettings(){}});'
            : path === 'PlayerAppearanceContext' ? 'export const usePlayerAppearance=()=>({appearance:"dark",setAppearance(){}});'
            : 'export const DiceSettingsPanel=()=> <p>Dice settings fixture</p>;' }));
    } }] });
    return { css: css.css, js: bundle.outputFiles[0].text };
}

export async function mountSettingsFixture(page, fixture) {
    await page.route('http://settings.fixture/**', route => route.fulfill({ contentType: 'text/html', body: '<html><body data-sd-appearance="dark"><div id="root"></div></body></html>' }));
    await page.goto('http://settings.fixture/');
    await page.addStyleTag({ content: fixture.css });
    await page.addScriptTag({ content: fixture.js });
    await page.getByRole('button', { name: 'Open settings', exact: true }).waitFor();
}

/** R72-01: restoration depends on the last owner, including parent-first teardown. */
async function verifyScrollCleanup(browser, fixture) {
    const settled = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const overflow = page => page.evaluate(() => document.body.style.overflow);
    for (const original of ['', 'scroll', 'hidden']) {
        const priority = original === 'scroll' ? 'important' : '';
        for (const scenario of ['clean-done', 'discard-done', 'world', 'logout', 'module', 'unload', 'unmount', 'continue-editing', 'discard-tab']) {
            const page = await browser.newPage();
            try {
                await mountSettingsFixture(page, fixture);
                await page.evaluate(({ original, priority }) => {
                    document.body.style.setProperty('overflow', original, priority);
                    const content = document.createElement('div'); content.style.height = '2400px'; document.body.appendChild(content);
                }, { original, priority });
                const opener = page.getByRole('button', { name: 'Open settings', exact: true });
                await opener.click();
                const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
                const confirmation = page.getByRole('alertdialog');
                assert.equal(await overflow(page), 'hidden', `${scenario}: settings locks scrolling`);
                if (scenario === 'clean-done') await page.getByRole('button', { name: 'Done', exact: true }).click();
                else {
                    await page.getByRole('tab', { name: 'Sheet', exact: true }).click();
                    await page.getByLabel('Draft', { exact: true }).fill('unsaved');
                    if (scenario === 'discard-tab') await page.getByRole('tab', { name: 'Themes', exact: true }).click();
                    else await page.getByRole('button', { name: 'Done', exact: true }).click();
                    await confirmation.waitFor();
                    assert.equal(await page.locator('dialog[open]').count(), 2);
                    assert.equal(await overflow(page), 'hidden');
                    if (scenario === 'continue-editing') {
                        await page.getByRole('button', { name: 'Continue editing', exact: true }).click();
                        await confirmation.waitFor({ state: 'detached' }); await settled(page);
                        assert.equal(await overflow(page), 'hidden', 'cancelling child retains the parent lock');
                        assert.equal(await page.getByLabel('Draft', { exact: true }).inputValue(), 'unsaved');
                        assert.equal(await page.getByRole('button', { name: 'Done', exact: true }).evaluate(el => el === document.activeElement), true);
                        await page.getByRole('button', { name: 'Done', exact: true }).click();
                        await page.getByRole('button', { name: 'Discard', exact: true }).click();
                    } else if (scenario === 'discard-tab') {
                        await page.getByRole('button', { name: 'Discard', exact: true }).click();
                        await confirmation.waitFor({ state: 'detached' }); await settled(page);
                        assert.equal(await overflow(page), 'hidden', 'tab navigation retains the settings lock');
                        assert.equal(await page.getByRole('tab', { name: 'Themes', exact: true }).getAttribute('aria-selected'), 'true');
                        await page.getByRole('button', { name: 'Done', exact: true }).click();
                    } else if (scenario === 'discard-done') await page.getByRole('button', { name: 'Discard', exact: true }).click();
                    else await page.evaluate(scenario => {
                        if (scenario === 'unmount') { window.unmountFixture(); return; }
                        if (scenario === 'world') window.state.worldId = 'changed-world';
                        if (scenario === 'logout') { window.state.token = null; window.state.sessionEpoch++; }
                        if (scenario === 'module') window.state.system = { id: 'changed-module' };
                        if (scenario === 'unload') window.emit('moduleStateChanged');
                        window.render();
                    }, scenario);
                }
                await settings.waitFor({ state: 'detached' }); await settled(page);
                assert.equal(await page.locator('dialog[open]').count(), 0);
                assert.equal(await confirmation.count(), 0);
                assert.equal(await overflow(page), original, `R72-01 ${scenario}: restore original ${JSON.stringify(original)}`);
                assert.equal(await page.evaluate(() => document.body.style.getPropertyPriority('overflow')), priority);
                await page.mouse.move(100, 500); await page.mouse.wheel(0, 250);
                if (original === 'hidden') {
                    await settled(page);
                    assert.equal(await page.evaluate(() => scrollY), 0, 'preserve a pre-existing scroll lock');
                } else await page.waitForFunction(() => scrollY > 0, undefined, { timeout: 2000 });
                if (['clean-done', 'discard-done', 'continue-editing', 'discard-tab'].includes(scenario)) {
                    assert.equal(await opener.evaluate(el => el === document.activeElement), true);
                    // A new ownership cycle must not capture a stale value from the first.
                    await opener.click(); await page.getByRole('button', { name: 'Done', exact: true }).click();
                    await settings.waitFor({ state: 'detached' }); await settled(page);
                    assert.equal(await overflow(page), original, 'reopening restores the same original value');
                }
            } finally { await page.close(); }
        }
        for (const topLayer of [false, true]) {
            const page = await browser.newPage();
            try {
                await mountSettingsFixture(page, fixture);
                await page.evaluate(({ original, priority, topLayer }) => { document.body.style.setProperty('overflow', original, priority); window.state.ordinaryTopLayer = topLayer; }, { original, priority, topLayer });
                const opener = page.getByRole('button', { name: 'Open ordinary confirmation', exact: true });
                for (const action of ['Confirm', 'Cancel']) {
                    await opener.click();
                    const confirmation = page.getByRole('alertdialog', { name: 'Ordinary confirmation', exact: true });
                    await confirmation.waitFor();
                    assert.equal(await overflow(page), 'hidden');
                    assert.equal(await page.locator('dialog[open]').count(), topLayer ? 1 : 0, 'legacy confirmation keeps its overlay');
                    await confirmation.getByRole('button', { name: action, exact: true }).click();
                    await confirmation.waitFor({ state: 'detached' }); await settled(page);
                    assert.equal(await overflow(page), original, `ordinary confirmation (${topLayer}): restore original`);
                    assert.equal(await page.evaluate(() => document.body.style.getPropertyPriority('overflow')), priority);
                    if (topLayer) assert.equal(await opener.evaluate(el => el === document.activeElement), true);
                }
            } finally { await page.close(); }
        }
    }
    console.log('R72-01 scroll cleanup passed: discard/forced retirement, retained parent, reopen, original overflow and ordinary confirmations');
}

async function run() {
    const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
    const fixture = await settingsFixture();
    const output = process.env.SETTINGS_UI_OUTPUT || '/tmp/sd-module-settings';
    await fs.mkdir(output, { recursive: true });
    const browser = await chromium.launch({ headless: true, ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ['--no-sandbox', '--disable-background-networking'] });
    try {
        const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        await mountSettingsFixture(page, fixture);
        const open = () => page.getByRole('button', { name: 'Open settings', exact: true }).click();
        const tab = name => page.getByRole('tab', { name, exact: true });
        const confirmation = page.getByRole('alertdialog');
        await open();
        assert.deepEqual(await page.evaluate(() => window.loads), [], 'registration does not load panels');
        await tab('Chat & Rolls').focus(); await page.keyboard.press('ArrowRight');
        assert.equal(await tab('Themes').evaluate(el => el === document.activeElement), true);
        assert.equal(await tab('Chat & Rolls').getAttribute('aria-selected'), 'true', 'arrows only move focus');
        await page.keyboard.press('End'); assert.equal(await tab('GM Options').evaluate(el => el === document.activeElement), true);
        await page.keyboard.press('Home'); assert.equal(await tab('Chat & Rolls').evaluate(el => el === document.activeElement), true);
        await tab('Sheet').click(); await page.getByLabel('Draft', { exact: true }).waitFor();
        assert.deepEqual(await page.evaluate(() => window.loads), ['sheet']);
        // Returning to a loaded tab reuses code, but creates fresh form/session state.
        await page.evaluate(() => {
            window.firstPanelSignal = window.sessions.at(-1).signal;
            window.loadingFlashes = 0;
            window.loadingObserver = new MutationObserver(records => {
                for (const record of records) for (const node of record.addedNodes)
                    if (node.textContent?.includes('Loading settings…')) window.loadingFlashes++;
            });
            window.loadingObserver.observe(document.querySelector('dialog'), { childList: true, subtree: true });
        });
        await tab('Themes').click(); await tab('Sheet').click();
        await page.getByLabel('Draft', { exact: true }).waitFor();
        assert.deepEqual(await page.evaluate(() => window.loads), ['sheet'], 'tab revisit reuses loaded component');
        assert.equal(await page.evaluate(() => window.firstPanelSignal.aborted && window.firstPanelSignal !== window.sessions.at(-1).signal), true);
        assert.equal(await page.evaluate(() => window.loadingFlashes), 0, 'warm tab must not flash loading fallback');
        await page.evaluate(() => window.loadingObserver.disconnect());
        await page.getByLabel('Draft', { exact: true }).fill('discard on close');
        await page.getByRole('button', { name: 'Done', exact: true }).click();
        await page.getByRole('button', { name: 'Discard', exact: true }).click();
        await open(); await tab('Sheet').click(); await page.getByLabel('Draft', { exact: true }).waitFor();
        assert.deepEqual(await page.evaluate(() => window.loads), ['sheet'], 'dialog reopening reuses loaded component');
        assert.equal(await page.getByLabel('Draft', { exact: true }).inputValue(), '', 'cached code does not retain discarded form state');
        assert.equal(await page.getByTestId('identity').textContent(), 'world:fixture');
        assert.equal(await page.locator('[data-sd-surface="settingsTab"].sdk-module--fixture').count(), 0, 'Core settings must not activate the module theme');
        assert.equal(await page.locator('[data-sd-surface="settingsTab"].sd-settings-content').count(), 1);
        await page.addStyleTag({content: '.sdk-module--fixture section {background: rgb(255, 0, 0); font-family: serif;}'});
        const settingsPanel = page.locator('[data-sd-surface="settingsTab"]');
        assert.equal(await settingsPanel.locator('section').evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)', 'module stylesheet must not theme settings');
        for (const theme of ['dark', 'light']) {
            await page.evaluate(theme => document.body.dataset.sdAppearance=theme, theme);
            const colors = await page.getByLabel('Draft', {exact:true}).evaluate(el => {
                const reference=document.createElement('input'); reference.className='sd-ui-control'; document.body.appendChild(reference);
                const actual=getComputedStyle(el), expected=getComputedStyle(reference);
                const result=[actual.color, expected.color, actual.backgroundColor, expected.backgroundColor, actual.borderRadius, expected.borderRadius];
                reference.remove();return result;
            });
            assert.equal(colors[0], colors[1]);assert.equal(colors[2], colors[3]);assert.equal(colors[4], colors[5]);
        }
        await page.evaluate(() => document.body.dataset.sdAppearance='dark');
        await tab('Sheet').focus(); await page.keyboard.press('Tab');
        assert.equal(await page.getByRole('tabpanel').evaluate(el => el === document.activeElement), true);
        await page.getByLabel('Immediate preference').check();
        await page.getByLabel('Draft', { exact: true }).fill('unsaved');
        await page.getByRole('button', { name: 'Save draft' }).click(); await page.evaluate(() => window.finishSave(false));
        await page.getByText('Save failed', { exact: true }).waitFor();
        await tab('Themes').click(); await confirmation.waitFor();
        assert.equal(await confirmation.evaluate(el => el.matches(':modal')), true, 'shared confirmation is in native top layer');
        assert.equal(await page.getByRole('button', { name: 'Continue editing' }).evaluate(el => document.elementFromPoint(el.getBoundingClientRect().x + 5, el.getBoundingClientRect().y + 5) === el), true);
        await page.screenshot({ path: `${output}/dirty-confirmation.png` });
        await page.getByRole('button', { name: 'Continue editing' }).click();
        assert.equal(await page.getByLabel('Draft', { exact: true }).inputValue(), 'unsaved');
        await page.keyboard.press('Escape'); await confirmation.waitFor();
        for (let i = 0; i < 6; i++) {
            await page.keyboard.press('Tab');
            assert.equal(await confirmation.evaluate(el => el.contains(document.activeElement)), true, 'confirmation contains keyboard focus');
        }
        await page.keyboard.press('Escape'); await confirmation.waitFor({ state: 'detached' });
        assert.equal(await page.getByLabel('Draft', { exact: true }).count(), 1, 'Escape on confirmation keeps draft and parent');
        await page.getByRole('button', { name: 'Close settings' }).click(); await confirmation.waitFor();
        await page.getByRole('button', { name: 'Continue editing' }).click();
        await page.getByRole('button', { name: 'Done', exact: true }).click(); await confirmation.waitFor();
        await page.getByRole('button', { name: 'Discard', exact: true }).click();
        await page.getByRole('dialog', { name: 'Settings', exact: true }).waitFor({ state: 'detached' });
        assert.equal(await page.getByRole('button', { name: 'Open settings', exact: true }).evaluate(el => el === document.activeElement), true);
        await open(); await tab('Sheet').click();
        assert.equal(await page.getByLabel('Immediate preference').isChecked(), true, 'preference survives reopen');
        await page.getByRole('button', { name: 'Reset preference' }).click();
        assert.equal(await page.getByLabel('Immediate preference').isChecked(), false);
        await page.evaluate(() => {
            window.originalSetItem = Storage.prototype.setItem;
            Storage.prototype.setItem = function(key, value) { if (key.includes('sheetdelver:settings:')) throw Error('storage denied'); return window.originalSetItem.call(this, key, value); };
        });
        await page.getByLabel('Immediate preference').click();
        await page.getByText('storage denied', { exact: true }).waitFor();
        assert.equal(await page.getByLabel('Immediate preference').isChecked(), false);
        await page.evaluate(() => { Storage.prototype.setItem = window.originalSetItem; });
        await page.getByLabel('Draft', { exact: true }).fill('saved');
        await page.getByRole('button', { name: 'Save draft' }).click(); await page.evaluate(() => window.finishSave(true));
        await tab('Themes').click(); assert.equal(await confirmation.count(), 0, 'successful save clears dirty');
        await page.evaluate(() => window.sessions.forEach(s => s.onDirtyChange(true)));
        await tab('Chat & Rolls').click(); assert.equal(await confirmation.count(), 0, 'retired callbacks cannot dirty Core');
        await tab('Sheet').click(); await page.getByLabel('Draft', { exact: true }).fill('discard tab');
        await page.getByRole('button', { name: 'Save draft' }).click();
        await tab('Themes').click(); await page.getByRole('button', { name: 'Discard', exact: true }).click();
        await page.evaluate(() => window.finishSave(true));
        assert.equal(await tab('Themes').getAttribute('aria-selected'), 'true', 'stale save completion cannot revive the retired form');
        await page.evaluate(() => { window.state.currentUser = { id: 'user', role: 3 }; window.render(); });
        assert.equal(await tab('GM Options').count(), 1, 'Assistant has GM visibility');
        // Import failure then fresh lazy/boundary retry; crashed panel follows the same path.
        await page.evaluate(() => { window.failLoad = true; }); await tab('GM Options').click();
        await page.getByRole('button', { name: 'Retry', exact: true }).click();
        await page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
        await page.evaluate(() => { window.failLoad = false; }); await page.getByRole('button', { name: 'Retry', exact: true }).click();
        await page.getByRole('heading', { name: 'GM options', exact: true }).waitFor();
        await page.evaluate(() => { window.crashPanel = true; window.render(); });
        await page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
        await page.evaluate(() => { window.crashPanel = false; }); await page.getByRole('button', { name: 'Retry', exact: true }).click();
        await page.getByLabel('GM draft').fill('draft');
        await tab('Themes').click(); await confirmation.waitFor();
        await page.evaluate(() => { window.state.currentUser = { id: 'user', role: 2 }; window.render(); });
        await tab('GM Options').waitFor({ state: 'detached' });
        assert.equal(await tab('Chat & Rolls').getAttribute('aria-selected'), 'true');
        assert.equal(await confirmation.count(), 0, 'demotion forcibly discards');
        // A deselected slow import cannot mount after resolution.
        await page.evaluate(() => { window.slowLoad = true; window.emit('moduleSourceChanged'); });
        await open(); await tab('Sheet').click();
        await page.getByRole('status').waitFor();
        const pendingLoads = await page.evaluate(() => window.loads.length);
        await tab('Themes').click(); await tab('Sheet').click();
        await page.getByRole('status').waitFor();
        assert.equal(await page.evaluate(() => window.loads.length), pendingLoads, 'pending imports are reused across tab visits');
        await tab('Themes').click(); await page.evaluate(() => window.resolveSlow());
        assert.equal(await page.getByLabel('Draft', { exact: true }).count(), 0);
        await page.evaluate(() => { window.slowLoad = false; });
        for (const theme of ['dark', 'light']) {
            await page.evaluate(theme => document.body.dataset.sdAppearance = theme, theme);
            await page.setViewportSize({ width: 320, height: 700 });
            await tab('Sheet').click(); await page.getByLabel('Draft', { exact: true }).waitFor();
            const bounds = await page.getByRole('dialog', { name: 'Settings', exact: true }).boundingBox();
            assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 320, 'dialog fits narrow viewport');
            assert.equal(await page.getByRole('tablist').evaluate(el => el.scrollWidth > el.clientWidth), true);
            await page.screenshot({ path: `${output}/${theme}-320.png` });
            await page.getByLabel('Draft', { exact: true }).fill('narrow draft');
            await page.getByRole('button', { name: 'Done', exact: true }).click(); await confirmation.waitFor();
            assert.equal(await confirmation.evaluate(el => Array.from(el.querySelectorAll('button')).every(button => {
                const bounds = button.getBoundingClientRect(); return bounds.x >= 0 && bounds.right <= innerWidth;
            })), true, 'confirmation actions fit320px');
            await page.screenshot({ path: `${output}/${theme}-confirmation-320.png` });
            await page.getByRole('button', { name: 'Continue editing' }).click();
            await page.getByRole('button', { name: 'Discard draft' }).click();
        }
        // Forced world/module/session/unload changes retire without replay or confirmation.
        for (const change of ['world', 'module', 'logout', 'unload']) {
            const loadsBeforeRetirement = await page.evaluate(() => window.loads.length);
            await page.getByLabel('Draft', { exact: true }).fill('forced');
            await page.evaluate(change => {
                if (change === 'world') window.state.worldId = 'other-world';
                if (change === 'module') window.state.system = { id: 'other-module' };
                if (change === 'logout') { window.state.token = null; window.state.sessionEpoch++; }
                if (change === 'unload') window.emit('moduleStateChanged', window.state.system.id);
                window.render();
            }, change);
            await page.getByRole('dialog', { name: 'Settings', exact: true }).waitFor({ state: 'detached' });
            assert.equal(await confirmation.count(), 0);
            await page.evaluate(() => { window.state.token = 'fixture'; window.render(); });
            await open(); await tab('Sheet').click(); await page.getByLabel('Draft', { exact: true }).waitFor();
            assert.equal(await page.evaluate(() => window.loads.length), loadsBeforeRetirement + 1, 'scope retirement clears cached panel code');
        }
        assert.equal(await page.evaluate(() => [...new Set(window.cleanup.map(row => row.signal))].filter(signal => signal.aborted)
            .every(signal => window.cleanup.filter(row => row.signal === signal).at(-1).aborted)), true,
        'actual retirement aborts before final layout cleanup; StrictMode rehearsal cleanups can stay live');
        await page.getByRole('button', { name: 'Done', exact: true }).click();
        // Legacy/empty/malformed registrations leave all Core tabs usable.
        for (const settingsTabs of [undefined, [], null]) {
            await page.evaluate(settingsTabs => { window.manifest = { ...window.defaultManifest, settingsTabs }; }, settingsTabs);
            await open(); await tab('Themes').click();
            assert.equal(await page.getByRole('tab').count(), 3);
            await page.getByRole('button', { name: 'Done', exact: true }).click();
        }
        assert.deepEqual(errors, []);
        console.log('Module settings mounted lifecycle, dirty forms, retry, keyboard and narrow-theme checks passed');
        await page.close();
        await verifyScrollCleanup(browser, fixture);
    } finally { await browser.close(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await run();
