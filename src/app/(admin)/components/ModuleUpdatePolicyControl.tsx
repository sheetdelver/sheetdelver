'use client';

import { useEffect, useState } from 'react';
import { Lock, Pin } from 'lucide-react';
import { updateModuleUpdatePolicy, type ModuleLifecycleInfo } from '../lib/adminApi';
import { useAdminNotifications } from '../context/AdminNotificationContext';
import Button from './ui/Button';

export default function ModuleUpdatePolicyControl({
    module,
    onChanged,
    onSessionExpired,
}: {
    module: ModuleLifecycleInfo;
    onChanged: () => void;
    onSessionExpired: () => void;
}) {
    const { addNotification } = useAdminNotifications();
    const policy = module.artifact?.updatePolicy || { locked: false };
    const [locked, setLocked] = useState(policy.locked);
    const [pinnedVersion, setPinnedVersion] = useState(policy.pinnedVersion || '');
    const [savingLock, setSavingLock] = useState(false);
    const [savingPin, setSavingPin] = useState(false);

    useEffect(() => {
        setLocked(policy.locked);
        setPinnedVersion(policy.pinnedVersion || '');
    }, [policy.locked, policy.pinnedVersion]);

    const update = async (updates: { locked?: boolean; pinnedVersion?: string | null }) => {
        const result = await updateModuleUpdatePolicy(module.moduleId, updates);
        if (result.sessionExpired) {
            onSessionExpired();
            return false;
        }
        if (!result.ok || !result.data) {
            addNotification(result.error || 'Failed to update module policy.', 'error');
            return false;
        }
        setLocked(result.data.updatePolicy.locked);
        setPinnedVersion(result.data.updatePolicy.pinnedVersion || '');
        onChanged();
        return true;
    };

    const toggleLock = async () => {
        const next = !locked;
        setSavingLock(true);
        if (await update({ locked: next })) {
            addNotification(next ? 'Module locked.' : 'Module unlocked.', 'success');
        }
        setSavingLock(false);
    };

    const savePin = async () => {
        setSavingPin(true);
        const value = pinnedVersion.trim();
        if (await update({ pinnedVersion: value || null })) {
            addNotification(value ? `Module pinned to v${value}.` : 'Version pin cleared.', 'success');
        }
        setSavingPin(false);
    };

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
                <Lock className="h-4 w-4 text-[var(--admin-text-muted)]" />
                <label className="flex cursor-pointer items-center gap-2 text-sm text-[var(--admin-text-primary)]">
                    <input
                        type="checkbox"
                        checked={locked}
                        disabled={savingLock}
                        onChange={() => void toggleLock()}
                    />
                    Lock managed module
                </label>
            </div>
            <div className="flex flex-wrap items-center gap-2">
                <Pin className="h-4 w-4 text-[var(--admin-text-muted)]" />
                <input
                    value={pinnedVersion}
                    onChange={(event) => setPinnedVersion(event.target.value)}
                    placeholder="Exact version"
                    aria-label="Pinned module version"
                    className="min-w-0 flex-1 rounded-md border border-[var(--admin-border)] bg-[var(--admin-bg)] px-3 py-1.5 text-sm text-[var(--admin-text-primary)]"
                />
                <Button size="sm" onClick={() => setPinnedVersion(module.artifact?.version || '')}>
                    Current
                </Button>
                <Button
                    size="sm"
                    variant="primary"
                    onClick={() => void savePin()}
                    disabled={savingPin || pinnedVersion.trim() === (policy.pinnedVersion || '')}
                >
                    {savingPin ? 'Saving...' : 'Save pin'}
                </Button>
            </div>
        </div>
    );
}
