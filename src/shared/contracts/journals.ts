export interface JournalPageTextDto {
    content?: string;
    [key: string]: unknown;
}

export interface JournalPageDto {
    name?: string;
    text?: JournalPageTextDto;
    [key: string]: unknown;
}

export interface JournalEntryDto {
    id?: string;
    _id: string;
    name: string;
    folder: string | null;
    content?: string;
    pages?: JournalPageDto[];
    ownership?: Record<string, number>;
    [key: string]: unknown;
}

export interface JournalFolderDto {
    id?: string;
    _id: string;
    name: string;
    type: string;
    parent: string | null;
    sort: number;
    color: string | null;
    ownership?: Record<string, number>;
    [key: string]: unknown;
}

export interface JournalListPayload {
    journals: JournalEntryDto[];
    folders: JournalFolderDto[];
}

export interface JournalErrorPayload {
    error: string;
    status: number;
}
