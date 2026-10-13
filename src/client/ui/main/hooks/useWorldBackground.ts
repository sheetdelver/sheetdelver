import { useEffect, useState } from 'react';
import { useFoundry } from '@client/ui/context/FoundryContext';

export const useWorldBackground = () => {
    const { system, step, worldId } = useFoundry();

    // World metadata may outlive the lifecycle transition while caches clear.
    // Retire its artwork in the same render as the unavailable-world screen.
    const showWorldBackground = system?.status === 'active' &&
        (step === 'login' || step === 'dashboard' || step === 'authenticating' || step === 'logging-out');
    const worldArt = showWorldBackground ? system?.worldBackground || null : null;
    const foundryDefault = showWorldBackground ? system?.coreFallbackBackground || null : null;
    const sourceKey = showWorldBackground ? JSON.stringify([worldId, worldArt, foundryDefault]) : '';
    const [loaded, setLoaded] = useState<{ key: string; url: string } | null>(null);

    useEffect(() => {
        if (!sourceKey) return;
        let cancelled = false;
        const tryLoad = (url: string | null, fallback: string | null) => {
            if (!url) { setLoaded(null); return; }
            const image = new Image();
            image.onload = () => { if (!cancelled) setLoaded({ key: sourceKey, url }); };
            image.onerror = () => {
                if (!cancelled) tryLoad(fallback && fallback !== url ? fallback : null, null);
            };
            image.src = url;
        };
        tryLoad(worldArt || foundryDefault, worldArt ? foundryDefault : null);
        return () => { cancelled = true; };
    }, [sourceKey, worldArt, foundryDefault]);

    const bgSrc = loaded?.key === sourceKey ? loaded.url : null;

    const bgStyle = bgSrc
        ? {
            backgroundImage: `linear-gradient(var(--sd-ui-image-scrim), var(--sd-ui-image-scrim)), url(${bgSrc})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat'
        }
        : { backgroundImage: 'none' };

    return bgStyle;
};
