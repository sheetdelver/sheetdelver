'use client';

import { useCallback, useEffect, useState } from 'react';
import {
    ChevronDown,
    ChevronUp,
    CircleCheck,
    CircleX,
    Pencil,
    Plus,
    RefreshCw,
    Trash2,
} from 'lucide-react';
import { ModuleSourceKind, SourceProfileId } from '@shared/types/modules';
import {
    createSourceProfile,
    deleteSourceProfile,
    fetchSourceProfiles,
    testSourceProfile,
    updateSourceProfile,
    type SourceProfile,
} from '../lib/adminApi';
import { useAdminNotifications } from '../context/AdminNotificationContext';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';
import ErrorState from './ui/ErrorState';

const INPUT_CLASS = 'w-full rounded-md border border-[var(--admin-border)] bg-[var(--admin-surface)] px-3 py-2 text-sm text-[var(--admin-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--admin-accent-soft)]';

function isProtected(profile: SourceProfile): boolean {
    return profile.id === SourceProfileId.LocalDefault
        || profile.id === SourceProfileId.OfficialCatalog;
}

export default function SourceProfilePanel() {
    const { addNotification } = useAdminNotifications();
    const [profiles, setProfiles] = useState<SourceProfile[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [showCreate, setShowCreate] = useState(false);
    const [newName, setNewName] = useState('');
    const [newUrl, setNewUrl] = useState('');
    const [creating, setCreating] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editName, setEditName] = useState('');
    const [editUrl, setEditUrl] = useState('');
    const [editPriority, setEditPriority] = useState(200);
    const [savingId, setSavingId] = useState<string | null>(null);
    const [testingId, setTestingId] = useState<string | null>(null);
    const [deleteId, setDeleteId] = useState<string | null>(null);

    const loadProfiles = useCallback(async () => {
        setLoading(true);
        const result = await fetchSourceProfiles();
        if (result.ok && result.data?.profiles) {
            setProfiles(result.data.profiles);
            setError(null);
        } else {
            setError(result.error || 'Failed to load catalog sources.');
        }
        setLoading(false);
    }, []);

    useEffect(() => {
        void loadProfiles();
    }, [loadProfiles]);

    const handleCreate = async () => {
        setCreating(true);
        const result = await createSourceProfile({
            name: newName.trim(),
            baseUrl: newUrl.trim(),
            enabled: true,
            priority: Math.max(200, ...profiles.map((profile) => profile.priority + 10)),
        });
        if (result.ok) {
            setShowCreate(false);
            setNewName('');
            setNewUrl('');
            await loadProfiles();
            addNotification('Catalog source added.', 'success');
        } else {
            addNotification(result.error || 'Failed to add catalog source.', 'error');
        }
        setCreating(false);
    };

    const beginEdit = (profile: SourceProfile) => {
        setEditingId(profile.id);
        setEditName(profile.name);
        setEditUrl(profile.baseUrl);
        setEditPriority(profile.priority);
        setDeleteId(null);
    };

    const handleSave = async (profile: SourceProfile) => {
        setSavingId(profile.id);
        const official = profile.id === SourceProfileId.OfficialCatalog;
        const result = await updateSourceProfile(profile.id, {
            ...(!official ? { name: editName.trim(), baseUrl: editUrl.trim() } : {}),
            priority: editPriority,
        });
        if (result.ok) {
            setEditingId(null);
            await loadProfiles();
            addNotification('Catalog source updated.', 'success');
        } else {
            addNotification(result.error || 'Failed to update catalog source.', 'error');
        }
        setSavingId(null);
    };

    const handleToggle = async (profile: SourceProfile) => {
        const result = await updateSourceProfile(profile.id, { enabled: !profile.enabled });
        if (result.ok) await loadProfiles();
        else addNotification(result.error || 'Failed to update catalog source.', 'error');
    };

    const handleTest = async (profile: SourceProfile) => {
        setTestingId(profile.id);
        const result = await testSourceProfile(profile.id);
        if (result.ok && result.data) {
            addNotification(
                `${profile.name}: ${result.data.moduleCount ?? 0} modules (${result.data.state || 'ready'}).`,
                'success',
            );
        } else {
            addNotification(result.error || 'Catalog test failed.', 'error');
        }
        setTestingId(null);
    };

    const handleDelete = async (profile: SourceProfile) => {
        const result = await deleteSourceProfile(profile.id);
        if (result.ok) {
            setDeleteId(null);
            await loadProfiles();
            addNotification('Catalog source deleted.', 'success');
        } else {
            addNotification(result.error || 'Failed to delete catalog source.', 'error');
        }
    };

    const moveProfile = async (profile: SourceProfile, direction: -1 | 1) => {
        const movable = profiles
            .filter((candidate) => candidate.id !== SourceProfileId.LocalDefault)
            .sort((left, right) => left.priority - right.priority);
        const index = movable.findIndex((candidate) => candidate.id === profile.id);
        const other = movable[index + direction];
        if (!other) return;
        const first = await updateSourceProfile(profile.id, { priority: other.priority });
        const second = await updateSourceProfile(other.id, { priority: profile.priority });
        if (first.ok && second.ok) await loadProfiles();
        else addNotification(first.error || second.error || 'Failed to reorder catalog sources.', 'error');
    };

    if (loading && profiles.length === 0) {
        return <div className="p-4 text-sm text-[var(--admin-text-secondary)]">Loading catalog sources...</div>;
    }

    return (
        <div className="space-y-4 p-4">
            <div className="flex items-center justify-end gap-2">
                <Button size="sm" onClick={() => void loadProfiles()} disabled={loading} title="Refresh sources">
                    <RefreshCw className="mr-2 h-4 w-4" />
                    Refresh
                </Button>
                <Button
                    size="sm"
                    variant="primary"
                    onClick={() => setShowCreate((visible) => !visible)}
                >
                    <Plus className="mr-2 h-4 w-4" />
                    Add source
                </Button>
            </div>

            {error && <ErrorState message={error} />}

            {showCreate && (
                <div className="grid gap-3 border-y border-[var(--admin-border)] py-4 md:grid-cols-[1fr_2fr_auto]">
                    <input
                        className={INPUT_CLASS}
                        value={newName}
                        onChange={(event) => setNewName(event.target.value)}
                        placeholder="Catalog name"
                    />
                    <input
                        className={INPUT_CLASS}
                        value={newUrl}
                        onChange={(event) => setNewUrl(event.target.value)}
                        placeholder="https://example.org/catalog.json"
                        inputMode="url"
                    />
                    <Button
                        variant="primary"
                        onClick={() => void handleCreate()}
                        disabled={creating || !newName.trim() || !newUrl.trim()}
                    >
                        {creating ? 'Adding...' : 'Add'}
                    </Button>
                </div>
            )}

            <div className="space-y-2">
                {profiles.length === 0 && <EmptyState message="No catalog sources configured." />}
                {profiles.map((profile) => {
                    const local = profile.id === SourceProfileId.LocalDefault;
                    const official = profile.id === SourceProfileId.OfficialCatalog;
                    const editing = editingId === profile.id;
                    const movable = profiles
                        .filter((candidate) => candidate.id !== SourceProfileId.LocalDefault)
                        .sort((left, right) => left.priority - right.priority);
                    const moveIndex = movable.findIndex((candidate) => candidate.id === profile.id);

                    return (
                        <div key={profile.id} className="rounded-md border border-[var(--admin-border)] bg-[var(--admin-surface)] p-3">
                            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
                                <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="font-semibold text-[var(--admin-text-primary)]">{profile.name}</span>
                                        <span className="rounded border border-[var(--admin-border)] px-1.5 py-0.5 text-xs text-[var(--admin-text-muted)]">
                                            {local ? 'Development' : profile.trustTier || 'unverified'}
                                        </span>
                                        {!local && (
                                            profile.enabled
                                                ? <CircleCheck className="h-4 w-4 text-[var(--admin-success)]" aria-label="Enabled" />
                                                : <CircleX className="h-4 w-4 text-[var(--admin-text-muted)]" aria-label="Disabled" />
                                        )}
                                    </div>
                                    <div className="mt-1 break-all font-mono text-xs text-[var(--admin-text-muted)] sm:truncate">
                                        {profile.baseUrl}
                                    </div>
                                </div>

                                {!local && (
                                    <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
                                        <div className="flex items-center">
                                            <button
                                                type="button"
                                                onClick={() => void moveProfile(profile, -1)}
                                                disabled={moveIndex <= 0}
                                                className="p-1 text-[var(--admin-text-muted)] hover:text-[var(--admin-text-primary)] disabled:opacity-30"
                                                aria-label={`Move ${profile.name} up`}
                                                title="Move up"
                                            >
                                                <ChevronUp className="h-4 w-4" />
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => void moveProfile(profile, 1)}
                                                disabled={moveIndex < 0 || moveIndex >= movable.length - 1}
                                                className="p-1 text-[var(--admin-text-muted)] hover:text-[var(--admin-text-primary)] disabled:opacity-30"
                                                aria-label={`Move ${profile.name} down`}
                                                title="Move down"
                                            >
                                                <ChevronDown className="h-4 w-4" />
                                            </button>
                                        </div>
                                        {profile.enabled && profile.kind === ModuleSourceKind.Indexed && (
                                            <Button size="sm" onClick={() => void handleTest(profile)} disabled={testingId === profile.id}>
                                                {testingId === profile.id ? 'Testing...' : 'Test'}
                                            </Button>
                                        )}
                                        <Button size="sm" onClick={() => void handleToggle(profile)}>
                                            {profile.enabled ? 'Disable' : 'Enable'}
                                        </Button>
                                        <button
                                            type="button"
                                            onClick={() => editing ? setEditingId(null) : beginEdit(profile)}
                                            className="p-2 text-[var(--admin-text-secondary)] hover:text-[var(--admin-text-primary)]"
                                            aria-label={`Edit ${profile.name}`}
                                            title="Edit source"
                                        >
                                            <Pencil className="h-4 w-4" />
                                        </button>
                                        {!isProtected(profile) && (
                                            <button
                                                type="button"
                                                onClick={() => setDeleteId(deleteId === profile.id ? null : profile.id)}
                                                className="p-2 text-[var(--admin-danger-text)]"
                                                aria-label={`Delete ${profile.name}`}
                                                title="Delete source"
                                            >
                                                <Trash2 className="h-4 w-4" />
                                            </button>
                                        )}
                                    </div>
                                )}
                            </div>

                            {editing && (
                                <div className="mt-3 grid gap-3 border-t border-[var(--admin-border)] pt-3 md:grid-cols-[1fr_2fr_8rem_auto]">
                                    <input
                                        className={INPUT_CLASS}
                                        value={editName}
                                        onChange={(event) => setEditName(event.target.value)}
                                        disabled={official}
                                        aria-label="Catalog name"
                                    />
                                    <input
                                        className={INPUT_CLASS}
                                        value={editUrl}
                                        onChange={(event) => setEditUrl(event.target.value)}
                                        disabled={official}
                                        aria-label="Catalog URL"
                                    />
                                    <input
                                        className={INPUT_CLASS}
                                        type="number"
                                        min={0}
                                        step={1}
                                        value={editPriority}
                                        onChange={(event) => setEditPriority(Number(event.target.value))}
                                        aria-label="Catalog priority"
                                    />
                                    <Button
                                        variant="primary"
                                        onClick={() => void handleSave(profile)}
                                        disabled={savingId === profile.id}
                                    >
                                        {savingId === profile.id ? 'Saving...' : 'Save'}
                                    </Button>
                                </div>
                            )}

                            {deleteId === profile.id && (
                                <div className="mt-3 flex items-center justify-end gap-2 border-t border-[var(--admin-danger-border)] pt-3">
                                    <span className="mr-auto text-sm text-[var(--admin-danger-text)]">Delete {profile.name}?</span>
                                    <Button size="sm" onClick={() => setDeleteId(null)}>Cancel</Button>
                                    <Button size="sm" variant="danger" onClick={() => void handleDelete(profile)}>Delete</Button>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
