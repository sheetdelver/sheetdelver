'use client';

/** Shared error block for admin panels (ADR-0030 UX-4). */

import React from 'react';

export default function ErrorState({
    message,
    className = '',
}: {
    message: string;
    className?: string;
}) {
    return (
        <div
            role="alert"
            className={`rounded-lg border border-[var(--admin-danger-border)] bg-[var(--admin-danger-bg)] p-3 text-sm text-[var(--admin-danger-text)] ${className}`}
        >
            {message}
        </div>
    );
}
