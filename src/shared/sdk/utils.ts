import { sanitizeRichHtml, type SafeHtml } from '@shared/security/safeHtml';

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

/**
 * Safely extract a string message from an unknown error value.
 * Use this in catch blocks: `getErrorMessage(err)`
 */
export function getErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    return 'Unknown error';
}

// ---------------------------------------------------------------------------
// Image and HTML utilities
// ---------------------------------------------------------------------------

/**
 * Resolve an image path to a full URL.
 * Relative paths are prefixed with the Foundry base URL when provided.
 */
export function resolveImage(path: string, baseUrl?: string): string {
    if (!path) return '/placeholder.png';
    if (path.startsWith('http') || path.startsWith('data:')) return path;

    if (baseUrl) {
        const cleanPath = path.startsWith('/') ? path.slice(1) : path;
        const cleanBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
        return `${cleanBase}${cleanPath}`;
    }
    return path;
}

/**
 * Build the platform URL for a module's static asset (ADR-0027 decision 27).
 * The same URL — `/api/modules/<id>/assets/<path>` — resolves in dev and packaged.
 * A leading `assets/` (as declared in `info.json` `stylesheet`) is tolerated.
 */
export function buildModuleAssetUrl(moduleId: string, assetPath: string): string {
    const clean = assetPath.replace(/^\/+/, '').replace(/^assets\//, '');
    return `/api/modules/${moduleId}/assets/${clean}`;
}

/**
 * Sanitize Foundry-enriched HTML and resolve relative link/image URLs.
 */
export function processHtmlContent(html: string, baseUrl?: string): SafeHtml {
    return sanitizeRichHtml(html, { foundryBaseUrl: baseUrl });
}

/**
 * Safely extract a description string from a Foundry system object.
 * Handles rich text objects (`{ value: string }`), plain strings, and
 * legacy `.desc` fields.
 */
export function getSafeDescription(system: unknown): string {
    if (!system || typeof system !== 'object') return '';
    const s = system as Record<string, unknown>;

    const desc = s.description;
    if (desc && typeof desc === 'object' && 'value' in desc && typeof (desc as any).value === 'string') {
        return (desc as any).value;
    }
    if (typeof desc === 'string' && desc.trim()) return desc;
    if (typeof s.desc === 'string' && s.desc.trim()) return s.desc;
    return '';
}

// ---------------------------------------------------------------------------
// Dice simulation
// ---------------------------------------------------------------------------

/**
 * Result of a local table draw simulation.
 */
export interface DrawResult {
    /** The simulated roll value. */
    roll: number;
    /** The formula used (e.g. "1d20"). */
    formula: string;
    /** Raw matched result rows from the table. */
    results: DrawResultRow[];
    /** Resolved item documents for any document-type results. */
    items: Record<string, unknown>[];
    /** The original table document. */
    table: Record<string, unknown>;
}

export interface DrawResultRow {
    /** The result range [min, max]. */
    range: [number, number];
    /** Display text for the result. */
    text?: string;
    /** Name of the result. */
    name?: string;
    /** UUID of a linked Foundry document, if any. */
    documentUuid?: string;
    /** Legacy collection reference. */
    documentCollection?: string;
    /** Legacy document id. */
    documentId?: string;
    [key: string]: unknown;
}

/**
 * Normalize a raw roll evaluation into the structured `RollResult` shape (ADR-0027
 * decision 15) — the server-side counterpart to `simulateRoll`. Module route handlers
 * compose automated sequences over `runtime.rolls.roll`; `parseRollResult` flattens a
 * raw roll-ish object (Foundry `Roll.toJSON()`, the `rolls.roll` payload, etc.) into a
 * consistent `{ formula, total, terms?, dice? }` so chat-card rendering and downstream
 * logic don't each re-parse vendor shapes.
 */
export function parseRollResult(
    raw: unknown,
    fallbackFormula = '',
): { formula: string; total: number; terms?: unknown[]; dice?: number[]; [key: string]: unknown } {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

    const formula = String(r.formula ?? r.expression ?? fallbackFormula ?? '');
    const total = Number(r.total ?? r.rollTotal ?? r.result ?? 0) || 0;
    const terms = Array.isArray(r.terms) ? (r.terms as unknown[]) : undefined;

    // Pull individual die results from common shapes: a flat `dice` array, or
    // Foundry's `terms[].results[].result`.
    let dice: number[] | undefined;
    if (Array.isArray(r.dice) && r.dice.every((d) => typeof d === 'number')) {
        dice = r.dice as number[];
    } else if (terms) {
        const collected: number[] = [];
        for (const term of terms) {
            const results = (term as { results?: Array<{ result?: unknown }> })?.results;
            if (Array.isArray(results)) {
                for (const res of results) {
                    if (typeof res?.result === 'number') collected.push(res.result);
                }
            }
        }
        if (collected.length) dice = collected;
    }

    return {
        ...r,
        formula,
        total,
        ...(terms ? { terms } : {}),
        ...(dice ? { dice } : {}),
    };
}

/**
 * Simulate a dice roll for a formula string.
 *
 * Supports:
 *   - `NdX`     — e.g. "1d20", "2d6"
 *   - `NdX+M`   — e.g. "1d8+2", "2d6+3"
 *   - `NdX-M`   — e.g. "1d6-1"
 *
 * Returns the roll value and the original formula.
 * Pass `rollOverride` to force a specific result (useful for testing or GM overrides).
 */
export function simulateRoll(
    formula: string,
    rollOverride?: number
): { roll: number; formula: string } {
    if (rollOverride !== undefined) {
        return { roll: rollOverride, formula };
    }

    const clean = formula.replace(/\s/g, '');

    // NdX+M or NdX-M
    const withMod = clean.match(/^(\d+)d(\d+)([+-])(\d+)$/i);
    if (withMod) {
        const count = parseInt(withMod[1], 10);
        const die = parseInt(withMod[2], 10);
        const sign = withMod[3] === '+' ? 1 : -1;
        const mod = parseInt(withMod[4], 10);
        let total = 0;
        for (let i = 0; i < count; i++) {
            total += Math.floor(Math.random() * die) + 1;
        }
        return { roll: total + sign * mod, formula };
    }

    // NdX
    const basic = clean.match(/^(\d+)d(\d+)$/i);
    if (basic) {
        const count = parseInt(basic[1], 10);
        const die = parseInt(basic[2], 10);
        let total = 0;
        for (let i = 0; i < count; i++) {
            total += Math.floor(Math.random() * die) + 1;
        }
        return { roll: total, formula };
    }

    // Fallback for unrecognized formulas (e.g. kh/kl notation)
    return { roll: Math.floor(Math.random() * 20) + 1, formula };
}

/**
 * Simulate drawing from a RollTable document.
 *
 * Rolls the table formula, finds matched results, and optionally resolves
 * document UUIDs using the provided fetch function.
 *
 * The table document must have `formula` and `results` fields following
 * the standard Foundry RollTable shape.
 *
 * @param table - The RollTable document (pre-fetched from compendium or cache)
 * @param options.rollOverride - Force a specific roll value
 * @param options.fetchDocument - Async function to resolve a UUID to a full document
 */
export async function simulateTableDraw(
    table: Record<string, unknown>,
    options: {
        rollOverride?: number;
        fetchDocument?: (uuid: string) => Promise<Record<string, unknown> | null>;
    } = {}
): Promise<DrawResult> {
    const formula = (
        (table.system as any)?.formula ||
        (table as any).formula ||
        '1d20'
    ) as string;

    const { roll } = simulateRoll(formula, options.rollOverride);

    const allResults = ((table.results as DrawResultRow[]) || []);
    const matched = allResults.filter((r) => {
        const range = r.range ?? [1, 1];
        return roll >= range[0] && roll <= range[1];
    });

    const items: Record<string, unknown>[] = [];
    if (options.fetchDocument) {
        for (const res of matched) {
            const uuid = res.documentUuid || (
                res.documentCollection && res.documentId
                    ? `Compendium.${res.documentCollection}.Item.${res.documentId}`
                    : null
            );
            if (uuid) {
                const doc = await options.fetchDocument(uuid);
                if (doc) items.push(doc);
            }
        }
    }

    return {
        roll,
        formula,
        results: matched,
        items,
        table,
    };
}
