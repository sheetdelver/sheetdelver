import { CoreSocket } from '@server/core/foundry/sockets/CoreSocket';
import type {
    FoundryProgressEvent,
    FoundryServiceAccountMissingEvent,
    FoundryTransportDisconnectedEvent,
    FoundryWorldDiscoveredEvent,
    FoundryWorldTitleDetectedEvent,
} from '@server/core/foundry/sockets/FoundrySocketEvents';
import { worldLifecycleStore } from '@server/core/world/WorldLifecycleStore';
import { worldStateStore } from '@server/core/world/WorldStateStore';
import { logger } from '@shared/utils/logger';
import { engagementService, type EngagementService } from './EngagementService';
import { worldBootstrapper } from './WorldBootstrapper';

export interface WorldTransportControllerDeps {
    transport: CoreSocket;
    engagement?: EngagementService;
    isRuntimeReady?: () => boolean;
}

export interface WorldControlResult {
    accepted: true;
    response: unknown;
}

export class WorldTransportController {
    private readonly transport: CoreSocket;
    private readonly engagement: EngagementService;
    private readonly isRuntimeReady: () => boolean;
    private retryCount = 0;
    private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private closedWorldStatusTitle: string | null = null;
    private setupEvidenceCount = 0;
    private detachCallbacks: Array<() => void> = [];

    public constructor(deps: WorldTransportControllerDeps) {
        this.transport = deps.transport;
        this.engagement = deps.engagement ?? engagementService;
        this.isRuntimeReady = deps.isRuntimeReady ?? (() => worldBootstrapper.isReady());
        this.attach();
    }

    public dispose(): void {
        this.stopHeartbeat();
        this.clearRetryTimer();
        for (const detach of this.detachCallbacks.splice(0)) detach();
    }

    public connect(): Promise<void> {
        this.clearRetryTimer();
        return this.transport.connect();
    }

    public disconnect(): void {
        this.stopHeartbeat();
        this.clearRetryTimer();
        this.transport.disconnect();
    }

    public startHeartbeat(immediate = false): void {
        this.stopHeartbeat();
        this.heartbeatTimer = setTimeout(
            () => void this.runHeartbeat(),
            this.engagement.getInitialHeartbeatDelayMs(immediate),
        );
    }

    public stopHeartbeat(): void {
        if (!this.heartbeatTimer) return;
        clearTimeout(this.heartbeatTimer);
        this.heartbeatTimer = null;
    }

    public async withHeartbeatPaused<T>(operation: () => Promise<T>): Promise<T> {
        return this.engagement.withHeartbeatPaused(operation);
    }

    public async launchWorld(worldId: string): Promise<WorldControlResult> {
        const trimmedWorldId = typeof worldId === 'string' ? worldId.trim() : '';
        if (!trimmedWorldId) throw new Error('World id is required to launch a Foundry world');

        const response = await this.transport.postSetupAction({
            action: 'launchWorld',
            world: trimmedWorldId,
        });

        this.resetRetryBackoff();
        this.startHeartbeat(true);
        return { accepted: true, response };
    }

    public async shutdownWorld(): Promise<WorldControlResult> {
        // Foundry v14 can emit the authoritative native shutdown signal and
        // then redirect the POST to /setup. That redirect is not a failed
        // shutdown when the signal already retired the world runtime.
        let nativeShutdown = false;
        const onNativeShutdown = () => { nativeShutdown = true; };
        this.transport.on('foundry:shutdown', onNativeShutdown);
        let response: unknown;
        try {
            response = await this.transport.postSetupAction({ shutdown: true });
        } catch (error) {
            if (!nativeShutdown) throw error;
            logger.info('WorldTransportController | Shutdown confirmed by Foundry native signal after setup redirect.');
            response = { nativeShutdown: true };
        } finally {
            this.transport.off('foundry:shutdown', onNativeShutdown);
        }
        if (nativeShutdown) return { accepted: true, response };
        worldLifecycleStore.setState('setup', 'admin-shutdown-accepted');
        this.transport.emit('foundry:runtimeTeardown', { reason: 'admin-shutdown' });
        this.transport.disconnect();
        this.startHeartbeat(true);
        return { accepted: true, response };
    }

    public resetRetryBackoff(): void {
        this.retryCount = 0;
    }

    public retryAfterRecoveryFailure(): void {
        worldLifecycleStore.setState('offline', 'world-reconciliation-failed');
        this.transport.disconnect();
        this.scheduleReconnect(5000);
    }

    private attach(): void {
        this.onTransport('foundry:setupDetected', () => this.handleSetupDetected());
        this.onTransport('foundry:worldTitleDetected', (event) => this.handleWorldTitleDetected(event as FoundryWorldTitleDetectedEvent));
        this.onTransport('foundry:worldDiscovered', (event) => this.handleWorldDiscovered(event as FoundryWorldDiscoveredEvent));
        this.onTransport('foundry:worldMissing', () => this.handleWorldMissing());
        this.onTransport('foundry:serviceAccountMissing', (event) => this.handleServiceAccountMissing(event as FoundryServiceAccountMissingEvent));
        this.onTransport('foundry:worldInactive', () => this.handleWorldInactive());
        this.onTransport('foundry:worldActive', () => this.handleWorldActive());
        this.onTransport('foundry:transportDisconnected', (event) => this.handleTransportDisconnected(event as FoundryTransportDisconnectedEvent));
        this.onTransport('foundry:shutdown', () => this.handleShutdown());
        this.onTransport('foundry:reload', () => this.handleReload());
        this.onTransport('foundry:progress', (event) => this.handleProgress(event as FoundryProgressEvent));
        this.onTransport('foundry:connectionFailed', () => this.handleConnectionFailed());

        const onReturnedToEngagement = () => this.handleReturnToEngagement();
        this.engagement.on('returnedToEngagement', onReturnedToEngagement);
        this.detachCallbacks.push(() => this.engagement.off('returnedToEngagement', onReturnedToEngagement));
    }

    private onTransport(event: string, handler: (...args: unknown[]) => void): void {
        this.transport.on(event, handler);
        this.detachCallbacks.push(() => this.transport.off(event, handler));
    }

    private handleSetupDetected(): void {
        logger.debug('WorldTransportController | Socket classified Foundry as setup.');
        this.recordSetupEvidence('handshake-setup');
    }

    private recordSetupEvidence(reason: string): void {
        const retainedWorld = worldStateStore.isReady();
        this.setupEvidenceCount += 1;
        if (retainedWorld && this.setupEvidenceCount < 2) {
            // One contradictory status observation must not retire an active
            // world's sessions. The next independent handshake corroborates it.
            logger.warn(`WorldTransportController | Setup report (${reason}) awaiting confirmation.`);
            worldLifecycleStore.setState('offline', 'setup-awaiting-confirmation');
            this.scheduleReconnect(1000);
            return;
        }

        this.setupEvidenceCount = 0;
        this.closedWorldStatusTitle = null;
        worldLifecycleStore.setState('setup', reason);
        if (retainedWorld) {
            this.transport.emit('foundry:runtimeTeardown', { reason: 'confirmed-world-setup' });
        }
        this.scheduleSetupRetry();
    }

    private handleWorldTitleDetected(event: FoundryWorldTitleDetectedEvent): void {
        this.setupEvidenceCount = 0;
        this.closedWorldStatusTitle = event.pageTitle;
        if (!worldLifecycleStore.isState('active')) {
            worldLifecycleStore.setState('startup', 'handshake-world-title-detected');
            logger.info(`WorldTransportController | World detected (${event.pageTitle}). Transitioning to startup.`);
        }
    }

    private handleWorldDiscovered(event: FoundryWorldDiscoveredEvent): void {
        this.setupEvidenceCount = 0;
        worldLifecycleStore.setState('startup', 'probe-world-discovered');
        worldStateStore.setProbeData(event.world, event.userCount);
    }

    private handleWorldMissing(): void {
        this.setupEvidenceCount = 0;
        worldLifecycleStore.setState('offline', 'probe-world-missing');
        this.scheduleDiscoveryRetry();
    }

    private handleServiceAccountMissing(event: FoundryServiceAccountMissingEvent): void {
        this.clearRetryTimer();
        worldLifecycleStore.setState('closed', 'service-account-missing');
        logger.error(`WorldTransportController | Service account "${event.username}" not found in world "${event.worldTitle || 'unknown'}". Available users: [${event.availableUsers.join(', ') || 'none'}].`);
        // Halt login/bootstrap retries for this known-bad world, but keep a
        // passive heartbeat so setup or a different world can be discovered.
        logger.info('WorldTransportController | Closed-state monitoring remains active for Foundry lifecycle changes.');
        this.startHeartbeat();
    }

    private handleWorldInactive(): void {
        logger.warn('WorldTransportController | Socket reported inactive after an active HTTP handshake; retrying without setup classification.');
        this.transport.disconnect();
        worldLifecycleStore.setState('offline', 'conflicting-world-status');
        this.scheduleReconnect(1000);
    }

    private handleWorldActive(): void {
        logger.debug('WorldTransportController | Socket reported world active.');
        this.setupEvidenceCount = 0;
        this.resetRetryBackoff();
        worldLifecycleStore.setState('startup', 'foundry-world-active');
        worldStateStore.clearProbeData();
    }

    private handleTransportDisconnected(event: FoundryTransportDisconnectedEvent): void {
        logger.debug('WorldTransportController | Socket transport disconnected.');
        this.stopHeartbeat();
        this.resetRetryBackoff();

        // Capture every Store before a replacement socket can deliver updates.
        // The browser's last visible state is the reconciliation baseline.
        if (this.isRuntimeReady()) worldBootstrapper.captureRecoveryBaseline();

        // A partial initial bootstrap has no retained usable runtime; retire
        // its epoch so late async seeds cannot mark a disconnected world ready.
        if (!this.isRuntimeReady()) {
            this.transport.emit('foundry:runtimeTeardown', { reason: 'partial-bootstrap-disconnect' });
        }

        if (!worldLifecycleStore.isState('setup')) {
            worldLifecycleStore.setState('offline', 'socket-disconnect');
        }

        if (this.engagement.shouldReconnectAfterUnexpectedDisconnect(event.reason)) {
            void this.connect().catch(() => undefined);
        } else {
            this.startHeartbeat(true);
        }
    }

    private handleShutdown(): void {
        logger.debug('WorldTransportController | Socket reported Foundry shutdown.');
        this.setupEvidenceCount = 0;
        worldLifecycleStore.setState('setup', 'foundry-shutdown');
        this.transport.emit('foundry:runtimeTeardown', { reason: 'foundry-shutdown' });
        this.transport.disconnect();
        this.startHeartbeat(true);
    }

    private handleReload(): void {
        this.resetRetryBackoff();
        worldBootstrapper.captureRecoveryBaseline();
        worldLifecycleStore.setState('offline', 'foundry-reload');
        this.transport.disconnect();
        void this.connect().catch(() => undefined);
    }

    private handleProgress(event: FoundryProgressEvent): void {
        const data = event.data as { action?: unknown; step?: unknown } | null;
        if (data?.action === 'launchWorld' && data.step === 'complete') {
            logger.warn('WorldTransportController | Foundry progress: world launch complete. Reconnecting immediately.');
            this.resetRetryBackoff();
            // The launch progress event arrives on the still-connected Setup
            // socket. Disconnect it first or CoreSocket.connect() returns
            // early and leaves lifecycle state stranded in Setup.
            this.transport.disconnect();
            void this.connect().catch(() => undefined);
        }
    }

    private handleConnectionFailed(): void {
        worldLifecycleStore.setState('offline', 'connection-flow-failed');
        this.scheduleReconnect(5000);
    }

    private handleReturnToEngagement(): void {
        this.resetRetryBackoff();
        this.startHeartbeat(true);

        if (this.engagement.shouldReconnectOnEngagement({
            lifecycleState: worldLifecycleStore.getState(),
            isConnecting: this.transport.isConnectionAttemptInFlight,
        })) {
            void this.connect().catch(() => undefined);
        }
    }

    private async runHeartbeat(): Promise<void> {
        const lifecycleState = worldLifecycleStore.getState();
        const canDiscoverWorld = lifecycleState === 'setup' || lifecycleState === 'offline';
        const isClosed = lifecycleState === 'closed';

        if (!this.engagement.shouldRunHeartbeat({
            isConnected: this.transport.isConnected,
            isConnecting: this.transport.isConnectionAttemptInFlight,
            lifecycleState,
        })) {
            this.heartbeatTimer = null;
            return;
        }

        try {
            const { isSetupMatch, pageTitle } = await this.transport.checkStatus();
            if (!isSetupMatch) this.setupEvidenceCount = 0;
            const isGenericOrErrorTitle = !pageTitle || pageTitle === 'Foundry Virtual Tabletop' || pageTitle.includes('Critical Failure');
            const closedWorldChanged =
                isClosed &&
                !isSetupMatch &&
                !!this.closedWorldStatusTitle &&
                pageTitle !== this.closedWorldStatusTitle;

            if ((canDiscoverWorld || closedWorldChanged) && pageTitle && !isGenericOrErrorTitle) {
                logger.info(`WorldTransportController | Heartbeat detected world lifecycle change (Title="${pageTitle}").`);
                this.resetRetryBackoff();
                this.heartbeatTimer = null;
                void this.connect().catch(() => undefined);
                return;
            }

            if (isSetupMatch) {
                logger.debug('WorldTransportController | Heartbeat reported explicit setup.');
                this.transport.disconnect();
                this.heartbeatTimer = null;
                this.recordSetupEvidence('heartbeat-setup');
                return;
            }
        } catch {
            // Ignore transient network errors; the next heartbeat/retry owns recovery.
        }

        if (this.heartbeatTimer !== null) {
            this.heartbeatTimer = setTimeout(
                () => void this.runHeartbeat(),
                this.engagement.getNextHeartbeatDelayMs(),
            );
        }
    }

    private scheduleSetupRetry(): void {
        let backoffMs = 5000 * Math.pow(2, Math.min(this.retryCount - 30, 4));
        if (this.retryCount < 30) {
            backoffMs = 1000;
            if (this.retryCount % 5 === 0 || this.retryCount < 5) {
                logger.info(`WorldTransportController | World in setup/gray state. Fast-retrying in 1s... (${this.retryCount + 1}/30)`);
            }
        } else {
            logger.info(`WorldTransportController | World in setup/gray state. Backing off for ${backoffMs / 1000}s... (Retry: ${this.retryCount})`);
        }

        this.retryCount += 1;
        this.scheduleReconnect(Math.min(60000, backoffMs));
    }

    private scheduleDiscoveryRetry(): void {
        let backoffMs = 5000 * Math.pow(2, Math.min(this.retryCount, 4));
        if (this.retryCount < 3) {
            backoffMs = 1000;
            logger.warn(`WorldTransportController | Discovery failed. Fast-retrying in 1s... (${this.retryCount + 1}/3)`);
        } else {
            logger.warn(`WorldTransportController | Discovery failed. Backing off for ${backoffMs / 1000}s... (Retry Count: ${this.retryCount})`);
        }

        this.retryCount += 1;
        this.scheduleReconnect(Math.min(60000, backoffMs));
    }

    private scheduleReconnect(delayMs: number): void {
        this.clearRetryTimer();
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            void this.connect().catch(() => undefined);
        }, delayMs);
    }

    private clearRetryTimer(): void {
        if (!this.retryTimer) return;
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
    }
}
