'use client';

import type { CatalogDryRunResult } from '../lib/adminApi';

export type MigrationPreviewDetails = NonNullable<CatalogDryRunResult['migration']>;

/** Shared review surface for archive, source repair and recovery approval. */
export default function MigrationPlanDetails({ preview }: { preview: MigrationPreviewDetails }) {
    const { plan } = preview;
    return <div className="min-w-0 space-y-2 break-words text-sm" aria-label="Exact migration plan">
        <p>World: {plan.world.identity.worldId}; native system {plan.world.identity.systemVersion}.</p>
        {plan.world.identity.instanceId && <p className="break-all text-xs">Instance: {plan.world.identity.instanceId}; system {plan.world.identity.systemId}; Foundry {plan.world.identity.foundryGeneration}.{plan.world.identity.foundryBuild}; context {plan.world.identity.contextRevision}.</p>}
        <p>Candidate {preview.candidateVersion}; {plan.checked} checks; {plan.operations.length} proposed writes.</p>
        <p className="break-all text-xs">Artifact: {preview.artifactDigest}</p>
        <p className="break-all text-xs">Plan: {preview.id}. Expires {new Date(preview.expiresAt).toLocaleString()}.</p>
        {plan.digest && <p className="break-all text-xs">Approval digest: {plan.digest}</p>}
        <p className="text-xs">Apply revalidates this exact world, artifact and read dependencies. Native Foundry clients are not locked out.</p>
        {plan.exclusions.map((text, index) => <p key={index} className="text-xs">Excluded/advisory: {text}</p>)}
        <details className="text-xs"><summary>Proposed source paths</summary>
            <div className="max-h-64 overflow-y-auto">
                {plan.operations.map((operation, index) => <p key={index} className="break-all">{operation.stepId}: {operation.uuid}: {Object.keys(operation.updates).join(', ')}</p>)}
                {!plan.operations.length && <p>No source writes proposed.</p>}
            </div>
        </details>
    </div>;
}
