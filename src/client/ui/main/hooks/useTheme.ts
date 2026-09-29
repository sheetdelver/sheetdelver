import { useFoundry } from '@client/ui/context/FoundryContext';

export interface Theme {
    bg: string;
    panelBg: string;
    text: string;
    accent: string;
    button: string;
    headerFont: string;
    input: string;
    success: string;
}

const defaultTheme: Theme = {
    bg: 'bg-slate-900',
    panelBg: 'bg-slate-800',
    text: 'text-slate-100',
    accent: 'text-amber-500',
    button: 'bg-amber-600 hover:bg-amber-700',
    headerFont: 'font-sans font-bold',
    input: 'bg-slate-700 border-slate-600 focus:border-amber-500',
    success: 'bg-green-600 hover:bg-green-700'
};

export const useTheme = () => {
    const { system, step } = useFoundry();

    const theme: Theme = system?.theme || defaultTheme;

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

    return { theme, bgStyle };
};
