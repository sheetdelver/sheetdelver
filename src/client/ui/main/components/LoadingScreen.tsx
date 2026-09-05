import React from 'react';
import LoadingModal from '@client/ui/components/LoadingModal';
import type { AppSystemInfo, ConnectionStep } from '@shared/interfaces';
import { Theme } from '../hooks/useTheme';

interface LoadingScreenProps {
    step: ConnectionStep;
    system: AppSystemInfo | null;
    theme: Theme;
}

export const LoadingScreen = ({ step, system, theme }: LoadingScreenProps) => {
    return (
        <>
            <LoadingModal
                message="Initializing"
                visible={step === 'init'}
                theme={system?.componentStyles?.loadingModal}
            />

            <LoadingModal
                message="Authenticating..."
                visible={step === 'authenticating'}
                theme={system?.componentStyles?.loadingModal}
            />

            <LoadingModal
                message="Logging out..."
                visible={step === 'logging-out'}
                theme={system?.componentStyles?.loadingModal}
            />

            <LoadingModal
                message="Booting System..."
                submessage="Warming up Compendium Cache"
                visible={step === 'initializing'}
                theme={{
                    ...system?.componentStyles?.loadingModal,
                    spinner: "w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"
                }}
            />

            <LoadingModal
                message="World Starting..."
                submessage="Please wait while the world launches"
                visible={step === 'startup'}
                theme={{
                    ...system?.componentStyles?.loadingModal,
                    spinner: "w-12 h-12 border-4 border-green-500 border-t-transparent rounded-full animate-spin"
                }}
            />
        </>
    );
};
