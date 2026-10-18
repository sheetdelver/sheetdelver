import PageHeading from '../../../components/PageHeading';
import AdminServiceAvailability from '../../../components/AdminServiceAvailability';
import CatalogModulePanel from '../../../components/CatalogModulePanel';

export default function AdminModuleUpdatesPage() {
    return (
        <>
            <PageHeading title="Modules - Updates" description="Release changes from each managed module's recorded catalog source." />
            <section className="admin-panel overflow-hidden rounded-lg shadow-sm">
                <AdminServiceAvailability feature="Module update checks">
                    <CatalogModulePanel mode="updates" />
                </AdminServiceAvailability>
            </section>
        </>
    );
}
