import type { FoundryRelease } from '@server/core/world/types';

export const SUPPORTED_FOUNDRY_GENERATION_MIN = 13;
export const KNOWN_FOUNDRY_GENERATION_MAX = 13;

export type FoundryVersionCompatibilityStatus =
    | 'supported'
    | 'newer-untested'
    | 'unknown'
    | 'unsupported';

export interface FoundryVersionCompatibilityResult {
    status: FoundryVersionCompatibilityStatus;
    generation: number | null;
    minGeneration: number;
    maxGeneration: number;
    message: string;
}

export interface FoundryVersionCompatibilityDiagnostic extends FoundryVersionCompatibilityResult {
    checkedAt: number;
}

export class UnsupportedFoundryVersionError extends Error {
    public readonly code = 'UNSUPPORTED_FOUNDRY_VERSION';
    public readonly compatibility: FoundryVersionCompatibilityResult;

    public constructor(compatibility: FoundryVersionCompatibilityResult) {
        super(compatibility.message);
        this.name = 'UnsupportedFoundryVersionError';
        this.compatibility = compatibility;
    }
}

/**
 * Pure Foundry generation policy.
 *
 * `FoundryRelease` is typed by ADR-0014, but at runtime it still arrives from
 * Foundry JSON. Keep validation here so bootstrap can ask one service-owned
 * policy question before accepting the snapshot into Stores.
 */
export function evaluateFoundryVersionCompatibility(
    release: FoundryRelease | null | undefined,
): FoundryVersionCompatibilityResult {
    const minGeneration = SUPPORTED_FOUNDRY_GENERATION_MIN;
    const maxGeneration = KNOWN_FOUNDRY_GENERATION_MAX;
    const generation = readGeneration(release);

    if (generation === null) {
        return {
            status: 'unknown',
            generation,
            minGeneration,
            maxGeneration,
            message: 'Foundry release generation is unavailable or invalid; proceeding as unverified.',
        };
    }

    if (generation < minGeneration) {
        return {
            status: 'unsupported',
            generation,
            minGeneration,
            maxGeneration,
            message: `Foundry generation ${generation} is below supported minimum ${minGeneration}.`,
        };
    }

    if (generation > maxGeneration) {
        return {
            status: 'newer-untested',
            generation,
            minGeneration,
            maxGeneration,
            message: `Foundry generation ${generation} is newer than known maximum ${maxGeneration}; proceeding as untested.`,
        };
    }

    return {
        status: 'supported',
        generation,
        minGeneration,
        maxGeneration,
        message: `Foundry generation ${generation} is supported.`,
    };
}

export function assertFoundryVersionSupported(
    result: FoundryVersionCompatibilityResult,
): void {
    if (result.status === 'unsupported') {
        throw new UnsupportedFoundryVersionError(result);
    }
}

function readGeneration(release: FoundryRelease | null | undefined): number | null {
    const generation = release?.generation;

    if (typeof generation !== 'number') return null;
    if (!Number.isFinite(generation)) return null;
    if (!Number.isInteger(generation)) return null;

    return generation;
}
