import sanitizeHtml from 'sanitize-html';

declare const safeHtmlBrand: unique symbol;

/** HTML that has crossed the platform sanitizer and is eligible for rendering. */
export type SafeHtml = string & { readonly [safeHtmlBrand]: true };

export interface SanitizeRichHtmlOptions {
    foundryBaseUrl?: string;
}

const ALLOWED_TAGS = [
    'a', 'article', 'b', 'blockquote', 'br', 'button', 'code', 'dd', 'details',
    'del', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'footer', 'h1',
    'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i', 'img', 'ins', 'kbd',
    'li', 'mark', 'ol', 'p', 'pre', 's', 'samp', 'section', 'small', 'span',
    'strike', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot',
    'th', 'thead', 'time', 'tr', 'u', 'ul', 'var', 'caption', 'col', 'colgroup',
] as const;

const SHARED_DATA_ATTRIBUTES = [
    'data-action',
    'data-dc',
    'data-content-embed',
    'data-document-class',
    'data-document-id',
    'data-entry-id',
    'data-formula',
    'data-id',
    'data-link',
    'data-mode',
    'data-pack',
    'data-page-id',
    'data-stat',
    'data-tooltip',
    'data-tooltip-class',
    'data-tooltip-direction',
    'data-tooltip-text',
    'data-type',
    'data-user-id',
    'data-uuid',
] as const;

function resolveRelativeUrl(value: string | undefined, foundryBaseUrl?: string): string | undefined {
    if (!value || !foundryBaseUrl || value.startsWith('#')) return value;

    // Preserve absolute schemes for the sanitizer to approve or reject. Rewriting
    // a javascript: value as a relative Foundry URL would conceal its origin.
    if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('//')) return value;

    try {
        const base = foundryBaseUrl.endsWith('/') ? foundryBaseUrl : `${foundryBaseUrl}/`;
        return new URL(value.replace(/^\/+/, ''), base).toString();
    } catch {
        return value;
    }
}

function transformUrlTag(
    tagName: string,
    attribs: sanitizeHtml.Attributes,
    foundryBaseUrl?: string,
): sanitizeHtml.Tag {
    const rewritten = { ...attribs };

    if (tagName === 'a') {
        rewritten.href = resolveRelativeUrl(rewritten.href, foundryBaseUrl) ?? '';
        if (rewritten.target === '_blank') {
            rewritten.rel = 'noopener noreferrer';
        }
    }

    if (tagName === 'img') {
        rewritten.src = resolveRelativeUrl(rewritten.src, foundryBaseUrl) ?? '';
        // Inline raster images are supported; executable SVG and arbitrary data
        // payloads are rejected even though the data scheme is allowed for img.
        if (rewritten.src.startsWith('data:')
            && !/^data:image\/(?:gif|jpeg|png|webp);base64,/i.test(rewritten.src)) {
            delete rewritten.src;
        }
    }

    return { tagName, attribs: rewritten };
}

/**
 * Rewrite Foundry-relative URLs while parsing, then sanitize the final markup.
 * No caller may brand a string without crossing this function.
 */
export function sanitizeRichHtml(
    untrustedHtml: string,
    options: SanitizeRichHtmlOptions = {},
): SafeHtml {
    if (!untrustedHtml) return '' as SafeHtml;

    return sanitizeHtml(untrustedHtml, {
        allowedTags: [...ALLOWED_TAGS],
        allowedAttributes: {
            '*': ['class', 'title', 'role', 'aria-label', 'aria-hidden', ...SHARED_DATA_ATTRIBUTES],
            a: ['draggable', 'href', 'name', 'rel', 'target', ...SHARED_DATA_ATTRIBUTES],
            button: ['disabled', 'type', ...SHARED_DATA_ATTRIBUTES],
            col: ['span'],
            img: ['alt', 'height', 'loading', 'src', 'width'],
            ol: ['start', 'type'],
            td: ['colspan', 'rowspan'],
            th: ['colspan', 'rowspan', 'scope'],
            time: ['datetime'],
        },
        allowedSchemes: ['http', 'https', 'mailto'],
        allowedSchemesByTag: {
            img: ['data', 'http', 'https'],
        },
        allowProtocolRelative: false,
        disallowedTagsMode: 'discard',
        nonTextTags: ['script', 'style', 'textarea', 'option', 'iframe', 'object', 'embed', 'svg', 'math'],
        transformTags: {
            a: (tagName, attribs) => transformUrlTag(tagName, attribs, options.foundryBaseUrl),
            img: (tagName, attribs) => transformUrlTag(tagName, attribs, options.foundryBaseUrl),
        },
    }) as SafeHtml;
}
