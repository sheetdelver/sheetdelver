'use client';

import PageHeading from '../../components/PageHeading';
import AdminServiceAvailability from '../../components/AdminServiceAvailability';
import CacheInfoPanel from '../../components/CacheInfoPanel';

export default function AdminCachePage() {
    return (
        <>
            <PageHeading title="Cache" description="Persistent world/cache state." />
            <section className="admin-panel rounded-xl shadow-sm overflow-hidden">
                <AdminServiceAvailability feature="Cache inspection">
                    <CacheInfoPanel />
                </AdminServiceAvailability>
            </section>
        </>
    );
}
