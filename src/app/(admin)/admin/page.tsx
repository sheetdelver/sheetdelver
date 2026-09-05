'use client';

/**
 * Admin Overview (route: /admin)
 *
 * Navigation, authentication gating, and persistent chrome live in the admin
 * layout; this page renders only system/world overview content.
 */

import PageHeading from '../components/PageHeading';
import SystemInfoCard from '../components/SystemInfoCard';

export default function AdminOverviewPage() {
    return (
        <>
            <PageHeading title="Overview" description="System and world status at a glance." />
            <section className="admin-panel rounded-xl p-6 shadow-sm">
                <SystemInfoCard />
            </section>
        </>
    );
}
