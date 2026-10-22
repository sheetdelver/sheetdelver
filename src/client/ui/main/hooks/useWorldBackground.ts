import { useEffect, useState } from 'react';
import { useFoundry } from '@client/ui/context/FoundryContext';

export const useWorldBackground = () => {
    const { system, step, worldId } = useFoundry();

    // World metadata may outlive the lifecycle transition while caches clear.
    // Retire its artwork in the same render as the unavailable-world screen.
    const showWorldBackground = system?.status === 'active' &&
        (step === 'login' || step === 'dashboard' || step === 'authenticating' || step === 'logging-out');
    const worldArt = showWorldBackground ? system?.worldBackground || null : null;
    const sourceKey = showWorldBackground ? JSON.stringify([worldId, worldArt]) : '';
    const [loaded, setLoaded] = useState<{ key: string; url: string } | null>(null);

    useEffect(() => {
        if (!sourceKey) return;
        let cancelled = false;
        if (!worldArt) { setLoaded(null); return; }
        const image = new Image();
        image.onload = () => { if (!cancelled) setLoaded({ key: sourceKey, url: worldArt }); };
        image.onerror = () => { if (!cancelled) setLoaded(null); };
        image.src = worldArt;
        return () => { cancelled = true; };
    }, [sourceKey, worldArt]);

    const bgSrc = loaded?.key === sourceKey ? loaded.url : null;

    const bgStyle = bgSrc
        ? {
            backgroundImage: `linear-gradient(var(--sd-ui-image-scrim), var(--sd-ui-image-scrim)), url(${bgSrc})`
        }
        : { backgroundImage: 'none' };

    return bgStyle;
};
