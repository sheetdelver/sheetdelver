import type { ModulePermissionDeclaration } from '../core/types';

interface NormalizedPermissionDeclaration {
    network: {
        outbound: boolean;
        allowHosts: string[];
    };
    filesystem: {
        read: string[];
        write: string[];
    };
    adminRoutes: boolean;
    sensitiveData: string[];
}

export interface PermissionEscalation {
    key: string;
    change: string;
}

export interface PermissionDeltaResult {
    escalated: boolean;
    escalations: PermissionEscalation[];
}

function normalizeStringArray(value?: string[]): string[] {
    return Array.from(new Set((value || []).map((item) => item.trim()).filter(Boolean))).sort();
}

function diffAddedStrings(previous: string[], next: string[], key: string, label: string): PermissionEscalation[] {
    const previousSet = new Set(previous);
    return next
        .filter((item) => !previousSet.has(item))
        .map((item) => ({ key, change: `${label} added: ${item}` }));
}

export function normalizePermissions(
    permissions?: ModulePermissionDeclaration
): NormalizedPermissionDeclaration {
    return {
        network: {
            outbound: permissions?.network?.outbound === true,
            allowHosts: normalizeStringArray(permissions?.network?.allowHosts),
        },
        filesystem: {
            read: normalizeStringArray(permissions?.filesystem?.read),
            write: normalizeStringArray(permissions?.filesystem?.write),
        },
        adminRoutes: permissions?.adminRoutes === true,
        sensitiveData: normalizeStringArray(permissions?.sensitiveData),
    };
}

export function evaluatePermissionDelta(
    previousPermissions?: ModulePermissionDeclaration,
    requestedPermissions?: ModulePermissionDeclaration
): PermissionDeltaResult {
    const previous = normalizePermissions(previousPermissions);
    const requested = normalizePermissions(requestedPermissions);
    const escalations: PermissionEscalation[] = [];

    if (!previous.network.outbound && requested.network.outbound) {
        escalations.push({ key: 'network.outbound', change: 'Network outbound access enabled' });
    }
    escalations.push(...diffAddedStrings(previous.network.allowHosts, requested.network.allowHosts, 'network.allowHosts', 'Network host allowlist entry'));

    escalations.push(...diffAddedStrings(previous.filesystem.read, requested.filesystem.read, 'filesystem.read', 'Filesystem read scope'));
    escalations.push(...diffAddedStrings(previous.filesystem.write, requested.filesystem.write, 'filesystem.write', 'Filesystem write scope'));

    if (!previous.adminRoutes && requested.adminRoutes) {
        escalations.push({ key: 'adminRoutes', change: 'Admin route access enabled' });
    }

    escalations.push(...diffAddedStrings(previous.sensitiveData, requested.sensitiveData, 'sensitiveData', 'Sensitive data access'));

    return {
        escalated: escalations.length > 0,
        escalations,
    };
}
