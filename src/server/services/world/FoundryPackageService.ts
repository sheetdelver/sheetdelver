import { EventEmitter } from 'node:events';
import type { GameData, FoundryPackageBase } from '@server/core/world/types';
import { settingStore, type SettingStore } from '@server/core/documents/primary/settings/SettingStore';
import { compendiumStore, type CompendiumStore } from '@server/core/compendium/CompendiumStore';
import { freezeWorldValue, type ModuleWorldContext } from '@shared/sdk/world';
import type { FoundryPackageContext, FoundryPackageDescriptor, FoundryPackageSnapshot, CompendiumArtworkReader,
    CompendiumArtworkKind, CompendiumArtworkResult } from '@shared/sdk/packages';

type Provider = { id: string; kind: 'system' | 'module'; mapping: unknown; credit?: string; enabled: boolean };
type Mapping = Record<string, Record<string, Record<string, unknown>>>;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]+$/.test(value);
const unavailable = (reason: Extract<CompendiumArtworkResult, { status: 'unavailable' }>['reason']): CompendiumArtworkResult => ({ status: 'unavailable', reason });

/** Derived package/asset projection. Native manifests remain owned by WorldStateStore.
 * No network during configure/snapshot. Mapping assets are lazy, bounded and
 * shared per package revision. Native documents and tokens are never modified.
 */
export class FoundryPackageService extends EventEmitter {
    private revision = 0;
    private epoch = 0;
    private current: FoundryPackageSnapshot = { status: 'unavailable', reason: 'not-ready' };
    private providers: Provider[] = [];
    private base: URL | null = null;
    private preferences: unknown;
    private fingerprint = '';
    private scope = '';
    private assets = new Map<string, { expires: number; pending: Promise<Mapping | null>; controller: AbortController }>();
    constructor(private readonly settings: Pick<SettingStore, 'getValueByKey' | 'isReady'> = settingStore,
        private readonly packs: Pick<CompendiumStore, 'listPackMetadata' | 'getPackMetadata'> = compendiumStore,
        private readonly request: typeof fetch = (...args) => fetch(...args), private readonly now = Date.now) { super(); }

    configure(instanceUrl: string, data: Pick<GameData, 'world' | 'system' | 'modules'> | undefined, runtimeEpoch = 0): void {
        const scope = JSON.stringify([instanceUrl, data?.world?.id, data?.system?.id, runtimeEpoch]);
        const sameScope = this.scope === scope;
        const epoch = this.epoch;
        this.clear();
        if (sameScope) this.epoch = epoch; // Same-world recovery retains adapter handles.
        this.scope = scope;
        try {
            this.base = new URL(instanceUrl.endsWith('/') ? instanceUrl : `${instanceUrl}/`);
            if (!['https:', 'http:'].includes(this.base.protocol) || this.base.username || this.base.password || this.base.search || this.base.hash) this.base = null;
        } catch { this.base = null; }
        if (!data?.world?.id || !validId(data.system?.id) || !Array.isArray(data.modules)) {
            this.current = { status: 'unavailable', reason: 'incomplete-metadata' }; return;
        }
        const systemId = data.system.id;
        const describe = (pkg: FoundryPackageBase, kind: 'system' | 'module'): FoundryPackageDescriptor | null => {
            if (!pkg || typeof pkg !== 'object' || !validId(pkg.id)) return null;
            const enabled = kind === 'system' ? true : typeof pkg.active === 'boolean' ? pkg.active : null;
            const flags = pkg.flags?.compendiumArtMappings;
            const art = record(flags) && record(flags[systemId]) ? flags[systemId] : undefined;
            if (art) this.providers.push({ id: pkg.id, kind, mapping: art.mapping, enabled: enabled === true,
                ...(typeof art.credit === 'string' ? { credit: art.credit.slice(0, 1024) } : {}) });
            return { id: pkg.id, kind, title: typeof pkg.title === 'string' ? pkg.title : pkg.id,
                version: typeof pkg.version === 'string' ? pkg.version : null, enabled,
                capabilities: { compendiumArt: !!art }, packs: [] };
        };
        const system = describe(data.system, 'system')!;
        const modules = data.modules.map(pkg => describe(pkg, 'module')).filter((pkg): pkg is FoundryPackageDescriptor => !!pkg);
        // Missing/duplicate IDs make absence unknowable; do not claim a complete inventory.
        if (modules.length !== data.modules.length || new Set(modules.map(pkg => pkg.id)).size !== modules.length) {
            this.providers = []; this.current = { status: 'unavailable', reason: 'incomplete-metadata' }; return;
        }
        this.current = { status: 'ready', worldId: data.world.id, revision: ++this.revision, system, modules };
        this.refreshPreferences(false);
    }

    clear(): void {
        for (const asset of this.assets.values()) asset.controller.abort();
        this.assets.clear(); this.epoch++; this.revision++;
        this.current = { status: 'unavailable', reason: 'not-ready' };
        this.providers = []; this.preferences = undefined; this.fingerprint = ''; this.base = null; this.scope = '';
    }

    suspend(): void {
        const scope = this.scope, epoch = this.epoch;
        this.clear();
        this.scope = scope; this.epoch = epoch;
    }

    /** Artwork preferences have their own revision; never gate rules/migrations. */
    refreshPreferences(publish = true): void {
        if (this.current.status !== 'ready') return;
        const value = this.settings.getValueByKey('core.compendiumArtConfiguration');
        const fingerprint = JSON.stringify([this.settings.isReady(), value === undefined ? 'absent' : 'present', value]);
        if (this.fingerprint === fingerprint) return;
        this.fingerprint = fingerprint; this.preferences = structuredClone(value);
        for (const asset of this.assets.values()) asset.controller.abort();
        this.assets.clear();
        this.current = { ...this.current, revision: ++this.revision };
        if (publish) this.emit('changed', { revision: this.revision });
    }

    handle(world: ModuleWorldContext, allowed: (pack: string) => boolean = () => true): FoundryPackageContext & CompendiumArtworkReader {
        const epoch = this.epoch;
        const guard = () => { world.snapshot(); if (epoch !== this.epoch) throw Error('Foundry package context retired'); };
        return Object.freeze({ snapshot: () => {
            guard(); this.refreshPreferences();
            if (this.current.status !== 'ready') return freezeWorldValue({ ...this.current });
            const metadata = this.packs.listPackMetadata();
            const project = (pkg: FoundryPackageDescriptor): FoundryPackageDescriptor => ({ ...pkg,
                packs: metadata.filter(pack => pack.packageType === pkg.kind && (pack.packageName ?? pack.moduleId) === pkg.id && allowed(String(pack.id)))
                    .map(pack => ({ id: String(pack.id), label: String(pack.label ?? pack.id), type: String(pack.type ?? pack.documentName ?? '') })) });
            return freezeWorldValue({ ...this.current, system: project(this.current.system), modules: this.current.modules.map(project) });
        }, resolve: async (uuid: string, kind: CompendiumArtworkKind = 'image') => {
            try { guard(); } catch { return unavailable('not-ready'); }
            const identity = world.snapshot().identity;
            const revision = identity.contextRevision;
            return this.resolve(uuid, kind, identity.foundryGeneration, allowed, () => { guard(); world.assertRevision(revision); });
        } });
    }

    private assetUrl(path: unknown): URL | null {
        if (!this.base || typeof path !== 'string' || path.length > 2048 || path.trim() !== path || /[\\\x00-\x1f]/.test(path)) return null;
        try {
            // Foundry's route prefix is retained for root-relative package paths.
            const relative = path.replace(/^\/(modules|systems)\//, '$1/');
            if (relative.split('/').some(part => {
                const decoded = decodeURIComponent(part);
                return ['.', '..'].includes(decoded) || /[/\\\x00-\x1f]/.test(decoded);
            })) return null;
            const url = new URL(relative, this.base);
            if (url.origin !== this.base.origin || url.username || url.password || url.search || url.hash
                || !url.pathname.startsWith(this.base.pathname)) return null;
            const suffix = url.pathname.slice(this.base.pathname.length);
            return /^(modules|systems)\/[a-zA-Z0-9_-]+\//.test(suffix) ? url : null;
        } catch { return null; }
    }

    private async mapping(provider: Provider): Promise<Mapping | null> {
        const url = this.assetUrl(provider.mapping);
        const prefix = `${provider.kind === 'system' ? 'systems' : 'modules'}/${provider.id}/`;
        if (!url || !url.pathname.slice(this.base!.pathname.length).startsWith(prefix)) return null;
        const cached = this.assets.get(url.href);
        if (cached && cached.expires > this.now()) return cached.pending;
        const controller = new AbortController();
        const entry = { expires: Infinity, controller, pending: Promise.resolve<Mapping | null>(null) };
        this.assets.set(url.href, entry);
        entry.pending = this.load(url, controller).then(value => { entry.expires = this.now() + (value ? 300_000 : 10_000); return value; });
        return entry.pending;
    }

    private async load(url: URL, controller: AbortController): Promise<Mapping | null> {
        const timer = setTimeout(() => controller.abort(), 1500);
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
            const response = await this.request(url, { credentials: 'omit', redirect: 'error', signal: controller.signal });
            if (!response.ok || Number(response.headers.get('content-length')) > 2_097_152) { await response.body?.cancel(); return null; }
            reader = response.body?.getReader(); if (!reader) return null;
            const chunks: Uint8Array[] = []; let size = 0;
            for (;;) { const next = await reader.read(); if (next.done) break;
                size += next.value.byteLength; if (size > 2_097_152) { await reader.cancel(); return null; } chunks.push(next.value); }
            const bytes = new Uint8Array(size); let offset = 0;
            for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
            const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
            return record(value) ? value as Mapping : null;
        } catch { return null; }
        finally { clearTimeout(timer); reader?.releaseLock(); }
    }

    private async resolve(uuid: string, kind: CompendiumArtworkKind, generation: number, allowed: (pack: string) => boolean, guard: () => void): Promise<CompendiumArtworkResult> {
        const parts = typeof uuid === 'string' ? uuid.split('.') : [];
        if (parts.length !== 5 || parts[0] !== 'Compendium' || !parts.slice(1).every(validId)
            || !['Actor', 'Item'].includes(parts[3]) || !['image', 'token'].includes(kind) || kind === 'token' && parts[3] !== 'Actor') return unavailable('invalid-reference');
        const packId = `${parts[1]}.${parts[2]}`;
        const visible = () => {
            const metadata = this.packs.getPackMetadata(packId);
            return allowed(packId) && !!metadata && (metadata.type ?? metadata.documentName) === parts[3];
        };
        if (!visible()) return unavailable('not-visible');
        if (generation !== 13 && generation !== 14) return unavailable('unsupported-version');
        // Foundry v13's native artwork feature is Actor-only.
        if (generation === 13 && parts[3] !== 'Actor') return { status: 'none' };
        this.refreshPreferences();
        if (this.current.status !== 'ready' || !this.base || !this.settings.isReady()) return unavailable('not-ready');
        if (this.preferences !== undefined && !record(this.preferences)) return unavailable('invalid-configuration');
        const revision = this.revision;
        const candidates: Array<{ provider: Provider; priority?: number }> = [];
        for (const provider of this.providers.filter(row => row.enabled)) {
            const config = record(this.preferences) ? this.preferences[provider.id] : undefined;
            if (config !== undefined && !record(config)) return unavailable('invalid-configuration');
            const option = kind === 'token' ? 'tokens' : parts[3] === 'Item' ? 'items' : 'portraits';
            const enabled = record(config) ? config[option] : undefined;
            const priority = record(config) ? config.priority : undefined;
            if (enabled !== undefined && typeof enabled !== 'boolean' || priority !== undefined && (typeof priority !== 'number' || !Number.isFinite(priority))) return unavailable('invalid-configuration');
            // v13 uses an existing provider config as-is; v14 fills omitted switches.
            if (generation === 13 ? config === undefined || enabled === true : enabled !== false) candidates.push({ provider, priority: priority as number | undefined });
        }
        candidates.sort((a, b) => a.priority === undefined ? b.priority === undefined ? 0 : 1 : b.priority === undefined ? -1 : a.priority - b.priority);
        // Higher priority wins; a failed higher-priority mapping is not silently
        // replaced by a different provider's interpretation.
        for (const { provider } of candidates) {
            const mapping = await this.mapping(provider);
            this.refreshPreferences();
            try { guard(); } catch { return unavailable('not-ready'); }
            if (revision !== this.revision) return unavailable('not-ready');
            if (!visible()) return unavailable('not-visible');
            if (!mapping) return unavailable('asset-unavailable');
            const entry = record(mapping[packId]) ? mapping[packId][parts[4]] : undefined;
            if (!record(entry)) continue;
            const token = entry.token;
            const path = kind === 'image' ? generation === 13 ? entry.actor : entry.img ?? (parts[3] === 'Actor' ? entry.actor : undefined) : typeof token === 'string' ? token : record(token) && record(token.texture) ? token.texture.src : undefined;
            if (path === undefined) continue;
            const asset = this.assetUrl(path);
            if (!asset) return unavailable('asset-unavailable');
            return { status: 'resolved', src: asset.href, packageId: provider.id, ...(provider.credit ? { credit: provider.credit } : {}) };
        }
        return { status: 'none' };
    }
}
