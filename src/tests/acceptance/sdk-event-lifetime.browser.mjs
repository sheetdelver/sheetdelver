/** Actual host provider lifecycle with fixture contexts/socket; no Core server or Foundry.
 * SD_PLAYWRIGHT_MODULE=<playwright> SD_CHROME=<chrome> node src/tests/acceptance/sdk-event-lifetime.browser.mjs
 */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(process.cwd()+'/package.json');
const {build}=require('esbuild');
const {chromium}=await import(process.env.SD_PLAYWRIGHT_MODULE||'playwright');
const stubs=new Map([
['next/navigation','export const useRouter=()=>({push(){},replace(){}});'],
['@client/ui/context/FoundryContext','export const FoundryProvider=({children})=>children;export const useFoundry=()=>window.world;'],
['@client/ui/context/SessionContext','export const SessionProvider=({children})=>children;export const useSession=()=>({sessionEpoch:window.epoch});'],
['@client/ui/context/RealtimeContext','export const RealtimeProvider=({children})=>children;export const useRealtime=()=>({linkState:"ready"});'],
['@client/ui/context/UIContext','export const UIProvider=({children})=>children;export const useUI=()=>({registerBottomNavigation:()=>()=>{}});'],
['@client/ui/context/ConfigContext','export const ConfigProvider=({children})=>children;export const useConfig=()=>({resolveImageUrl:x=>x});'],
['@client/ui/components/NotificationSystem','export const NotificationProvider=({children})=>children;export const useNotifications=()=>({});'],
['@client/ui/sdk/createClientDocumentSource','const docs={invalidate(){}};export const getClientDocumentSource=()=>docs;export const refreshObservedClientDocuments=()=>{};export const setClientDocumentSourceScope=()=>{};'],
['@shared/sdk','export const buildModuleAssetUrl=()=>"";export const setModuleLogSink=()=>{};'],
['@shared/utils/logger','export const logger={debug(){},info(){},warn(){},error(){}};'],
['@client/ui/api/worldRuntime','export const worldRuntimeHeaders=()=>({});']]);
for(const name of ['PageHeader','LoadingModal','RollDialog','RichTextEditor'])stubs.set('@client/ui/components/'+name,'export default ()=>null;');
for(const name of ['ConfirmationModal','SharedContentModal'])stubs.set('@client/ui/components/'+name,`export const ${name}=()=>null;`);
for(const [file,name] of [
['context/ActorCombatContext','ActorCombatProvider'],['context/ChatContext','ChatProvider'],
['context/DicePresentationContext','DicePresentationProvider'],['context/JournalProvider','JournalProvider'],
['context/PlayerAppearanceContext','PlayerAppearanceProvider']])stubs.set('@client/ui/'+file,`export const ${name}=({children})=>children;`);
for(const [file,name] of [['components/Settings/PlayerSettingsDialog','PlayerSettingsDialog'],['components/Notifications/NotificationSessionBoundary','NotificationSessionBoundary'],['components/Chat/ChatPreview','ChatPreview']])stubs.set('@client/ui/'+file,`export const ${name}=()=>null;`);
stubs.set('@client/ui/providers/SDKGlobalProvider','export default ({children})=>children;');
const bundle=await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`
import React from 'react';import {createRoot} from 'react-dom/client';
import {SurfaceHost} from './src/client/ui/components/SurfaceHost';
import PlayerProviders from './src/app/(player)/PlayerProviders';
import {useSDK} from './src/shared/sdk/react';
window.makeSocket=()=>{const handlers=new Map();return{on:(id,fn)=>{if(!handlers.has(id))handlers.set(id,new Set());handlers.get(id).add(fn)},off:(id,fn)=>handlers.get(id)?.delete(fn),emit:(id,p)=>handlers.get(id)?.forEach(fn=>fn(p)),count:id=>handlers.get(id)?.size||0}};window.socket=window.makeSocket();
window.world={token:'fixture',worldId:'fixture',currentUser:{id:'gm',role:4},step:'dashboard',system:{id:'shadowdark'},appSocket:window.socket};
window.seen=[];window.invalidations=0;window.epoch=0;window.loads=0;const cache=new WeakMap();
function Probe(){const sdk=useSDK();React.useEffect(()=>{
window.latest=sdk;window.seen.push(sdk.events);if(!cache.has(sdk.events)){window.loads++;cache.set(sdk.events,true)}
},[sdk.events]);return <p>Tool</p>}
window.retainModuleListener=()=>{const events=window.latest.events;events.on('world:contextChanged',()=>{window.invalidations++;cache.delete(events)});};
const root=createRoot(document.getElementById('root'));window.show=tool=>root.render(<React.StrictMode><PlayerProviders>{tool?<SurfaceHost moduleId="shadowdark" surface="tools"><Probe/></SurfaceHost>:<p>Dashboard</p>}</PlayerProviders></React.StrictMode>);window.stop=()=>root.unmount();window.show(true);
`},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',plugins:[{name:'fixture',setup(b){b.onResolve({filter:/.*/},a=>stubs.has(a.path)?{path:a.path,namespace:'fixture'}:undefined);b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:stubs.get(a.path),loader:'tsx',resolveDir:process.cwd()}));}}]});
const browser=await chromium.launch({executablePath:process.env.SD_CHROME,headless:true,args:['--no-sandbox','--disable-background-networking']});
try {
    const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',r=>r.abort());await page.setContent('<div id="root"></div>');await page.addScriptTag({content:bundle.outputFiles[0].text});
    await page.waitForFunction(()=>window.seen.length>0);
    await page.evaluate(()=>{window.first=window.latest.events;window.retainModuleListener();window.show(false)});
    await page.getByText('Dashboard',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.socket.count('worldContextChanged')),1,'one workspace subscription remains while no module surface is mounted');
    await page.evaluate(()=>window.show(true));await page.getByText('Tool',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.latest.events===window.first),true);
    assert.equal(await page.evaluate(()=>window.loads),1,'reopening a surface reuses its cached resources');
    assert.deepEqual(await page.evaluate(()=>Object.keys(window.latest.events)),['on'],'modules cannot attach, detach or dispose the host bus');
    await page.evaluate(()=>window.show(false));await page.getByText('Dashboard',{exact:true}).waitFor();
    await page.evaluate(()=>window.socket.emit('worldContextChanged',{revision:2,keys:[]}));
    assert.equal(await page.evaluate(()=>window.invalidations),1,'retained module listener receives off-page invalidation once, including Strict Mode');
    await page.evaluate(()=>window.show(true));await page.getByText('Tool',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.loads),2);
    await page.evaluate(()=>{window.oldSocket=window.socket;window.socket=window.makeSocket();window.world.appSocket=window.socket;window.show(true)});
    await page.waitForFunction(()=>window.oldSocket.count('worldContextChanged')===0 && window.socket.count('worldContextChanged')===1);
    assert.equal(await page.evaluate(()=>window.latest.events===window.first),true,'transport replacement preserves the same authenticated owner');
    await page.evaluate(()=>window.oldSocket.emit('worldContextChanged',{revision:9,keys:[]}));
    assert.equal(await page.evaluate(()=>window.invalidations),1,'detached transport cannot publish');
    await page.evaluate(()=>window.socket.emit('worldContextChanged',{revision:10,keys:[]}));
    assert.equal(await page.evaluate(()=>window.invalidations),2,'replacement transport reaches the retained listener');
    // Identity/permission changes create a new owner; old subscriptions cannot receive new-session events.
    for(const change of [{user:{id:'player',role:1}}, {role:4}, {worldId:'other'}, {logout:true}, {login:true}]) {
        const before=await page.evaluate(()=>{window.previous=window.latest.events;return window.invalidations;});
        await page.evaluate(change=>{
            if(change.user)window.world.currentUser=change.user;
            if(change.role)window.world.currentUser={...window.world.currentUser,role:change.role};
            if(change.worldId)window.world.worldId=change.worldId;
            if(change.logout){window.world.token=null;window.epoch++}
            if(change.login){window.world.token='fixture';window.epoch++}
            window.show(true);
        },change);
        await page.waitForFunction(()=>window.latest.events!==window.previous);
        await page.evaluate(()=>window.socket.emit('worldContextChanged',{revision:3,keys:[]}));
        assert.equal(await page.evaluate(()=>window.invalidations),before,'old session listeners were retired');
        assert.equal(await page.evaluate(()=>window.socket.count('worldContextChanged')),change.logout?0:1);
    }
    // Same-user reauthentication has a distinct epoch even without an intermediate screen.
    await page.evaluate(()=>{window.previous=window.latest.events;window.epoch++;window.show(true)});
    await page.waitForFunction(()=>window.latest.events!==window.previous);
    await page.evaluate(()=>window.stop());await page.waitForFunction(()=>window.socket.count('worldContextChanged')===0);
    assert.deepEqual(errors,[]);
    console.log('SDK workspace lifetime: real PlayerProviders/SurfaceHost/SDKProvider navigation, one subscription, off-page invalidation, Strict Mode, user/role/world/logout/session-epoch retirement passed.');
} finally { await browser.close(); }
