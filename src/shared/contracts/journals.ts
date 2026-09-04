export interface JournalPageTextDto {
    content?: string;
    [key: string]: unknown;
}

export interface JournalPageDto {
    id?: string;
    _id?: string;
    name?: string;
    sort?: number;
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
    sort?: number;
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
    sorting: 'a' | 'm';
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
