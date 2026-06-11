'use client';

/**
 * Admin Overview (route: /admin)
 *
 * Landing page of the admin control plane — system and world status at a glance.
 * Navigation, auth gating, and global chrome live in the shell layout
 * (`(admin)/admin/layout.tsx`); this page renders only its content (ADR-0030 UX-3).
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
