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

- Requires `main`, a newer stable version, matching current package/lock
  versions, and no existing local tag with the requested name.
- Refuses unrelated staged, unstaged, or untracked work and unfinished Git
  operations. Only a hand-written `CHANGELOG.md` edit may be pending.
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

An already-prepared version uses a separate resume path rather than the
new-version check:

```sh
npm run release:tag -- 0.15.1 --resume --dry-run
npm run release:tag -- 0.15.1 --resume
```

The resume dry-run validates the local version, changelog, clean `main`, and
annotated tag without contacting the remote or changing refs. Actual resume
checks remote refs and GitHub workflows, then continues from the missing step.
It recognizes pushes that landed despite a local command error. If main CI
failed and a fix advanced `main`, it moves an **unpublished local** tag to the
fixed commit only after verifying there is no remote tag or GitHub Release.
For a completed failed CI or release run, an interactive resume can offer one
explicit rerun of the same workflow and wait for the new attempt. An interactive
run asks before each missing push. `--resume --no-push` may
repair an unpublished local tag after read-only remote checks, but performs no
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
manually. Do not rerun with a different version just to bypass the failure.

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
