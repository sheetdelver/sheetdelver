'use client';

import { Settings } from 'lucide-react';
import { useUI } from '../../context/UIContext';

export function PlayerSettingsButton({ className }: { className?: string }) {
    const { setSettingsOpen } = useUI();
    return <button type="button" className={className} onClick={() => setSettingsOpen(true)}
        title="Settings" aria-label="Settings" aria-haspopup="dialog">
        <Settings className="w-6 h-6" size={24} aria-hidden="true" />
    </button>;
}
