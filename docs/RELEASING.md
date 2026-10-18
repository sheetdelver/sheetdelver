# Release Process

SheetDelver releases are published by `.github/workflows/release.yml` when a
stable semantic-version tag such as `v0.9.1` is pushed.

The root `package.json` version is the application release authority. The
matching `CHANGELOG.md` heading supplies the GitHub Release notes. SDK and
named API contract versions remain independent and are maintained in
`src/shared/sdk/contractVersions.ts`.

## Prepare the Release

After the feature is merged, check out and update `main`. No release branch is
needed. Fetch tags first so the local duplicate-tag check includes published
releases. The helper never fetches, pulls, or switches branches. Remote pushes
require explicit confirmation after local preparation.

During feature work and ADR closeout, prepare changelog entries only (Unreleased
or the intended version heading). Leave package.json/package-lock.json versions
to release:tag; do not pre-bump them in the feature commit. Module release
versions likewise require separate release-preparation approval. Updating a
changelog heading is not permission to bump application/module metadata.

Use the local release command to preview a new version and short changelog
bullets (the version below is illustrative):

```bash
npm run release:tag -- 0.11.1 --note "Fixed example issue" --dry-run
```

Repeat without `--dry-run` to prepare it. For several entries, pass a single
multiline block (works in Bash and Fish):

```sh
npm run release:tag -- 0.14.0 --dry-run --notes "Synchronized dice result timing
Expanded dice appearance options
Added rolling region presets
Added dice settlement effects
Expanded rendering and sound controls
Unified admin notification lifecycle"
```

Or use a text file for a short, single-line command:

```sh
npm run release:tag -- 0.14.0 --notes-file /tmp/release-notes.txt --dry-run
```

Each nonblank line becomes one changelog bullet. Plain lines and Markdown
`-`, `*` or `+` bullet prefixes are accepted; omit the version heading. Paths
are relative to the working directory unless absolute. Use an ignored file or
one outside the repository so unrelated-work validation still passes. The input
file is read only and is never committed by the helper. Do not combine
`--notes-file` with inline note flags. Repeated `--note` remains supported, and
`--note`/`--notes` entries are appended in argument order.

Alternatively, write the exact `## 0.14.0` section directly in `CHANGELOG.md`
and run `npm run release:tag -- 0.14.0 --dry-run` with no note flags. An existing
section and note flags are rejected together to prevent accidental replacement.

The command:

- Requires `main`, matching current package/lock versions, and no existing
  local tag with the requested name. Normally the requested stable version is
  newer; matching already-committed metadata uses tag-only recovery below.
- Refuses unrelated staged, unstaged, or untracked work and unfinished Git
  operations. Only a hand-written `CHANGELOG.md` edit may be pending for a new
  version; tag-only recovery requires a completely clean worktree.
- Shows the package version changes, changelog section, commit, and tag.
- Updates `package.json`, both root version fields in `package-lock.json`,
  and the changelog entry without changing dependencies or SDK versions.
- Commits only those three release files and creates an annotated tag on that
  commit. Local preparation never replaces tags, creates branches, or writes
  to a remote.
- In an interactive terminal, offers separate default-No push confirmations,
  with main CI required before the tag push. Otherwise prints the remaining
  manual commands.

`--dry-run` performs the same validation and prints the plan without changing
files, the index, commits, or tags. It never prompts or contacts a remote.
Use `--no-push` to prepare locally and print manual commands without prompts.
Noninteractive runs also stay local. Blockers produce a nonzero exit status.
Run `npm run release:tag -- --help` for the argument summary.

### Already-bumped metadata, missing tag

If a prior commit already bumped package.json and both root lock versions, do
not revert it or select another patch just to satisfy the helper. On clean main,
with a committed matching changelog section, use the same command without note
flags:

```sh
npm run release:tag -- 0.18.1 --dry-run
npm run release:tag -- 0.18.1
```

The helper recognizes the matching version and creates only its missing
annotated tag at the existing main commit. It does not rewrite files, stage
anything or create an empty release commit. Dry-run previews that action without
creating the tag or contacting a remote. Commit implementation/tooling changes
first: a dirty tree, mismatched lock version, missing notes, in-progress Git
operation or existing local tag still blocks preparation. A local tag that
already exists uses --resume; it is never silently replaced.

Local preparation, including tag-only recovery, remains offline and cannot
prove absence of remote tags/releases; fetch/inspect tags first as above.
The resume path below additionally performs read-only remote checks before
creating a missing local tag. Neither path force-pushes tags or overwrites a
published release. This is recovery support, not the normal version-bump process.

An already-prepared version uses a separate resume path rather than the
new-version check:

```sh
npm run release:tag -- 0.15.1 --resume --dry-run
npm run release:tag -- 0.15.1 --resume
```

The resume dry-run validates the local version, changelog, clean `main`, and
existing annotated tag (or previews its creation when missing), without
contacting the remote or changing refs. Actual resume
checks remote refs and GitHub workflows, then continues from the missing step.
If the local tag is missing, resume verifies that no remote tag or GitHub
Release exists before creating it at current main without a version bump or
commit. A remote-only tag requires fetching/inspection, not a replacement tag;
API/authentication errors fail closed.
It recognizes pushes that landed despite a local command error. If main CI
failed and a fix advanced `main`, it moves an **unpublished local** tag to the
fixed commit only after verifying there is no remote tag or GitHub Release.
For a completed failed CI or release run, an interactive resume can offer one
explicit rerun of the same workflow and wait for the new attempt. An interactive
run asks before each missing push. `--resume --no-push` may
create a missing local tag or repair an unpublished one after read-only remote checks, but performs no
remote writes; a noninteractive resume likewise performs no remote writes.

Commit the helper itself and other implementation work before using it for a
real release. The command does not run the entire test/build pipeline. Run the
appropriate local gates before preparing, and wait for main CI before pushing
the tag:

```bash
export SHEET_DELVER_DATA="${TMPDIR:-/tmp}/sheet-delver-release-data"
npm ci
npm run managed:generate
npm audit --omit=dev --audit-level=high
npm run lint
npx tsc --noEmit
npm run test:unit
npm run test:integration
npm run ci:fixture
npm run build
```

The existing `release:prepare` command remains the read-only metadata validator
and notes extractor used by release CI; it does not commit or tag:

```bash
npm run release:prepare -- v0.11.1 /tmp/sheet-delver-v0.11.1-notes.md
```

## Publish the Release

After preparing locally in an interactive terminal, the helper asks:

1. `Push the prepared main commit to origin? [y/N]`
2. Once main CI passes, whether to push the tag and start the release.

Only `y` or `yes` approves a push. Enter or any other answer declines.
Declining the main push skips the tag prompt and prints both manual commands.
Approving main but declining the tag prints only the remaining tag command.

Automatic publishing requires GitHub CLI (`gh`) installed and authenticated
for origin's push repository. The helper checks the exact prepared commit,
push event, and branch/tag in `ci.yml` and `release.yml`, polling every ten
seconds for up to thirty minutes per workflow. It also waits for the release
workflow after an approved tag push. Failure, API errors, or timeout stop the
sequence and print remaining steps; they never authorize the next push.

Both pushes use `--no-follow-tags` so Git configuration cannot publish the tag
during the main push. Only the intended ref is pushed; no force pushes are used.
Changed local release refs or origin stop publishing.

For manual publishing (`--no-push`, a noninteractive run, or a declined
prompt), the helper has already created the local tag. Push the commit first:

```bash
git push --no-follow-tags origin main
```

After main CI passes, push only the intended release tag:

```bash
git push --no-follow-tags origin v0.11.1
```

The release workflow repeats the dependency audit, lint, type checking, tests,
fixture validation, and production build against the tagged commit. It then:

- Verifies that the tag exactly matches the `package.json` version.
- Extracts the matching `CHANGELOG.md` section as release notes.
- Generates a CycloneDX production dependency SBOM.
- Publishes the SBOM and its SHA-256 checksum with the GitHub Release.

GitHub automatically provides source archives for the tag. SheetDelver does
not currently publish a deployment ZIP because a complete deployment includes
the application shell, Core service, manager scripts, dependencies, and module
layout. Production deployments should check out the release tag and use the
documented install, build, and start process.

## Monitor and Recover

If preparation fails during a commit hook or signing operation, the helper
stops without pushing or resetting your work. Inspect `git status` and
`git log -1`; a successful commit may exist even if tagging failed. Fix the
reported problem, verify the release metadata, then finish the commit/tag
using the same-version/tag-only path if metadata is committed and the tag is
missing, or --resume for guarded recovery. Uncommitted failed work still needs
inspection/correction first. Do not choose a different version just to bypass
the failure.

If local preparation succeeded but publishing stopped or was declined, do not
rerun preparation for that version. Its commit and tag already exist. Use
`npm run release:tag -- <version> --resume` to inspect the actual remote refs
and continue. A failed push may have reached the remote; resume checks before
trying it again. Correct a failed main CI in a new commit on main, then resume.

If the tag reached GitHub but its release workflow failed because source must
change, fix and pass main CI first. Then use
`npm run release:tag -- <version> --resume --reuse-failed-tag`. This opt-in path
requires a failed completed release run, verifies that no GitHub Release
exists, compares the exact remote tag object, and asks before deleting the
remote tag. It rechecks those guards immediately before deletion, then moves
the local tag to the fixed commit and asks before republishing it. A remote
tag may already have been fetched; use this exception only for an unpublished
failed release. It never rewrites main or silently deletes a remote tag. If a
GitHub Release exists, publish a new patch version instead. For a transient
workflow failure without a source change, accept the ordinary resume prompt
to rerun that workflow; declining leaves it untouched.

With GitHub CLI installed and authenticated:

```bash
gh run list --workflow release.yml
gh run watch <run-id>
gh release view v0.9.0
```

Rerun a failed workflow only when the failure is transient. Correct a source,
version, changelog, or test failure on main before using guarded tag recovery;
if the release was published, use a new patch version.

An unpushed local tag may be deleted and recreated at the intended commit:

```bash
git tag -d v0.9.0
git tag -a v0.9.0 -m "SheetDelver v0.9.0"
```

Never move or replace a published GitHub Release tag. The guarded failed-tag
recovery above is the only exception for a pushed tag with no Release.

## Module Releases

Public module repositories can call the reusable
`.github/workflows/module-release.yml` workflow from a small tag-triggered
wrapper:

`npm run module:init` generates this wrapper and a separate validation workflow
for new modules. The example remains useful when migrating an existing module:

```yaml
name: Release Module

on:
  push:
    tags:
      - 'v*.*.*'

permissions:
  contents: read

jobs:
  release:
    permissions:
      contents: write
    uses: sheetdelver/sheetdelver/.github/workflows/module-release.yml@v0.9.0
    with:
      module_id: my-system
      core_ref: v0.9.0
```

Pin both the workflow call and `core_ref` to the same tested SheetDelver
release tag. The explicit toolchain ref prevents a later change on `main` from
altering an older module's release build.
The module tag without its leading `v` must exactly match the version in
`info.json`.

The reusable workflow checks out the module and the pinned SheetDelver
toolchain into the GitHub runner, stages the module under an isolated temporary
data directory, runs `module:check`, packages it, verifies the checksum, and
creates a GitHub Release containing:

- `<moduleId>-<version>.tgz`
- `sheet-delver-manifest.json`
- `sheet-delver-releases.json`
- `<moduleId>-<version>.sha256`

The fixed manifest asset name allows the static module catalog to follow the
latest release without editing the catalog for every module version. The release
history asset records up to 100 immutable manifests from existing non-draft,
non-prerelease releases, allowing compatible historical versions to be selected
without querying GitHub at application runtime. Releases made before adopting
this workflow join history only when they contain `sheet-delver-manifest.json`.
A release workflow refuses to overwrite an existing GitHub Release.

## Migration-bearing module releases

[Core ADR-0064](adr/0064-module-world-context-and-data-migrations.md) implements a
conventional root `migration.json` catalog, native-version directories containing
`definition.json`, and separately compiled check/plan/verify hooks. Migration maps
and logic paths do not belong in `info.json`; it retains ordinary module version/
compatibility metadata. Release tooling may generate a catalog-presence/hash
summary, verified against the archive, but cannot create a second migration list.

Development tooling now compiles hooks, checks catalog/definition and archive
health, and derives release-schema-v2 summaries. See [the contract guide](MODULE_MIGRATIONS.md).
Do not publish dependent modules before the supporting Core host/toolchain.
The complete-maintenance correction adds SDK 3.4.0/module-api 1.6.0 for
relation-bearing catalogs (older migration catalogs retain 1.5.0). These contracts
and complete-maintenance corrections shipped in0.19.1; the selected G8 fixes shipped
in0.19.2. CR64-27's normal admin access correction is accepted for0.19.3 and retains
the same SDK/API versions. Its changelog is prepared before feature merge; the
release helper applies package/lock metadata on main. Module adoption and release
acceptance remain module-owned, with explicit tested host/toolchain requirements.
Announce the persistent maintenance-only composition and the append-only receipt
format. Keep config/module-upgrades and retained packages together; do not resume
new-format jobs with 0.19.0 or discard receipts to make an older host start.
Retain steps needed for skipped upgrades and declare
supported data-read compatibility; an old host must not silently ignore migrations.

Publication distributes requirements/code, not world-write authority. The local
admin reviews a live-world dry-run and acknowledges that SheetDelver cannot create
or restore a world backup or undo migration changes. Native Foundry backup is
recommended. Core runs the approved job; native-user lockout and world rollback
are out of scope. Actual source checks at bootstrap detect restored legacy data
despite completed journal records. Download/replacement/restart is not completed
migration. Version changes and publication remain separately authorized operations.

The enforcing Core release must also announce ADR-0064's **connection-wide full-GM
service-account requirement**, independent of whether a module declares migrations.
Administrators using Assistant service accounts must change them to Gamemaster in
Foundry before upgrading; release notes must link the
[configuration/retry procedure](CONFIGURATION.md#service-account-role-and-recovery).
Core **0.19.0** shipped SDK **3.3.0**, module-api **1.5.0** and UI API **3.2.0**;
roll-engine-api remains **1.0.0**. Its original small-world native v13/v14 gate
does not by itself establish the later complete-maintenance correction's native
acceptance. ADR-0064 records the subsequent completed Core v13/v14 gates and
CR64-27 operator acceptance. Adopting modules still need their own verification
and supporting release/toolchain pins. Do not
claim these additions shipped in Core 0.18.1 or change human Assistant permissions.
Application metadata still belongs to release:tag; a changelog heading does not
perform release preparation. See [module adoption requirements](MODULE_MIGRATIONS.md#compatibility-and-adoption).
