import { createHash, randomUUID } from 'node:crypto';
import { actorStore } from '@server/core/documents/primary/actors/ActorStore';
import { sceneStore } from '@server/core/documents/primary/scenes/SceneStore';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import { isRecord, stableJson } from '@server/core/documents/primary/base/PrimaryDocumentStore';
import { isOrphanToken, tokenDisplayName, tokenRows } from '@server/core/world/orphanTokens';
import { worldStateStore } from '@server/core/world/WorldStateStore';
import { worldWorkGate } from '@server/core/world/WorldWorkGate';
import { serviceAccountAuthority } from '@server/core/world/ServiceAccountAuthority';
import type { OrphanTokenReview, OrphanTokenCleanupResponse, OrphanTokenCleanupResult } from '@shared/types/adminWorldCleanup';

interface CleanupFrame {
    scope: string;
    revision: string;
    actors: Record<string, unknown>[];
    scenes: Record<string, unknown>[];
}
interface CleanupDependencies {
    snapshot(): CleanupFrame;
    read(type: string, operation: Record<string, unknown>): Promise<unknown>;
    remove(sceneId: string, tokenId: string): Promise<unknown>;
}
const documentId = (row: Record<string, unknown>) => String(row._id ?? row.id ?? '');
const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex');
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
function sourceRows(response: unknown): Record<string, unknown>[] {
    const rows = isRecord(response) ? response.result : response;
    if (!Array.isArray(rows) || rows.some(row => !isRecord(row) || !validId(row._id ?? row.id))
        || new Set(rows.map(documentId)).size !== rows.length) throw new Error('Foundry source read unavailable');
    return rows;
}
function storedTokens(scene: Record<string, unknown>): Record<string, unknown>[] {
    // A failed/malformed embedded collection is never proof of absence.
    return sourceRows(scene.tokens);
}
class CleanupUnconfirmedError extends Error {}

/** No write on listing; only explicitly selected and confirmed tokens are deleted. */
export function createOrphanTokenCleanup(deps: CleanupDependencies) {
    const pending = new Set<string>();
    const review = (scope: string, sceneId: string, token: Record<string, unknown>) => digest([scope, sceneId, token]);
    const list = (): OrphanTokenReview[] => {
        const frame = deps.snapshot();
        const actors = new Set(frame.actors.map(documentId));
        return frame.scenes.flatMap(scene => tokenRows(scene).filter(token => isOrphanToken(token, actors)).map(token => ({
            sceneId: documentId(scene), sceneName: tokenDisplayName(scene, 'Unnamed scene'),
            tokenId: documentId(token), tokenName: tokenDisplayName(token, 'Unnamed token'), actorId: String(token.actorId),
            review: review(frame.scope, documentId(scene), token),
        }))).filter(row => validId(row.sceneId) && validId(row.tokenId));
    };
    const remove = async (input: unknown, assertAdministrator: () => void) => {
        if (!isRecord(input) || !validId(input.sceneId) || !validId(input.tokenId) || typeof input.review !== 'string' || input.confirmed !== true) {
            throw new Error('Review and confirm one orphaned token before deleting it.');
        }
        const { sceneId, tokenId } = input;
        const frame = deps.snapshot();
        const key = `${frame.scope}:${sceneId}:${tokenId}`;
        if (pending.has(key)) throw new Error('Cleanup is already running for this token. Refresh its status.');
        pending.add(key);
        const assertCurrent = () => {
            assertAdministrator();
            const now = deps.snapshot();
            if (now.scope !== frame.scope || now.revision !== frame.revision) throw new Error('World data changed. Refresh and review the token again. Nothing was deleted.');
        };
        try {
            assertCurrent();
            const scenes = sourceRows(await deps.read('Scene', { query: { _id: sceneId } }));
            const scene = scenes.find(row => documentId(row) === sceneId);
            const token = scene && storedTokens(scene).find(row => documentId(row) === tokenId);
            if (!token || review(frame.scope, sceneId, token) !== input.review) throw new Error('Token changed or was removed. Refresh and review it again. Nothing was deleted.');
            const actors = sourceRows(await deps.read('Actor', { query: {} }));
            if (!isOrphanToken(token, new Set(actors.map(documentId)))) throw new Error('This token has an Actor again. It will not be deleted.');
            assertCurrent();
            // The native socket's normal mutation guard also fences maintenance.
            try { await deps.remove(sceneId, tokenId); }
            catch { /* A lost response is resolved by one primary read, never replay. */ }
            try {
                assertAdministrator();
                if (deps.snapshot().scope !== frame.scope) throw new Error('World changed');
                const after = sourceRows(await deps.read('Scene', { query: { _id: sceneId } }));
                assertAdministrator();
                if (deps.snapshot().scope !== frame.scope) throw new Error('World changed');
                const remaining = after.find(row => documentId(row) === sceneId);
                if (!remaining || storedTokens(remaining).some(row => documentId(row) === tokenId)) throw new Error('Token deletion not observed');
            } catch {
                throw new CleanupUnconfirmedError('Deletion was not confirmed. Refresh or inspect the token in Foundry; no automatic retry was sent.');
            }
            return { deleted: true };
        } finally { pending.delete(key); }
    };
    const removeSelected = async (input: unknown, assertAdministrator: () => void): Promise<OrphanTokenCleanupResponse> => {
        if (!isRecord(input) || input.confirmed !== true || !Array.isArray(input.tokens) || !input.tokens.length
            || input.tokens.some(row => !isRecord(row) || !validId(row.sceneId) || !validId(row.tokenId) || typeof row.review !== 'string')) {
            throw new Error('Select and confirm the orphaned tokens to delete.');
        }
        const selected = input.tokens as Pick<OrphanTokenReview, 'sceneId' | 'tokenId' | 'review'>[];
        if (new Set(selected.map(row => `${row.sceneId}:${row.tokenId}`)).size !== selected.length) throw new Error('A token was selected more than once. Refresh and review the selection.');
        assertAdministrator();
        const batchScope = deps.snapshot().scope;
        const results: OrphanTokenCleanupResult[] = [];
        let stopped = false;
        for (const row of selected) {
            const identity = { sceneId: row.sceneId, tokenId: row.tokenId };
            if (stopped) { results.push({ ...identity, state: 'not-attempted', reason: 'Cleanup stopped. Refresh and review the remaining tokens.' }); continue; }
            try {
                assertAdministrator();
                if (deps.snapshot().scope !== batchScope) throw new Error('World connection changed. Refresh and review the remaining tokens.');
                // Each entry retains its own fresh checks, duplicate guard and
                // readback. Earlier confirmed deletions are never sent again.
                await remove({ ...row, confirmed: true }, assertAdministrator);
                results.push({ ...identity, state: 'deleted' });
            } catch (error) {
                results.push({ ...identity, state: error instanceof CleanupUnconfirmedError ? 'unconfirmed' : 'not-deleted',
                    reason: error instanceof Error ? error.message : 'Cleanup could not be completed. Refresh before reviewing another action.' });
                stopped = true;
            }
        }
        return { results };
    };
    return { list, remove, removeSelected };
}

const processScope = randomUUID();
export async function getOrphanTokenCleanup() {
    const { systemService } = await import('./SystemService');
    return cleanup ??= createOrphanTokenCleanup({
        snapshot: () => {
            const transport = systemService.getSystemClient();
            const userId = serviceAccountAuthority.getUserId();
            if (!systemService.isReady() || !transport.isConnected || !actorStore.isReady() || !sceneStore.isReady()
                || !userId || !serviceAccountAuthority.checkCurrent(userStore.get(userId))) {
                throw new Error('Optional cleanup is available after world preparation completes with a full-GM service account.');
            }
            worldWorkGate.assertOpen();
            return { scope: digest([processScope, transport.connectionEpoch, worldStateStore.getCurrentWorldId()]),
                revision: stableJson([actorStore.getMutationRevision(), sceneStore.getMutationRevision()]), actors: actorStore.list(), scenes: sceneStore.list() };
        },
        read: (type, operation) => systemService.getSystemClient().readDocumentSources(type, operation),
        remove: (sceneId, tokenId) => systemService.getSystemClient().dispatchDocumentSocket('Token', 'delete', { ids: [tokenId], parentUuid: `Scene.${sceneId}`, broadcast: true }),
    });
}
let cleanup: ReturnType<typeof createOrphanTokenCleanup> | undefined;
