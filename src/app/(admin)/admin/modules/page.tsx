'use client';

import PageHeading from '../../components/PageHeading';
import ModuleLifecycleControl from '../../components/ModuleLifecycleControl';
import OrphanTokenCleanup from '../../components/OrphanTokenCleanup';
import ModuleUpgradeStatus from '../../components/ModuleUpgradeStatus';
import { Suspense } from 'react';
import MaintenanceControlPanel from '../../components/MaintenanceControlPanel';
import { useAdminMigration } from '../../context/AdminMigrationContext';
import { InstalledMigrationStatus } from '../../components/MigrationAttentionNotice';

export default function AdminModulesPage() {
    const { data } = useAdminMigration();
    return (
        <>
            <PageHeading title="Modules - Installed" description="Lifecycle state of installed system modules." />
            <InstalledMigrationStatus />
            {data?.maintenance ? <MaintenanceControlPanel /> : data ? <>
                <ModuleUpgradeStatus diagnosticsOnly />
                <OrphanTokenCleanup />
                <section className="admin-panel rounded-xl shadow-sm overflow-hidden">
                    <Suspense fallback={<p className="p-4">Loading exact source selection…</p>}><ModuleLifecycleControl /></Suspense>
                </section>
            </> : null}
        </>
    );
}
