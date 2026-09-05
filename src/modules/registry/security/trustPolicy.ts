import type { ModuleTrustTier, SystemModuleInfo } from '../core/types';

export interface ModuleTrustPolicyConfig {
    minimumTrustTier: ModuleTrustTier;
    allowUnverifiedInDevelopment: boolean;
    requireAdminOverrideForLowerTrust: boolean;
    requirePermissionEscalationApproval: boolean;
}

export interface TrustPolicyDecision {
    allowed: boolean;
    requiresAdminOverride: boolean;
    effectiveTier: ModuleTrustTier;
    minimumRequiredTier: ModuleTrustTier;
    reason?: string;
}

const TRUST_TIER_RANK: Record<ModuleTrustTier, number> = {
    'untrusted': -1,
    'unverified': 0,
    'verified-third-party': 1,
    'first-party': 2,
};

export function getDefaultModuleTrustPolicy(
    env: NodeJS.ProcessEnv = process.env
): ModuleTrustPolicyConfig {
    const isProduction = env.NODE_ENV === 'production';
    return {
        minimumTrustTier: isProduction ? 'verified-third-party' : 'unverified',
        allowUnverifiedInDevelopment: !isProduction,
        requireAdminOverrideForLowerTrust: isProduction,
        requirePermissionEscalationApproval: true,
    };
}

export function resolveEffectiveTrustTier(info: SystemModuleInfo): ModuleTrustTier {
    // Backward compatibility: existing in-repo modules without trust metadata are treated as first-party.
    return info.trust?.tier || 'first-party';
}

export function evaluateTrustPolicy(
    info: SystemModuleInfo,
    policy: ModuleTrustPolicyConfig,
    options?: {
        adminOverride?: boolean;
        env?: NodeJS.ProcessEnv;
        operation?: 'install' | 'upgrade';
    }
): TrustPolicyDecision {
    const env = options?.env || process.env;
    const operation = options?.operation || 'install';
    const effectiveTier = resolveEffectiveTrustTier(info);
    const minimumRequiredTier = policy.minimumTrustTier;

    const effectiveRank = TRUST_TIER_RANK[effectiveTier];
    const minimumRank = TRUST_TIER_RANK[minimumRequiredTier];

    if (effectiveRank >= minimumRank) {
        return {
            allowed: true,
            requiresAdminOverride: false,
            effectiveTier,
            minimumRequiredTier,
        };
    }

    const isProduction = env.NODE_ENV === 'production';
    if (!isProduction && effectiveTier === 'unverified' && policy.allowUnverifiedInDevelopment) {
        return {
            allowed: true,
            requiresAdminOverride: false,
            effectiveTier,
            minimumRequiredTier,
            reason: 'Allowed by development unverified trust policy override',
        };
    }

    const adminOverride = options?.adminOverride === true;
    if (policy.requireAdminOverrideForLowerTrust && adminOverride) {
        return {
            allowed: true,
            requiresAdminOverride: true,
            effectiveTier,
            minimumRequiredTier,
            reason: `Allowed by explicit admin override for ${operation} on lower trust tier module`,
        };
    }

    return {
        allowed: false,
        requiresAdminOverride: policy.requireAdminOverrideForLowerTrust,
        effectiveTier,
        minimumRequiredTier,
        reason: `Module trust tier "${effectiveTier}" is below required minimum "${minimumRequiredTier}" for ${operation}`,
    };
}
