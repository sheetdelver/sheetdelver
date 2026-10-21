# ADR-0066: Publish the files produced by successful validation

**Status:** Implemented — metadata-only follow-up locally verified; hosted rollout pending
**Date:** October 20, 2026
**Related:** ADR-0037

## Problem

Core at `346631dd` ran audit, lint, typing, tests and build in main CI, then
repeated that pipeline when the release tag was pushed. Module CI could run
twice for an atomic main/tag push; publication installed Core's toolchain and
packaged again even after the exact tag passed validation. Consequently the
published archive was a newly built file, not the file checked by the first run.

The user selected release-workflow correction separately from module UI work.
Module branches/worktrees preserve Shadowdark's pending presentation edits and
D&D's character-lifecycle work. No application rules, UI, runtime contract,
compatibility floor or release version changes are part of this decision.

## Decision

1. Validation owns installation, checks, tests and build/package. A successful
   non-PR run retains publication files for 30 days. A small `validation.json`
   records repository, full commit, workflow, run/attempt, product/version,
   Node major, resolved toolchain commit and per-file size/SHA-256.
2. Publication consumes those exact files. It requires completed successful
   same-repository push/manual validation at main or the matching version tag.
   PR/fork runs cannot authorize publication. The artifact's GitHub ZIP digest,
   run/attempt, file inventory, identity and individual hashes are verified.
   No user-supplied run ID or artifact name can bypass selection.
3. **Original decision, superseded for strictly checked release metadata by the October 21 addendum below.** A source, dependency, workflow or metadata change creates a different commit
   and requires validation. Module reuse also checks its resolved Core toolchain
   commit. A changed toolchain runs validation again. We deliberately do not
   infer equivalence from an unchanged application-source subset.
4. **PR behavior refined by the October 21 addendum below.** Module main/tag validations share a commit concurrency group with cancellation
   disabled. Whichever runs second can reuse the successful first run, skipping
   installation, tests and packaging. It verifies the retained bytes and reports
   the original run; it does not create a chain of copied artifacts. PRs retain
   their independent full checks. Manual validation deliberately runs fully.
5. Core tag publication retains the existing trigger. Module publication retains
   its separate interactive confirmation and tag-only manual dispatch. The
   existing module release helper still requires successful exact-tag push CI;
   that tag run may have verified reuse from main at the identical commit.
6. Core publishes the CI-produced notes and SBOM plus its checksum, as before;
   it does not introduce a deployment ZIP. Modules publish the CI-produced tgz,
   manifest and checksum. Current release history is generated at publication,
   since another release can appear after validation. CI bundles the existing
   history generator from its pinned Core checkout into a standalone Node file;
   publication needs neither npm installation nor a second rules/schema copy.
7. Missing/expired artifacts require a validation run at the unchanged release
   tag, followed by a publication retry. A running validation can be awaited.
   API failures, corruption and identity conflicts stop publication. They never
   silently authorize unchecked bytes or overwrite an existing release.

## Ownership and rollout

`src/scripts/tools/releases/ci-artifacts.mjs` implements the dependency-free
artifact handoff; the same file/tests are copied into module-owned release tools
and `module:init`. Core's publisher remains Core-owned. Module publishers remain
module-owned and independent of a local Core checkout.

New module wrappers call their own publisher instead of the old reusable rebuild.
Their existing validation toolchain pins remain unchanged (Shadowdark 0.19.2;
Mörk Borg and D&D 0.19.3). The updated reusable Core entry point delegates to the
same module-owned tools for callers that prefer it; it requires adoption of the
artifact-producing CI and publisher scripts together. Historical tags and older
pinned workflows retain their original behavior. Do not repoint published tags.

Merge the workflow/scripts/docs together in each repository before preparing a
new release. An earlier successful CI run without the new retained files cannot
be reused. This is a release-tool change, not a requirement to bump the SDK or
modules' runtime Core minimums.

## Verification

Maintained executable tests cover same-commit main/tag reuse; changed commits,
toolchains and attempts; PR/fork rejection; failed/cancelled/in-flight runs;
missing/expired artifacts; API failures; actual ZIP digest/file verification;
publication without install/build commands; tag identity; existing releases;
and exact archive/manifest/checksum consistency. The existing release-helper
tests retain the explicit push/publication confirmations and recovery behavior.
Scaffold tests generate a real module and run its complete standalone release
tests and contract check. Workflow checks retain all validation gates while
requiring publication to use the validated artifact path.

Commands and final results are recorded in the release guides/current handoff.
Local completion: full Core unit suite, TypeScript, lint and whitespace checks
pass. `actionlint` passes for Core, all three module wrappers and generated
scaffold workflows. Standalone release tests pass 38/38 in Shadowdark and
Mörk Borg, and 45/45 in D&D (including seven existing tooling cases). Generated
scaffold tests and module contract checks pass. The history generator was bundled
and executed from both existing pins, Core 0.19.2 and 0.19.3. A retained real
Mörk Borg package passed asset verification and history generation through the
publisher with GitHub publication replaced by a recording fixture.
Local fixture runs do not claim a hosted Actions execution or publication. No
workflow was dispatched, repository pushed, tag created or Foundry contacted.
The first hosted main/tag/release sequence still needs observation after merge.

GitHub's [artifact API](https://docs.github.com/en/rest/actions/artifacts)
provides the origin, expiry and digest fields used by the handoff; its
[concurrency documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
defines serialization. Pending-run order is not assumed: either main or tag may
perform the first complete validation.

## October 21 addendum — reuse merge validation through release preparation

The user selected this follow-up after merging the bootstrap correction and
preparing Core 0.19.7. Baselines: Core `b01344ed`; module mains Shadowdark
`47abb3b`, Mörk Borg `c1f1952`, D&D `8422ab6`. Four separately approved
`fix/reuse-metadata-only-ci` branches isolate this work from Shadowdark's pending
presentation edits and D&D's lifecycle branch. No runtime, dependency, release
version, compatibility requirement or CI Core pin changes are included.

### R66-01 — compare all committed inputs

`src/scripts/tools/releases/ci-reuse.mjs` (identical module/scaffold copies)
first attempts existing exact-commit reuse. Otherwise it considers at most 100
recent main workflow runs. The baseline must be a completed successful
same-repository push/manual run, an ancestor of the current checkout, and have
an unexpired, verified artifact from its successful attempt. PR/fork results
cannot supply publication authority. Node major and resolved module toolchain
identity retain their existing checks.

The complete Git trees are compared, including file modes and unknown paths.
Only `CHANGELOG.md` and the following JSON fields may differ:

| Product | Fields permitted to change |
| --- | --- |
| Core | `package.json.version`, `package-lock.json.version`, `package-lock.json.packages[""].version` |
| Module | `info.json.version` |

Core root versions must agree in both revisions and versions must be stable
semver. JSON comparison preserves every other field, including scripts,
dependencies, integrity, SDK ranges, source declarations and toolchain settings.
File additions/removals, symlinks, mode changes, source/assets/configuration,
workflow/helper changes and other unknown inputs require the full pipeline.
Changelog changes are documentation-only; release tags do not change a tree.
Missing/shallow history, a missing/expired artifact or changed toolchain falls
back to full validation. API failures, corrupt artifacts and conflicting identity
remain errors. The bounded lookup may miss an older reusable run; it then runs
normally. An in-progress baseline is not yet successful and cannot authorize
metadata reuse. Manual CI deliberately remains the full-validation escape hatch.

### R66-02 — lightweight checks and truthful final packages

Core skips repeated npm installation, audit, lint, typing, tests and application
build on verified metadata reuse. The dependency-free shared release-notes parser
validates the current numbered section. `npm sbom --package-lock-only` produces
the current version's CycloneDX inventory from the committed production lock,
without installing dependencies. All Core CI SBOMs now use that same lock-based
inventory (including platform-optional locked packages), rather than depending
on a runner's installed tree. Publication continues to publish notes/SBOM; no
Core executable build artifact is relabeled or shipped.

Module `module/ui.tsx` imports `info.json`; some logic also imports it. Therefore
changing that file requires the existing pinned packager to compile the correct
embedded version. Metadata reuse skips the independent helper/type/rules suites,
but installs the pinned packaging toolchain, generates its configuration and
runs the existing package command, including its built-in contract validation.
The resulting archive/manifest/checksum and bundled history generator are retained
for publication. This is required package production, not a second complete test
pipeline. No string replacement of compiled JavaScript or cosmetic archive rename
is used to conceal a stale version.

A changelog-only module edit retains the already-verified compiled bytes when
the archive does not contain `CHANGELOG.md`. If that file is packaged, the current
package must be refreshed. Any `info.json` byte change conservatively requests
packaging, even equivalent JSON formatting. The standard modules do not package
the changelog. New module scaffolds receive the same selection logic.

Metadata-only CI binds the final publication files to the new commit/run/attempt,
and records its baseline commit/run/attempt and changed paths in `validation.json`.
The Actions step summary explains which path ran. Exact-commit main/tag reuse
continues without another artifact upload. A later metadata-only run may reuse a
successful prior metadata run; each hop proves its complete tree equivalence and
retains its immediate baseline identity. Publication still requires successful CI
and verified files for the exact final tag; it does not build or install anything.

### R66-03 — consistent triggers and pull requests

Core and all module main/tag workflows use this selection, as does `module:init`.
Same-repository PRs may reuse a successful main ancestor when the merge checkout
passes the same strict metadata comparison. They publish no artifacts. Fork PRs
and all manual validation run fully. Core dependency-delta review remains a small
independent PR check. Module path filters are removed: a new lockfile, migration,
configuration or other input must trigger CI rather than disappear from coverage.
No broad documentation/source path exclusion or commit-message heuristic grants
reuse. Existing action hashes, permissions, concurrency, validation commands,
publication confirmations and module-specific toolchain pins remain.

### Verification and rollout

Maintained tests exercise real temporary Git commits/trees, file modes, malformed
metadata and changed dependencies; real ZIPs and artifact digests; ancestor and
run eligibility; version-bearing module packaging selection; unchanged compiled
archive copying; no-install Core notes/SBOM; and final commit/baseline binding.
Workflow contracts check the full/metadata/exact conditions and generated modules
execute their standalone tooling suite. No live Foundry or application service
is needed. Local verification: all Core unit tests, TypeScript and lint passed;
`node --test src/scripts/tools/releases/*.test.mjs` passed 24 tests, including
actual offline npm SBOM generation. Each module's standalone release suite
passed 49 tests. The generated scaffold's standalone suite and module contract
check passed. `actionlint` passed Core, all module and generated workflows;
whitespace checks passed. The unchanged application build and native rules suites
were not repeated for this tooling-only change. No live service was started.

Isolated copies of the three module mains were packaged with fixture version
91.0.1 using the current Core 0.19.7 packager/dependency tree. Each archive's
`info.json`, compiled `dist/ui.js` and release manifest contain 91.0.1, and the
manifest hash matches its archive. This demonstrates why version-bearing packages
must be regenerated; it is not execution of each historical CI pin. The copied
D&D tsconfig used an absolute host SDK path; the original relative configuration
and all real metadata remain unchanged. Initial fixture attempts lacked ancestor
node_modules/SDK paths; those fixture-path failures were corrected before the
successful package checks. Reproducible maintained contracts remain in the tests;
local logs/fixture archives are optional context, not publication inputs.

Merge helpers, tests and workflows together in each repository. Their own changes
require one full CI run. Subsequent version/changelog commits can use that run.
D&D main retains its existing 0.18.0 toolchain pin; the active lifecycle branch's
0.19.3 pin and additional checks must be preserved when this work is integrated.
No merge into that branch or Shadowdark's dirty presentation branch is performed
by this implementation. Hosted Actions reuse/publication must still be observed
after the user pushes/merges; local fixtures do not claim a hosted execution.
