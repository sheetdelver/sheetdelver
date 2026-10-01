import { useFoundry } from '@client/ui/context/FoundryContext';

export const useWorldBackground = () => {
    const { system, step } = useFoundry();

    // World metadata may outlive the lifecycle transition while caches clear.
    // Retire its artwork in the same render as the unavailable-world screen.
    const showWorldBackground = system?.status === 'active' &&
        (step === 'login' || step === 'dashboard' || step === 'authenticating' || step === 'logging-out');
    const bgSrc = showWorldBackground ? (system?.worldBackground || system?.background) : null;

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
