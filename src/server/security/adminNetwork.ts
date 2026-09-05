import { BlockList, isIP } from 'node:net';

export const DEFAULT_ADMIN_ALLOWED_NETWORKS = ['127.0.0.0/8', '::1/128'] as const;

interface ParsedNetwork {
    address: string;
    prefix: number;
    type: 'ipv4' | 'ipv6';
}

function parseNetwork(value: string): ParsedNetwork {
    const trimmed = value.trim();
    const parts = trimmed.split('/');
    if (parts.length > 2 || !parts[0]) {
        throw new Error(`Invalid admin network: ${value}`);
    }
    const family = isIP(parts[0]);
    if (family !== 4 && family !== 6) {
        throw new Error(`Admin network must use an IP address: ${value}`);
    }
    const maximum = family === 4 ? 32 : 128;
    const prefix = parts[1] === undefined ? maximum : Number(parts[1]);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > maximum) {
        throw new Error(`Admin network has an invalid prefix: ${value}`);
    }
    return { address: parts[0], prefix, type: family === 4 ? 'ipv4' : 'ipv6' };
}

/** Validate once during configuration load so malformed CIDRs fail startup. */
export function validateAdminAllowedNetworks(values: readonly string[]): string[] {
    if (values.length === 0) {
        throw new Error('At least one admin allowed network is required');
    }
    return values.map((value) => {
        parseNetwork(value);
        return value.trim();
    });
}

/** Check the effective proxy client address against the configured CIDRs. */
export function isAdminClientAddressAllowed(address: string | undefined, networks: readonly string[]): boolean {
    if (!address) return false;
    const normalized = address.startsWith('::ffff:') ? address.slice(7) : address.split('%')[0];
    const family = isIP(normalized);
    if (family !== 4 && family !== 6) return false;

    const allowlist = new BlockList();
    for (const value of networks) {
        const network = parseNetwork(value);
        allowlist.addSubnet(network.address, network.prefix, network.type);
    }
    return allowlist.check(normalized, family === 4 ? 'ipv4' : 'ipv6');
}
