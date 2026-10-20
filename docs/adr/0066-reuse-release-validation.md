# ADR-0066: Publish the files produced by successful validation

**Status:** Implemented — local verification; first hosted workflow run pending
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
3. A source, dependency, workflow or metadata change creates a different commit
   and requires validation. Module reuse also checks its resolved Core toolchain
   commit. A changed toolchain runs validation again. We deliberately do not
   infer equivalence from an unchanged application-source subset.
4. Module main/tag validations share a commit concurrency group with cancellation
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
