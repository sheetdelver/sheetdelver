'use client';

import PageHeading from '../../components/PageHeading';
import AuditLogViewer from '../../components/AuditLogViewer';

export default function AdminAuditPage() {
    return (
        <>
            <PageHeading title="Audit Log" description="Recent privileged admin actions, newest first." />
            <section className="admin-panel rounded-xl shadow-sm overflow-hidden">
                <AuditLogViewer />
            </section>
        </>
    );
}
