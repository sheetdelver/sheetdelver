import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SharedContentStore, sharedContentStore } from '@server/core/world/SharedContentStore';
import { journalStore } from '@server/core/documents/primary/journals/JournalStore';
import { userStore } from '@server/core/documents/primary/users/UserStore';
import { createSharedJournalService } from '@server/services/journals/SharedJournalService';
import { createJournalService } from '@server/services/journals/JournalService';
import { attachSharedContentIngress } from '@server/services/utility/SharedContentIngress';
import { registerJournalRoutes } from '@server/routes/protected/registerJournalRoutes';
import { createRouteMap, createRouterStub, getLastHandler, invokeHandler } from '../routing/route-test-helpers';
import { isErrorPayload } from '@server/shared/utils/isErrorPayload';
import type { JournalEntryDto, SharedJournalView } from '@shared/contracts/journals';
import type { JournalEntryDocument } from '@server/shared/types/documents';

export async function run() {
    let now = 100;
    const shares = new SharedContentStore(() => now);
    const scope = { sessionId: 'a', worldId: 'world', userId: 'player' };
    const userClient = new EventEmitter();
    const detach = attachSharedContentIngress(userClient, { ...scope, isCurrent: () => true }, shares);
    await userStore.seed(async () => [{ _id: 'player', role: 1 }, { _id: 'owner', role: 1 }]);
    const source: JournalEntryDocument[] = [{ _id: 'private', name: 'Shared story', ownership: { default: 0 }, flags: { private: 'hidden flag' }, pages: [
        { _id: 'first', name: 'First', type: 'text', ownership: { default: -1 }, text: { content: '<p>PUBLIC</p><section class="secret">UNREVEALED</section><section class="secret revealed">REVEALED</section>' }, flags: { private: 'hidden page flag' } },
        { _id: 'second', name: 'Restricted sibling', type: 'text', ownership: { default: 0 }, text: { content: 'SIBLING' } },
        { _id: 'image', name: 'Image', type: 'image', ownership: { default: -1 }, src: 'picture.png', image: { caption: 'Caption', private: 'hidden image flag' } },
        { _id: 'owned', name: 'Owned page', type: 'text', ownership: { default: 0, owner: 3 }, text: { content: '<section class="secret">OWNER SECRET</section>' } },
    ] }, { _id: 'public', name: 'Public story', ownership: { default: 2 }, pages: [
        { _id: 'public-page', name: 'Public', ownership: { default: -1 }, text: { content: 'PUBLIC PAGE' } },
        { _id: 'private-page', name: 'Private', ownership: { default: 0 }, text: { content: 'PRIVATE PAGE' } },
    ] }];
    await journalStore.seed(async () => source);
    const service = createSharedJournalService(shares);
    const ordinary = createJournalService();
    const before = journalStore.get('private');
    const share = (page?: string, force = true) => {
        userClient.emit('foundry:showEntry', { uuid: 'JournalEntry.private' + (page ? '.JournalEntryPage.' + page : ''), args: [force] });
        const receipt = shares.getCurrent(scope.sessionId, scope.worldId)!;
        return { streamId: receipt.streamId!, sequence: receipt.sequence!, shareId: receipt.shareId! };
    };
    const open = (receipt: ReturnType<typeof share>, recipient = scope): SharedJournalView => {
        const view = service.open(recipient, receipt);
        assert.ok(!isErrorPayload(view), JSON.stringify(view));
        return view as SharedJournalView;
    };
    const read = (view: SharedJournalView, recipient = scope): JournalEntryDto => {
        const projection = service.read(recipient, view.viewId);
        assert.ok(!isErrorPayload(projection), JSON.stringify(projection));
        return projection as JournalEntryDto;
    };
    try {
        const receipt = share('first');
        assert.equal(shares.getCurrent('a', 'world')?.data?.force, true);
        const view = open(receipt);
        const body = read(view);
        assert.deepEqual(body.pages?.map(page => page._id), ['first']);
        assert.match(JSON.stringify(body), /PUBLIC/);
        assert.match(JSON.stringify(body), /REVEALED/);
        assert.doesNotMatch(JSON.stringify(body), /UNREVEALED|SIBLING|hidden flag|hidden page flag|ownership/);
        assert.ok(isErrorPayload(await ordinary.getJournalById({ userId: 'player' } as any, 'private')), 'ordinary detail remains denied');
        assert.deepEqual(journalStore.get('private'), before, 'temporary display never mutates ownership/source');
        assert.ok(isErrorPayload(service.open({ ...scope, sessionId: 'other' }, receipt)));
        assert.ok(isErrorPayload(service.open(scope, { ...receipt, force: true })));
        assert.ok(isErrorPayload(service.open(scope, { ...receipt, sequence: receipt.sequence + 1 })));
        assert.ok(isErrorPayload(service.read({ ...scope, sessionId: 'other' }, view.viewId)));
        assert.ok(isErrorPayload(service.read({ ...scope, worldId: 'other' }, view.viewId)));
        assert.equal(read(view)._id, 'private', 'a wrong-world attempt cannot revoke the rightful lease');
        const secondBrowser = open(receipt);
        service.close(scope, view.viewId);
        assert.ok(isErrorPayload(service.read(scope, view.viewId)));
        assert.equal(read(secondBrowser)._id, 'private', 'independent browser close does not retire another lease');
        const whole = open(share());
        assert.ok(isErrorPayload(service.read(scope, secondBrowser.viewId)), 'supersession revokes old views');
        assert.deepEqual(read(whole).pages?.map(page => page._id), ['first', 'image']);
        const nonForced = share('first', false);
        assert.ok(isErrorPayload(service.open(scope, nonForced)), 'force=false cannot open a private entry');
        userClient.emit('foundry:showEntry', { uuid: 'JournalEntry.public.JournalEntryPage.public-page', args: [false] });
        const publicReceipt = shares.getCurrent('a', 'world')!;
        const publicView = open({ streamId: publicReceipt.streamId!, sequence: publicReceipt.sequence!, shareId: publicReceipt.shareId! });
        assert.match(JSON.stringify(read(publicView)), /PUBLIC PAGE/);
        userClient.emit('foundry:showEntry', { uuid: 'JournalEntry.public.JournalEntryPage.private-page', args: [false] });
        const denied = shares.getCurrent('a', 'world')!;
        assert.ok(isErrorPayload(service.open(scope, { streamId: denied.streamId!, sequence: denied.sequence!, shareId: denied.shareId! })));
        const ownedReceipt = share('owned');
        const ownedView = open(ownedReceipt, { ...scope, userId: 'owner' });
        assert.match(JSON.stringify(read(ownedView, { ...scope, userId: 'owner' })), /OWNER SECRET/);
        const limitedView = open(ownedReceipt);
        assert.doesNotMatch(JSON.stringify(read(limitedView)), /OWNER SECRET/);
        now += 29 * 60 * 1000;
        read(limitedView);
        now += 2 * 60 * 1000;
        read(limitedView);
        now += 30 * 60 * 1000;
        assert.ok(isErrorPayload(service.read(scope, limitedView.viewId)), 'idle expiry is enforced without polling');
        const latest = share('first');
        const views = Array.from({ length: 16 }, () => open(latest));
        assert.equal((service.open(scope, latest) as { status: number }).status, 429);
        service.close(scope, views[0].viewId);
        open(latest);
        shares.clearSession('a');
        assert.ok(isErrorPayload(service.read(scope, views[1].viewId)));
        const afterSession = open(share('first'));
        shares.clear('world-retired');
        assert.ok(isErrorPayload(service.read(scope, afterSession.viewId)));
        const deleted = open(share('second'));
        journalStore.applyModifyDocument('JournalEntryPage', 'delete', ['second'], { parentId: 'private' });
        assert.ok(isErrorPayload(service.read(scope, deleted.viewId)), 'a deleted page never falls back to siblings');

        // Exercise the real registrar's session/system gate and no-store responses.
        sharedContentStore.set('a', 'world', { type: 'journal', data: { id: 'private', pageId: 'first', force: true } });
        const native = sharedContentStore.getCurrent('a', 'world')!;
        const routes = createRouteMap(); registerJournalRoutes(createRouterStub(routes) as any);
        const route = (method: 'get' | 'post' | 'delete') => getLastHandler(routes, method, '/shared-content/journal-view');
        const request = { foundryClient: { userId: 'player' }, userSession: { id: 'a', worldId: 'world', userId: 'player' },
            body: { streamId: native.streamId, sequence: native.sequence, shareId: native.shareId }, query: {} } as any;
        const opened = await invokeHandler(route('post'), request);
        assert.equal(opened.statusCode, 200); assert.equal(opened.headers['Cache-Control'], 'no-store');
        const routeView = opened.payload as SharedJournalView;
        const response = await invokeHandler(route('get'), { ...request, query: { viewId: routeView.viewId } });
        assert.equal(response.statusCode, 200); assert.doesNotMatch(JSON.stringify(response.payload), /UNREVEALED|SIBLING/);
        for (const method of ['get', 'post', 'delete'] as const) {
            assert.equal((await invokeHandler(route(method), { ...request, isSystem: true })).statusCode, 403);
            assert.equal((await invokeHandler(route(method), { ...request, userSession: undefined })).statusCode, 403);
            assert.equal((await invokeHandler(route(method), { ...request, foundryClient: { userId: 'other' } } as any)).statusCode, 403);
        }
        await invokeHandler(route('delete'), { ...request, body: { viewId: routeView.viewId } });
        assert.equal((await invokeHandler(route('get'), { ...request, query: { viewId: routeView.viewId } })).statusCode, 404);
        console.log('shared-journal-view: recipient/receipt/session routes, read-only projection, page isolation, Secrets, close/supersession/expiry/limits/retirement PASS');
    } finally { detach(); shares.clear(); sharedContentStore.clear(); journalStore.clear(); userStore.clear(); }
}
if (import.meta.url === `file://${process.argv[1]}`) run().catch(error => { console.error(error); process.exitCode = 1; });
