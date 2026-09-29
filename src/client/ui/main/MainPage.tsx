'use client';

import { useState } from 'react';
import { useFoundry } from '@client/ui/context/FoundryContext';
import { useActorCombat } from '@client/ui/context/ActorCombatContext';
import { useSession } from '@client/ui/context/SessionContext';
import { useConfig } from '@client/ui/context/ConfigContext';
import { useTheme } from './hooks/useTheme';
import { LoginView } from './views/LoginView';
import { SetupView } from './views/SetupView';
import { DashboardView } from './views/DashboardView';
import { WorldClosedView } from './views/WorldClosedView';
import { LoadingScreen } from './components/LoadingScreen';
import LoadingModal from '@client/ui/components/LoadingModal';

interface MainPageProps {
    initialUrl: string;
}

export default function MainPage({ initialUrl }: MainPageProps) {
    const {
        step,
        users,
        system,
        currentUser,
        handleLogin: globalLogin,
        appVersion
    } = useFoundry();

    const { fetchActors, ownedActors } = useActorCombat();
    const { token } = useSession();

    const { foundryUrl: configUrl } = useConfig();
    const { theme: moduleTheme, bgStyle } = useTheme();

    const [loading, setLoading] = useState(false);
    const [loginMessage, setLoginMessage] = useState('');

    const handleLogin = async (user: string, pass: string) => {
        setLoading(true);
        setLoginMessage('Logging in...');
        try {
            await globalLogin(user, pass);
        } catch (e) {
            // Password clear handled by view state reset if needed
        } finally {
            setLoading(false);
            setLoginMessage('');
        }
    };

    return (
        <main
            className="sd-ui-page p-4 sm:p-8 font-sans transition-colors duration-500 flex flex-col"
            style={bgStyle}
            data-step={step}
            data-loading={loading}
        >
            <LoadingScreen step={step} system={system} />

            {step === 'login' && (
                <LoginView
                    users={users}
                    system={system}
                    onLogin={handleLogin}
                    loading={loading}
                />
            )}

            {step === 'setup' && <SetupView appVersion={appVersion || ''} />}

            {step === 'world-closed' && (
                <WorldClosedView system={system} appVersion={appVersion || ''} />
            )}

            {step === 'dashboard' && (
                <DashboardView
                    system={system}
                    user={users.find(u => (u._id || u.id) === (currentUser?._id || currentUser?.id)) || null}
                    ownedActors={ownedActors}
                    token={token}
                    moduleTheme={moduleTheme}
                    configUrl={configUrl || ''}
                    appVersion={appVersion || ''}
                    fetchActors={fetchActors}
                    setLoading={setLoading}
                    setLoginMessage={setLoginMessage}
                />
            )}

            <LoadingModal
                message={loginMessage}
                visible={loading && !!loginMessage}
                theme={system?.componentStyles?.loadingModal}
            />
        </main>
    );
}
