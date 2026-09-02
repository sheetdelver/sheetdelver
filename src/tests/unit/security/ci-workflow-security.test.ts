import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

interface WorkflowStep {
    uses?: string;
    run?: string;
    with?: Record<string, unknown>;
}

interface WorkflowJob {
    if?: string;
    steps?: WorkflowStep[];
}

interface WorkflowDocument {
    permissions?: Record<string, unknown>;
    jobs?: Record<string, WorkflowJob>;
}

export function run() {
    const workflowPath = path.join(process.cwd(), '.github', 'workflows', 'ci.yml');
    const source = fs.readFileSync(workflowPath, 'utf8');
    const workflow = yaml.load(source) as WorkflowDocument;
    const jobs = Object.values(workflow.jobs ?? {});
    const steps = jobs.flatMap((job) => job.steps ?? []);

    assert.equal(workflow.permissions?.contents, 'read');
    assert.ok(steps.length > 0);

    // Every third-party workflow dependency must be immutable and retain a
    // human-readable release comment in the source for future review.
    for (const step of steps) {
        if (!step.uses) continue;
        assert.match(step.uses, /^[^@\s]+@[a-f0-9]{40}$/);
        const escaped = step.uses.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        assert.match(source, new RegExp(`${escaped}\\s+#\\s+v\\d`));
    }

    const commands = steps.map((step) => step.run ?? '').join('\n');
    for (const required of [
        'npm ci',
        'npm run managed:generate',
        'npm audit --omit=dev --audit-level=high',
        'npm run lint',
        'npx tsc --noEmit',
        'npm run test:unit',
        'npm run test:integration',
        'npm run ci:fixture',
        'npm run build',
        'npm sbom --omit=dev --sbom-format cyclonedx',
    ]) {
        assert.ok(commands.includes(required), `CI is missing required gate: ${required}`);
    }

    // A clean checkout has no ignored .managed alias map, so generation must
    // precede the standalone TypeScript gate that consumes it.
    assert.ok(
        commands.indexOf('npm run managed:generate') < commands.indexOf('npx tsc --noEmit'),
        'CI must generate managed TypeScript paths before type checking',
    );

    assert.equal(source.includes('cat >'), false);
    assert.equal(source.includes('data/config/settings.yaml'), false);
    assert.ok(source.includes("vars.ENABLE_DEPENDENCY_REVIEW == 'true'"));
    assert.ok(steps.some((step) => step.uses?.startsWith('actions/dependency-review-action@')));
    assert.ok(steps.some((step) => step.uses?.startsWith('actions/upload-artifact@')));
    for (const step of steps.filter((candidate) => candidate.uses?.startsWith('actions/checkout@'))) {
        assert.equal(step.with?.['persist-credentials'], false);
    }
}
