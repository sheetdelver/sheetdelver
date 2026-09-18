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
releases. The helper itself never fetches, pulls, switches branches, or pushes.

Use the local release command to preview a new version and short changelog
bullets (the version below is illustrative):

```bash
npm run release:tag -- 0.11.1 --note "Fixed example issue" --dry-run
```

Repeat without `--dry-run` to prepare it. Add multiple `--note` arguments for
multiple terse bullets. Alternatively, manually write the exact
`## 0.11.1` changelog section and omit `--note`.

The command:

- Requires `main`, a newer stable version, matching current package/lock
  versions, and no existing local tag with the requested name.
- Refuses unrelated staged, unstaged, or untracked work and unfinished Git
  operations. Only a hand-written `CHANGELOG.md` edit may be pending.
- Shows the package version changes, changelog section, commit, and tag.
- Updates `package.json`, both root version fields in `package-lock.json`,
  and the changelog entry without changing dependencies or SDK versions.
- Commits only those three release files and creates an annotated tag on that
  commit. It never replaces tags, creates branches, or performs remote writes.
- Prints the push commands for you to run.

`--dry-run` performs the same validation and prints the plan without changing
files, the index, commits, or tags. Blockers produce a nonzero exit status.
Run `npm run release:tag -- --help` for the argument summary.

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

The helper has already created the local tag. Push the release commit first:

```bash
git push origin main
```

After main CI passes, push only the intended release tag:

```bash
git push origin v0.11.1
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

With GitHub CLI installed and authenticated:

```bash
gh run list --workflow release.yml
gh run watch <run-id>
gh release view v0.9.0
```

Rerun a failed workflow only when the failure is transient. Correct source,
version, changelog, or test failures in a new commit and use a new release
version.

An unpushed local tag may be deleted and recreated at the intended commit:

```bash
git tag -d v0.9.0
git tag -a v0.9.0 -m "SheetDelver v0.9.0"
```

Never move or replace a tag that has already been pushed or published. Release
tags are immutable records; publish a new patch version instead.

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
