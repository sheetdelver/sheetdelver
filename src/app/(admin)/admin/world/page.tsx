'use client';

import PageHeading from '../../components/PageHeading';
import AdminServiceAvailability from '../../components/AdminServiceAvailability';
import WorldManagementPanel from '../../components/WorldManagementPanel';

export default function AdminWorldPage() {
    return (
        <>
            <PageHeading title="World Management" description="Launch, shut down, and reconnect the Foundry world." />
            <section className="admin-panel rounded-xl shadow-sm overflow-hidden">
                <AdminServiceAvailability feature="World management">
                    <WorldManagementPanel />
                </AdminServiceAvailability>
            </section>
        </>
    );
}
