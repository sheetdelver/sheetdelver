'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useFoundry } from '@client/ui/context/FoundryContext';
import { worldRuntimeHeaders } from '@client/ui/api/worldRuntime';
import type { DisplayArtworkContext } from '@shared/sdk';

/** Original image renders immediately; optional artwork never gates its parent. */
export function DisplayArtwork({ src, actorId, combatId, combatantId, purpose, className, fallback }: {
    src: string | null; actorId?: string | null; combatId?: string; combatantId?: string;
    purpose: DisplayArtworkContext['purpose']; className?: string; fallback?: ReactNode;
}) {
    const { currentUser, worldId, step, appSocket } = useFoundry();
    const userId=currentUser?._id || currentUser?.id;
    const scope=JSON.stringify([worldId,userId,currentUser?.role,step,purpose,actorId,combatId,combatantId,src]);
    const [result,setResult]=useState<{scope:string;src:string;credit?:string}|null>(null);
    const [failure,setFailure]=useState<{scope:string;urls:string[]}|null>(null);
    useEffect(()=>{
        let retired=false, generation=0;
        let controller:AbortController|undefined;
        const clear=()=>{generation++;controller?.abort();setResult(null);setFailure(null);};
        const refresh=async()=>{
            clear();
            if(step!=='dashboard'||!worldId||!userId||appSocket?.connected===false)return;
            const request=generation;controller=new AbortController();
            const query=new URLSearchParams({purpose,...(purpose==='actor-card'?{actorId:actorId??''}:{combatId:combatId??'',combatantId:combatantId??''})});
            try{
                const response=await fetch(`/api/display-artwork?${query}`,{credentials:'same-origin',cache:'no-store',headers:worldRuntimeHeaders(),signal:controller.signal});
                const data=await response.json();
                if(!retired&&request===generation&&response.ok&&data.status==='resolved'&&typeof data.src==='string'
                    && data.original===src)setResult({scope,src:data.src,...(typeof data.credit==='string'?{credit:data.credit}:{})});
            }catch{/* Keep the original image; optional artwork is not a page error. */}
        };
        const actorChanged=(event:{actorId?:string})=>{if(!event.actorId||event.actorId===actorId)void refresh();};
        const combatChanged=(event:{combatId?:string})=>{if(!event.combatId||event.combatId===combatId)void refresh();};
        const reload=()=>{void refresh();};
        const events=['worldPackagesChanged','worldContextChanged','connect','actorListInvalidated','combatListInvalidated'];
        events.forEach(event=>appSocket?.on(event,reload));
        appSocket?.on('actorChanged',actorChanged);appSocket?.on('combatChanged',combatChanged);appSocket?.on('disconnect',clear);
        void refresh();
        return()=>{retired=true;generation++;controller?.abort();events.forEach(event=>appSocket?.off(event,reload));
            appSocket?.off('actorChanged',actorChanged);appSocket?.off('combatChanged',combatChanged);appSocket?.off('disconnect',clear);};
    },[scope,worldId,userId,currentUser?.role,step,appSocket,purpose,actorId,combatId,combatantId,src]);
    const selected=result?.scope===scope && !(failure?.scope===scope&&failure.urls.includes(result.src))?result.src:src;
    const originalFailed=selected===src&&failure?.scope===scope&&!!src&&failure.urls.includes(src);
    return selected&&!originalFailed?<img src={selected} alt="" loading="lazy" className={className}
        title={selected===result?.src?result.credit:undefined}
        onError={()=>setFailure(previous=>({scope,urls:[...(previous?.scope===scope?previous.urls:[]),selected]}))}/>:<>{fallback}</>;
}
