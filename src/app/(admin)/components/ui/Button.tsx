'use client';

/**
 * Button — shared admin button primitive (ADR-0030 UX-4).
 *
 * Centralizes radius, padding, disabled, and focus-ring styling so panels stop
 * hand-rolling button classes (which had drifted across `rounded-xl`/`2xl`/`full`
 * and varied padding). Backed by the `--admin-*` tokens.
 */

import React from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
type Size = 'sm' | 'md';

const VARIANTS: Record<Variant, string> = {
    primary: 'bg-[var(--admin-accent)] text-white hover:bg-[var(--admin-accent-strong)] disabled:bg-[var(--admin-accent-soft)]',
    secondary: 'border border-[var(--admin-border-strong)] bg-[var(--admin-surface)] text-[var(--admin-text-primary)] hover:bg-[var(--admin-surface-hover)]',
    danger: 'bg-[var(--admin-danger-button)] text-white hover:bg-[var(--admin-danger-button-strong)] disabled:bg-[var(--admin-danger-button-soft)]',
    ghost: 'text-[var(--admin-text-secondary)] hover:bg-[var(--admin-surface-hover)]',
};

const SIZES: Record<Size, string> = {
    sm: 'px-3 py-1.5 text-sm',
    md: 'px-4 py-2 text-sm font-semibold',
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: Variant;
    size?: Size;
}

export default function Button({
    variant = 'secondary',
    size = 'md',
    className = '',
    ...props
}: ButtonProps) {
    return (
        <button
            {...props}
            className={[
                'rounded-md font-medium transition',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--admin-accent-soft)]',
                'disabled:cursor-not-allowed disabled:opacity-60',
                VARIANTS[variant],
                SIZES[size],
                className,
            ].join(' ')}
        />
    );
}
