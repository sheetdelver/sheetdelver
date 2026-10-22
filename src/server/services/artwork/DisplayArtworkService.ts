import type { ActorDocument } from '@server/shared/types/actors';
import type { CombatDocument } from '@server/shared/types/documents';
import { parseDocumentUuid } from '@server/services/documents';
import { readCombatManagerFlag } from '@server/services/combats/combatManagerFlag';
import { isRecord } from '@server/core/documents/primary/base/PrimaryDocumentStore';
import type { DisplayArtworkContext, DisplayArtworkResult, DisplayArtworkRuntime, SystemAdapter } from '@shared/sdk';
import { freezeWorldValue } from '@shared/sdk/world';

/** Optional hooks run outside preparation/combat projection and cannot hold them up.
 * No result cache: source and caller authority belong to the current request.
 */
export async function resolveDisplayArtwork(adapter: Pick<SystemAdapter, 'resolveDisplayArtwork'> | null,
    context: DisplayArtworkContext, runtime: Omit<DisplayArtworkRuntime, 'signal'>,
    options: { isCurrent: () => boolean; resolveUrl: (path: string) => string | null; timeoutMs?: number; signal?: AbortSignal },
): Promise<DisplayArtworkResult | null> {
    if (!adapter?.resolveDisplayArtwork || !options.isCurrent() || options.signal?.aborted) return null;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
        const retired = new Promise<null>(resolve => {
            abort = () => { controller.abort(); resolve(null); };
            options.signal?.addEventListener('abort', abort, { once: true });
            timer = setTimeout(abort, options.timeoutMs ?? 3000);
        });
        const result = await Promise.race([Promise.resolve().then(() => adapter.resolveDisplayArtwork!(
            freezeWorldValue(structuredClone(context)), Object.freeze({ ...runtime, signal: controller.signal }))), retired]);
        if (controller.signal.aborted || !result || !options.isCurrent() || typeof result.src !== 'string') return null;
        const src = options.resolveUrl(result.src);
        return src ? { src, ...(typeof result.credit === 'string' && result.credit.trim() ? { credit: result.credit.slice(0, 1024) } : {}) } : null;
    } catch { return null; }
    finally { clearTimeout(timer); if (abort) options.signal?.removeEventListener('abort', abort); controller.abort(); }
}

/** Existing public Foundry paths or the active SheetDelver module's own assets.
 * No asset fetch occurs here. Reject scripts, credentials, traversal and redirects.
 */
export function displayArtworkUrl(src: string, foundryUrl: string, moduleId: string): string | null {
    if (!src || src.length > 2048 || src.trim() !== src || /[\\\x00-\x1f]/.test(src)) return null;
    try {
        if (src.split('/').some(part => { const decoded=decodeURIComponent(part); return decoded==='.' || decoded==='..' || /[/\\\x00-\x1f]/.test(decoded); })) return null;
        const local = `/api/modules/${moduleId}/assets/`;
        if (src.startsWith(local) && !/[?#]/.test(src)) return src;
        const base = new URL(foundryUrl.endsWith('/') ? foundryUrl : `${foundryUrl}/`);
        const url = new URL(src.replace(/^\/(?!\/)/,''),base);
        return ['http:','https:'].includes(url.protocol) && url.origin===base.origin
            && url.pathname.startsWith(base.pathname) && !url.username && !url.password && !url.search && !url.hash ? url.href : null;
    } catch { return null; }
}

/** Read existing encounter copy provenance; never infer identity from a name.
 * A marker alone is insufficient: both the encounter and its copy folder must agree. */
export function readCombatCopySourceUuid(actor: ActorDocument, combat: CombatDocument): string | undefined {
    const flag = readCombatManagerFlag(combat);
    const actorId = actor._id ?? actor.id;
    if (!flag?.folderId || !actorId || !flag.copyIds.includes(actorId) || actor.folder !== flag.folderId) return undefined;
    if (!isRecord(actor.flags) || !isRecord(actor.flags.world)) return undefined;
    const marker = actor.flags.world.sheetDelverCombatCopy;
    if (!isRecord(marker)) return undefined;
    if (marker.combatId !== (combat._id ?? combat.id) || typeof marker.sourceUuid !== 'string') return undefined;
    const parsed = parseDocumentUuid(marker.sourceUuid);
    return parsed?.kind === 'compendium' && parsed.type === 'Actor'
        ? `Compendium.${parsed.packId}.Actor.${parsed.documentId}` : undefined;
}
