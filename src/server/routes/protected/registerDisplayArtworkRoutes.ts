import type express from 'express';
import { getAdapter } from '@modules/registry/server';
import { actorStore } from '@server/core/documents/primary/actors/ActorStore';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import { sceneStore } from '@server/core/documents/primary/scenes/SceneStore';
import { combatStore } from '@server/core/documents/primary/combats/CombatStore';
import { combatEncounterReadModel } from '@server/core/documents/encounters/CombatEncounterReadModel';
import { buildCombatTrackerDto } from '@server/services/combats/CombatTrackerProjection';
import { readCombatManagerFlag } from '@server/services/combats/combatManagerFlag';
import type { CombatDocument } from '@server/shared/types/documents';
import { DocumentOwnershipLevel } from '@server/core/documents/primary/base/ownership';
import { moduleWorldContext } from '@server/services/world/ModuleWorldContextService';
import { createModuleRuntime } from '@server/shared/utils/createModuleRuntime';
import { createModuleRequestRuntime } from '@server/shared/utils/moduleDocumentServices';
import { displayArtworkUrl, resolveDisplayArtwork, readCombatCopySourceUuid } from '@server/services/artwork/DisplayArtworkService';
import type { DisplayArtworkContext, FoundryActor } from '@shared/sdk';

/** Read current authorized inputs. An encounter never grants Actor read access. */
export function readDisplayArtworkContext(userId: string, target: { purpose: DisplayArtworkContext['purpose']; actorId?: string; combatId?: string; combatantId?: string }): DisplayArtworkContext | null {
    const subject=userStore.createAccessSubject(userId);
    if (!subject || !userStore.get(userId) || subject.role<1) return null;
    let actorId=target.actorId, currentImage: string | null = null;
    let imageSource: DisplayArtworkContext['imageSource']='actor';
    let token: DisplayArtworkContext['token'];
    let encounter: CombatDocument | undefined;
    if (target.purpose!=='actor-card') {
        if (!target.combatId || !target.combatantId) return null;
        const combat=combatStore.get(target.combatId,{subject});
        const prepared=combatEncounterReadModel.getOrRebuild(target.combatId);
        if (!combat || !prepared) return null;
        encounter = combat;
        if (target.purpose==='combat-portrait' && (subject.role<3 || !readCombatManagerFlag(combat))) return null;
        const visible=buildCombatTrackerDto(prepared,subject,{canWriteActor:(id,caller)=>actorStore.canReadActor(id,caller,DocumentOwnershipLevel.OWNER)});
        if (!visible.combatants.some(row=>row.id===target.combatantId)) return null;
        const row=combat.combatants?.find(row=>(row._id??row.id)===target.combatantId);
        if (!row?.actorId) return null;
        actorId=row.actorId;
        const sourceToken=row.sceneId && row.tokenId ? sceneStore.getToken(row.sceneId,row.tokenId) : null;
        if (sourceToken) token={id:row.tokenId!,actorLink:sourceToken.actorLink!==false,img:typeof sourceToken.texture?.src==='string'?sourceToken.texture.src:null};
        if (typeof row.img==='string') {currentImage=row.img;imageSource='combatant';}
        else if (token?.img!==null && token?.img!==undefined) {currentImage=token.img;imageSource='token';}
    }
    if (!actorId) return null;
    const actor=actorStore.get(actorId,{subject,minOwnership:DocumentOwnershipLevel.OBSERVER});
    if (!actor) return null;
    if (imageSource==='actor' || (target.purpose==='combat-portrait' && typeof actor.img==='string' && actor.img)) {
        currentImage=typeof actor.img==='string'?actor.img:null;
        imageSource='actor';
    }
    const compendiumSourceUuid = encounter ? readCombatCopySourceUuid(actor, encounter) : undefined;
    return {purpose:target.purpose,actor:actor as unknown as FoundryActor,currentImage,imageSource,
        ...(compendiumSourceUuid?{compendiumSourceUuid}:{}),...(token?{token}:{})};
}

export function registerDisplayArtworkRoutes(router: express.Router) {
    router.get('/display-artwork',async(req,res)=>{
        res.setHeader('Cache-Control','no-store');
        const none=()=>res.json({status:'none'});
        const purpose=req.query.purpose;
        if (!['actor-card','combat-portrait','combat-token'].includes(String(purpose))) return res.status(400).json({error:'Artwork purpose required'});
        const field=(key:string)=>typeof req.query[key]==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(req.query[key] as string)?req.query[key] as string:undefined;
        const target={purpose:purpose as DisplayArtworkContext['purpose'],actorId:field('actorId'),combatId:field('combatId'),combatantId:field('combatantId')};
        if (purpose==='actor-card'?!target.actorId:!target.combatId||!target.combatantId) return res.status(400).json({error:'Exact display target required'});
        const userId=req.userSession?.userId;
        if (!userId || !userStore.get(userId)) return res.status(401).json({error:'Session retired'});
        const controller=new AbortController();
        const abort=()=>controller.abort();res.on('close',abort);
        try {
            const world=moduleWorldContext.handle(), revision=world.snapshot().identity.contextRevision;
            const systemId=world.snapshot().identity.systemId;
            const role=userStore.getRole(userId);
            const context=readDisplayArtworkContext(userId,target);
            if (!context) return none();
            const identity=JSON.stringify(context);
            const isCurrent=()=>{
                try {world.assertRevision(revision);} catch{return false;}
                return userStore.getRole(userId)===role && JSON.stringify(readDisplayArtworkContext(userId,target))===identity;
            };
            const adapter=await getAdapter(systemId);
            if (!adapter?.resolveDisplayArtwork || !isCurrent()) return none();
            const runtime=createModuleRequestRuntime(await createModuleRuntime(systemId),req.foundryClient);
            const documents=Object.freeze({get:runtime.documents.get,list:runtime.documents.list,fetchByUuid:runtime.documents.fetchByUuid});
            const artwork=await resolveDisplayArtwork(adapter,context,{world:runtime.world,packages:runtime.packages,artwork:runtime.artwork,access:runtime.access,compendium:runtime.compendium,documents},
                {isCurrent,signal:controller.signal,resolveUrl:src=>displayArtworkUrl(src,runtime.foundryUrl??'',systemId)});
            return artwork?res.json({status:'resolved',...artwork,original:context.currentImage?req.foundryClient.resolveUrl(context.currentImage):null}):none();
        } catch {return none();}
        finally {res.off('close',abort);}
    });
}
