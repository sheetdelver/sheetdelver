export interface ModuleCoreConstraintDiagnostic {
    constraint: string;
    compatible: boolean;
    reason?: string;
}

export interface ModuleContractDiagnostic {
    contract: string;
    requiredRange: string;
    providedVersion?: string;
    compatible: boolean;
    reason?: string;
}

export interface CompatibilityResolutionInput {
    coreVersion: string;
    requiredCoreVersion?: string;
    requiredApiContracts?: Record<string, string>;
    providedApiContracts: Record<string, string>;
}

export interface CompatibilityResolution {
    compatible: boolean;
    reason?: string;
    coreDiagnostics?: ModuleCoreConstraintDiagnostic[];
    contractDiagnostics?: ModuleContractDiagnostic[];
}

interface ConstraintResult {
    ok: boolean;
    error?: string;
}

function parseSemver(version: string): { major: number; minor: number; patch: number } | null {
    const cleaned = version.trim().replace(/^v/i, '');
    const match = cleaned.match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!match) return null;

    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
    };
}

function compareSemver(
    a: { major: number; minor: number; patch: number },
    b: { major: number; minor: number; patch: number }
): number {
    if (a.major !== b.major) return a.major - b.major;
    if (a.minor !== b.minor) return a.minor - b.minor;
    return a.patch - b.patch;
}

function splitConstraints(range: string): string[] {
    return range
        .split(/[\s,]+/g)
        .map((token) => token.trim())
        .filter(Boolean);
}

function evaluateConstraint(currentVersion: string, token: string): ConstraintResult {
    const trimmed = token.trim();
    if (!trimmed) return { ok: true };

    const match = trimmed.match(/^(>=|<=|>|<|=)?\s*(\d+\.\d+\.\d+)$/);
    if (!match) {
        return { ok: false, error: `Unsupported version constraint token: "${trimmed}"` };
    }

    const operator = match[1] || '=';
    const targetVersion = parseSemver(match[2]);
    const current = parseSemver(currentVersion);

    if (!targetVersion || !current) {
        return { ok: false, error: 'Invalid semantic version format for compatibility check' };
    }

    const cmp = compareSemver(current, targetVersion);

    if (operator === '=') return { ok: cmp === 0 };
    if (operator === '>') return { ok: cmp > 0 };
    if (operator === '>=') return { ok: cmp >= 0 };
    if (operator === '<') return { ok: cmp < 0 };
    if (operator === '<=') return { ok: cmp <= 0 };

    return { ok: false, error: `Unsupported operator: ${operator}` };
}

export function resolveModuleCompatibility(input: CompatibilityResolutionInput): CompatibilityResolution {
    const coreDiagnostics: ModuleCoreConstraintDiagnostic[] = [];
    if (input.requiredCoreVersion) {
        const coreConstraints = splitConstraints(input.requiredCoreVersion);
        if (coreConstraints.length === 0) {
            coreDiagnostics.push({
                constraint: input.requiredCoreVersion,
                compatible: false,
                reason: 'Empty core version compatibility constraint',
            });
        } else {
            for (const constraint of coreConstraints) {
                const result = evaluateConstraint(input.coreVersion, constraint);
                coreDiagnostics.push({
                    constraint,
                    compatible: result.ok,
                    reason: result.error || (result.ok ? undefined : `Core ${input.coreVersion} does not satisfy constraint ${constraint}`),
                });
            }
        }
    }

    const failingCore = coreDiagnostics.find((entry) => !entry.compatible);
    if (failingCore) {
        return {
            compatible: false,
            reason: failingCore.reason || `Core ${input.coreVersion} is incompatible`,
            coreDiagnostics,
        };
    }

    const contractDiagnostics: ModuleContractDiagnostic[] = [];
    if (input.requiredApiContracts && Object.keys(input.requiredApiContracts).length > 0) {
        const sortedContracts = Object.keys(input.requiredApiContracts).sort((a, b) => a.localeCompare(b));
        for (const contract of sortedContracts) {
            const requiredRange = input.requiredApiContracts[contract];
            const providedVersion = input.providedApiContracts[contract];

            if (!providedVersion) {
                contractDiagnostics.push({
                    contract,
                    requiredRange,
                    compatible: false,
                    reason: `Contract "${contract}" is not provided by core`,
                });
                continue;
            }

            const constraints = splitConstraints(requiredRange);
            if (constraints.length === 0) {
                contractDiagnostics.push({
                    contract,
                    requiredRange,
                    providedVersion,
                    compatible: false,
                    reason: `Contract "${contract}" has an empty required range`,
                });
                continue;
            }

            let failedReason: string | undefined;
            for (const constraint of constraints) {
                const result = evaluateConstraint(providedVersion, constraint);
                if (result.error) {
                    failedReason = `Contract "${contract}" has invalid constraint: ${result.error}`;
                    break;
                }
                if (!result.ok) {
                    failedReason = `Contract ${contract} ${providedVersion} does not satisfy constraint ${constraint}`;
                    break;
                }
            }

            contractDiagnostics.push({
                contract,
                requiredRange,
                providedVersion,
                compatible: !failedReason,
                reason: failedReason,
            });
        }
    }

    const failingContract = contractDiagnostics.find((entry) => !entry.compatible);
    if (failingContract) {
        return {
            compatible: false,
            reason: failingContract.reason || `Contract ${failingContract.contract} is incompatible`,
            coreDiagnostics: coreDiagnostics.length > 0 ? coreDiagnostics : undefined,
            contractDiagnostics,
        };
    }

    return {
        compatible: true,
        coreDiagnostics: coreDiagnostics.length > 0 ? coreDiagnostics : undefined,
        contractDiagnostics: contractDiagnostics.length > 0 ? contractDiagnostics : undefined,
    };
}
