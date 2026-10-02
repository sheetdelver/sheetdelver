import fs from 'node:fs';
import path from 'node:path';
import type { CombatManagerSelectedStatDto } from '@shared/contracts/combatManager';
import { parseCombatStatSelection } from '@shared/contracts/combatStatAttributes';
import { getConfigDir, writeOwnerOnlyFileAtomicSync } from '@core/paths';
import { parseModuleId } from '@shared/security/moduleId';

interface PreferenceEntry {
    worldId: string;
    moduleId: string;
    attributes: CombatManagerSelectedStatDto[];
}

interface PreferenceFile {
    schemaVersion: 1;
    entries: PreferenceEntry[];
}

const WORLD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const MAX_FILE_BYTES = 256_000;
const MAX_ENTRIES = 500;

function validateScope(worldId: string, moduleId: string): void {
    if (!WORLD_ID_PATTERN.test(worldId) || !parseModuleId(moduleId)) {
        throw new Error('Invalid combat-stat preference scope');
    }
}

/** Core-owned durable UI preference. Never placed in the cache or Foundry Combat flags. */
export class CombatStatPreferenceStore {
    constructor(private readonly filePath?: string) {}

    private path(): string {
        return this.filePath ?? path.join(getConfigDir(), 'gm-combat-stats.json');
    }

    private load(): PreferenceFile {
        const filePath = this.path();
        let stat: fs.Stats;
        try { stat = fs.lstatSync(filePath); }
        catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
                return { schemaVersion: 1, entries: [] };
            }
            throw error;
        }
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) {
            throw new Error('Combat-stat preference file is unsafe or oversized');
        }
        let decoded: unknown;
        try { decoded = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
        catch { throw new Error('Combat-stat preference file is not valid JSON'); }
        if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
            throw new Error('Combat-stat preference file is malformed');
        }
        const file = decoded as Record<string, unknown>;
        if (file.schemaVersion !== 1 || !Array.isArray(file.entries) || file.entries.length > MAX_ENTRIES) {
            throw new Error('Combat-stat preference file has an unsupported schema');
        }
        const entries: PreferenceEntry[] = [];
        const scopes = new Set<string>();
        for (const entry of file.entries) {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Combat-stat preference entry is malformed');
            const row = entry as Record<string, unknown>;
            if (typeof row.worldId !== 'string' || typeof row.moduleId !== 'string') throw new Error('Combat-stat preference scope is malformed');
            validateScope(row.worldId, row.moduleId);
            const attributes = parseCombatStatSelection(row.attributes);
            const scope = `${row.worldId}\0${row.moduleId}`;
            if (!attributes || scopes.has(scope)) throw new Error('Combat-stat preference entry is malformed or duplicated');
            scopes.add(scope);
            entries.push({ worldId: row.worldId, moduleId: row.moduleId, attributes });
        }
        return { schemaVersion: 1, entries };
    }

    public get(worldId: string, moduleId: string): CombatManagerSelectedStatDto[] | null {
        validateScope(worldId, moduleId);
        const entry = this.load().entries.find(row => row.worldId === worldId && row.moduleId === moduleId);
        return entry ? entry.attributes : null;
    }

    public set(worldId: string, moduleId: string, attributes: CombatManagerSelectedStatDto[]): void {
        validateScope(worldId, moduleId);
        const parsed = parseCombatStatSelection(attributes);
        if (!parsed) throw new Error('Invalid combat-stat selection');
        const file = this.load();
        const entries = file.entries.filter(row => row.worldId !== worldId || row.moduleId !== moduleId);
        if (entries.length >= MAX_ENTRIES) throw new Error('Too many combat-stat preference scopes');
        entries.push({ worldId, moduleId, attributes: parsed });
        writeOwnerOnlyFileAtomicSync(this.path(), JSON.stringify({ schemaVersion: 1, entries }));
    }

    public reset(worldId: string, moduleId: string): void {
        validateScope(worldId, moduleId);
        const file = this.load();
        if (!file.entries.some(row => row.worldId === worldId && row.moduleId === moduleId)) return;
        const entries = file.entries.filter(row => row.worldId !== worldId || row.moduleId !== moduleId);
        writeOwnerOnlyFileAtomicSync(this.path(), JSON.stringify({ schemaVersion: 1, entries }));
    }
}

export const combatStatPreferenceStore = new CombatStatPreferenceStore();
