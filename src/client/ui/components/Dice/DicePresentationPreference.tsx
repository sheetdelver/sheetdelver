'use client';

import { useDicePresentation } from '../../context/DicePresentationContext';

export function DicePresentationPreference() {
    const { enabled, setEnabled } = useDicePresentation();
    return <label className="flex items-center gap-2 text-sm text-inherit">
        <input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />
        3D dice
    </label>;
}
