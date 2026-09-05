const ABSOLUTE_OR_INLINE_PREFIXES = ['http', 'data:'];

function isAlreadyResolvedUrl(value: string): boolean {
    return ABSOLUTE_OR_INLINE_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function stripLeadingSlash(path: string): string {
    return path.startsWith('/') ? path.slice(1) : path;
}

export function normalizeFoundryBaseUrl(foundryBaseUrl: string): string {
    return foundryBaseUrl.endsWith('/') ? foundryBaseUrl.slice(0, -1) : foundryBaseUrl;
}

export function resolveFoundryUrl(path: string, foundryBaseUrl: string): string {
    if (!path) return path;
    if (isAlreadyResolvedUrl(path)) return path;

    const cleanBase = normalizeFoundryBaseUrl(foundryBaseUrl);
    const cleanPath = stripLeadingSlash(path);

    return `${cleanBase}/${cleanPath}`;
}

export function resolveFoundryHtml(html: string, foundryBaseUrl: string): string {
    if (!html) return '';

    const cleanBase = `${normalizeFoundryBaseUrl(foundryBaseUrl)}/`;

    return html
        .replace(/src="([^"]+)"/g, (match, src: string) => {
            if (isAlreadyResolvedUrl(src)) return match;
            return `src="${cleanBase}${stripLeadingSlash(src)}"`;
        })
        .replace(/href="([^"]+)"/g, (match, href: string) => {
            if (isAlreadyResolvedUrl(href) || href.startsWith('#')) return match;
            return `href="${cleanBase}${stripLeadingSlash(href)}"`;
        });
}
