import type { Server } from 'socket.io';
import { systemService } from '@core/system/SystemService';
import { logger } from '@shared/utils/logger';
import type { SystemStatusPayload } from '@shared/contracts/status';

interface SystemStatusBroadcasterDeps {
    io: Server;
    getSystemStatusPayload: () => Promise<SystemStatusPayload>;
}

export function createSystemStatusBroadcaster(deps: SystemStatusBroadcasterDeps) {
    // Shared broadcaster used by lifecycle hooks, polling, and socket relays.
    // All socket-connected clients receive the full payload including user data.
    // The login form requires user list for the player dropdown, and the dashboard
    // needs it for current user resolution. The REST /api/status endpoint handles
    // auth-gating separately to prevent unauthenticated API scraping.
    const broadcastSystemStatus = async () => {
        const payload = await deps.getSystemStatusPayload();
        deps.io.emit('systemStatus', payload);
    };

    // World lifecycle hooks trigger a fresh status push to all connected app clients.
    const registerLifecycleBroadcasts = () => {
        const handleWorldConnected = (data: any) => {
            logger.info(`Core Service | World Connected [${data.state}]. Broadcasting status to clients...`);
            broadcastSystemStatus();
        };

        const handleWorldDisconnected = () => {
            logger.info('Core Service | World Disconnected. Broadcasting status to clients...');
            broadcastSystemStatus();
        };

        const handleWorldReady = (data: any) => {
            logger.info(`Core Service | World Ready [${data.systemId}]. Broadcasting status to clients...`);
            broadcastSystemStatus();
        };

        const handleSystemStatusUpdate = () => {
            broadcastSystemStatus();
        };

        systemService.on('world:connected', handleWorldConnected);
        systemService.on('world:disconnected', handleWorldDisconnected);
        systemService.on('world:ready', handleWorldReady);
        systemService.on('system:status-update', handleSystemStatusUpdate);

        return {
            dispose: () => {
                systemService.off('world:connected', handleWorldConnected);
                systemService.off('world:disconnected', handleWorldDisconnected);
                systemService.off('world:ready', handleWorldReady);
                systemService.off('system:status-update', handleSystemStatusUpdate);
            }
        };
    };

    // Polling acts as a fallback to keep dashboard status aligned when no explicit event fires.
    const startPolling = (intervalMs: number): ReturnType<typeof setInterval> => {
        return setInterval(async () => {
            const payload = await deps.getSystemStatusPayload();
            deps.io.emit('systemStatus', payload);
        }, intervalMs);
    };

    return {
        broadcastSystemStatus,
        registerLifecycleBroadcasts,
        startPolling
    };
}
