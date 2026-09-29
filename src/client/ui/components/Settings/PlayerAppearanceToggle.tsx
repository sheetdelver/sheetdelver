'use client';

import { Moon, Sun } from 'lucide-react';
import { usePlayerAppearance } from '../../context/PlayerAppearanceContext';

export function PlayerAppearanceToggle() {
    const { appearance, setAppearance } = usePlayerAppearance();
    const nextAppearance = appearance === 'dark' ? 'light' : 'dark';
    const Icon = nextAppearance === 'light' ? Sun : Moon;

    return (
        <button
            type="button"
            className="sd-ui-button inline-flex min-h-10 items-center justify-center gap-2 px-3 py-2 text-sm"
            aria-label={`Switch to ${nextAppearance} mode`}
            onClick={() => setAppearance(nextAppearance)}
        >
            <Icon size={16} aria-hidden="true" />
            {nextAppearance === 'light' ? 'Light mode' : 'Dark mode'}
        </button>
    );
}
