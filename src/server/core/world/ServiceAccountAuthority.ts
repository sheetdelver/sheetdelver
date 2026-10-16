import { EventEmitter } from 'node:events';
import type { GameData } from './types';
import { worldWorkGate } from './WorldWorkGate';

export interface ServiceAccountDiagnostic {
    code: 'service-account-gm-required';
    account: string;
    observedRole: number | null;
    requiredRole: 4;
    remediation: string;
}

/** Core-only identity facts. No role substitution and no mutation of human accounts. */
export class ServiceAccountAuthority extends EventEmitter {
    private diagnostic: ServiceAccountDiagnostic | null = null;
    private userId: string | null = null;
    private account = '';
    private qualified = false;

    getDiagnostic(): ServiceAccountDiagnostic | null { return this.diagnostic ? { ...this.diagnostic } : null; }
    getUserId(): string | null { return this.userId; }
    isQualified(): boolean { return this.qualified; }
    rejectDiscovery(account: string, id: string | null, role: number | null): void {
        this.account = account; this.userId = id; this.fail(role);
    }
    retire(): void {
        this.qualified = false;
        worldWorkGate.block('service-identity', { phase: 'blocked', message: 'World unavailable' });
    }
    verify(snapshot: GameData, account: string, expectedId: string | null): void {
        this.account = account;
        this.userId = expectedId;
        const user = snapshot.users?.find((row) => {
            const value = row as Record<string, unknown>;
            return value && (value._id ?? value.id) === expectedId && value.name === account;
        }) as Record<string, unknown> | undefined;
        if (!expectedId || snapshot.userId !== expectedId || user?.role !== 4) {
            this.fail(typeof user?.role === 'number' ? user.role : null);
            throw new Error('service-account-gm-required');
        }
        this.qualified = true;
        this.diagnostic = null;
        worldWorkGate.release('service-identity');
        this.emit('changed');
    }
    checkCurrent(user: Record<string, unknown> | null): boolean {
        if (!this.userId) return false;
        if (!user || (user._id ?? user.id) !== this.userId || user.name !== this.account || user.role !== 4) {
            this.fail(typeof user?.role === 'number' ? user.role : null);
            return false;
        }
        return this.qualified;
    }
    private fail(role: number | null): void {
        this.qualified = false;
        this.diagnostic = {
            code: 'service-account-gm-required', account: this.account, observedRole: role, requiredRole: 4,
            remediation: 'Ensure the configured account exists with the Gamemaster role in this Foundry world, then retry the Core connection. Assistant is insufficient.',
        };
        worldWorkGate.block('service-identity', { phase: 'blocked', message: 'World unavailable' });
        this.emit('changed');
    }
}

export const serviceAccountAuthority = new ServiceAccountAuthority();
