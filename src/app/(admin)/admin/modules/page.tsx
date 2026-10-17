'use client';

import PageHeading from '../../components/PageHeading';
import ModuleLifecycleControl from '../../components/ModuleLifecycleControl';
import ModuleUpgradeStatus from '../../components/ModuleUpgradeStatus';
import { Suspense } from 'react';
import { InstalledMigrationStatus } from '../../components/MigrationAttentionNotice';

export default function AdminModulesPage() {
    return (
        <>
            <PageHeading title="Modules - Installed" description="Lifecycle state of installed system modules." />
            <InstalledMigrationStatus />
            <ModuleUpgradeStatus diagnosticsOnly />
            <section className="admin-panel rounded-xl shadow-sm overflow-hidden">
                <Suspense fallback={<p className="p-4">Loading exact source selection…</p>}><ModuleLifecycleControl /></Suspense>
            </section>
        </>
    );
}
