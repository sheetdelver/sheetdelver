import { SocketBase } from '@server/core/foundry/sockets/SocketBase';
import type { FoundryConfig } from '@server/core/foundry/types';
import type { FoundryUserLike } from '@server/shared/types/foundry';

export class FoundryUserDiscoveryProbe extends SocketBase {
    public constructor(config: FoundryConfig) {
        super(config);
    }

    public async connect(): Promise<void> {
        return undefined;
    }

    public async discoverUsers(): Promise<FoundryUserLike[]> {
        const state = await this.probeWorldState(this.url);
        return Array.isArray(state?.users) ? state.users : [];
    }
}
