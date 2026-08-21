import { redirect } from 'next/navigation';

export default function AdminSourcesPage() {
    // Preserve old bookmarks without exposing controls for the dormant remote
    // distribution capability described by ADR-0033.
    redirect('/admin/modules');
}
