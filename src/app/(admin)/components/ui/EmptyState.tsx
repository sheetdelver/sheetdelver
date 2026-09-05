'use client';

/** Shared empty-state block for admin panels (ADR-0030 UX-4). */

import React from 'react';

export default function EmptyState({
    message,
    action,
}: {
    message: string;
    action?: React.ReactNode;
}) {
    return (
        <div className="rounded-lg border border-dashed border-[var(--admin-border)] px-4 py-8 text-center">
            <p className="text-sm text-[var(--admin-text-muted)]">{message}</p>
            {action && <div className="mt-3 flex justify-center">{action}</div>}
        </div>
    );
}
