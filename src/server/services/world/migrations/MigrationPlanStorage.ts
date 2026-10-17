import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureOwnerOnlyDirectorySync, writeOwnerOnlyFileAtomicSync } from '@core/paths';
import { migrationDigest } from '@modules/registry/migrations/catalog';
import { sourceHash, type MigrationWorldPlan, type PlannedMigrationTarget } from './planner';

const RECORD_BYTES = 32 * 1024 * 1024;
const PAGE_BYTES = 512 * 1024;
export interface StoredMigrationPlan { storage: 'core-migration-plan.v2' | 'core-migration-plan.v3'; root: string; digest: string }
type ListNode = { leaf: unknown[] } | { children: string[] };
interface DependencyDelta { previous?: string; set: string; remove: string }

/** Internal durable encoding only: public SDK/catalog and logical approvals do not change. */
export class MigrationPlanStorage {
    private cache = new Map<string, MigrationWorldPlan>();
    private references = new WeakMap<MigrationWorldPlan, StoredMigrationPlan>();
    private writing?: Map<string, string>;
    private reading?: Map<string, string>;
    constructor(readonly directory: string) { ensureOwnerOnlyDirectorySync(directory); }
    private file(digest: string): string {
        if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid migration content identity');
        return path.join(this.directory, `${digest.slice(7)}.json`);
    }
    private put(value: unknown): string {
        const json = JSON.stringify(value);
        if (Buffer.byteLength(json) > RECORD_BYTES) throw new Error('Migration content record exceeds 32 MiB; preserve the complete plan and inspect the offending value');
        const digest = migrationDigest(json); const file = this.file(digest);
        if (this.writing) { this.writing.set(digest, json); return digest; }
        if (fs.existsSync(file)) { this.get(digest); return digest; }
        writeOwnerOnlyFileAtomicSync(file, json);
        if (process.platform !== 'win32') { const fd = fs.openSync(this.directory, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
        return digest;
    }
    private get(digest: string): any {
        this.file(digest); // confined identity validation also applies to bundled records
        const bundled = this.reading?.get(digest);
        if (this.reading && bundled === undefined) throw new Error('Migration bundle record missing');
        if (bundled !== undefined) return JSON.parse(bundled);
        const file = this.file(digest); const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > RECORD_BYTES) throw new Error('Invalid migration content record');
        const json = fs.readFileSync(file, 'utf8');
        if (migrationDigest(json) !== digest) throw new Error('Migration content digest mismatch; preserve approval evidence for recovery');
        return JSON.parse(json);
    }
    private list(values: Iterable<unknown>): string {
        let page: unknown[] = []; let bytes = 0; let children: string[] = [];
        for (const value of values) {
            const length = Buffer.byteLength(JSON.stringify(value));
            if (page.length && bytes + length > PAGE_BYTES) { children.push(this.put({ leaf: page })); page = []; bytes = 0; }
            page.push(value); bytes += length;
        }
        if (page.length || !children.length) children.push(this.put({ leaf: page }));
        while (children.length > 1) {
            const next: string[] = [];
            for (let start = 0; start < children.length; start += 512) next.push(this.put({ children: children.slice(start, start + 512) }));
            children = next;
        }
        return children[0];
    }
    private *entries(digest: string, depth = 0): Generator<any> {
        if (depth > 64) throw new Error('Migration content tree exceeds structural bound');
        const value = this.get(digest) as ListNode;
        if ('leaf' in value && Array.isArray(value.leaf)) yield* value.leaf;
        else if ('children' in value && Array.isArray(value.children)) for (const child of value.children) yield* this.entries(child, depth + 1);
        else throw new Error('Invalid migration content list');
    }
    save(plan: MigrationWorldPlan): StoredMigrationPlan {
        const known = this.references.get(plan);
        if (known && Object.isFrozen(plan)) return known;
        this.writing = new Map();
        try {
        let previous: Record<string, string> = {}; let previousRef: string | undefined;
        const operations: unknown[] = [];
        for (const operation of plan.operations) {
            const set = Object.entries(operation.dependencies).filter(([key, hash]) => previous[key] !== hash);
            const remove = Object.keys(previous).filter(key => !Object.hasOwn(operation.dependencies, key));
            const dependencies = this.put({ previous: previousRef, set: this.list(set), remove: this.list(remove) });
            operations.push({ ...operation, dependencies });
            previous = operation.dependencies; previousRef = dependencies;
        }
        const { operations: _operations, blockers, exclusions, diagnostics, ...header } = plan;
        const root = this.put({ schema: 2, header, operations: this.list(operations), operationCount: operations.length,
            blockers: this.list(blockers), exclusions: this.list(exclusions), ...(diagnostics ? { diagnostics: this.list(diagnostics) } : {}) });
        const reference: StoredMigrationPlan = { storage: 'core-migration-plan.v3', root, digest: plan.digest };
        this.writeBundle(root, this.writing);
        this.references.set(plan, reference);
        return reference;
        } finally { this.writing = undefined; }
    }
    load(value: MigrationWorldPlan | StoredMigrationPlan): MigrationWorldPlan {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid migration plan schema');
        if (!('storage' in value)) return value;
        if (!['core-migration-plan.v2', 'core-migration-plan.v3'].includes(value.storage)) throw new Error('Unsupported migration plan storage');
        const cached = this.cache.get(value.root);
        if (cached) { if (cached.digest !== value.digest) throw new Error('Migration approval digest changed'); return cached; }
        this.reading = value.storage === 'core-migration-plan.v3' ? this.readBundle(value.root) : undefined;
        try {
        const encoded = this.get(value.root);
        if (encoded.schema !== 2 || !encoded.header || encoded.header.digest !== value.digest) throw new Error('Migration plan manifest mismatch');
        let previousRef: string | undefined; let previous: Record<string, string> = {};
        const operations: PlannedMigrationTarget[] = [];
        for (const row of this.entries(encoded.operations)) {
            const delta = this.get(row.dependencies) as DependencyDelta;
            if (delta.previous !== previousRef) throw new Error('Migration dependency history is not contiguous');
            const dependencies = { ...previous };
            for (const key of this.entries(delta.remove)) delete dependencies[key];
            for (const [key, hash] of this.entries(delta.set)) {
                if (typeof key !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid migration dependency evidence');
                Object.defineProperty(dependencies, key, { value: hash, enumerable: true, writable: true, configurable: true });
            }
            operations.push({ ...row, dependencies }); previous = dependencies; previousRef = row.dependencies;
        }
        if (operations.length !== encoded.operationCount) throw new Error('Migration plan inventory is incomplete');
        const plan: MigrationWorldPlan = { ...encoded.header, operations, blockers: [...this.entries(encoded.blockers)], exclusions: [...this.entries(encoded.exclusions)],
            ...(encoded.diagnostics ? { diagnostics: [...this.entries(encoded.diagnostics)] } : {}) };
        const { digest, diagnostics: _diagnostics, ...approved } = plan;
        if (sourceHash(approved) !== digest) throw new Error('Migration logical approval digest mismatch');
        const freeze = (entry: unknown): void => { if (entry && typeof entry === 'object' && !Object.isFrozen(entry)) { Object.values(entry).forEach(freeze); Object.freeze(entry); } };
        freeze(plan); this.cache.set(value.root, plan); this.references.set(plan, value);
        return plan;
        } finally { this.reading = undefined; }
    }
    private bundleFile(root: string): string { return this.file(root).replace(/\.json$/, '.bundle'); }
    private writeBundle(root: string, blocks: Map<string, string>): void {
        const file = this.bundleFile(root);
        if (fs.existsSync(file)) {
            // A previous writer may have renamed successfully but lost the
            // directory-sync acknowledgement. Validate and re-establish durable
            // publication before a new journal can confer approval authority.
            this.readBundle(root);
            const existing = fs.openSync(file, 'r'); try { fs.fsyncSync(existing); } finally { fs.closeSync(existing); }
            this.syncDirectory(); return;
        }
        const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
        const fd = fs.openSync(temporary, 'wx', 0o600);
        try {
            const write = (text: string) => { const bytes = Buffer.from(text); let offset = 0;
                while (offset < bytes.length) { const count = fs.writeSync(fd, bytes, offset); if (!count) throw new Error('Incomplete durable bundle write'); offset += count; } };
            write(`core-migration-plan.v3 ${root}\n`);
            for (const [digest, json] of blocks) write(`${digest} ${json}\n`);
            fs.fsyncSync(fd);
        } catch (error) { fs.closeSync(fd); fs.unlinkSync(temporary); throw error; }
        fs.closeSync(fd);
        fs.renameSync(temporary, file);
        this.syncDirectory();
    }
    private syncDirectory(): void {
        if (process.platform !== 'win32') { const directory = fs.openSync(this.directory, 'r'); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); } }
    }
    private readBundle(root: string): Map<string, string> {
        const file = this.bundleFile(root); const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid migration bundle');
        const fd = fs.openSync(file, 'r'); const buffer = Buffer.alloc(64 * 1024);
        const decoder = new TextDecoder('utf-8', { fatal: true });
        const blocks = new Map<string, string>(); let pending = ''; let header = false;
        try {
            for (;;) {
                const count = fs.readSync(fd, buffer); pending += decoder.decode(buffer.subarray(0, count), { stream: count > 0 });
                let end: number;
                while ((end = pending.indexOf('\n')) >= 0) {
                    const line = pending.slice(0, end); pending = pending.slice(end + 1);
                    if (!header) { if (line !== `core-migration-plan.v3 ${root}`) throw new Error('Migration bundle identity mismatch'); header = true; continue; }
                    if (Buffer.byteLength(line) > RECORD_BYTES + 72) throw new Error('Oversized migration content record');
                    const digest = line.slice(0, 71); const json = line.slice(72); this.file(digest);
                    if (line[71] !== ' ' || blocks.has(digest) || migrationDigest(json) !== digest) throw new Error('Migration content digest mismatch');
                    blocks.set(digest, json);
                }
                if (Buffer.byteLength(pending) > RECORD_BYTES + 72) throw new Error('Oversized migration content record');
                if (!count) break;
            }
            if (pending || !header || !blocks.has(root)) throw new Error('Incomplete migration bundle');
            return blocks;
        } finally { fs.closeSync(fd); }
    }
}

/** Legacy import has bounded tokens/depth, not a cap on total complete inventory. */
export function readLegacyMigrationJson(file: string): any {
    const fd = fs.openSync(file, 'r'); const buffer = Buffer.alloc(64 * 1024);
    let chunk = ''; let position = 0;
    // JSON records are UTF-8. Preserve split multibyte tokens between reads.
    const decoder = new TextDecoder('utf-8', { fatal: true }); let ended = false;
    const peek = (): string => {
        while (position === chunk.length && !ended) {
            const count = fs.readSync(fd, buffer); position = 0;
            chunk = decoder.decode(buffer.subarray(0, count), { stream: count > 0 });
            if (!count) ended = true;
        }
        return chunk[position] ?? '';
    };
    const take = (): string => { const value = peek(); if (value) position++; return value; };
    const space = () => { while (peek() && /[ \t\r\n]/.test(peek())) take(); };
    const string = (): string => {
        let raw = take(); let escape = false;
        for (;;) { const char = take(); if (!char) throw new Error('Incomplete legacy migration JSON'); raw += char;
            if (raw.length > RECORD_BYTES) throw new Error('Oversized legacy migration JSON token');
            if (char === '"' && !escape) return JSON.parse(raw);
            escape = !escape && char === '\\'; }
    };
    const parse = (depth: number): any => {
        if (depth > 64) throw new Error('Legacy migration JSON exceeds nesting bound'); space(); const char = peek();
        if (char === '"') return string();
        if (char === '{' || char === '[') {
            take(); space(); const array = char === '['; const value: any = array ? [] : {}; const close = array ? ']' : '}';
            if (peek() === close) { take(); return value; }
            for (;;) {
                space(); let key = '';
                if (!array) { if (peek() !== '"') throw new Error('Invalid legacy migration key'); key = string(); space(); if (take() !== ':') throw new Error('Invalid legacy migration JSON'); }
                const entry = parse(depth + 1);
                if (array) value.push(entry);
                else { if (Object.hasOwn(value, key)) throw new Error('Duplicate legacy migration key'); Object.defineProperty(value, key, { value: entry, enumerable: true, configurable: true, writable: true }); }
                space(); const next = take(); if (next === close) return value; if (next !== ',') throw new Error('Invalid legacy migration JSON');
            }
        }
        let token = ''; while (peek() && !/[\s,\]}]/.test(peek())) { token += take(); if (token.length > 128) throw new Error('Invalid legacy migration primitive'); }
        return JSON.parse(token);
    };
    try { const value = parse(0); space(); if (peek()) throw new Error('Trailing legacy migration JSON'); return value; }
    finally { fs.closeSync(fd); }
}
