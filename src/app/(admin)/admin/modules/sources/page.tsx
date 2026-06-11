'use client';

import PageHeading from '../../../components/PageHeading';
import SourceProfilePanel from '../../../components/SourceProfilePanel';

export default function AdminSourcesPage() {
    return (
        <>
            <PageHeading title="Modules — Sources" description="Configure where the manager discovers and installs modules." />
            <section className="admin-panel rounded-xl shadow-sm overflow-hidden">
                <div className="p-2">
                    <SourceProfilePanel />
                </div>
            </section>
        </>
    );
}
