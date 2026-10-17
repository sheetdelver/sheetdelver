/** Internal administrator DTO. Not a module SDK or player-status contract. */
export type MigrationAttentionState = 'no-migrations' | 'unknown' | 'checking' | 'unavailable'
    | 'up-to-date' | 'required' | 'blocked' | 'in-progress' | 'recovery-required';
export interface AdminMigrationStatus {
    moduleId: string;
    title: string;
    source: 'local' | 'managed' | null;
    version: string | null;
    selectedSource: boolean;
    activeWorld: boolean;
    world: { worldId: string; title: string; systemId: string; instanceId?: string; contextRevision?: number } | null;
    state: MigrationAttentionState;
    label: string;
    reason: string;
    nextStep?: string;
    scopeKey: string;
    catalogDeclared: boolean | null;
    artifactDigest?: string;
    catalogDigest?: string;
    checkedAt?: number;
    checked?: number;
    proposedWrites?: number;
    previewId?: string;
    phase?: string;
    progress?: { checked: number; total: number; confirmed?: number; uncertain?: number };
    action: { kind: 'check' | 'review' | 'maintenance' | 'none'; label: string; href: string | null };
}
export interface AdminMigrationOverview {
    revision: string;
    generatedAt: number;
    sources: AdminMigrationStatus[];
    active: AdminMigrationStatus | null;
    maintenance: AdminMigrationStatus | null;
}
