import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendAdminAuditEvent, listAdminAuditEvents } from '@server/security/adminAuditLog';

async function withTemporaryWorkingDirectory<T>(fn: () => Promise<T>): Promise<T> {
    const originalCwd = process.cwd();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sheet-delver-admin-audit-'));

    try {
        process.chdir(tempDir);
        return await fn();
    } finally {
        process.chdir(originalCwd);
        await fs.rm(tempDir, { recursive: true, force: true });
    }
}

async function runAdminAuditLogTests(): Promise<void> {
    await withTemporaryWorkingDirectory(async () => {
        const initial = await listAdminAuditEvents();
        assert.equal(initial.length, 0, 'Audit list should be empty on first read');

        await appendAdminAuditEvent({
            adminId: 'admin',
            method: 'POST',
            path: '/lifecycle/shadowdark/enable',
            statusCode: 200,
            outcome: 'success',
            ip: '127.0.0.1',
            userAgent: 'unit-test',
            durationMs: 12,
        });

        await appendAdminAuditEvent({
            adminId: 'admin',
            method: 'POST',
            path: '/lifecycle/shadowdark/disable',
            statusCode: 409,
            outcome: 'failure',
            ip: '127.0.0.1',
            durationMs: 18,
        });

        const all = await listAdminAuditEvents(10);
        assert.equal(all.length, 2, 'Expected 2 audit events');
        assert.equal(all[0].path, '/lifecycle/shadowdark/disable', 'Newest event should be first');
        assert.equal(all[1].path, '/lifecycle/shadowdark/enable', 'Older event should be second');

        const one = await listAdminAuditEvents(1);
        assert.equal(one.length, 1, 'Limit should trim results');
        assert.equal(one[0].path, '/lifecycle/shadowdark/disable', 'Limited result should return newest event');

        assert.equal(typeof all[0].eventId, 'string');
        assert.equal(typeof all[0].timestamp, 'string');
        assert.equal(all[0].adminId, 'admin');
    });
}

export const run = runAdminAuditLogTests;
