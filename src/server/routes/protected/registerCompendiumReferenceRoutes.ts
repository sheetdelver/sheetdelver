import type express from 'express';
import { getAdapter } from '@modules/registry/server';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import { moduleWorldContext } from '@server/services/world/ModuleWorldContextService';
import { createModuleRuntime } from '@server/shared/utils/createModuleRuntime';
import { createModuleRequestRuntime } from '@server/shared/utils/moduleDocumentServices';
import { prepareCompendiumReference, referenceIdentity } from '@server/services/artwork/CompendiumReferenceService';
import { readDisplayArtworkContext } from './registerDisplayArtworkRoutes';

export function registerCompendiumReferenceRoutes(router: express.Router) {
    router.get('/compendium-reference', async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        const none = () => res.json({ status: 'none' });
        const userId = req.userSession?.userId;
        if (!userId || !userStore.get(userId)) return res.status(401).json({ error: 'Session retired' });
        const { uuid, combatId, combatantId } = req.query;
        const direct = typeof uuid === 'string' && !combatId && !combatantId;
        const combat = !uuid && typeof combatId === 'string' && typeof combatantId === 'string';
        if (!direct && !combat) return res.status(400).json({ error: 'An exact reference target is required' });
        const readTarget = () => {
            if (direct) return referenceIdentity(uuid);
            const context = readDisplayArtworkContext(userId, { purpose: 'combat-portrait', combatId: combatId as string, combatantId: combatantId as string });
            if (!context) return null;
            const actor = context.actor as Record<string, any>;
            const ref = referenceIdentity(context.compendiumSourceUuid ?? actor._stats?.compendiumSource ?? actor.flags?.core?.sourceId);
            return ref?.documentType === 'Actor' ? ref : null;
        };
        const controller = new AbortController();
        const abort = () => controller.abort();
        res.on('close', abort);
        try {
            const world = moduleWorldContext.handle();
            const { contextRevision: revision, systemId } = world.snapshot().identity;
            const role = userStore.getRole(userId);
            const reference = readTarget();
            if (!reference || role < 1) return none();
            const isCurrent = () => {
                try { world.assertRevision(revision); } catch { return false; }
                return !controller.signal.aborted && userStore.getRole(userId) === role && JSON.stringify(readTarget()) === JSON.stringify(reference);
            };
            const adapter = await getAdapter(systemId);
            if (!adapter?.prepareReferenceView || !isCurrent()) return none();
            const runtime = createModuleRequestRuntime(await createModuleRuntime(systemId), req.foundryClient);
            const packages = runtime.packages?.snapshot();
            const packId = reference.uuid.split('.').slice(1, 3).join('.');
            if (packages?.status !== 'ready' || ![packages.system, ...packages.modules].some(pkg =>
                pkg.packs.some(pack => pack.id === packId && pack.type === reference.documentType))) return none();
            const documents = Object.freeze({ get: runtime.documents.get, list: runtime.documents.list, fetchByUuid: runtime.documents.fetchByUuid });
            const result = await prepareCompendiumReference(adapter, reference,
                { world: runtime.world, packages: runtime.packages, artwork: runtime.artwork, access: runtime.access, compendium: runtime.compendium, documents },
                { isCurrent, signal: controller.signal });
            const currentPackages = runtime.packages?.snapshot();
            if (!result || !isCurrent() || currentPackages?.status !== 'ready' || currentPackages.revision !== packages.revision) return none();
            return res.json({ status: 'resolved', moduleId: systemId, reference, title: result.title,
                ...(req.query.availability === '1' ? {} : { model: result.model }) });
        } catch { return none(); }
        finally { res.off('close', abort); }
    });
}
