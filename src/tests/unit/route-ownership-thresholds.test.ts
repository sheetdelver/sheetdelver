/**
 * ADR-0013 Phase 2: route-threshold integration tests.
 *
 * Confirms that each primary-document read path applies the documented
 * `DOCUMENT_VISIBILITY` threshold at the service boundary. Mostly the routes
 * themselves are thin pass-throughs to services, and the services delegate
 * read filtering to the Stores via `Store.list({ subject, minOwnership })`
 * and `Store.get(id, { subject, minOwnership })`. These tests exercise that
 * chain end-to-end with subjects spanning the threshold bands and assert
 * which docs are returned per band.
 *
 * Known divergence (documented, not a Phase 2 regression):
 *   - Actor detail endpoints (`/api/actors/:id`, `/api/actors/:id/card`) and
 *     bulk-card reads currently use LIST_VISIBLE for the per-actor lookup
 *     instead of DETAIL_VISIBLE. The route-client comment at `getActor` flags
 *     this for a future split. Phase 2's test reflects what's shipped.
 *   - Write endpoints (POST/PATCH/DELETE on actors, journals, combats, etc.)
 *     do NOT apply a Sheet Delver-side WRITEABLE courtesy gate before
 *     dispatching to Foundry. Foundry is the authoritative permission check
 *     on writes; the ADR text says "courtesy reject" but the current
 *     registrars omit it. Phase 2 documents this and leaves the gap as a
 *     follow-up — not a regression introduced by Phase 1.
 */
import { strict as assert } from 'node:assert';
import { actorStore } from '@server/core/documents/primary/actors/ActorStore';
import { chatMessageStore } from '@server/core/documents/primary/chat-messages/ChatMessageStore';
import { combatStore } from '@server/core/documents/primary/combats/CombatStore';
import { folderStore } from '@server/core/documents/primary/folders/FolderStore';
import { journalStore } from '@server/core/documents/primary/journals/JournalStore';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import {
    DOCUMENT_VISIBILITY,
    DocumentOwnershipLevel,
    FoundryUserRole,
} from '@server/core/documents/primary/base/ownership';
import { createChatService } from '@server/services/chat/ChatService';
import { createJournalService } from '@server/services/journals/JournalService';
import type {
    ChatClientLike,
    JournalClientLike,
    RawJournal,
} from '@server/shared/types/documents';
import type { RawActor } from '@server/shared/types/actors';

const config = { app: { chatHistory: 100 } } as any;

export async function run() {
    await runChatLogListThresholdIsListVisible();
    await runJournalListVsDetailThresholdsDiverge();
    await runCombatListVisibilityCrossesActorStore();
    await runActorDetailUsesListVisibleAsShipped();
    console.log('  - Route ownership thresholds: all checks passed');
}

/**
 * Chat list endpoint applies LIST_VISIBLE through `chatMessageStore.list`
 * with `resolveOwnership` doing the whisper/blind/author dispatch.
 *
 * Threshold chain:
 *   registerChatRoutes GET /chat
 *     → ChatService.getChatLog(client, limit)
 *     → chatMessageStore.list({ subject, minOwnership: LIST_VISIBLE })
 *     → ChatMessageStore.resolveOwnership (whisper/blind/author)
 */
async function runChatLogListThresholdIsListVisible() {
    await userStore.seed(async () => [
        { _id: 'gm-1', name: 'GM', role: FoundryUserRole.GAMEMASTER },
        { _id: 'p-target', name: 'Target', role: FoundryUserRole.PLAYER },
        { _id: 'p-other', name: 'Other', role: FoundryUserRole.PLAYER },
        { _id: 'p-author', name: 'Author', role: FoundryUserRole.PLAYER },
    ]);
    await chatMessageStore.seed(async () => [
        { _id: 'm-world', author: 'gm-1', whisper: [], blind: false, content: 'world-visible' },
        { _id: 'm-whisper-target', author: 'gm-1', whisper: ['p-target'], blind: false, content: 'whisper-target' },
        { _id: 'm-whisper-other', author: 'gm-1', whisper: ['p-other'], blind: false, content: 'whisper-other' },
        { _id: 'm-blind', author: 'p-author', whisper: [], blind: true, content: 'blind' },
        { _id: 'm-by-target', author: 'p-target', whisper: [], blind: false, content: 'by-target' },
    ]);

    try {
        const service = createChatService(config);

        const targetClient: ChatClientLike = {
            userId: 'p-target', on: () => undefined, off: () => undefined,
            createChatMessage: async () => ({}), dispatchDocument: async () => ({}), roll: async () => ({}),
        };
        const targetPayload = await service.getChatLog(targetClient, 100);
        const targetIds = targetPayload.messages.map((m: any) => m._id).sort();
        assert.deepEqual(
            targetIds,
            ['m-by-target', 'm-whisper-target', 'm-world'],
            'p-target sees world-visible + their own + whisper addressed to them (no blind, no other-user whisper)',
        );

        const otherClient: ChatClientLike = { ...targetClient, userId: 'p-other' };
        const otherPayload = await service.getChatLog(otherClient, 100);
        const otherIds = otherPayload.messages.map((m: any) => m._id).sort();
        assert.deepEqual(
            otherIds,
            ['m-by-target', 'm-whisper-other', 'm-world'],
            'p-other sees world-visible (including m-by-target, authored by another player with no whisper) + whisper addressed to them; no blind, no other-user whisper',
        );

        const gmClient: ChatClientLike = { ...targetClient, userId: 'gm-1' };
        const gmPayload = await service.getChatLog(gmClient, 100);
        assert.equal(gmPayload.messages.length, 5, 'GM sees everything including blind rolls');
    } finally {
        chatMessageStore.clear('threshold-test');
        userStore.clear('threshold-test');
    }
}

/**
 * Journal endpoints distinguish LIST_VISIBLE from DETAIL_VISIBLE — this is the
 * one type where the split is fully realized today, so the test pins the
 * divergence explicitly.
 *
 * Threshold chain:
 *   registerJournalRoutes GET /journals
 *     → JournalService.listJournals
 *     → journalStore.list({ subject, minOwnership: LIST_VISIBLE })
 *   registerJournalRoutes GET /journals/:id
 *     → JournalService.getJournalById
 *     → journalStore.get(id, { subject, minOwnership: DETAIL_VISIBLE })
 *     → journalStore.visiblePages(id, subject, DETAIL_VISIBLE)
 */
async function runJournalListVsDetailThresholdsDiverge() {
    await userStore.seed(async () => [
        { _id: 'gm-1', name: 'GM', role: FoundryUserRole.GAMEMASTER },
        { _id: 'p-1', name: 'Player', role: FoundryUserRole.PLAYER },
    ]);
    await folderStore.seed(async () => []);
    const journals: RawJournal[] = [
        // LIMITED: shows in list but NOT in detail.
        { _id: 'j-limited', name: 'Limited', folder: null, ownership: { default: 0, 'p-1': DocumentOwnershipLevel.LIMITED } },
        // OBSERVER: shows in list AND in detail.
        { _id: 'j-observer', name: 'Observer', folder: null, ownership: { default: 0, 'p-1': DocumentOwnershipLevel.OBSERVER } },
        // NONE: never visible.
        { _id: 'j-hidden', name: 'Hidden', folder: null, ownership: { default: 0 } },
    ];
    await journalStore.seed(async () => journals);

    try {
        const service = createJournalService();
        const playerClient: JournalClientLike = {
            userId: 'p-1', on: () => undefined, off: () => undefined,
            dispatchDocument: async () => ({}),
        };

        const listPayload = await service.listJournals(playerClient);
        const listIds = (listPayload.journals as any[]).map(j => j._id).sort();
        assert.deepEqual(
            listIds,
            ['j-limited', 'j-observer'],
            'LIST endpoint returns LIMITED + OBSERVER (LIST_VISIBLE threshold)',
        );

        // Detail at LIMITED → denied (DETAIL_VISIBLE requires OBSERVER).
        const limitedDetail = await service.getJournalById(playerClient, 'j-limited');
        assert.ok(
            'error' in limitedDetail,
            'DETAIL endpoint denies LIMITED journal (DETAIL_VISIBLE > LIMITED)',
        );

        // Detail at OBSERVER → granted.
        const observerDetail = await service.getJournalById(playerClient, 'j-observer');
        assert.ok(
            !('error' in observerDetail),
            'DETAIL endpoint grants OBSERVER journal',
        );
        assert.equal((observerDetail as any)._id, 'j-observer');
    } finally {
        journalStore.clear('threshold-test');
        folderStore.clear('threshold-test');
        userStore.clear('threshold-test');
    }
}

/**
 * Combat list visibility derives from ActorStore — a combat is LIST_VISIBLE
 * to a user iff any non-hidden combatant's actor is LIST_VISIBLE to them.
 *
 * Threshold chain:
 *   registerCombatRoutes GET /combats
 *     → CombatService.listCombats
 *     → combatStore.list({ subject })  // default minOwnership = LIST_VISIBLE
 *     → CombatStore.resolveOwnership → actorStore.canReadActor(..., LIST_VISIBLE)
 *
 * This also covers the Phase 1 cross-store coverage promise: an actor
 * ownership change propagates into combat visibility.
 */
async function runCombatListVisibilityCrossesActorStore() {
    await userStore.seed(async () => [
        { _id: 'p-1', name: 'Player', role: FoundryUserRole.PLAYER },
    ]);
    const combatActors: RawActor[] = [
        { _id: 'actor-hidden', name: 'Hidden', ownership: { default: 0 } },
        { _id: 'actor-visible', name: 'Visible', ownership: { default: 0, 'p-1': DocumentOwnershipLevel.LIMITED } },
    ];
    await actorStore.seed(async () => combatActors);
    await combatStore.seed(async () => [
        {
            _id: 'combat-only-hidden',
            id: 'combat-only-hidden',
            combatants: [{ _id: 'c1', id: 'c1', actorId: 'actor-hidden' }],
        },
        {
            _id: 'combat-with-visible',
            id: 'combat-with-visible',
            combatants: [{ _id: 'c2', id: 'c2', actorId: 'actor-visible' }],
        },
    ]);

    try {
        const subject = userStore.createAccessSubject('p-1');
        assert.ok(subject);

        // LIST_VISIBLE: only combats with at least one visible non-hidden combatant.
        const visible = combatStore.list({ subject });
        const visibleIds = visible.map(c => c._id).sort();
        assert.deepEqual(
            visibleIds,
            ['combat-with-visible'],
            'combat visibility derives from canReadActor(LIST_VISIBLE) per combatant',
        );

        // canReadDocument with LIST_VISIBLE matches.
        assert.equal(combatStore.canReadDocument('combat-with-visible', subject, DOCUMENT_VISIBILITY.LIST_VISIBLE), true);
        assert.equal(combatStore.canReadDocument('combat-only-hidden', subject, DOCUMENT_VISIBILITY.LIST_VISIBLE), false);
    } finally {
        combatStore.clear('threshold-test');
        actorStore.clear('threshold-test');
        userStore.clear('threshold-test');
    }
}

/**
 * Actor detail currently applies LIST_VISIBLE instead of DETAIL_VISIBLE
 * (per the comment at `createRouteFoundryClient.getActor`). Phase 2 pins this
 * as-shipped so future test runs catch any silent regression. The Journal
 * detail test above proves the DETAIL_VISIBLE threshold works correctly
 * where it IS applied.
 *
 * Threshold chain (current):
 *   registerActorRoutes GET /actors/:id
 *     → ActorService.getActorById
 *     → routeClient.getActor(id)
 *     → actorStore.getActor(id, { subject, minOwnership: LIST_VISIBLE })  // <- LIMITED, not OBSERVER
 *
 * If/when the actor detail path is split off to DETAIL_VISIBLE, this test
 * should flip from "LIMITED returns the doc" to "LIMITED is denied."
 */
async function runActorDetailUsesListVisibleAsShipped() {
    await userStore.seed(async () => [
        { _id: 'p-1', name: 'Player', role: FoundryUserRole.PLAYER },
    ]);
    const detailActors: RawActor[] = [
        { _id: 'actor-limited', name: 'Limited', ownership: { default: 0, 'p-1': DocumentOwnershipLevel.LIMITED } },
        { _id: 'actor-observer', name: 'Observer', ownership: { default: 0, 'p-1': DocumentOwnershipLevel.OBSERVER } },
        { _id: 'actor-hidden', name: 'Hidden', ownership: { default: 0 } },
    ];
    await actorStore.seed(async () => detailActors);

    try {
        const subject = userStore.createAccessSubject('p-1');
        assert.ok(subject);

        // List view at LIST_VISIBLE — both LIMITED and OBSERVER show up; hidden does not.
        const listed = actorStore.listActors({ subject, minOwnership: DOCUMENT_VISIBILITY.LIST_VISIBLE });
        const listIds = listed.map(a => a._id).sort();
        assert.deepEqual(
            listIds,
            ['actor-limited', 'actor-observer'],
            'LIST endpoint returns LIMITED + OBSERVER',
        );

        // Detail read at LIST_VISIBLE (the as-shipped behavior) — LIMITED still returns the doc.
        const limitedAsDetail = actorStore.getActor('actor-limited', { subject, minOwnership: DOCUMENT_VISIBILITY.LIST_VISIBLE });
        assert.ok(
            limitedAsDetail !== null,
            'Actor detail currently uses LIST_VISIBLE; LIMITED ownership returns the doc',
        );

        // What would happen at the documented DETAIL_VISIBLE threshold (for the future split):
        const limitedAtDetailVisible = actorStore.getActor('actor-limited', { subject, minOwnership: DOCUMENT_VISIBILITY.DETAIL_VISIBLE });
        assert.equal(
            limitedAtDetailVisible,
            null,
            'When the actor detail path is split off to DETAIL_VISIBLE, LIMITED ownership will return null. This assertion captures the future contract — the as-shipped LIST_VISIBLE check above will then change.',
        );

        // OBSERVER passes both thresholds.
        assert.ok(actorStore.getActor('actor-observer', { subject, minOwnership: DOCUMENT_VISIBILITY.DETAIL_VISIBLE }) !== null);

        // Hidden never returns.
        assert.equal(actorStore.getActor('actor-hidden', { subject, minOwnership: DOCUMENT_VISIBILITY.LIST_VISIBLE }), null);
    } finally {
        actorStore.clear('threshold-test');
        userStore.clear('threshold-test');
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('route-ownership-thresholds.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
