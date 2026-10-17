'use client';

import PageHeading from '../../components/PageHeading';
import AuditLogViewer from '../../components/AuditLogViewer';
import ModuleUpgradeStatus from '../../components/ModuleUpgradeStatus';

export default function AdminAuditPage() {
    return (
        <>
            <PageHeading title="Audit Log" description="Recent privileged admin actions, newest first." />
            <ModuleUpgradeStatus />
            <section className="admin-panel rounded-xl shadow-sm overflow-hidden">
                <AuditLogViewer />
            </section>
        </>
    );
}
