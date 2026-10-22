'use client';

import type { CSSProperties, ReactNode } from 'react';
import { useWorldBackground } from '@client/ui/main/hooks/useWorldBackground';

/** One image owner for every current and future route beneath the player layout. */
export function PlayerPageBackground({ children }: { children: ReactNode }) {
    const { backgroundImage } = useWorldBackground();
    return (
        <div className="sd-ui-page" data-sd-player-background style={{
            '--sd-world-background-image': backgroundImage,
        } as CSSProperties}>
            {children}
        </div>
    );
}
