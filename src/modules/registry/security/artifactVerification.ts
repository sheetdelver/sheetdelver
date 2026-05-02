export interface ArtifactVerificationInput {
    moduleId: string;
    operation: 'install' | 'upgrade';
    source: string;
    integrity?: string;
    signature?: string;
    now?: number;
}

export interface ArtifactVerificationOutcome {
    moduleId: string;
    operation: 'install' | 'upgrade';
    status: 'verified' | 'failed' | 'skipped';
    verified: boolean;
    reason?: string;
    source: string;
    integrity?: string;
    signature?: string;
    checkedAt: number;
}

function isHex(value: string): boolean {
    return /^[a-f0-9]+$/i.test(value);
}

function normalizeIntegrity(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;

    // Accept either "sha256:<64hex>" or raw <64hex> and normalize to sha256:<hex>.
    const lower = trimmed.toLowerCase();
    if (lower.startsWith('sha256:')) {
        const digest = trimmed.slice(7).trim();
        if (digest.length === 64 && isHex(digest)) {
            return `sha256:${digest.toLowerCase()}`;
        }
        return undefined;
    }

    if (trimmed.length === 64 && isHex(trimmed)) {
        return `sha256:${trimmed.toLowerCase()}`;
    }

    return undefined;
}

function isLocalSource(source: string): boolean {
    return source.startsWith('local://') || source.startsWith('file://');
}

export function verifyArtifactMetadata(input: ArtifactVerificationInput): ArtifactVerificationOutcome {
    const checkedAt = input.now ?? Date.now();
    const normalizedIntegrity = normalizeIntegrity(input.integrity);
    const normalizedSignature = input.signature?.trim() || undefined;

    if (isLocalSource(input.source)) {
        return {
            moduleId: input.moduleId,
            operation: input.operation,
            status: 'skipped',
            verified: true,
            reason: 'Local source verification skipped (digest/signature optional for local artifacts)',
            source: input.source,
            integrity: normalizedIntegrity,
            signature: normalizedSignature,
            checkedAt,
        };
    }

    if (!normalizedIntegrity) {
        return {
            moduleId: input.moduleId,
            operation: input.operation,
            status: 'failed',
            verified: false,
            reason: 'Artifact integrity is required and must be sha256:<64 hex> for non-local sources',
            source: input.source,
            integrity: input.integrity,
            signature: normalizedSignature,
            checkedAt,
        };
    }

    if (!normalizedSignature) {
        return {
            moduleId: input.moduleId,
            operation: input.operation,
            status: 'failed',
            verified: false,
            reason: 'Artifact signature is required for non-local sources',
            source: input.source,
            integrity: normalizedIntegrity,
            signature: input.signature,
            checkedAt,
        };
    }

    return {
        moduleId: input.moduleId,
        operation: input.operation,
        status: 'verified',
        verified: true,
        source: input.source,
        integrity: normalizedIntegrity,
        signature: normalizedSignature,
        checkedAt,
    };
}
