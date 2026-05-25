import type { WorldLifecycleState } from '@server/core/world/WorldLifecycleStore';

export interface EngagementTransportCallbacks {
    resetRetryBackoff(): void;
    startHeartbeat(immediate?: boolean): void;
    getReconnectInputs(): {
        lifecycleState: WorldLifecycleState;
        isConnecting: boolean;
    };
    reconnect(): void | Promise<void>;
}

export interface EngagementServiceDeps {
    now?: () => number;
}

export interface HeartbeatPolicyInput {
    isConnected: boolean;
    isConnecting: boolean;
    lifecycleState: WorldLifecycleState;
}

export interface EngagementUpdate {
    previousCount: number;
    browserCount: number;
    becameEngaged: boolean;
}

const ACTIVE_HEARTBEAT_DELAY_MS = 5000;
const RECENT_IDLE_HEARTBEAT_DELAY_MS = 30000;
const WARM_IDLE_HEARTBEAT_DELAY_MS = 60000;
const COLD_IDLE_HEARTBEAT_DELAY_MS = 120000;
const WARM_IDLE_AFTER_MS = 600000;
const COLD_IDLE_AFTER_MS = 1800000;

/**
 * Owns browser-engagement policy for the Foundry transport.
 *
 * CoreSocket still performs the raw heartbeat probe/connect operations, but
 * this service owns the inputs that decide when those operations should happen:
 * browser count, last activity, long-operation suspension, and reconnect on
 * return from idle.
 */
export class EngagementService {
    private readonly now: () => number;
    private browserCount = 0;
    private lastActivityAt: number;
    private pauseDepth = 0;
    private transportCallbacks: EngagementTransportCallbacks | null = null;

    public constructor(deps: EngagementServiceDeps = {}) {
        this.now = deps.now ?? Date.now;
        this.lastActivityAt = this.now();
    }

    public setTransportCallbacks(callbacks: EngagementTransportCallbacks): () => void {
        this.transportCallbacks = callbacks;

        return () => {
            if (this.transportCallbacks === callbacks) {
                this.transportCallbacks = null;
            }
        };
    }

    public setActiveBrowserCount(count: number): EngagementUpdate {
        const nextCount = Math.max(0, Math.floor(count));
        const previousCount = this.browserCount;
        this.browserCount = nextCount;

        if (nextCount > 0) {
            this.lastActivityAt = this.now();
        }

        const becameEngaged = previousCount === 0 && nextCount > 0;
        if (becameEngaged) {
            this.handleReturnToEngagement();
        }

        return {
            previousCount,
            browserCount: nextCount,
            becameEngaged,
        };
    }

    public getActiveBrowserCount(): number {
        return this.browserCount;
    }

    public shouldRunHeartbeat(input: HeartbeatPolicyInput): boolean {
        const canProbe = input.lifecycleState === 'setup' || input.lifecycleState === 'offline';
        if (this.pauseDepth > 0) return false;
        if (input.isConnecting) return false;
        if (input.lifecycleState === 'startup') return false;
        return input.isConnected || canProbe;
    }

    public getInitialHeartbeatDelayMs(immediate = false): number {
        return immediate ? 0 : ACTIVE_HEARTBEAT_DELAY_MS;
    }

    public getNextHeartbeatDelayMs(): number {
        if (this.browserCount > 0) return ACTIVE_HEARTBEAT_DELAY_MS;

        const idleTime = this.now() - this.lastActivityAt;
        if (idleTime > COLD_IDLE_AFTER_MS) return COLD_IDLE_HEARTBEAT_DELAY_MS;
        if (idleTime > WARM_IDLE_AFTER_MS) return WARM_IDLE_HEARTBEAT_DELAY_MS;
        return RECENT_IDLE_HEARTBEAT_DELAY_MS;
    }

    public shouldReconnectAfterUnexpectedDisconnect(reason: string): boolean {
        return reason !== 'io client disconnect' && this.browserCount > 0;
    }

    public async withHeartbeatPaused<T>(operation: () => Promise<T>): Promise<T> {
        this.pauseDepth += 1;
        try {
            return await operation();
        } finally {
            this.pauseDepth = Math.max(0, this.pauseDepth - 1);
        }
    }

    public isHeartbeatSuspended(): boolean {
        return this.pauseDepth > 0;
    }

    private handleReturnToEngagement(): void {
        const callbacks = this.transportCallbacks;
        if (!callbacks) return;

        callbacks.resetRetryBackoff();
        callbacks.startHeartbeat(true);

        const inputs = callbacks.getReconnectInputs();
        if (this.shouldReconnectOnEngagement(inputs)) {
            void Promise.resolve(callbacks.reconnect()).catch(() => undefined);
        }
    }

    // Per ADR-0021, browser return-to-engagement is a monitoring wakeup signal,
    // not a client control path for CoreSocket. Reconnect attempts (= early
    // monitoring polls for whether Foundry is reachable) are only valid when
    // the platform is actually monitoring — i.e. `offline` or `setup`. During
    // `startup` and `active`, CoreSocket is already connected/connecting and
    // WorldBootstrapper owns the in-flight bootstrap; a browser tab opening
    // must not restart the system transport.
    private shouldReconnectOnEngagement(inputs: { lifecycleState: WorldLifecycleState; isConnecting: boolean }): boolean {
        if (this.browserCount === 0 || inputs.isConnecting) return false;
        return inputs.lifecycleState === 'offline' || inputs.lifecycleState === 'setup';
    }
}

export const engagementService = new EngagementService();
