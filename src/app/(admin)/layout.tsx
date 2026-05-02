import type { Metadata } from 'next';
import AdminProviders from './components/AdminProviders';

/** SEO metadata for the admin panel. */
export const metadata: Metadata = {
    title: 'Admin Dashboard | SheetDelver',
    description: 'System administration panel for SheetDelver — manage modules, worlds, and system operations.',
};

/**
 * Admin Layout
 *
 * Root layout for the /admin route group. Wraps all admin pages
 * with the AdminProviders context (auth + theme).
 */
export default function AdminLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <AdminProviders>
            <div>
                {children}
            </div>
        </AdminProviders>
    );
}
