'use client';

import { useState } from 'react';
import { useFoundry } from '@client/ui/context/FoundryContext';
import { useActorCombat } from '@client/ui/context/ActorCombatContext';
import { useConfig } from '@client/ui/context/ConfigContext';
import { useWorldBackground } from './hooks/useWorldBackground';
import { DashboardView } from './views/DashboardView';
import LoadingModal from '@client/ui/components/LoadingModal';

export default function MainPage() {
    const {
        users,
        system,
        currentUser,
        appVersion
    } = useFoundry();

    const { fetchActors, ownedActors } = useActorCombat();
    const { token } = useFoundry();

    const { foundryUrl: configUrl } = useConfig();
    const bgStyle = useWorldBackground();

    const [loading, setLoading] = useState(false);
    const [loginMessage, setLoginMessage] = useState('');

    return (
        <main
            className="sd-ui-page p-4 sm:p-8 font-sans transition-colors duration-500 flex flex-col"
            style={bgStyle}
            data-loading={loading}
        >
            <DashboardView
                    system={system}
                    user={users.find(u => (u._id || u.id) === (currentUser?._id || currentUser?.id)) || null}
                    ownedActors={ownedActors}
                    token={token}
                    configUrl={configUrl || ''}
                    appVersion={appVersion || ''}
                    fetchActors={fetchActors}
                    setLoading={setLoading}
                    setLoginMessage={setLoginMessage}
            />

            <LoadingModal
                message={loginMessage}
                visible={loading && !!loginMessage}
                theme={system?.componentStyles?.loadingModal}
            />
        </main>
    );
}
