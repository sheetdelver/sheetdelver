import { parseDocumentUuid } from '@server/services/documents';
import { freezeWorldValue } from '@shared/sdk/world';
import type { CompendiumReferenceIdentity, CompendiumReferenceModel, CompendiumReferenceRuntime, SystemAdapter } from '@shared/sdk';

export function referenceIdentity(uuid: unknown): CompendiumReferenceIdentity | null {
    if (typeof uuid !== 'string' || uuid.length > 512 || !/^Compendium\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.(Actor|Item)\.[A-Za-z0-9_-]+$/.test(uuid)) return null;
    const parsed = parseDocumentUuid(uuid);
    if (parsed?.kind !== 'compendium' || (parsed.type !== 'Actor' && parsed.type !== 'Item')) return null;
    return { uuid: `Compendium.${parsed.packId}.${parsed.type}.${parsed.documentId}`, documentType: parsed.type as 'Actor' | 'Item' };
}

/** Bound the entire optional read, not just module execution. Never cache a
 * privileged result; source access is rechecked through caller-bound reads. */
export async function prepareCompendiumReference(
    adapter: Pick<SystemAdapter, 'prepareReferenceView'>,
    reference: CompendiumReferenceIdentity,
    runtime: Omit<CompendiumReferenceRuntime, 'signal'>,
    options: { isCurrent: () => boolean; signal?: AbortSignal; timeoutMs?: number },
): Promise<CompendiumReferenceModel | null> {
    if (!adapter.prepareReferenceView || !options.isCurrent() || options.signal?.aborted) return null;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
        const retired = new Promise<null>(resolve => {
            abort = () => { controller.abort(); resolve(null); };
            options.signal?.addEventListener('abort', abort, { once: true });
            timer = setTimeout(abort, options.timeoutMs ?? 3000);
        });
        const work = async () => {
            const source = await runtime.documents.fetchByUuid(reference.uuid);
            if (!source || controller.signal.aborted || !options.isCurrent()) return null;
            const observed = JSON.stringify(source);
            const result = await adapter.prepareReferenceView!(freezeWorldValue({ ...reference, document: structuredClone(source) }),
                Object.freeze({ ...runtime, signal: controller.signal }));
            if (!result || controller.signal.aborted || !options.isCurrent()) return null;
            const current = await runtime.documents.fetchByUuid(reference.uuid);
            if (!current || JSON.stringify(current) !== observed || controller.signal.aborted || !options.isCurrent()) return null;
            if (typeof result.title !== 'string' || !result.title.trim() || result.title.length > 256) return null;
            const json = JSON.stringify(result.model);
            if (!json || Buffer.byteLength(json) > 512 * 1024) return null;
            return { title: result.title, model: JSON.parse(json) };
        };
        return await Promise.race([work(), retired]);
    } catch { return null; }
    finally {
        clearTimeout(timer);
        if (abort) options.signal?.removeEventListener('abort', abort);
        controller.abort();
    }
}
