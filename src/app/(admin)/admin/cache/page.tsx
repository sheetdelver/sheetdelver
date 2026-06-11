'use client';

import PageHeading from '../../components/PageHeading';
import CacheInfoPanel from '../../components/CacheInfoPanel';

export default function AdminCachePage() {
    return (
        <>
            <PageHeading title="Cache" description="Persistent world/cache state." />
            <section className="admin-panel rounded-xl shadow-sm overflow-hidden">
                <CacheInfoPanel />
            </section>
        </>
    );
}
