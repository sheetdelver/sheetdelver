'use client';

import { useState, useEffect } from 'react';
import {
    fetchSourceProfiles,
    createSourceProfile,
    updateSourceProfile,
    deleteSourceProfile,
    testSourceProfile,
    fetchSourceModules,
    postManagerAction,
    type SourceProfile,
    type SourceModuleEntry
} from '../lib/adminApi';
import { ModuleSourceKind, SourceProfileId } from '@shared/types/modules';
import { useAdminToast } from '../context/AdminToastContext';

export default function SourceProfilePanel({
    onModuleInstalled,
    installedModules = []
}: {
    onModuleInstalled?: () => void;
    installedModules?: any[];
}) {
    const { addToast } = useAdminToast();
    const [profiles, setProfiles] = useState<SourceProfile[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);

    // Add source form state
    const [showAddForm, setShowAddForm] = useState(false);
    const [newUrl, setNewUrl] = useState('');
    const [newName, setNewName] = useState('');
    const [creating, setCreating] = useState(false);

    // Per-profile state
    const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
    const [testingId, setTestingId] = useState<string | null>(null);
    const [browsingId, setBrowsingId] = useState<string | null>(null);
    const [sourceModules, setSourceModules] = useState<Record<string, SourceModuleEntry> | null>(null);
    const [browseLoading, setBrowseLoading] = useState(false);
    const [installingId, setInstallingId] = useState<string | null>(null);

    const loadProfiles = async () => {
        setLoading(true);
        const result = await fetchSourceProfiles();
        if (result.ok && result.data?.profiles) {
            setProfiles(result.data.profiles);
            setLoadError(null);
        } else {
            setLoadError(result.error || 'Failed to load source profiles');
        }
        setLoading(false);
    };

    useEffect(() => { loadProfiles(); }, []);

    // ─── Handlers ────────────────────────────────────────────────

    const handleCreate = async () => {
        if (!newUrl.trim()) return;
        setCreating(true);
        const result = await createSourceProfile({
            name: newName.trim() || 'New Source',
            baseUrl: newUrl.trim(),
            kind: newUrl.startsWith('index://') || newUrl.startsWith('http') ? ModuleSourceKind.Indexed : ModuleSourceKind.Local,
            enabled: true,
            priority: profiles.length > 0 ? profiles[profiles.length - 1].priority + 10 : 10,
        });
        if (result.ok) {
            setShowAddForm(false);
            setNewUrl('');
            setNewName('');
            loadProfiles();
            addToast('Source profile created.', 'success');
        } else {
            addToast(result.error || 'Failed to create source profile.', 'error');
        }
        setCreating(false);
    };

    const handleToggleEnable = async (profile: SourceProfile) => {
        if (profile.id === SourceProfileId.LocalDefault) return;
        const result = await updateSourceProfile(profile.id, { enabled: !profile.enabled });
        if (result.ok) loadProfiles();
        else addToast(result.error || 'Failed to update source profile.', 'error');
    };

    const handleDelete = async (id: string) => {
        const result = await deleteSourceProfile(id);
        if (result.ok) {
            setDeleteConfirmId(null);
            loadProfiles();
            addToast('Source profile deleted.', 'success');
        } else {
            addToast(result.error || 'Failed to delete source profile.', 'error');
            setDeleteConfirmId(null);
        }
    };

    const handleTest = async (id: string) => {
        setTestingId(id);
        const result = await testSourceProfile(id);
        if (result.ok && result.data) {
            addToast(
                `Connected — ${result.data.moduleCount ?? 0} module${result.data.moduleCount !== 1 ? 's' : ''} · Publisher: ${result.data.publisher || 'Unknown'}`,
                'success'
            );
        } else {
            addToast(result.error || result.data?.error || 'Connection test failed.', 'error');
        }
        setTestingId(null);
    };

    const handleBrowse = async (id: string) => {
        if (browsingId === id) {
            setBrowsingId(null);
            setSourceModules(null);
            return;
        }
        setBrowsingId(id);
        setBrowseLoading(true);
        setSourceModules(null);
        const result = await fetchSourceModules(id);
        if (result.ok && result.data?.modules) {
            setSourceModules(result.data.modules);
        } else {
            addToast(result.error || 'Failed to load modules from source.', 'error');
            setBrowsingId(null);
        }
        setBrowseLoading(false);
    };

    const handleInstall = async (moduleId: string) => {
        setInstallingId(moduleId);
        try {
            const result = await postManagerAction(moduleId, 'install', { source: 'index://' });
            if (result.ok) {
                addToast(`${moduleId} installed successfully.`, 'success');
                if (onModuleInstalled) onModuleInstalled();
            } else {
                addToast(result.error || `Failed to install ${moduleId}.`, 'error');
            }
        } catch (err: any) {
            addToast(err.message || `Failed to install ${moduleId}.`, 'error');
        } finally {
            setInstallingId(null);
        }
    };

    // ─── Render ───────────────────────────────────────────────────

    if (loading) return <div className="p-4 text-[var(--admin-text-secondary)]">Loading source profiles...</div>;
    if (loadError) return <div className="p-4 text-[var(--admin-danger-text)] bg-[var(--admin-danger-bg)] rounded-xl">{loadError}</div>;

    return (
        <div className="space-y-4 p-2">
            {/* Header */}
            <div className="flex items-center justify-between">
                <p className="text-sm text-[var(--admin-text-secondary)]">
                    Configure where the manager discovers modules.
                </p>
                <button
                    onClick={() => { setShowAddForm(v => !v); setNewUrl(''); setNewName(''); }}
                    className="rounded-2xl bg-[var(--admin-accent)] px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-[var(--admin-accent-strong)]"
                >
                    {showAddForm ? 'Cancel' : '+ Add Source'}
                </button>
            </div>

            {/* Add source inline form */}
            {showAddForm && (
                <div className="rounded-2xl border border-[var(--admin-border)] bg-[var(--admin-surface)] p-4 space-y-3">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-[var(--admin-text-muted)]">New Source Profile</h4>
                    <div className="space-y-2">
                        <input
                            type="text"
                            placeholder="URL (e.g. https://my-registry.com or index://...)"
                            value={newUrl}
                            onChange={e => setNewUrl(e.target.value)}
                            className="w-full rounded-xl border border-[var(--admin-border)] bg-[var(--admin-surface-hover)] px-3 py-2 text-sm text-[var(--admin-text-primary)] placeholder-[var(--admin-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--admin-accent)]"
                        />
                        <input
                            type="text"
                            placeholder="Display name (optional)"
                            value={newName}
                            onChange={e => setNewName(e.target.value)}
                            className="w-full rounded-xl border border-[var(--admin-border)] bg-[var(--admin-surface-hover)] px-3 py-2 text-sm text-[var(--admin-text-primary)] placeholder-[var(--admin-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--admin-accent)]"
                        />
                    </div>
                    <div className="flex gap-2 justify-end">
                        <button
                            onClick={() => setShowAddForm(false)}
                            className="rounded-2xl border border-[var(--admin-border)] bg-[var(--admin-surface)] px-4 py-1.5 text-sm text-[var(--admin-text-secondary)] transition hover:bg-[var(--admin-surface-hover)]"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleCreate}
                            disabled={creating || !newUrl.trim()}
                            className="rounded-2xl bg-[var(--admin-accent)] px-4 py-1.5 text-sm font-semibold text-white transition hover:bg-[var(--admin-accent-strong)] disabled:opacity-50"
                        >
                            {creating ? 'Creating…' : 'Create'}
                        </button>
                    </div>
                </div>
            )}

            {/* Profile list */}
            <div className="grid gap-3">
                {profiles.map(profile => (
                    <div key={profile.id} className="rounded-2xl border border-[var(--admin-border)] bg-[var(--admin-surface)] overflow-hidden">
                        <div className="p-4 flex flex-col md:flex-row md:items-start justify-between gap-4">
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1 flex-wrap">
                                    <h3 className="font-bold text-[var(--admin-text-primary)]">{profile.name}</h3>
                                    {profile.id === SourceProfileId.LocalDefault && (
                                        <span className="rounded-full border border-[var(--admin-border)] bg-[var(--admin-surface-hover)] px-2 py-0.5 text-xs text-[var(--admin-text-muted)]">Default</span>
                                    )}
                                    {!profile.enabled && (
                                        <span className="rounded-full border border-[var(--admin-danger-border)] bg-[var(--admin-danger-bg)] px-2 py-0.5 text-xs text-[var(--admin-danger-text)]">Disabled</span>
                                    )}
                                </div>
                                <code className="text-xs text-[var(--admin-text-secondary)] break-all font-mono">
                                    {profile.baseUrl}
                                </code>

                                {/* Inline delete confirmation */}
                                {deleteConfirmId === profile.id && (
                                    <div className="mt-3 flex items-center gap-2">
                                        <span className="text-xs text-[var(--admin-danger-text)]">Delete this source profile?</span>
                                        <button
                                            onClick={() => handleDelete(profile.id)}
                                            className="rounded-xl bg-[var(--admin-danger-button)] px-3 py-1 text-xs font-semibold text-white hover:bg-[var(--admin-danger-button-strong)] transition"
                                        >
                                            Confirm
                                        </button>
                                        <button
                                            onClick={() => setDeleteConfirmId(null)}
                                            className="rounded-xl border border-[var(--admin-border)] px-3 py-1 text-xs text-[var(--admin-text-secondary)] hover:bg-[var(--admin-surface-hover)] transition"
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                )}
                            </div>

                            <div className="flex flex-wrap items-center gap-2 shrink-0">
                                {profile.kind === ModuleSourceKind.Indexed && profile.enabled && (
                                    <>
                                        <button
                                            onClick={() => handleBrowse(profile.id)}
                                            className="rounded-2xl border border-[var(--admin-border)] bg-[var(--admin-surface)] px-3 py-1.5 text-sm text-[var(--admin-text-secondary)] transition hover:bg-[var(--admin-surface-hover)]"
                                        >
                                            {browsingId === profile.id ? 'Close' : 'Browse'}
                                        </button>
                                        <button
                                            onClick={() => handleTest(profile.id)}
                                            disabled={testingId === profile.id}
                                            className="rounded-2xl border border-[var(--admin-border)] bg-[var(--admin-surface)] px-3 py-1.5 text-sm text-[var(--admin-text-secondary)] transition hover:bg-[var(--admin-surface-hover)] disabled:opacity-50"
                                        >
                                            {testingId === profile.id ? 'Testing…' : 'Test'}
                                        </button>
                                    </>
                                )}
                                {profile.id !== SourceProfileId.LocalDefault && (
                                    <>
                                        <button
                                            onClick={() => handleToggleEnable(profile)}
                                            className={`rounded-2xl px-3 py-1.5 text-sm font-medium transition border ${
                                                profile.enabled
                                                    ? 'border-[var(--admin-border)] bg-[var(--admin-surface)] text-[var(--admin-text-secondary)] hover:bg-[var(--admin-surface-hover)]'
                                                    : 'border-[var(--admin-success-border)] bg-[var(--admin-success-bg)] text-[var(--admin-success)] hover:opacity-80'
                                            }`}
                                        >
                                            {profile.enabled ? 'Disable' : 'Enable'}
                                        </button>
                                        <button
                                            onClick={() => setDeleteConfirmId(deleteConfirmId === profile.id ? null : profile.id)}
                                            className="rounded-2xl border border-[var(--admin-danger-border)] bg-[var(--admin-danger-bg)] px-3 py-1.5 text-sm text-[var(--admin-danger-text)] transition hover:opacity-80"
                                        >
                                            Delete
                                        </button>
                                    </>
                                )}
                            </div>
                        </div>

                        {/* Module browser */}
                        {browsingId === profile.id && (
                            <div className="border-t border-[var(--admin-border)] bg-[var(--admin-surface-hover)] p-4">
                                {browseLoading ? (
                                    <div className="text-sm text-[var(--admin-text-secondary)]">Loading modules…</div>
                                ) : sourceModules ? (
                                    Object.keys(sourceModules).length > 0 ? (
                                        <div className="space-y-3">
                                            <h4 className="text-xs font-bold uppercase tracking-wider text-[var(--admin-text-muted)]">Available Modules</h4>
                                            {Object.entries(sourceModules).map(([modId, modInfo]) => {
                                                const installed = installedModules.find(m => m.moduleId === modId);
                                                const artifact = installed?.artifact;
                                                const isUpdate = artifact && artifact.version !== modInfo.latestVersion;
                                                const btnClass = !artifact
                                                    ? 'bg-[var(--admin-accent)] hover:bg-[var(--admin-accent-strong)] text-white'
                                                    : isUpdate
                                                        ? 'bg-amber-600 hover:bg-amber-700 text-white'
                                                        : 'border border-[var(--admin-border)] bg-[var(--admin-surface)] text-[var(--admin-text-secondary)] hover:bg-[var(--admin-surface-hover)]';
                                                const btnLabel = installingId === modId ? 'Installing…'
                                                    : !installed || !artifact ? 'Install'
                                                    : isUpdate ? 'Update'
                                                    : 'Re-install';

                                                return (
                                                    <div key={modId} className="flex items-center justify-between rounded-2xl border border-[var(--admin-border)] bg-[var(--admin-surface)] p-3">
                                                        <div>
                                                            <div className="font-semibold text-[var(--admin-text-primary)] text-sm">{modInfo.title || modId}</div>
                                                            <div className="text-xs text-[var(--admin-text-muted)] font-mono">{modId} · v{modInfo.latestVersion}</div>
                                                        </div>
                                                        <button
                                                            onClick={() => handleInstall(modId)}
                                                            disabled={installingId === modId}
                                                            className={`rounded-2xl px-3 py-1.5 text-xs font-semibold transition disabled:opacity-50 ${btnClass}`}
                                                        >
                                                            {btnLabel}
                                                        </button>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    ) : (
                                        <div className="text-sm text-[var(--admin-text-muted)] italic">No modules found in this source.</div>
                                    )
                                ) : null}
                            </div>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}
