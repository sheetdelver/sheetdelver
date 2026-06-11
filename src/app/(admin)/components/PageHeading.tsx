import React from 'react';

/** Standard page-level heading for admin route segments (ADR-0030 UX-3). */
export default function PageHeading({ title, description }: { title: string; description?: string }) {
    return (
        <div className="mb-6">
            <h1 className="text-3xl font-bold tracking-tight text-[var(--admin-text-primary)]">{title}</h1>
            {description && <p className="mt-1 text-[var(--admin-text-secondary)]">{description}</p>}
        </div>
    );
}
