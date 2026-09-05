import type { Server } from 'socket.io';
import { systemService } from '@server/services/world';
import { logger } from '@shared/utils/logger';
import type { SystemStatusPayload } from '@shared/contracts/status';
import { projectPublicStatus } from '@server/services/status/StatusService';

export const STATUS_ROOMS = {
    public: 'status:public',
    authenticated: 'authenticated',
} as const;

interface SystemStatusBroadcasterDeps {
    io: Server;
    getSystemStatusPayload: () => Promise<SystemStatusPayload>;
}

export function createSystemStatusBroadcaster(deps: SystemStatusBroadcasterDeps) {
    // Shared broadcaster used by lifecycle hooks, polling, and socket relays.
    // Room-specific projections prevent lifecycle polling from widening guest data.
    const broadcastSystemStatus = async () => {
        const authenticatedPayload = await deps.getSystemStatusPayload();
        const publicPayload = projectPublicStatus(authenticatedPayload);
        deps.io.to(STATUS_ROOMS.authenticated).emit('systemStatus', authenticatedPayload);
        deps.io.to(STATUS_ROOMS.public).emit('systemStatus', publicPayload);
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
            await broadcastSystemStatus();
        }, intervalMs);
    };

    return {
        broadcastSystemStatus,
        registerLifecycleBroadcasts,
        startPolling
    };
}
