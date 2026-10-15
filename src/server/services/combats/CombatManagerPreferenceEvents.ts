import { EventEmitter } from 'node:events';

class CombatManagerPreferenceEvents extends EventEmitter {
    constructor() { super(); this.setMaxListeners(0); }

    changed(): void { this.emit('changed'); }

    onChanged(listener: () => void): () => void {
        this.on('changed', listener);
        return () => { this.off('changed', listener); };
    }
}

/** Empty invalidation only; tracker clients refetch their authorized projection. */
export const combatManagerPreferenceEvents = new CombatManagerPreferenceEvents();
