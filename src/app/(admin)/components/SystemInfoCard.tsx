import { logger } from '@/shared/utils/logger';
import { useState, useEffect } from 'react';
import { adminApiPath } from '../lib/adminApi';
import { SystemStatusPayload } from '@/shared/contracts/status';

async function GetSystemInfo() {
    const storedToken = localStorage.getItem('admin-token');
    const storedCsrf = localStorage.getItem('admin-csrf');
    if (storedToken) {
        //const response = await fetch(adminApiPath(`/system-info`), {
        const response = await fetch(`/api/status`, {
            headers: {
                Authorization: `Bearer ${storedToken}`,
            },
        });

        if (response.ok) {
            const data = await response.json();
            return data as SystemStatusPayload;
        }
    }
    return {} as SystemStatusPayload;
}

function createBadge(message: string, type: 'info' | 'warning' | 'error' | 'success') {
    const color = type === 'info' ? 'bg-blue-100' : type === 'warning' ? 'bg-yellow-100' : type === 'error' ? 'bg-red-100' : 'bg-green-100';
    const textColor = type === 'info' ? 'text-blue-900' : type === 'warning' ? 'text-yellow-900' : type === 'error' ? 'text-red-900' : 'text-green-900';
    const shadowColor = type === 'info' ? 'shadow-blue-500' : type === 'warning' ? 'shadow-yellow-500' : type === 'error' ? 'shadow-red-500' : 'shadow-green-500';
    return (
        <div role="alert" className={`border-2 ${color} ${textColor} p-4 shadow-[4px_4px_0_0_${shadowColor}] rounded-lg`}>
            <div className="flex items-start gap-3">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="mt-0.5 size-4">
                    <path d="M15 8A7 7 0 1 1 1 8a7 7 0 0 1 14 0ZM9 5a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM6.75 8a.75.75 0 0 0 0 1.5h.75v1.75a.75.75 0 0 0 1.5 0v-2.5A.75.75 0 0 0 8.25 8h-1.5Z"></path>
                </svg>

                <strong className="block flex-1 leading-tight font-semibold">
                    {message}
                </strong>
            </div>
        </div>
    )
}

function createCard(title: string, message: string) {
    return (
        <div className="col-span-1 border-2 text-white text-center bg-gray-800">
            <h3 className="text-center bg-gray-400 p-2">{title}</h3>
            <p className="text-center p-4">{message}</p>
        </div>
    );
}

export default function SystemInfoCard() {
    const [system, setSystem] = useState<SystemStatusPayload>({} as SystemStatusPayload);

    useEffect(() => {
        GetSystemInfo().then((data) => setSystem(data));
    }, []);

    const connected = system?.connected || false;
    const worldSystem = system?.system?.id || 'Unknown';
    const worldVersion = system?.system?.version || 'Unknown';
    const worldName = system?.system?.worldTitle || 'Unknown';
    const worldStatus = system?.system?.status || 'Unknown';

    return (
        <div className="grid grid-cols-1 gap-2 md:grid-cols-3">

            <h2 className="mb-2 text-2xl font-bold tracking-tight text-[var(--admin-text-primary)] col-span-full p-2">System Overview</h2>
            <div className="col-span-full text-xl font-bold text-center bg-[var(--admin-success-bg)] p-2">
                <h1 className="col-span-full uppercase">{worldSystem} ({worldVersion})</h1>
                <h3 className="col-span-full">{worldName}</h3>
            </div>
            {createCard(`Current Status`, worldStatus)}
            {createCard(`Initialized`, system?.initialized ? 'Yes' : 'No')}
            {createCard(`Configured`, system?.isConfigured ? 'Yes' : 'No')}
            {createCard(`Total Users`, system?.system?.users?.total?.toString() ?? 'Unknown')}
            {createCard(`Active Users`, system?.system?.users?.active?.toString() ?? 'Unknown')}
            {createCard(`Debug`, system?.debug?.enabled ? 'Yes' : 'No')}
            <div className="col-span-full">
                {connected ? createBadge(`Connected to ${system?.url}`, 'success') : createBadge(`Disconnected from ${system?.url || "Unknown"}`, 'error')}
            </div>

            {!connected ? (
                <div className="flex justify-end col-span-full">
                    <button className="text-right button border-2 p-2 text-white bg-gray-800 uppercase hover:font-bold hover:bg-gray-600 rounded-md cursor-pointer"
                        onClick={() => {
                            logger.info('Re-Connect clicked');
                            fetch(adminApiPath(`/world/retry`), {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'Authorization': `Bearer ${localStorage.getItem('admin-token')}`,
                                    'x-admin-csrf-token': `${localStorage.getItem('admin-csrf')}`,
                                },
                            })
                                .then((response) => response.json())
                                .then((data) => {
                                    logger.info('Re-Connect response', data);
                                })
                                .catch((error) => {
                                    logger.error('Re-Connect error', error);
                                })
                        }
                        }>
                        Re-Connect service account
                    </button>
                </div>
            ) : null}
        </div>
    );
}