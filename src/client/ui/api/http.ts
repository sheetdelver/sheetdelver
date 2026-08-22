export class ApiError extends Error {
    status: number;

    constructor(message: string, status: number) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
    }
}

export class UnauthorizedApiError extends ApiError {
    constructor(message: string = 'Unauthorized') {
        super(message, 401);
        this.name = 'UnauthorizedApiError';
    }
}

interface RequestJsonOptions {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    token?: string | null;
    body?: unknown;
    cache?: RequestCache;
}

export async function requestJson<T>(path: string, options: RequestJsonOptions = {}): Promise<T> {
    const headers: Record<string, string> = {};
    // `token` remains a temporary caller-compatibility argument. Authentication
    // is carried only by the same-origin HttpOnly player-session cookie.
    void options.token;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await fetch(path, {
        method: options.method || 'GET',
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        cache: options.cache,
        credentials: 'same-origin',
    });

    if (res.status === 401) {
        throw new UnauthorizedApiError();
    }

    const text = await res.text();
    const payload = text ? (JSON.parse(text) as T) : ({} as T);

    if (!res.ok) {
        const message =
            (payload as { error?: string } | undefined)?.error ||
            `${res.status} ${res.statusText}`;
        throw new ApiError(message, res.status);
    }

    return payload;
}
