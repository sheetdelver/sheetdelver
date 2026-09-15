# Release Process

Sheet Delver releases are published by `.github/workflows/release.yml` when a
stable semantic-version tag such as `v0.9.1` is pushed.

The root `package.json` version is the application release authority. The
matching `CHANGELOG.md` heading supplies the GitHub Release notes. SDK and
named API contract versions remain independent and are maintained in
`src/shared/sdk/contractVersions.ts`.

## Prepare the Release

1. Start from a clean release branch based on the current `main`.
2. Update the application version without creating a tag:

   ```bash
   npm version 0.9.0 --no-git-tag-version
   ```

3. Add an exact `## 0.9.0` section to `CHANGELOG.md`. Keep release entries
   concise and include at least one bullet.
4. Validate the version and release notes locally:

   ```bash
   npm run release:prepare -- v0.9.0 /tmp/sheet-delver-v0.9.0-notes.md
   ```

5. Run the release gates:

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

6. Commit and merge the version, changelog, and any release changes. Confirm
   the normal CI workflow passes on `main` before tagging.

## Publish the Release

Create the tag from the verified commit on `main`, then push only that tag:

```bash
git switch main
git pull --ff-only
git tag -a v0.9.0 -m "Sheet Delver v0.9.0"
git push origin v0.9.0
```

The release workflow repeats the dependency audit, lint, type checking, tests,
fixture validation, and production build against the tagged commit. It then:

- Verifies that the tag exactly matches the `package.json` version.
- Extracts the matching `CHANGELOG.md` section as release notes.
- Generates a CycloneDX production dependency SBOM.
- Publishes the SBOM and its SHA-256 checksum with the GitHub Release.

GitHub automatically provides source archives for the tag. Sheet Delver does
not currently publish a deployment ZIP because a complete deployment includes
the application shell, Core service, manager scripts, dependencies, and module
layout. Production deployments should check out the release tag and use the
documented install, build, and start process.

## Monitor and Recover

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
git tag -a v0.9.0 -m "Sheet Delver v0.9.0"
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

Pin both the workflow call and `core_ref` to the same tested Sheet Delver
release tag. The explicit toolchain ref prevents a later change on `main` from
altering an older module's release build.
The module tag without its leading `v` must exactly match the version in
`info.json`.

The reusable workflow checks out the module and the pinned Sheet Delver
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
