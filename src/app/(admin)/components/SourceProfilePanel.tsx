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

export default function SourceProfilePanel({ 
    onModuleInstalled,
    installedModules = []
}: { 
    onModuleInstalled?: () => void;
    installedModules?: any[];
}) {
    const [profiles, setProfiles] = useState<SourceProfile[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [browsingId, setBrowsingId] = useState<string | null>(null);
    const [sourceModules, setSourceModules] = useState<Record<string, SourceModuleEntry> | null>(null);
    const [browseLoading, setBrowseLoading] = useState(false);
    const [installingId, setInstallingId] = useState<string | null>(null);

    const loadProfiles = async () => {
        setLoading(true);
        const result = await fetchSourceProfiles();
        if (result.ok && result.data?.profiles) {
            setProfiles(result.data.profiles);
            setError(null);
        } else {
            setError(result.error || 'Failed to load source profiles');
        }
        setLoading(false);
    };

    useEffect(() => {
        loadProfiles();
    }, []);

    const handleCreate = async () => {
        const url = prompt('Enter Source HTTP URL (e.g., https://my-registry.com):');
        if (!url) return;
        const name = prompt('Enter Source Name:', 'New Source') || 'New Source';

        const result = await createSourceProfile({
            name,
            baseUrl: url,
            kind: url.startsWith('index://') || url.startsWith('http') ? 'indexed' : 'local',
            enabled: true,
            priority: profiles.length > 0 ? profiles[profiles.length - 1].priority + 10 : 10
        });
        if (result.ok) {
            loadProfiles();
        } else {
            alert(`Error: ${result.error}`);
        }
    };

    const handleToggleEnable = async (profile: SourceProfile) => {
        if (profile.id === 'built-in') return;
        const result = await updateSourceProfile(profile.id, { enabled: !profile.enabled });
        if (result.ok) loadProfiles();
        else alert(`Error: ${result.error}`);
    };

    const handleDelete = async (id: string) => {
        if (id === 'built-in') return;
        if (!confirm('Are you sure you want to delete this source profile?')) return;
        const result = await deleteSourceProfile(id);
        if (result.ok) loadProfiles();
        else alert(`Error: ${result.error}`);
    };

    const handleTest = async (id: string) => {
        const result = await testSourceProfile(id);
        if (result.ok) {
            alert(`Success! Found ${result.data?.moduleCount} modules.\nPublisher: ${result.data?.publisher || 'Unknown'}`);
        } else {
            alert(`Failed: ${result.error} (${result.data?.errorCode})`);
        }
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
            alert(`Failed to load modules: ${result.error}`);
            setBrowsingId(null);
        }
        setBrowseLoading(false);
    };

    const handleInstall = async (moduleId: string) => {
        setInstallingId(moduleId);
        try {
            const result = await postManagerAction(moduleId, 'install', { source: 'index://' });
            if (result.ok) {
                if (onModuleInstalled) onModuleInstalled();
            } else {
                alert(`Install failed: ${result.error}`);
            }
        } catch (err: any) {
            alert(`Install failed: ${err.message}`);
        } finally {
            setInstallingId(null);
        }
    };

    if (loading) return <div className="p-4 text-[var(--admin-text-secondary)]">Loading source profiles...</div>;
    if (error) return <div className="p-4 text-[var(--admin-danger-text)] bg-[var(--admin-danger-bg)] rounded-xl">{error}</div>;

    return (
        <div className="space-y-4">
            <div className="flex justify-between items-center px-2">
                <p className="text-sm text-[var(--admin-text-secondary)]">
                    Configure where the manager discovers modules.
                </p>
                <button
                    onClick={handleCreate}
                    className="px-3 py-1.5 bg-blue-600 text-white text-sm font-semibold rounded hover:bg-blue-700 transition shadow"
                >
                    + Add Source
                </button>
            </div>

            <div className="grid gap-4">
                {profiles.map(profile => (
                    <div key={profile.id} className="border border-[var(--admin-border)] rounded-xl bg-[var(--admin-surface)] overflow-hidden">
                        <div className="p-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
                            <div className="flex-1">
                                <div className="flex items-center gap-2 mb-1">
                                    <h3 className="font-bold text-[var(--admin-text-primary)]">{profile.name}</h3>
                                    {profile.id === 'built-in' && (
                                        <span className="px-2 py-0.5 bg-gray-200 text-gray-700 text-xs rounded-full font-medium">Built-in</span>
                                    )}
                                    {!profile.enabled && (
                                        <span className="px-2 py-0.5 bg-red-100 text-red-700 text-xs rounded-full font-medium">Disabled</span>
                                    )}
                                </div>
                                <div className="text-sm text-[var(--admin-text-secondary)] break-all font-mono bg-[var(--admin-surface-hover)] p-1.5 rounded inline-block">
                                    {profile.baseUrl}
                                </div>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                                {profile.kind === 'indexed' && profile.enabled && (
                                    <>
                                        <button
                                            onClick={() => handleBrowse(profile.id)}
                                            className="px-3 py-1.5 border border-purple-200 bg-purple-50 text-purple-700 text-sm font-medium rounded hover:bg-purple-100 transition"
                                        >
                                            {browsingId === profile.id ? 'Close' : 'Browse'}
                                        </button>
                                        <button
                                            onClick={() => handleTest(profile.id)}
                                            className="px-3 py-1.5 border border-blue-200 bg-blue-50 text-blue-700 text-sm font-medium rounded hover:bg-blue-100 transition"
                                        >
                                            Test
                                        </button>
                                    </>
                                )}
                                {profile.id !== 'built-in' && (
                                    <>
                                        <button
                                            onClick={() => handleToggleEnable(profile)}
                                            className={`px-3 py-1.5 text-sm font-medium rounded transition border ${profile.enabled ? 'bg-orange-50 text-orange-700 border-orange-200 hover:bg-orange-100' : 'bg-green-50 text-green-700 border-green-200 hover:bg-green-100'}`}
                                        >
                                            {profile.enabled ? 'Disable' : 'Enable'}
                                        </button>
                                        <button
                                            onClick={() => handleDelete(profile.id)}
                                            className="px-3 py-1.5 border border-red-200 bg-red-50 text-red-700 text-sm font-medium rounded hover:bg-red-100 transition"
                                        >
                                            Delete
                                        </button>
                                    </>
                                )}
                            </div>
                        </div>

                        {/* Module Browser Expansion */}
                        {browsingId === profile.id && (
                            <div className="border-t border-[var(--admin-border)] bg-[var(--admin-surface-hover)] p-4">
                                {browseLoading ? (
                                    <div className="text-sm text-[var(--admin-text-secondary)]">Loading modules...</div>
                                ) : sourceModules ? (
                                    Object.keys(sourceModules).length > 0 ? (
                                        <div className="space-y-3">
                                            <h4 className="text-xs font-bold uppercase text-[var(--admin-text-muted)] tracking-wider">Available Modules</h4>
                                            {Object.entries(sourceModules).map(([modId, modInfo]) => (
                                                <div key={modId} className="flex items-center justify-between bg-[var(--admin-surface)] p-3 rounded-xl border border-[var(--admin-border)] shadow-sm">
                                                    <div>
                                                        <div className="font-bold text-[var(--admin-text-primary)] text-sm">{modInfo.title || modId}</div>
                                                        <div className="text-xs text-[var(--admin-text-secondary)] font-mono">{modId} @ {modInfo.latestVersion}</div>
                                                    </div>
                                                    <button
                                                        onClick={() => handleInstall(modId)}
                                                        disabled={installingId === modId}
                                                        className={`px-3 py-1.5 text-xs font-bold rounded-lg transition disabled:opacity-50 ${
                                                            (() => {
                                                                const installed = installedModules.find(m => m.moduleId === modId);
                                                                const artifact = installed?.artifact;
                                                                // Local dev module (no artifact) → treat as fresh install
                                                                if (!artifact) return 'bg-[var(--admin-accent)] hover:bg-[var(--admin-accent-strong)] text-white';
                                                                if (artifact.version !== modInfo.latestVersion) return 'bg-orange-600 hover:bg-orange-700 text-white';
                                                                return 'bg-gray-600 hover:bg-gray-700 text-white';
                                                            })()
                                                        }`}
                                                    >
                                                        {(() => {
                                                            const installed = installedModules.find(m => m.moduleId === modId);
                                                            if (installingId === modId) return 'Installing...';
                                                            // Not known, or known but no managed artifact (local dev module)
                                                            if (!installed || !installed.artifact) return 'Install';
                                                            const currentVersion = installed.artifact.version;
                                                            if (currentVersion && modInfo.latestVersion && currentVersion !== modInfo.latestVersion) {
                                                                return 'Update';
                                                            }
                                                            return 'Re-install';
                                                        })()}
                                                    </button>
                                                </div>
                                            ))}
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
