'use client';

import { useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { logger } from '@shared/utils/logger';
import type { Socket } from 'socket.io-client';
import type { User } from '@shared/interfaces';
import { UnauthorizedApiError } from '@client/ui/api/http';
import * as foundryApi from '@client/ui/api/foundryApi';
import { areUsersEqual } from '@client/ui/context/foundryRealtimeComparisons';

interface UseUserRosterRealtimeOptions {
    appSocket: Socket | null;
    token: string | null;
    users: User[];
    setUsers: Dispatch<SetStateAction<User[]>>;
}

export function useUserRosterRealtime({
    appSocket,
    token,
    users,
    setUsers,
}: UseUserRosterRealtimeOptions) {
    const latestRef = useRef({ token, users });
    const refreshInFlightRef = useRef<Promise<void> | null>(null);

    useEffect(() => {
        latestRef.current = { token, users };
    }, [token, users]);

    useEffect(() => {
        if (!appSocket) return;

        const refreshUsers = (): Promise<void> => {
            if (refreshInFlightRef.current) return refreshInFlightRef.current;

            const promise = (async () => {
                try {
                    const latest = latestRef.current;
                    const data = await foundryApi.fetchStatus(latest.token);
                    if (Array.isArray(data.users) && !areUsersEqual(latest.users, data.users)) {
                        setUsers(data.users as User[]);
                    }
                } catch (e) {
                    if (!(e instanceof UnauthorizedApiError)) {
                        logger.error('FoundryProvider | User refresh failed', e);
                    }
                } finally {
                    refreshInFlightRef.current = null;
                }
            })();

            refreshInFlightRef.current = promise;
            return promise;
        };

        const handleUserChanged = () => { void refreshUsers(); };
        const handleUserListInvalidated = () => { void refreshUsers(); };

        appSocket.on('userChanged', handleUserChanged);
        appSocket.on('userListInvalidated', handleUserListInvalidated);

        return () => {
            appSocket.off('userChanged', handleUserChanged);
            appSocket.off('userListInvalidated', handleUserListInvalidated);
        };
    }, [appSocket, setUsers]);
}
