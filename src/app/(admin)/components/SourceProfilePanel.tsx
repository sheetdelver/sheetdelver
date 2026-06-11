'use client';

import { useState, useEffect } from 'react';
import {
    fetchSourceProfiles,
    createSourceProfile,
    updateSourceProfile,
    deleteSourceProfile,
    testSourceProfile,
    fetchSourceModules,
    fetchModuleLifecycle,
    postManagerAction,
    type SourceProfile,
    type SourceModuleEntry,
    type ModuleLifecycleInfo,
} from '../lib/adminApi';
import { ModuleSourceKind, SourceProfileId } from '@shared/types/modules';
import { useAdminToast } from '../context/AdminToastContext';

export default function SourceProfilePanel({
    onModuleInstalled,
}: {
    onModuleInstalled?: () => void;
} = {}) {
    const { addToast } = useAdminToast();
    const [profiles, setProfiles] = useState<SourceProfile[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);

    // Installed-module lifecycle list — fetched here so the browse view can label
    // Install / Update / Re-install. (Previously fed from a sibling panel; the
    // routed layout makes this page self-sufficient — ADR-0030 UX-3.)
    const [installedModules, setInstalledModules] = useState<ModuleLifecycleInfo[]>([]);
    const loadInstalledModules = async () => {
        const result = await fetchModuleLifecycle();
        if (result.ok && result.data?.modules) setInstalledModules(result.data.modules);
    };

    // Add source form state
    const [showAddForm, setShowAddForm] = useState(false);
    const [newUrl, setNewUrl] = useState('');
    const [newName, setNewName] = useState('');
    const [newToken, setNewToken] = useState('');
    const [creating, setCreating] = useState(false);

    // Edit form state (single profile edited at a time)
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editName, setEditName] = useState('');
    const [editUrl, setEditUrl] = useState('');
    const [editPriority, setEditPriority] = useState(0);
    const [editToken, setEditToken] = useState('');
    const [savingEdit, setSavingEdit] = useState(false);

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

    useEffect(() => { loadProfiles(); loadInstalledModules(); }, []);

    // ─── Handlers ────────────────────────────────────────────────

    const handleCreate = async () => {
        if (!newUrl.trim()) return;
        setCreating(true);
        const token = newToken.trim();
        const result = await createSourceProfile({
            name: newName.trim() || 'New Source',
            baseUrl: newUrl.trim(),
            kind: newUrl.startsWith('index://') || newUrl.startsWith('http') ? ModuleSourceKind.Indexed : ModuleSourceKind.Local,
            enabled: true,
            priority: profiles.length > 0 ? profiles[profiles.length - 1].priority + 10 : 10,
            ...(token ? { auth: { type: 'bearer' as const, token } } : {}),
        });
        if (result.ok) {
            setShowAddForm(false);
            setNewUrl('');
            setNewName('');
            setNewToken('');
            loadProfiles();
            addToast('Source profile created.', 'success');
        } else {
            addToast(result.error || 'Failed to create source profile.', 'error');
        }
        setCreating(false);
    };

    const startEdit = (profile: SourceProfile) => {
        setEditingId(profile.id);
        setEditName(profile.name);
        setEditUrl(profile.baseUrl);
        setEditPriority(profile.priority);
        setEditToken(''); // write-only: blank means "leave token unchanged"
        setDeleteConfirmId(null);
    };

    const cancelEdit = () => {
        setEditingId(null);
        setEditToken('');
    };

    const handleSaveEdit = async (profile: SourceProfile) => {
        setSavingEdit(true);
        const token = editToken.trim();
        const result = await updateSourceProfile(profile.id, {
            name: editName.trim() || profile.name,
            baseUrl: editUrl.trim() || profile.baseUrl,
            priority: Number.isFinite(editPriority) ? editPriority : profile.priority,
            // Only send a token when one was typed — blank leaves existing auth untouched.
            ...(token ? { auth: { type: 'bearer' as const, token } } : {}),
        });
        if (result.ok) {
            cancelEdit();
            loadProfiles();
            addToast('Source profile updated.', 'success');
        } else {
            addToast(result.error || 'Failed to update source profile.', 'error');
        }
        setSavingEdit(false);
    };

    const handleToggleEnable = async (profile: SourceProfile) => {
        if (profile.id === SourceProfileId.LocalDefault) return;
        const result = await updateSourceProfile(profile.id, { enabled: !profile.enabled });
        if (result.ok) loadProfiles();
        else addToast(result.error || 'Failed to update source profile.', 'error');
    };

    // Reorder by swapping priority with the adjacent profile (lower priority = higher
    // in the list / earlier resolution). The protected default local source can't move.
    const moveProfile = async (profile: SourceProfile, direction: 'up' | 'down') => {
        const sorted = [...profiles].sort((a, b) => a.priority - b.priority);
        const idx = sorted.findIndex(p => p.id === profile.id);
        const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
        const other = sorted[swapIdx];
        if (!other || other.id === SourceProfileId.LocalDefault || profile.id === SourceProfileId.LocalDefault) return;

        const a = await updateSourceProfile(profile.id, { priority: other.priority });
        const b = await updateSourceProfile(other.id, { priority: profile.priority });
        if (a.ok && b.ok) loadProfiles();
        else addToast(a.error || b.error || 'Failed to reorder source profiles.', 'error');
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

    /**
     * Build a source ref scoped to a specific profile. `index://<host>` resolves
     * against only the matching profile's index, whereas a bare `index://`
     * aggregates every enabled indexed source by global priority (ADR-0029 Phase 4).
     */
    const sourceRefForProfile = (profile: SourceProfile): string => {
        if (profile.kind !== ModuleSourceKind.Indexed) return 'index://';
        const host = profile.baseUrl.replace(/^https?:\/\//, '').replace(/^index:\/\//, '');
        return host ? `index://${host}` : 'index://';
    };

    const handleInstall = async (moduleId: string, profile: SourceProfile) => {
        setInstallingId(moduleId);
        try {
            const result = await postManagerAction(moduleId, 'install', { source: sourceRefForProfile(profile) });
            if (result.ok) {
                addToast(`${moduleId} installed successfully.`, 'success');
                loadInstalledModules();
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
                    className="rounded-lg bg-[var(--admin-accent)] px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-[var(--admin-accent-strong)]"
                >
                    {showAddForm ? 'Cancel' : '+ Add Source'}
                </button>
            </div>

            {/* Add source inline form */}
            {showAddForm && (
                <div className="rounded-lg border border-[var(--admin-border)] bg-[var(--admin-surface)] p-4 space-y-3">
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
                        <input
                            type="password"
                            placeholder="Bearer auth token (optional, for private registries)"
                            value={newToken}
                            onChange={e => setNewToken(e.target.value)}
                            autoComplete="off"
                            className="w-full rounded-xl border border-[var(--admin-border)] bg-[var(--admin-surface-hover)] px-3 py-2 text-sm text-[var(--admin-text-primary)] placeholder-[var(--admin-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--admin-accent)]"
                        />
                    </div>
                    <div className="flex gap-2 justify-end">
                        <button
                            onClick={() => setShowAddForm(false)}
                            className="rounded-lg border border-[var(--admin-border)] bg-[var(--admin-surface)] px-4 py-1.5 text-sm text-[var(--admin-text-secondary)] transition hover:bg-[var(--admin-surface-hover)]"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleCreate}
                            disabled={creating || !newUrl.trim()}
                            className="rounded-lg bg-[var(--admin-accent)] px-4 py-1.5 text-sm font-semibold text-white transition hover:bg-[var(--admin-accent-strong)] disabled:opacity-50"
                        >
                            {creating ? 'Creating…' : 'Create'}
                        </button>
                    </div>
                </div>
            )}

            {/* Profile list */}
            <div className="grid gap-3">
                {profiles.map((profile, index) => (
                    <div key={profile.id} className="rounded-lg border border-[var(--admin-border)] bg-[var(--admin-surface)] overflow-hidden">
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
                                    {profile.auth?.configured && (
                                        <span className="rounded-full border border-[var(--admin-border)] bg-[var(--admin-surface-hover)] px-2 py-0.5 text-xs text-[var(--admin-text-muted)]">🔒 Auth</span>
                                    )}
                                </div>
                                <code className="text-xs text-[var(--admin-text-secondary)] break-all font-mono">
                                    {profile.baseUrl}
                                </code>

                                {/* Inline edit form */}
                                {editingId === profile.id && (
                                    <div className="mt-3 space-y-2 rounded-xl border border-[var(--admin-border)] bg-[var(--admin-surface-hover)] p-3">
                                        <h4 className="text-xs font-bold uppercase tracking-wider text-[var(--admin-text-muted)]">Edit Source Profile</h4>
                                        <input
                                            type="text"
                                            placeholder="Display name"
                                            value={editName}
                                            onChange={e => setEditName(e.target.value)}
                                            className="w-full rounded-xl border border-[var(--admin-border)] bg-[var(--admin-surface)] px-3 py-2 text-sm text-[var(--admin-text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--admin-accent)]"
                                        />
                                        <input
                                            type="text"
                                            placeholder="URL"
                                            value={editUrl}
                                            onChange={e => setEditUrl(e.target.value)}
                                            className="w-full rounded-xl border border-[var(--admin-border)] bg-[var(--admin-surface)] px-3 py-2 text-sm text-[var(--admin-text-primary)] font-mono focus:outline-none focus:ring-1 focus:ring-[var(--admin-accent)]"
                                        />
                                        <label className="flex items-center gap-2 text-xs text-[var(--admin-text-secondary)]">
                                            Priority
                                            <input
                                                type="number"
                                                value={editPriority}
                                                onChange={e => setEditPriority(parseInt(e.target.value, 10))}
                                                className="w-24 rounded-xl border border-[var(--admin-border)] bg-[var(--admin-surface)] px-3 py-1.5 text-sm text-[var(--admin-text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--admin-accent)]"
                                            />
                                        </label>
                                        <input
                                            type="password"
                                            placeholder={profile.auth?.configured ? 'Bearer token (leave blank to keep existing)' : 'Bearer auth token (optional)'}
                                            value={editToken}
                                            onChange={e => setEditToken(e.target.value)}
                                            autoComplete="off"
                                            className="w-full rounded-xl border border-[var(--admin-border)] bg-[var(--admin-surface)] px-3 py-2 text-sm text-[var(--admin-text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--admin-accent)]"
                                        />
                                        <div className="flex justify-end gap-2 pt-1">
                                            <button
                                                onClick={cancelEdit}
                                                disabled={savingEdit}
                                                className="rounded-xl border border-[var(--admin-border)] bg-[var(--admin-surface)] px-3 py-1.5 text-xs text-[var(--admin-text-secondary)] transition hover:bg-[var(--admin-surface-hover)] disabled:opacity-50"
                                            >
                                                Cancel
                                            </button>
                                            <button
                                                onClick={() => handleSaveEdit(profile)}
                                                disabled={savingEdit}
                                                className="rounded-xl bg-[var(--admin-accent)] px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-[var(--admin-accent-strong)] disabled:opacity-50"
                                            >
                                                {savingEdit ? 'Saving…' : 'Save'}
                                            </button>
                                        </div>
                                    </div>
                                )}

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
                                {/* Priority reorder (non-default only; default local stays pinned at top) */}
                                {profile.id !== SourceProfileId.LocalDefault && (
                                    <div className="flex flex-col">
                                        <button
                                            onClick={() => moveProfile(profile, 'up')}
                                            disabled={index <= 1}
                                            aria-label={`Move ${profile.name} up`}
                                            title="Move up (higher priority)"
                                            className="px-1.5 text-xs text-[var(--admin-text-muted)] hover:text-[var(--admin-text-primary)] disabled:opacity-30"
                                        >
                                            ▲
                                        </button>
                                        <button
                                            onClick={() => moveProfile(profile, 'down')}
                                            disabled={index >= profiles.length - 1}
                                            aria-label={`Move ${profile.name} down`}
                                            title="Move down (lower priority)"
                                            className="px-1.5 text-xs text-[var(--admin-text-muted)] hover:text-[var(--admin-text-primary)] disabled:opacity-30"
                                        >
                                            ▼
                                        </button>
                                    </div>
                                )}
                                {profile.kind === ModuleSourceKind.Indexed && profile.enabled && (
                                    <>
                                        <button
                                            onClick={() => handleBrowse(profile.id)}
                                            className="rounded-lg border border-[var(--admin-border)] bg-[var(--admin-surface)] px-3 py-1.5 text-sm text-[var(--admin-text-secondary)] transition hover:bg-[var(--admin-surface-hover)]"
                                        >
                                            {browsingId === profile.id ? 'Close' : 'Browse'}
                                        </button>
                                        <button
                                            onClick={() => handleTest(profile.id)}
                                            disabled={testingId === profile.id}
                                            className="rounded-lg border border-[var(--admin-border)] bg-[var(--admin-surface)] px-3 py-1.5 text-sm text-[var(--admin-text-secondary)] transition hover:bg-[var(--admin-surface-hover)] disabled:opacity-50"
                                        >
                                            {testingId === profile.id ? 'Testing…' : 'Test'}
                                        </button>
                                    </>
                                )}
                                {profile.id !== SourceProfileId.LocalDefault && (
                                    <>
                                        <button
                                            onClick={() => (editingId === profile.id ? cancelEdit() : startEdit(profile))}
                                            className="rounded-lg border border-[var(--admin-border)] bg-[var(--admin-surface)] px-3 py-1.5 text-sm text-[var(--admin-text-secondary)] transition hover:bg-[var(--admin-surface-hover)]"
                                        >
                                            {editingId === profile.id ? 'Close' : 'Edit'}
                                        </button>
                                        <button
                                            onClick={() => handleToggleEnable(profile)}
                                            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition border ${
                                                profile.enabled
                                                    ? 'border-[var(--admin-border)] bg-[var(--admin-surface)] text-[var(--admin-text-secondary)] hover:bg-[var(--admin-surface-hover)]'
                                                    : 'border-[var(--admin-success-border)] bg-[var(--admin-success-bg)] text-[var(--admin-success)] hover:opacity-80'
                                            }`}
                                        >
                                            {profile.enabled ? 'Disable' : 'Enable'}
                                        </button>
                                        <button
                                            onClick={() => setDeleteConfirmId(deleteConfirmId === profile.id ? null : profile.id)}
                                            className="rounded-lg border border-[var(--admin-danger-border)] bg-[var(--admin-danger-bg)] px-3 py-1.5 text-sm text-[var(--admin-danger-text)] transition hover:opacity-80"
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
                                                    <div key={modId} className="flex items-center justify-between rounded-lg border border-[var(--admin-border)] bg-[var(--admin-surface)] p-3">
                                                        <div>
                                                            <div className="font-semibold text-[var(--admin-text-primary)] text-sm">{modInfo.title || modId}</div>
                                                            <div className="text-xs text-[var(--admin-text-muted)] font-mono">{modId} · v{modInfo.latestVersion}</div>
                                                        </div>
                                                        <button
                                                            onClick={() => handleInstall(modId, profile)}
                                                            disabled={installingId === modId}
                                                            className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition disabled:opacity-50 ${btnClass}`}
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
