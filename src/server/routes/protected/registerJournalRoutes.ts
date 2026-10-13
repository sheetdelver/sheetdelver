import express from 'express';
import { createJournalService } from '@server/services/journals/JournalService';
import { getErrorMessage } from '@server/shared/utils/getErrorMessage';
import { isErrorPayload } from '@server/shared/utils/isErrorPayload';
import { createSharedJournalService } from '@server/services/journals/SharedJournalService';

/**
 * Journal route registrar — ownership-threshold contract (ADR-0013):
 *
 *   GET    /journals       → DETAIL_VISIBLE metadata-only directory projection
 *                            Folder list filtered to ancestors of any visible
 *                            journal; ASSISTANT-GM bypasses to see all folders.
 *   GET    /journals/:id   → DETAIL_VISIBLE on entry + per-page (visiblePages)
 *                            Full entry with per-page ownership filtering.
 *   POST   /journals       → no courtesy gate; Foundry enforces on dispatch
 *   PATCH  /journals/:id   → no courtesy gate
 *   DELETE /journals/:id   → no courtesy gate
 *
 * Verified by `runJournalListVsDetailThresholdsDiverge` in
 * `src/tests/unit/routing/route-ownership-thresholds.test.ts`.
 */
export function registerJournalRoutes(appRouter: express.Router) {
    // Journal domain service: displaced logic for visibility-filtered listing and CRUD operations.
    const journalService = createJournalService();
    const sharedJournals = createSharedJournalService();
    const recipient = (req: express.Request) => {
        const session = req.userSession;
        return !req.isSystem && session?.id && session.worldId && session.userId
            && session.userId === req.foundryClient.userId
            ? { sessionId: session.id, worldId: session.worldId, userId: session.userId } : null;
    };
    const shareRequest = (operation: 'open' | 'read' | 'close'): express.RequestHandler => (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        const scope = recipient(req);
        if (!scope) return res.status(403).json({ error: 'A player world session is required' });
        try {
            if (operation === 'close') {
                sharedJournals.close(scope, req.body?.viewId);
                return res.json({ ok: true });
            }
            const payload = operation === 'open' ? sharedJournals.open(scope, req.body) : sharedJournals.read(scope, req.query.viewId);
            if (isErrorPayload(payload)) return res.status(payload.status).json({ error: payload.error });
            return res.json(payload);
        } catch (error: unknown) {
            return res.status(500).json({ error: getErrorMessage(error) });
        }
    };
    appRouter.post('/shared-content/journal-view', shareRequest('open'));
    appRouter.get('/shared-content/journal-view', shareRequest('read'));
    appRouter.delete('/shared-content/journal-view', shareRequest('close'));

    appRouter.get('/journals', async (req, res) => {
        try {
            const client = req.foundryClient;
            const payload = await journalService.listJournals(client);
            res.json(payload);
        } catch (error: unknown) {
            res.status(500).json({ error: getErrorMessage(error) });
        }
    });

    appRouter.post('/journals', async (req, res) => {
        try {
            const client = req.foundryClient;
            const payload = await journalService.createJournal(client, req.body);
            res.json(payload);
        } catch (error: unknown) {
            res.status(500).json({ error: getErrorMessage(error) });
        }
    });

    appRouter.get('/journals/:id', async (req, res) => {
        try {
            const client = req.foundryClient;
            const payload = await journalService.getJournalById(client, req.params.id);
            if (isErrorPayload(payload)) {
                return res.status(payload.status).json({ error: payload.error });
            }
            res.json(payload);
        } catch (error: unknown) {
            res.status(500).json({ error: getErrorMessage(error) });
        }
    });

    appRouter.patch('/journals/:id', async (req, res) => {
        try {
            const client = req.foundryClient;
            const payload = await journalService.updateJournal(client, req.params.id, req.body);
            res.json(payload);
        } catch (error: unknown) {
            res.status(500).json({ error: getErrorMessage(error) });
        }
    });

    appRouter.patch('/journals/:id/pages/:pageId', async (req, res) => {
        try {
            const client = req.foundryClient;
            // Page edits use Foundry's embedded JournalEntryPage mutation so
            // the parent cache retains page ownership and metadata.
            const payload = await journalService.updateJournalPage(
                client,
                req.params.id,
                req.params.pageId,
                req.body,
            );
            res.json(payload);
        } catch (error: unknown) {
            res.status(500).json({ error: getErrorMessage(error) });
        }
    });

    appRouter.delete('/journals/:id', async (req, res) => {
        try {
            const client = req.foundryClient;
            const payload = await journalService.deleteJournal(client, req.params.id, req.query);
            res.json(payload);
        } catch (error: unknown) {
            res.status(500).json({ error: getErrorMessage(error) });
        }
    });
}
