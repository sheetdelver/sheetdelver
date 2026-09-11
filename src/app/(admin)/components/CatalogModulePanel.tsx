'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CircleAlert, Download, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { useAdminAuth } from '../context/AdminAuthContext';
import { useAdminToast } from '../context/AdminToastContext';
import {
    fetchCatalog,
    fetchCatalogRelease,
    fetchModuleLifecycle,
    postCatalogDryRun,
    postCatalogOperation,
    type CatalogDryRunResult,
    type CatalogModuleListing,
    type CatalogResponse,
    type CatalogSource,
    type ModuleLifecycleInfo,
    type PublicReleaseSummary,
} from '../lib/adminApi';
import { isInstalledReleaseCurrent } from '../lib/catalogReleaseState';
import Button from './ui/Button';
import Drawer from './ui/Drawer';
import EmptyState from './ui/EmptyState';
import ErrorState from './ui/ErrorState';

type CatalogMode = 'available' | 'updates';

interface ReleaseState {
    loading: boolean;
    release?: PublicReleaseSummary;
    error?: string;
}

interface CatalogRow {
    moduleId: string;
    title: string;
    description?: string;
    tags?: string[];
    listing?: CatalogModuleListing;
    installed?: ModuleLifecycleInfo;
    source?: CatalogSource;
    releaseState?: ReleaseState;
}

function matchingCatalogSource(
    listing: CatalogModuleListing,
    installed?: ModuleLifecycleInfo,
    allowPriorityFallback = false,
): CatalogSource | undefined {
    const sources = [listing.source, ...listing.alternatives];
    const recordedSource = installed?.artifact?.sourceProfileId;
    if (!recordedSource) return listing.source;
    return sources.find((source) => source.id === recordedSource)
        || (allowPriorityFallback ? listing.source : undefined);
}

function compareVersions(left: string, right: string): number {
    return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

function releaseKey(moduleId: string, sourceId: string): string {
    return `${sourceId}:${moduleId}`;
}

export default function CatalogModulePanel({ mode }: { mode: CatalogMode }) {
    const { logout } = useAdminAuth();
    const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
    const [modules, setModules] = useState<ModuleLifecycleInfo[]>([]);
    const [releaseStates, setReleaseStates] = useState<Record<string, ReleaseState>>({});
    const [selectedModuleId, setSelectedModuleId] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async (refresh = false) => {
        setLoading(true);
        setError(null);
        const [catalogResult, lifecycleResult] = await Promise.all([
            fetchCatalog(refresh),
            fetchModuleLifecycle(),
        ]);
        if (catalogResult.sessionExpired || lifecycleResult.sessionExpired) {
            logout();
            return;
        }
        if (!catalogResult.ok || !catalogResult.data) {
            setError(catalogResult.error || 'Failed to load module catalogs.');
            setLoading(false);
            return;
        }
        if (!lifecycleResult.ok || !lifecycleResult.data) {
            setError(lifecycleResult.error || 'Failed to load installed modules.');
            setLoading(false);
            return;
        }

        const nextCatalog = catalogResult.data;
        const nextModules = lifecycleResult.data.modules || [];
        setCatalog(nextCatalog);
        setModules(nextModules);

        if (mode === 'updates') {
            const inspections = Object.values(nextCatalog.modules).flatMap((listing) => {
                const installed = nextModules.find((item) => (
                    item.moduleId === listing.moduleId && item.managed && item.artifact
                ));
                const source = matchingCatalogSource(listing, installed);
                if (!installed || !source) return [];
                return [{ listing, source }];
            });
            setReleaseStates(Object.fromEntries(inspections.map(({ listing, source }) => [
                releaseKey(listing.moduleId, source.id),
                { loading: true },
            ])));
            const inspected = await Promise.all(inspections.map(async ({ listing, source }) => {
                const result = await fetchCatalogRelease(source.id, listing.moduleId);
                return {
                    key: releaseKey(listing.moduleId, source.id),
                    state: result.ok && result.data
                        ? { loading: false, release: result.data.release }
                        : { loading: false, error: result.error || 'Release inspection failed.' },
                    sessionExpired: result.sessionExpired,
                };
            }));
            if (inspected.some((result) => result.sessionExpired)) {
                logout();
                return;
            }
            setReleaseStates(Object.fromEntries(inspected.map(({ key, state }) => [key, state])));
        } else {
            setReleaseStates({});
        }
        setLoading(false);
    }, [logout, mode]);

    useEffect(() => {
        void load();
    }, [load]);

    const rows = useMemo<CatalogRow[]>(() => {
        if (!catalog) return [];
        const catalogRows = Object.values(catalog.modules).map((listing) => {
            const installed = modules.find((item) => item.moduleId === listing.moduleId && item.managed && item.artifact);
            const source = matchingCatalogSource(listing, installed, mode === 'available');
            return {
                moduleId: listing.moduleId,
                title: listing.entry.title,
                description: listing.entry.description,
                tags: listing.entry.tags,
                listing,
                installed,
                source,
                releaseState: source
                    ? releaseStates[releaseKey(listing.moduleId, source.id)]
                    : undefined,
            };
        });
        if (mode === 'available') {
            return catalogRows.sort((left, right) => left.title.localeCompare(right.title));
        }

        const byId = new Map(catalogRows.map((row) => [row.moduleId, row]));
        return modules
            .filter((item) => item.managed && item.artifact)
            .map((installed): CatalogRow => byId.get(installed.moduleId) || {
                moduleId: installed.moduleId,
                title: installed.title,
                installed,
            })
            .filter((row) => {
                if (!row.listing || !row.source || row.releaseState?.loading || row.releaseState?.error) return true;
                return !isInstalledReleaseCurrent(row.releaseState?.release, row.installed?.artifact);
            })
            .sort((left, right) => left.title.localeCompare(right.title));
    }, [catalog, mode, modules, releaseStates]);

    const selected = rows.find((row) => row.moduleId === selectedModuleId);
    const sourceFailures = catalog?.sources.filter((source) => source.state === 'error' || source.state === 'stale') || [];

    if (loading && !catalog) {
        return <div className="p-4 text-sm text-[var(--admin-text-secondary)]">Loading module catalogs...</div>;
    }

    return (
        <div className="p-4">
            <div className="mb-4 flex items-center justify-end">
                <Button size="sm" onClick={() => void load(true)} disabled={loading}>
                    <RefreshCw className="mr-2 h-4 w-4" />
                    {loading ? 'Refreshing...' : 'Refresh catalogs'}
                </Button>
            </div>

            {error && <ErrorState message={error} className="mb-4" />}
            {sourceFailures.map((source) => (
                <div
                    key={source.sourceId}
                    className="mb-3 flex items-start gap-2 rounded-md border border-[var(--admin-warning-border)] bg-[var(--admin-warning-bg)] p-3 text-sm text-[var(--admin-warning-text)]"
                >
                    <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                        {source.sourceName}: {source.state === 'stale' ? 'using stale cache' : 'unavailable'}
                        {source.error ? ` (${source.error})` : ''}
                    </span>
                </div>
            ))}

            {rows.length === 0 ? (
                <EmptyState message={mode === 'updates' ? 'Managed modules are up to date.' : 'No modules are available from enabled catalogs.'} />
            ) : (
                <div className="space-y-2">
                    {rows.map((row) => (
                        <CatalogRowItem
                            key={row.moduleId}
                            row={row}
                            mode={mode}
                            onOpen={() => setSelectedModuleId(row.moduleId)}
                        />
                    ))}
                </div>
            )}

            <Drawer
                open={Boolean(selected)}
                title={selected?.title || ''}
                onClose={() => setSelectedModuleId(null)}
            >
                {selected?.listing && selected.source ? (
                    <CatalogOperationPanel
                        key={`${selected.moduleId}:${selected.source.id}`}
                        row={selected}
                        initialSourceId={selected.source.id}
                        onSessionExpired={logout}
                        onComplete={async () => {
                            setSelectedModuleId(null);
                            await load(true);
                        }}
                    />
                ) : selected ? (
                    <ErrorState message={selected.listing
                        ? 'The module\'s recorded catalog source is not enabled.'
                        : 'This managed module is not present in an enabled catalog.'}
                    />
                ) : null}
            </Drawer>
        </div>
    );
}

function CatalogRowItem({ row, mode, onOpen }: { row: CatalogRow; mode: CatalogMode; onOpen: () => void }) {
    const currentVersion = row.installed?.artifact?.version;
    const nextVersion = row.releaseState?.release?.version;
    const changed = currentVersion && nextVersion && currentVersion !== nextVersion;
    const direction = changed && compareVersions(nextVersion, currentVersion) < 0 ? 'Earlier release' : 'Update';

    return (
        <div className="rounded-md border border-[var(--admin-border)] bg-[var(--admin-surface)] p-4">
            <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-base font-semibold text-[var(--admin-text-primary)]">{row.title}</h3>
                        {row.installed && (
                            <span className="rounded border border-[var(--admin-border)] px-1.5 py-0.5 text-xs text-[var(--admin-text-muted)]">
                                Installed {currentVersion ? `v${currentVersion}` : ''}
                            </span>
                        )}
                        {changed && (
                            <span className="rounded border border-[var(--admin-success-border)] bg-[var(--admin-success-bg)] px-1.5 py-0.5 text-xs text-[var(--admin-success)]">
                                {direction} v{nextVersion}
                            </span>
                        )}
                    </div>
                    <p className="mt-1 font-mono text-xs text-[var(--admin-text-muted)]">{row.moduleId}</p>
                    {row.description && <p className="mt-2 text-sm text-[var(--admin-text-secondary)]">{row.description}</p>}
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--admin-text-muted)]">
                        {row.source && <span>Source: {row.source.name}</span>}
                        {row.source && <span>Trust: {row.source.trustTier}</span>}
                        {row.listing && row.listing.alternatives.length > 0 && (
                            <span>{row.listing.alternatives.length + 1} catalog sources</span>
                        )}
                        {row.releaseState?.loading && <span>Inspecting release...</span>}
                        {row.releaseState?.error && <span className="text-[var(--admin-danger-text)]">{row.releaseState.error}</span>}
                        {mode === 'updates' && !row.listing && <span className="text-[var(--admin-warning-text)]">Not in enabled catalogs</span>}
                        {mode === 'updates' && row.listing && !row.source && <span className="text-[var(--admin-warning-text)]">Recorded source unavailable</span>}
                    </div>
                </div>
                <Button size="sm" onClick={onOpen} disabled={!row.listing || !row.source}>
                    <Search className="mr-2 h-4 w-4" />
                    Review
                </Button>
            </div>
        </div>
    );
}

function CatalogOperationPanel({
    row,
    initialSourceId,
    onComplete,
    onSessionExpired,
}: {
    row: CatalogRow;
    initialSourceId: string;
    onComplete: () => void | Promise<void>;
    onSessionExpired: () => void;
}) {
    const { addToast } = useAdminToast();
    const listing = row.listing!;
    const sources = [listing.source, ...listing.alternatives];
    const operation = row.installed ? 'upgrade' : 'install';
    const [sourceId, setSourceId] = useState(initialSourceId);
    const [release, setRelease] = useState<PublicReleaseSummary | null>(null);
    const [releaseLoading, setReleaseLoading] = useState(true);
    const [preview, setPreview] = useState<CatalogDryRunResult | null>(null);
    const [previewLoading, setPreviewLoading] = useState(false);
    const [applying, setApplying] = useState(false);
    const [trustApproved, setTrustApproved] = useState(false);
    const [permissionsApproved, setPermissionsApproved] = useState(false);
    const [previewApprovals, setPreviewApprovals] = useState<{ trust: boolean; permissions: boolean } | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let active = true;
        setReleaseLoading(true);
        setRelease(null);
        setPreview(null);
        setPreviewApprovals(null);
        setTrustApproved(false);
        setPermissionsApproved(false);
        setError(null);
        void fetchCatalogRelease(sourceId, row.moduleId).then((result) => {
            if (!active) return;
            if (result.sessionExpired) {
                onSessionExpired();
                return;
            }
            if (result.ok && result.data) setRelease(result.data.release);
            else setError(result.error || 'Failed to inspect release.');
            setReleaseLoading(false);
        });
        return () => { active = false; };
    }, [onSessionExpired, row.moduleId, sourceId]);

    const runPreview = async () => {
        setPreviewLoading(true);
        setError(null);
        const result = await postCatalogDryRun(sourceId, row.moduleId, operation, {
            approveTrustOverride: trustApproved,
            approvePermissionEscalation: permissionsApproved,
        });
        if (result.sessionExpired) {
            onSessionExpired();
            return;
        }
        if (result.ok && result.data) {
            setPreview(result.data);
            setPreviewApprovals({ trust: trustApproved, permissions: permissionsApproved });
        }
        else setError(result.error || 'Dry-run failed.');
        setPreviewLoading(false);
    };

    const apply = async () => {
        if (!preview?.wouldProceed) return;
        setApplying(true);
        setError(null);
        const result = await postCatalogOperation(sourceId, row.moduleId, operation, {
            approveTrustOverride: trustApproved,
            approvePermissionEscalation: permissionsApproved,
        });
        if (result.sessionExpired) {
            onSessionExpired();
            return;
        }
        if (!result.ok) {
            setError(result.error || `Failed to ${operation} module.`);
            setApplying(false);
            return;
        }
        addToast(`${row.title} ${operation === 'install' ? 'installed' : 'updated'}.`, 'success');
        await onComplete();
        setApplying(false);
    };

    const trustDecision = preview?.governance?.trustPolicy;
    const permissionDelta = preview?.governance?.permissionDelta;
    const previewIsCurrent = Boolean(preview && previewApprovals
        && previewApprovals.trust === trustApproved
        && previewApprovals.permissions === permissionsApproved);
    const currentRelease = operation === 'upgrade'
        && isInstalledReleaseCurrent(release, row.installed?.artifact);

    return (
        <div className="space-y-5">
            {sources.length > 1 && (
                <label className="block text-sm text-[var(--admin-text-secondary)]">
                    <span className="mb-1 block text-xs font-bold uppercase text-[var(--admin-text-muted)]">Catalog source</span>
                    <select
                        value={sourceId}
                        onChange={(event) => setSourceId(event.target.value)}
                        className="w-full rounded-md border border-[var(--admin-border)] bg-[var(--admin-surface)] px-3 py-2 text-[var(--admin-text-primary)]"
                    >
                        {sources.map((source) => (
                            <option key={source.id} value={source.id}>{source.name} ({source.trustTier})</option>
                        ))}
                    </select>
                </label>
            )}

            <DetailSection title="Release">
                {releaseLoading ? (
                    <p className="text-sm text-[var(--admin-text-secondary)]">Inspecting release manifest...</p>
                ) : release ? (
                    <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-2 text-sm">
                        <dt className="text-[var(--admin-text-muted)]">Version</dt>
                        <dd className="text-[var(--admin-text-primary)]">{release.version}</dd>
                        {row.installed?.artifact?.version && (
                            <>
                                <dt className="text-[var(--admin-text-muted)]">Installed</dt>
                                <dd className="text-[var(--admin-text-primary)]">{row.installed.artifact.version}</dd>
                            </>
                        )}
                        <dt className="text-[var(--admin-text-muted)]">Trust</dt>
                        <dd className="text-[var(--admin-text-primary)]">{release.trustTier}</dd>
                        <dt className="text-[var(--admin-text-muted)]">Archive</dt>
                        <dd className="text-[var(--admin-text-primary)]">{(release.archiveSize / 1024).toFixed(1)} KiB</dd>
                        <dt className="text-[var(--admin-text-muted)]">SHA-256</dt>
                        <dd className="break-all font-mono text-xs text-[var(--admin-text-primary)]">{release.integrity}</dd>
                    </dl>
                ) : null}
            </DetailSection>

            {error && <ErrorState message={error} />}

            {preview && (
                <CatalogDryRunPreview preview={preview} />
            )}

            {trustDecision?.requiresAdminOverride && !trustDecision.allowed && (
                <label className="flex items-start gap-2 text-sm text-[var(--admin-text-primary)]">
                    <input
                        type="checkbox"
                        checked={trustApproved}
                        onChange={(event) => setTrustApproved(event.target.checked)}
                        className="mt-0.5"
                    />
                    Approve this lower-trust catalog release
                </label>
            )}

            {permissionDelta?.escalated && (
                <label className="flex items-start gap-2 text-sm text-[var(--admin-text-primary)]">
                    <input
                        type="checkbox"
                        checked={permissionsApproved}
                        onChange={(event) => setPermissionsApproved(event.target.checked)}
                        className="mt-0.5"
                    />
                    Acknowledge declared-access changes
                </label>
            )}

            <div className="flex flex-wrap gap-2 border-t border-[var(--admin-border)] pt-4">
                {currentRelease && (
                    <p className="w-full text-sm text-[var(--admin-text-muted)]">The current release is already installed.</p>
                )}
                <Button onClick={() => void runPreview()} disabled={releaseLoading || !release || previewLoading || currentRelease}>
                    <ShieldCheck className="mr-2 h-4 w-4" />
                    {previewLoading ? 'Checking...' : preview && !previewIsCurrent ? 'Re-run checks' : 'Run dry-run'}
                </Button>
                <Button variant="primary" onClick={() => void apply()} disabled={!preview?.wouldProceed || !previewIsCurrent || applying || currentRelease}>
                    <Download className="mr-2 h-4 w-4" />
                    {applying ? 'Applying...' : operation === 'install' ? 'Install' : 'Update'}
                </Button>
            </div>
        </div>
    );
}

function CatalogDryRunPreview({ preview }: { preview: CatalogDryRunResult }) {
    const governance = preview.governance;
    return (
        <div className="space-y-3">
            <div className={`rounded-md border p-3 text-sm font-semibold ${preview.wouldProceed
                ? 'border-[var(--admin-success-border)] bg-[var(--admin-success-bg)] text-[var(--admin-success)]'
                : 'border-[var(--admin-danger-border)] bg-[var(--admin-danger-bg)] text-[var(--admin-danger-text)]'}`}
            >
                {preview.wouldProceed ? 'Dry-run passed' : 'Dry-run blocked'}
            </div>

            {preview.blockingReasons.length > 0 && (
                <DetailSection title="Blockers">
                    <ul className="space-y-1 text-sm text-[var(--admin-danger-text)]">
                        {preview.blockingReasons.map((reason) => <li key={reason}>{reason}</li>)}
                    </ul>
                </DetailSection>
            )}

            {preview.archive && (
                <DetailSection title="Archive">
                    <div className="space-y-1 text-sm text-[var(--admin-text-secondary)]">
                        <p>{preview.archive.title} v{preview.archive.version}</p>
                        <p>{(preview.archive.archiveSize / 1024).toFixed(1)} KiB, SHA-256 verified</p>
                        {preview.archive.localSourceCollision && (
                            <p className="text-[var(--admin-warning-text)]">A local development copy exists and will remain unchanged.</p>
                        )}
                        {preview.archive.warnings.map((warning) => (
                            <p key={warning} className="text-[var(--admin-warning-text)]">{warning}</p>
                        ))}
                    </div>
                </DetailSection>
            )}

            {governance && (
                <DetailSection title="Governance">
                    <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-2 text-sm">
                        <dt className="text-[var(--admin-text-muted)]">Manifest</dt>
                        <dd className="text-[var(--admin-text-primary)]">{governance.manifestGate.allowed ? 'Accepted' : 'Blocked'}</dd>
                        <dt className="text-[var(--admin-text-muted)]">Artifact</dt>
                        <dd className="text-[var(--admin-text-primary)]">{governance.artifactVerification.verified ? 'Verified' : 'Unverified'}</dd>
                        {governance.trustPolicy && (
                            <>
                                <dt className="text-[var(--admin-text-muted)]">Trust</dt>
                                <dd className="text-[var(--admin-text-primary)]">
                                    {governance.trustPolicy.effectiveTier} ({governance.trustPolicy.allowed ? 'accepted' : 'blocked'})
                                </dd>
                            </>
                        )}
                        {governance.dependencyImpact && (
                            <>
                                <dt className="text-[var(--admin-text-muted)]">Dependencies</dt>
                                <dd className="text-[var(--admin-text-primary)]">{governance.dependencyImpact.canProceed ? 'Satisfied' : 'Blocked'}</dd>
                            </>
                        )}
                    </dl>
                    {governance.permissionDelta?.escalations.map((entry) => (
                        <p key={entry.change} className="mt-2 text-sm text-[var(--admin-warning-text)]">{entry.change}</p>
                    ))}
                </DetailSection>
            )}
        </div>
    );
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <section>
            <h3 className="mb-2 text-xs font-bold uppercase text-[var(--admin-text-muted)]">{title}</h3>
            <div className="rounded-md border border-[var(--admin-border)] bg-[var(--admin-surface)] p-3">{children}</div>
        </section>
    );
}
