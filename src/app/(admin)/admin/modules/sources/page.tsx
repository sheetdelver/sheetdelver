import { redirect } from 'next/navigation';

export default function AdminSourcesPage() {
    // Preserve old bookmarks without reintroducing dormant distribution UI.
    redirect('/admin/modules');
}
