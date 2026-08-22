import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { logger } from '@shared/utils/logger';
import {
    ensureOwnerOnlyDirectorySync,
    ensureOwnerOnlyFileSync,
    getSecurityDir,
    OWNER_ONLY_FILE_MODE,
} from '@core/paths';

/** Returns the admin audit file path within the resolved security directory. */
const getAuditFile = () => path.join(getSecurityDir(), 'admin-audit.ndjson');

import { ManagerOutcome } from '@shared/types/modules';

export interface AdminAuditEvent {
    eventId: string;
    timestamp: string;
    adminId: string;
    method: string;
    path: string;
    statusCode: number;
    outcome: typeof ManagerOutcome.Success | typeof ManagerOutcome.Failure;
    ip: string;
    userAgent?: string;
    durationMs?: number;
}

export async function appendAdminAuditEvent(input: Omit<AdminAuditEvent, 'eventId' | 'timestamp'>): Promise<void> {
    const event: AdminAuditEvent = {
        eventId: randomUUID(),
        timestamp: new Date().toISOString(),
        ...input,
    };

    try {
        ensureOwnerOnlyDirectorySync(getSecurityDir());
        const auditFile = getAuditFile();
        // Open with a private creation mode; startup migration and the explicit
        // post-append check also correct an existing permissive file.
        const handle = await fs.open(auditFile, 'a', OWNER_ONLY_FILE_MODE);
        try {
            await handle.appendFile(JSON.stringify(event) + '\n', 'utf8');
        } finally {
            await handle.close();
        }
        ensureOwnerOnlyFileSync(auditFile);
    } catch (error) {
        logger.error('Failed to append admin audit event', error);
    }
}

export async function listAdminAuditEvents(limit = 100): Promise<AdminAuditEvent[]> {
    const safeLimit = Math.max(1, Math.min(500, Number.isFinite(limit) ? Math.floor(limit) : 100));

    try {
        const raw = await fs.readFile(getAuditFile(), 'utf8');
        const lines = raw.split('\n').filter((line) => line.trim().length > 0);

        const parsed: AdminAuditEvent[] = [];
        for (const line of lines) {
            try {
                const event = JSON.parse(line) as AdminAuditEvent;
                parsed.push(event);
            } catch {
                // Skip malformed lines; keep audit stream readable.
            }
        }

        return parsed.slice(-safeLimit).reverse();
    } catch (error: any) {
        if (error?.code === 'ENOENT') {
            return [];
        }
        logger.error('Failed to read admin audit events', error);
        throw error;
    }
}
