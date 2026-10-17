import { EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';

export interface MaintenanceStatus {
    phase: string;
    message: string;
}

export class WorldWorkUnavailableError extends Error {
    readonly status = 503;
    readonly code = 'WORLD_WORK_UNAVAILABLE';
    constructor() { super('World unavailable — maintenance required'); }
}

/** One admission/fencing boundary, not a replacement world lifecycle. Native ingress bypasses it. */
export class WorldWorkGate extends EventEmitter {
    private servingToken: string | null = null;
    private generation = 0;
    private blockers = new Map<string, MaintenanceStatus>();
    private inFlight = 0;
    private drainWaiters = new Set<() => void>();

    block(key: string, status: MaintenanceStatus): void {
        this.generation += 1;
        this.blockers.set(key, Object.freeze({ ...status }));
        this.emit('changed');
    }
    release(key: string): void {
        if (!this.blockers.delete(key)) return;
        this.generation += 1;
        this.emit('changed');
    }
    isOpen(): boolean { return this.blockers.size === 0; }
    hasBlock(key: string): boolean { return this.blockers.has(key); }
    pendingDispatches(): number { return this.inFlight; }
    getServingToken(): string | null { return this.servingToken; }
    activateServingToken(token: string): void { this.servingToken = token; this.generation += 1; this.emit('changed'); }
    status(): MaintenanceStatus | null {
        const status = this.blockers.values().next().value;
        return status ? { ...status } : null;
    }
    capture(): number { this.assertOpen(); return this.generation; }
    assertOpen(revision?: number): void {
        if (!this.isOpen() || (revision !== undefined && revision !== this.generation)) {
            throw new WorldWorkUnavailableError();
        }
    }
    /** Invoke immediately around the final socket send, never around a queued callback. */
    async dispatch<T>(send: () => Promise<T>, revision?: number): Promise<T> {
        this.assertOpen(revision);
        this.inFlight += 1;
        try { return await send(); }
        finally {
            this.inFlight -= 1;
            if (this.inFlight === 0) for (const done of this.drainWaiters) done();
        }
    }
    async drain(timeoutMs = 15_000): Promise<void> {
        if (this.inFlight === 0) return;
        await new Promise<void>((resolve, reject) => {
            const done = () => { clearTimeout(timer); this.drainWaiters.delete(done); resolve(); };
            const timer = setTimeout(() => {
                this.drainWaiters.delete(done);
                reject(new Error('World dispatch drain timed out; reconcile before proceeding'));
            }, timeoutMs);
            this.drainWaiters.add(done);
        });
    }
}

export const worldWorkGate = new WorldWorkGate();
const workScope = new AsyncLocalStorage<number>();
const maintenanceScope = new AsyncLocalStorage<() => void>();
/** Internal Core runner scope, never exported by the SDK. Fence checked at the actual send. */
export function withMaintenanceDispatch<T>(fence: () => void, work: () => Promise<T>): Promise<T> {
    return maintenanceScope.run(fence, work);
}
export function dispatchCoreMutation<T>(send: () => Promise<T>): Promise<T> {
    const fence = maintenanceScope.getStore();
    if (fence) { fence(); return send(); }
    return dispatchWorldWork(send);
}
export function withWorldWorkScope<T>(work: () => T): T {
    return workScope.run(worldWorkGate.capture(), work);
}
export function dispatchWorldWork<T>(send: () => Promise<T>): Promise<T> {
    return worldWorkGate.dispatch(send, workScope.getStore());
}
