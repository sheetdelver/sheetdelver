import PageHeading from '../../../components/PageHeading';
import AdminServiceAvailability from '../../../components/AdminServiceAvailability';
import CatalogModulePanel from '../../../components/CatalogModulePanel';

export default function AdminAvailableModulesPage() {
    return (
        <>
            <PageHeading title="Modules - Available" description="Modules published by enabled public catalogs." />
            <section className="admin-panel overflow-hidden rounded-lg shadow-sm">
                <AdminServiceAvailability feature="Module discovery">
                    <CatalogModulePanel mode="available" />
                </AdminServiceAvailability>
            </section>
        </>
    );
}
