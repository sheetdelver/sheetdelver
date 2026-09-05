import { EventEmitter } from 'node:events';

export const WORLD_LIFECYCLE_STATES = ['offline', 'setup', 'startup', 'active', 'closed'] as const;
export type WorldLifecycleState = typeof WORLD_LIFECYCLE_STATES[number];

export interface WorldLifecycleTransition {
    from: WorldLifecycleState;
    to: WorldLifecycleState;
    reason: string;
    at: number;
}

export interface WorldLifecycleSnapshot {
    state: WorldLifecycleState;
    lastTransition: WorldLifecycleTransition | null;
}

function isWorldLifecycleState(value: string): value is WorldLifecycleState {
    return (WORLD_LIFECYCLE_STATES as readonly string[]).includes(value);
}

/**
 * ADR-0014 lifecycle home for Foundry world availability.
 *
 * `active` means Sheet Delver is ready to serve world-backed requests.
 * CoreSocket may detect a Foundry-active world, but lifecycle stays in
 * `startup` until WorldBootstrapper finishes Store seeding, compendium
 * discovery, primary-document seeds, and adapter initialization.
 */
export class WorldLifecycleStore extends EventEmitter {
    private state: WorldLifecycleState = 'offline';
    private lastTransition: WorldLifecycleTransition | null = null;

    public getState(): WorldLifecycleState {
        return this.state;
    }

    public isState(state: WorldLifecycleState): boolean {
        return this.state === state;
    }

    public getSnapshot(): WorldLifecycleSnapshot {
        return {
            state: this.state,
            lastTransition: this.lastTransition ? { ...this.lastTransition } : null,
        };
    }

    public setState(next: WorldLifecycleState, reason: string = 'unspecified'): WorldLifecycleTransition | null {
        if (!isWorldLifecycleState(next)) {
            throw new Error(`Invalid world lifecycle state: ${next}`);
        }

        if (next === this.state) return null;

        const transition: WorldLifecycleTransition = {
            from: this.state,
            to: next,
            reason,
            at: Date.now(),
        };

        this.state = next;
        this.lastTransition = transition;
        this.emit('transition', { ...transition });
        return { ...transition };
    }

    public reset(reason: string = 'reset'): WorldLifecycleTransition | null {
        return this.setState('offline', reason);
    }
}

export const worldLifecycleStore = new WorldLifecycleStore();
