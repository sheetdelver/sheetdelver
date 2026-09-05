'use client';

import PageHeading from '../../components/PageHeading';
import ModuleLifecycleControl from '../../components/ModuleLifecycleControl';

export default function AdminModulesPage() {
    return (
        <>
            <PageHeading title="Modules - Installed" description="Lifecycle state of installed system modules." />
            <section className="admin-panel rounded-xl shadow-sm overflow-hidden">
                <ModuleLifecycleControl />
            </section>
        </>
    );
}
