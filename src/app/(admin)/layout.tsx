import type { Metadata } from 'next';
import AdminProviders from './components/AdminProviders';

/** SEO metadata for the admin panel. */
export const metadata: Metadata = {
    title: 'Admin Dashboard | SheetDelver',
    description: 'System administration panel for SheetDelver - manage modules, worlds, and system operations.',
};

/**
 * Route-group layout keeps admin auth/theme providers scoped to /admin while
 * the sibling player layout owns sockets, HUDs, and Foundry session runtime.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
    return (
        <AdminProviders>
            <div>{children}</div>
        </AdminProviders>
    );
}
