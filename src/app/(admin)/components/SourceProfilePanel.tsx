'use client';

import { useState, useEffect } from 'react';
import {
    fetchSourceProfiles,
    createSourceProfile,
    updateSourceProfile,
    deleteSourceProfile,
    testSourceProfile,
    type SourceProfile
} from '../lib/adminApi';

export default function SourceProfilePanel() {
    const [profiles, setProfiles] = useState<SourceProfile[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

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
                    <div key={profile.id} className="border border-[var(--admin-border)] rounded-xl p-4 bg-[var(--admin-surface)] flex flex-col md:flex-row md:items-center justify-between gap-4">
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
                                <button
                                    onClick={() => handleTest(profile.id)}
                                    className="px-3 py-1.5 border border-blue-200 bg-blue-50 text-blue-700 text-sm font-medium rounded hover:bg-blue-100 transition"
                                >
                                    Test Connection
                                </button>
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
                ))}
            </div>
        </div>
    );
}
