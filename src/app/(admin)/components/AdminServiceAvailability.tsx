'use client';

import type { ReactNode } from 'react';
import { useAdminMigration } from '../context/AdminMigrationContext';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';

/** Keep the normal admin page, without mounting clients of stopped services. */
export default function AdminServiceAvailability({ children, feature }: { children: ReactNode; feature: string }) {
    const { data, error, loading, refresh } = useAdminMigration();
    if (!data) return <div className="p-4" role="status">
        <EmptyState message={error ?? 'Checking service availability…'} action={error && <Button disabled={loading} onClick={() => void refresh()}>Retry</Button>} />
    </div>;
    if (data.maintenance) return <div className="p-4" role="status">
        <EmptyState message={`${feature} is unavailable during maintenance`} />
    </div>;
    return children;
}
