import { FoundryConfig } from './types';
import { ClientSocket } from './sockets/ClientSocket';
import { CoreSocket } from './sockets/CoreSocket';
import type { FoundryClient } from './interfaces';

export function createFoundryClient(config: FoundryConfig): FoundryClient {
    return new ClientSocket(config);
}

// Export individual clients and interface for flexibility
export { ClientSocket, CoreSocket };
export type { FoundryClient };

