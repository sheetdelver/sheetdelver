
/**
 * Generic utility to resolve image paths.
 * Handles relative paths, absolute URLs, and prepending foundryUrl.
 */
export const resolveImage = (path: string, foundryUrl?: string) => {
    if (!path) return '/placeholder.png';
    if (path.startsWith('http') || path.startsWith('data:')) return path;

    if (foundryUrl) {
        const cleanPath = path.startsWith('/') ? path.slice(1) : path;
        const cleanUrl = foundryUrl.endsWith('/') ? foundryUrl : `${foundryUrl}/`;
        return `${cleanUrl}${cleanPath}`;
    }
    return path;
};

// Registry consumers share the SDK sanitizer so there is one HTML trust boundary.
export { processHtmlContent } from '@shared/sdk/utils';

/**
 * extract a safe description string from a system object field.
 * Many Foundry systems store descriptions as strings or objects with a 'value' property.
 */
export const getSafeDescription = (system: any) => {
    if (!system) return '';
    // 1. Try explicit .value property (common for rich text objects)
    if (system.description?.value) return system.description.value;
    // 2. Try description as a direct string
    else if (typeof system.description === 'string' && system.description.trim()) return system.description;
    // 3. Try legacy .desc property
    else if (system.desc) return system.desc;
    return '';
};
