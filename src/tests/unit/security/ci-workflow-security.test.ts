import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import yaml from 'js-yaml';

interface WorkflowStep {
    uses?: string;
    run?: string;
    with?: Record<string, unknown>;
}

interface WorkflowJob {
    if?: string;
    permissions?: Record<string, unknown>;
    steps?: WorkflowStep[];
}

interface WorkflowDocument {
    permissions?: Record<string, unknown>;
    jobs?: Record<string, WorkflowJob>;
}

function loadWorkflow(name: string): {
    source: string;
    workflow: WorkflowDocument;
    steps: WorkflowStep[];
} {
    const workflowPath = path.join(process.cwd(), '.github', 'workflows', name);
    const source = fs.readFileSync(workflowPath, 'utf8');
    const workflow = yaml.load(source) as WorkflowDocument;
    const steps = Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []);
    return { source, workflow, steps };
}

function assertPinnedActions(source: string, steps: WorkflowStep[]): void {
    for (const step of steps) {
        if (!step.uses) continue;
        assert.match(step.uses, /^[^@\s]+@[a-f0-9]{40}$/);
        const escaped = step.uses.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
        assert.match(source, new RegExp(escaped + '\\s+#\\s+v\\d'));
    }
}

function assertCheckoutCredentialsDisabled(steps: WorkflowStep[]): void {
    for (const step of steps.filter((candidate) => candidate.uses?.startsWith('actions/checkout@'))) {
        assert.equal(step.with?.['persist-credentials'], false);
    }
}

export function run() {
    const ci = loadWorkflow('ci.yml');
    assert.equal(ci.workflow.permissions?.contents, 'read');
    assert.ok(ci.steps.length > 0);
    assertPinnedActions(ci.source, ci.steps);

    const ciCommands = ci.steps.map((step) => step.run ?? '').join('\n');
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
        assert.ok(ciCommands.includes(required), 'CI is missing required gate: ' + required);
    }

    assert.ok(
        ciCommands.indexOf('npm run managed:generate') < ciCommands.indexOf('npx tsc --noEmit'),
        'CI must generate managed TypeScript paths before type checking',
    );
    assert.equal(ci.source.includes('cat >'), false);
    assert.equal(ci.source.includes('data/config/settings.yaml'), false);
    const dependencyReviewJob = ci.workflow.jobs?.['dependency-review'];
    assert.ok(dependencyReviewJob, 'CI must define the dependency-review job');
    assert.equal(dependencyReviewJob.if, "github.event_name == 'pull_request'");
    assert.equal(ci.source.includes('ENABLE_DEPENDENCY_REVIEW'), false);
    assert.ok(ci.steps.some((step) => step.uses?.startsWith('actions/dependency-review-action@')));
    assert.ok(ci.steps.some((step) => step.uses?.startsWith('actions/upload-artifact@')));
    assertCheckoutCredentialsDisabled(ci.steps);

    const release = loadWorkflow('release.yml');
    const releaseJob = release.workflow.jobs?.release;
    assert.equal(release.workflow.permissions?.contents, 'read');
    assert.equal(releaseJob?.permissions?.contents, 'write');
    assertPinnedActions(release.source, release.steps);
    assertCheckoutCredentialsDisabled(release.steps);
    assert.ok(release.source.includes("- 'v*.*.*'"));

    const releaseCommands = release.steps.map((step) => step.run ?? '').join('\n');
    assert.equal(releaseJob?.permissions?.actions, 'read');
    assert.ok(releaseCommands.includes('node src/scripts/tools/releases/publish-release.mjs'));
    for (const forbidden of ['npm ci', 'npm run build', 'npm run test:', 'npm run lint']) {
        assert.equal(releaseCommands.includes(forbidden), false, 'Publication must reuse completed CI, not repeat ' + forbidden);
    }
    assert.ok(ciCommands.includes('ci-artifacts.mjs record'));
    assert.ok(ciCommands.includes('npm run release:prepare'));
    assert.ok(ci.source.includes("if: github.event_name != 'pull_request'"));
    assert.equal(release.source.includes('softprops/'), false);
    assert.equal(release.source.includes('cat >'), false);
    assert.equal(release.source.includes('settings.yaml'), false);
    assert.equal(release.source.includes('.next/standalone'), false);
    assert.ok(release.source.includes('GH_TOKEN: ${{ github.token }}'));
    assert.equal(releaseCommands.includes('${{'), false);

    const moduleRelease = loadWorkflow('module-release.yml');
    const moduleReleaseJob = moduleRelease.workflow.jobs?.release;
    assert.equal(moduleRelease.workflow.permissions?.contents, 'read');
    assert.equal(moduleReleaseJob?.permissions?.contents, 'write');
    assertPinnedActions(moduleRelease.source, moduleRelease.steps);
    assertCheckoutCredentialsDisabled(moduleRelease.steps);
    assert.equal(moduleReleaseJob?.permissions?.actions, 'read');
    const moduleReleaseCommands = moduleRelease.steps.map(step => step.run ?? '').join('\n');
    assert.ok(moduleReleaseCommands.includes('node scripts/release.mjs --verify-tag-ci'));
    assert.ok(moduleReleaseCommands.includes('node scripts/publish-release.mjs'));
    assert.doesNotMatch(moduleReleaseCommands, /npm ci|module:package|npm run build/);

    // Execute the provenance/hash/publication contracts, not just workflow text assertions.
    execFileSync(process.execPath, ['--test',
        'src/scripts/tools/releases/ci-artifacts.test.mjs',
        'src/scripts/tools/releases/publish-release.test.mjs'], { stdio: 'pipe' });
}
