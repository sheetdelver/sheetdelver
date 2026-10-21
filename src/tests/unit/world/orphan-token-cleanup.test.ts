import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDataDir, initDataDir } from '@server/core/paths';
import { listAdminAuditEvents } from '@server/security/adminAuditLog';
import { createOrphanTokenCleanup } from '@server/services/world/OrphanTokenCleanup';
import { registerAdminCleanupRoutes } from '@server/routes/admin/registerAdminCleanupRoutes';
import { adminSessionManager, createAdminSessionClaims } from '@server/security/adminSessionService';

function fixture() {
    const state = { scope: 'world-epoch', revision: '1', actors: [{ _id: 'live' }] as Record<string, unknown>[], scenes: [{
        _id: 'scene', name: 'The old chapel', tokens: [
            { _id: 'orphan', name: 'Forgotten skeleton', actorId: 'gone', actorLink: false, delta: { _id: 'delta', items: [{ _id: 'sword' }] } },
            { _id: 'linked', name: 'Old placement', actorId: 'gone', actorLink: true },
            { _id: 'decoration', actorId: null }, { _id: 'valid', actorId: 'live' },
        ],
    }] as Record<string, unknown>[] };
    let writes = 0; let reads = 0;
    let onRead: (type: string, count: number) => void | Promise<void> = () => {};
    let onWrite = () => {};
    let actuallyDelete = true;
    const cleanup = createOrphanTokenCleanup({
        snapshot: () => structuredClone(state),
        read: async (type, operation) => {
            reads++; await onRead(type, reads);
            if (type === 'Scene') return { result: structuredClone(state.scenes.filter(row => row._id === (operation.query as { _id: string })._id)) };
            assert.equal(type, 'Actor'); return structuredClone(state.actors);
        },
        remove: async (sceneId, tokenId) => {
            const scene = state.scenes.find(row => row._id === sceneId)!; writes++;
            if (actuallyDelete) scene.tokens = (scene.tokens as Record<string, unknown>[]).filter(token => token._id !== tokenId);
            onWrite();
        },
    });
    return { state, cleanup, input: () => ({ ...cleanup.list()[0], confirmed: true }),
        writes: () => writes, reads: () => reads, setRead: (fn: typeof onRead) => { onRead = fn; },
        setWrite: (fn: typeof onWrite) => { onWrite = fn; }, noDelete: () => { actuallyDelete = false; } };
}

export async function run() {
    const first = fixture(); const original = JSON.stringify(first.state);
    assert.deepEqual(first.cleanup.list().map(row => row.tokenName), ['Forgotten skeleton', 'Old placement']);
    assert.equal(first.cleanup.list()[0].sceneName, 'The old chapel');
    assert.equal(JSON.stringify(first.state), original); assert.equal(first.writes(), 0); assert.equal(first.reads(), 0);
    await assert.rejects(first.cleanup.remove({ ...first.input(), confirmed: false }, () => {}), /confirm/);
    assert.equal(first.writes(), 0); assert.equal(first.reads(), 0);
    assert.deepEqual(await first.cleanup.remove(first.input(), () => {}), { deleted: true });
    assert.equal(first.writes(), 1); assert.equal(first.cleanup.list().length, 1);

    for (const scenario of ['changed-token', 'restored-actor', 'changed-world', 'changed-revision', 'revoked-admin', 'unreadable', 'malformed-actors'] as const) {
        const test = fixture(); const input = test.input(); let admin = true;
        if (scenario === 'changed-token') (test.state.scenes[0].tokens as Record<string, unknown>[])[0].name = 'Changed';
        if (scenario === 'restored-actor') test.state.actors.push({ _id: 'gone' });
        if (scenario === 'malformed-actors') test.state.actors = [{}];
        test.setRead((_type, count) => {
            if (count !== 1) return;
            if (scenario === 'changed-world') test.state.scope = 'new-world';
            if (scenario === 'changed-revision') test.state.revision = '2';
            if (scenario === 'revoked-admin') admin = false;
            if (scenario === 'unreadable') throw new Error('source unavailable');
        });
        await assert.rejects(test.cleanup.remove(input, () => { if (!admin) throw new Error('session revoked'); }), scenario);
        assert.equal(test.writes(), 0, scenario);
    }
    const lostReceipt = fixture(); lostReceipt.setWrite(() => { throw new Error('receipt lost'); });
    assert.deepEqual(await lostReceipt.cleanup.remove(lostReceipt.input(), () => {}), { deleted: true });
    assert.equal(lostReceipt.writes(), 1, 'fresh source confirms outcome without replay');
    for (const outcome of ['still-present', 'readback-failed', 'world-changed', 'parent-gone', 'missing-token-array'] as const) {
        const test = fixture();
        if (outcome === 'still-present') test.noDelete();
        test.setWrite(() => {
            if (outcome === 'world-changed') test.state.scope = 'new-world';
            if (outcome === 'parent-gone') test.state.scenes = [];
            if (outcome === 'missing-token-array') delete test.state.scenes[0].tokens;
        });
        test.setRead((_type, count) => { if (count === 3 && outcome === 'readback-failed') throw new Error('readback lost'); });
        await assert.rejects(test.cleanup.remove(test.input(), () => {}), /not confirmed/, outcome);
        assert.equal(test.writes(), 1, 'uncertain result does not resend');
    }
    const duplicate = fixture(); let unblock!: () => void;
    const wait = new Promise<void>(resolve => { unblock = resolve; });
    duplicate.setRead(async (_type, count) => { if (count === 1) await wait; });
    const input = duplicate.input(); const pending = duplicate.cleanup.remove(input, () => {});
    await assert.rejects(duplicate.cleanup.remove(input, () => {}), /already running/);
    unblock(); await pending; assert.equal(duplicate.writes(), 1);

    const bulk = fixture();
    bulk.state.scenes.push({ _id: 'second', name: 'Tower', tokens: [{ _id: 'tower', name: 'Rubble', actorId: 'lost' }] });
    const all = bulk.cleanup.list();
    bulk.setWrite(() => { bulk.state.revision = String(Number(bulk.state.revision) + 1); });
    const bulkResult = await bulk.cleanup.removeSelected({ tokens: [all[0], all[2]], confirmed: true }, () => {});
    assert.deepEqual(bulkResult.results.map(row => row.state), ['deleted', 'deleted']);
    assert.equal(bulk.writes(), 2); assert.deepEqual(bulk.cleanup.list().map(row => row.tokenId), ['linked'], 'unselected token is preserved');
    for (const invalid of [[], [all[0], all[0]], [{ sceneId: 'bad/id', tokenId: 'x', review: 'x' }]]) {
        await assert.rejects(bulk.cleanup.removeSelected({ tokens: invalid, confirmed: true }, () => {}));
        assert.equal(bulk.writes(), 2, 'invalid selection dispatches nothing');
    }
    for (const scenario of ['changed-second', 'readback-failed', 'world-changed', 'admin-revoked']) {
        const batch = fixture(); let admin = true;
        batch.state.scenes.push({ _id: 'last', tokens: [{ _id: 'last', actorId: 'lost' }] });
        const tokens = batch.cleanup.list();
        batch.setWrite(() => {
            if (batch.writes() !== 1) return;
            batch.state.revision = '2';
            if (scenario === 'changed-second') (batch.state.scenes[0].tokens as Record<string, unknown>[])[0].name = 'Changed since review';
        });
        batch.setRead((_type, count) => {
            if (count === 6 && scenario === 'readback-failed') throw new Error('readback unavailable');
            if (count === 4 && scenario === 'world-changed') batch.state.scope = 'new-world';
            if (count === 4 && scenario === 'admin-revoked') admin = false;
        });
        const result = await batch.cleanup.removeSelected({ tokens, confirmed: true }, () => { if (!admin) throw new Error('session revoked'); });
        assert.deepEqual(result.results.map(row => row.state), ['deleted', scenario === 'readback-failed' ? 'unconfirmed' : 'not-deleted', 'not-attempted'], scenario);
        assert.equal(batch.writes(), scenario === 'readback-failed' ? 2 : 1, 'no replay or later writes');
    }

    // Actual HTTP middleware: ordinary/Foundry credentials cannot use admin cleanup.
    const previousData = getDataDir();
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-orphan-cleanup-'));
    initDataDir(data);
    const http = fixture(); const app = express(); app.use(express.json());
    registerAdminCleanupRoutes(app, (_req, _res, next) => next(), async () => http.cleanup);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}/world-cleanup/orphan-tokens`;
    const claims = createAdminSessionClaims('orphan-cleanup-test', 60_000);
    const token = adminSessionManager.storeSession(claims);
    const headers = { Authorization: `Bearer ${token}`, Origin: `http://127.0.0.1:${address.port}`, 'Content-Type': 'application/json', 'X-Admin-Csrf-Token': claims.csrfToken };
    try {
        assert.equal((await fetch(base)).status, 401);
        assert.equal((await fetch(base, { headers: { Authorization: 'Bearer ordinary-player' } })).status, 401);
        const listed = await fetch(base, { headers }); assert.equal(listed.status, 200); assert.equal(listed.headers.get('cache-control'), 'no-store');
        assert.equal((await listed.json()).tokens.length, 2);
        const body = JSON.stringify(http.input());
        assert.equal((await fetch(`${base}/delete`, { method: 'POST', headers: { ...headers, 'X-Admin-Csrf-Token': '' }, body })).status, 403);
        assert.equal(http.writes(), 0);
        const selected = http.cleanup.list();
        const bulkResponse = await fetch(`${base}/delete`, { method: 'POST', headers, body: JSON.stringify({ tokens: [selected[1]], confirmed: true }) });
        assert.equal(bulkResponse.status, 200); assert.equal((await bulkResponse.json()).results[0].state, 'deleted');
        assert.equal(http.writes(), 1);
        http.setRead(() => { adminSessionManager.revokeSession(token); });
        assert.equal((await fetch(`${base}/delete`, { method: 'POST', headers, body })).status, 409);
        assert.equal(http.writes(), 1, 'admin revocation before dispatch rejects the delete');
        for (let i = 0; i < 40 && !(await listAdminAuditEvents()).some(row => row.statusCode === 409); i++) await new Promise(resolve => setTimeout(resolve, 5));
        assert.ok((await listAdminAuditEvents()).some(row => row.statusCode === 409), 'cleanup attempt uses existing admin audit');
    } finally {
        adminSessionManager.revokeSession(token);
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        initDataDir(previousData); fs.rmSync(data, { recursive: true, force: true });
    }
    console.log('orphan-token-cleanup: named review, exact deletion, no-write rejections, readback, duplicate protection and admin HTTP guards passed');
}
if (import.meta.url === `file://${process.argv[1]}`) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-cleanup-unit-')); initDataDir(root);
    run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
}
