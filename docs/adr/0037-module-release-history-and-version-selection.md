# ADR-0037: Module Release History and Version Selection

**Status:** Accepted - Implemented
**Date:** September 14, 2026
**Supersedes:** None
**Revises:** ADR-0035 (historical remote version browsing)
**Related:** ADR-0003, ADR-0004, ADR-0027, ADR-0035, ADR-0036

---

## Context

ADR-0035 introduced public manifest distribution using a central discovery
catalog and module-owned GitHub Releases. Its first implementation intentionally
resolved only the latest release. Operators can verify and install updates, but
cannot select an older published version to test compatibility, recover from a
bad release, or deliberately hold a deployment at a known version.

The secure archive transaction already accepts an immutable release-manifest
URL and treats install and upgrade as separate operations. Artifact policy also
already supports exact version pins and locks. The missing capability is a
bounded way to discover the immutable manifests owned by one module repository.

## Decision

Each module release will publish `sheet-delver-releases.json` alongside
`sheet-delver-manifest.json`. The document uses the
`sheet-delver-release-history.v1` schema and contains only:

- the canonical module ID
- a generation timestamp
- at most 100 unique release versions
- the immutable HTTPS release-manifest URL for each version
- the core and SDK compatibility declaration copied from that release manifest

The central catalog remains a discovery pointer and does not become a release
database. Sheet Delver derives the history URL as a sibling of the catalog's
stable latest-manifest URL. A missing or malformed history document is a supported legacy
state: the source remains usable for its latest release when compatible, but
does not offer a version selector. Valid history must include the release
resolved by the stable latest-manifest URL.

The reusable module release workflow generates history from existing,
non-draft, non-prerelease GitHub Releases plus the release currently being
published. Module authors do not maintain version metadata by hand. Every
selected manifest is fetched and validated through the same HTTPS-only,
allowlisted distribution client, and its module ID and version must match the
validated history entry before an archive is downloaded.

The admin catalog review presents available releases in publisher order, with
the newest release selected initially. Installing a historical release is
allowed. Replacing an installed release with another version continues through
the existing upgrade transaction regardless of version direction. Selecting an
earlier version is described as a downgrade and requires an explicit operator
acknowledgement before apply.

Locks and exact version pins remain authoritative. Selecting a version does not
implicitly pin it. A locked module cannot change version; a pinned module can
only be changed to the pinned version. Existing dry-run compatibility, trust,
permission, dependency, conflict, integrity, local-source collision, atomic
promotion, and supervised restart behavior is unchanged.

## Consequences

- Existing catalogs and older module releases remain latest-only compatible.
- Historical selection does not depend on GitHub's API at application runtime.
- A publisher can remove a history entry without invalidating an already
  installed artifact, but the removed release can no longer be selected remotely.
- The selected release is still authenticated by its release manifest and
  archive digest; the history document is discovery metadata, not executable
  trust evidence.
- Operational rollback becomes an explicit selection of a previously published
  version. Transaction rollback after a failed mutation remains automatic.

## Implementation Plan

- [x] Define and test the release-history schema.
- [x] Resolve history and selected manifests through the distribution client.
- [x] Extend catalog admin endpoints with release listing and target selection.
- [x] Add version selection and downgrade acknowledgement to the admin UI.
- [x] Generate release history in reusable module release workflows.
- [x] Update catalog, release, module-author, API, and architecture guidance.
- [x] Verify version selection, downgrade approval, upgrade policy, pin, lock
      and latest-only fallback through automated checks and user release-workflow
      acceptance; evidence and limits are recorded below.

## Closeout (September 22, 2026)

Implementation merged in `a1bfda2` (PR #22). Later module releases published
history; the user confirmed the selector showed both releases and an available
update, then reported "1-7 confirmed" for the acceptance sequence. The earlier
latest-only HTTP 404 fallback was also observed before release history became
available. These are user reports, not new agent-run production tests; the
numbered prompt is not reproduced here as independently observed evidence for
every individual interaction.

The full unit suite passed again on September 22. Release-history and public
release tests cover schema/identity checks, compatible-version filtering,
selected-manifest validation, missing/incomplete history fallback, explicit
downgrade approval and digest rejection. Archive-operation tests cover pins,
locks, upgrade and preservation of the local source. Transaction tests cover
rollback separately from selecting a historical release. Network behavior uses
injected transport fixtures; no hosted Foundry instance was contacted.

This closes the original implementation/acceptance task. Retain these cases as
regression coverage, not an automatically recurring release blocker. A concrete
new failure should be tracked as a new issue.
