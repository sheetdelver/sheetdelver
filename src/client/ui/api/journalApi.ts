import { requestJson } from '@client/ui/api/http';
import type { JournalEntryDto, JournalListPayload } from '@shared/contracts/journals';

export function fetchJournals(token: string): Promise<JournalListPayload> {
    return requestJson<JournalListPayload>('/api/journals', { token });
}

export function fetchJournalById(token: string, id: string): Promise<JournalEntryDto> {
    return requestJson<JournalEntryDto>(`/api/journals/${id}`, { token });
}

export function createJournalEntry(token: string | null, name: string, folderId?: string): Promise<Record<string, unknown>> {
    return requestJson<Record<string, unknown>>('/api/journals', {
        method: 'POST',
        token,
        body: {
            type: 'JournalEntry',
            data: { name, folder: folderId || null },
        },
    });
}

export function updateJournalEntry(token: string | null, id: string, data: Partial<JournalEntryDto>): Promise<Record<string, unknown>> {
    return requestJson<Record<string, unknown>>(`/api/journals/${id}`, {
        method: 'PATCH',
        token,
        body: {
            type: 'JournalEntry',
            data,
        },
    });
}

export function deleteJournalEntry(token: string | null, id: string): Promise<Record<string, unknown>> {
    return requestJson<Record<string, unknown>>(`/api/journals/${id}`, {
        method: 'DELETE',
        token,
    });
}

export function createJournalFolder(token: string | null, name: string, parentId?: string): Promise<Record<string, unknown>> {
    return requestJson<Record<string, unknown>>('/api/journals', {
        method: 'POST',
        token,
        body: {
            type: 'Folder',
            data: {
                name,
                type: 'JournalEntry',
                parent: parentId || null,
            },
        },
    });
}
