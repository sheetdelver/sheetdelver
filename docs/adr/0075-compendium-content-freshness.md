# ADR-0075: Revalidate declared compendium contents

**Status:** Completed — automated checks and operator verification passed
**Date:** 2026-10-27

## Problem and evidence

Core reused full compendium documents when an index hash of document IDs and
names matched its persisted manifest. Embedded effects, system data and other
same-name content could change without changing that hash. Modification timestamps
and package versions are not reliable content revisions for replaced pack files.

The reported Shadowdark Creator failure establishes a concrete instance. The
production compendium screenshot shows talent `XRW3jhpTni15hwFc` granting `witch`
in its Spell Class effect; SheetDelver's cached document grants
`knight-of-st.-ydris`. An isolated copy of the user's installed native v14 pack
also contains `witch`, as does pinned native4.0.6. Native commit `972d2eff` changes
that exact value. The initial comparison with local v14 alone did not prove a
production/cache discrepancy; the subsequent production screenshot did.

This is a platform cache defect. No system-specific identity, effect rewrite,
Foundry document migration or module rule exception belongs in the correction.

## Decision

This supersedes ADR-0021's zero-transport persistent-hash shortcut and the same
warm-cache statement in ADR-0017. Keep the Store/Service ownership, declaration
boundary, caller authorization, cache-only SDK reads and lifecycle gates.

1. On startup and same-world recovery, read each present module-declared pack
   from Foundry: one full-pack read for `hydrate: true`, or a fresh index read
   with the declaration's fields for index-only packs. A default ID/name index
   cannot validate richer cached content. Absent optional packs remain skipped.
2. Hash the returned declared content with a versioned SHA-256 signature covering
   the declaration's type, hydration shape and requested fields. Canonicalize
   object keys and pack row order; retain embedded array order. Check persisted
   rows as well as the manifest before skipping a disk rewrite. An old ID/name
   hash can never qualify: existing caches update automatically on next bootstrap.
3. Full reads also populate the minimal discovery index locally, avoiding a
   redundant index request. Persistent shards survive shutdown/reconnect; their
   existence never replaces source validation. Unchanged contents avoid rewrites.
4. Hydration failures reject startup/context recovery before ready publication.
   Do not log a failure and continue with stale data. Retain the old disk snapshot
   for retry, but do not claim it was freshly validated. Existing scope fences
   reject replies after pack invalidation or world retirement.
5. Live pack events rehydrate only the affected declared pack, then rebuild the
   adapter context using existing ingress/lifecycle handling. No periodic polling
   or extra transport per sheet, picker, request or ordinary cached read.

## Costs and boundaries

Warm startup/reconnect now reads declared content even if unchanged. Foundry's
available ID/name index does not provide a trustworthy digest of embedded data;
correctness requires this bounded read. There is no broad scan of undeclared
packs, recurring timer or second module cache. Index fallback transports retain
existing behavior; the normal successful path uses one request per pack.

Application version remains 0.22.1; SDK/API versions and module requirements are
unchanged. No production cache deletion or Foundry edits are required. Deploying
this code and restarting Core revalidates and repairs stale declared snapshots.
Release publication remains separate from this implementation closeout.

## Verification

The maintained compendium hydration suite reproduces the same-ID/name effect
failure before the fix, then proves legacy replacement and a later content edit
with the new manifest. It covers field-aware index updates, unchanged-content
reuse after an authoritative read, empty/absent packs, no transport for ordinary
Store reads, failed refresh without fresh evidence, and a retired in-flight read.

Bootstrap tests establish that a hydration error prevents adapter initialization
and ready state, retry can recover, and a live pack refresh scopes its read to
that pack. Existing compendium Store/Service/scoped-reader and adapter lifecycle
regressions remain the relevant retained checks. Native v14 pack inspection was
read-only from a temporary database copy; automated tests use isolated sources.
An isolated replay of the actual stale cached Talent rows against an extracted
local v14 native pack replaces the incorrect grant with `witch` in one full-pack
read. The production cache file remains byte-for-byte unchanged by that test.
Typing, targeted production lint, ADR metadata and the retained suites pass.
After the operator restarted Core on 2026-10-27, the application log recorded
`shadowdark.talents` refreshed at 04:33:48.531 UTC and all 16 declared packs
hydrated at 04:33:49.041 UTC (0 unchanged, 0 missing). Compendium hydration took
2362.0 ms; bootstrap completed successfully in 7009.3 ms. The persisted Knight
casting grant now reads `witch`. The user subsequently verified the Character
Creator and accepted closeout. This confirms the reported stale-content failure
is resolved without editing Foundry documents or manually deleting cache files.


### CI integration synchronization correction

PR #64 exposed a timing error in the retained adapter-lifecycle integration
fixture: it requested refresh before event-driven persistent invalidation had
finished, allowing shard deletion to overlap the new write. A single event-loop
turn did not wait for filesystem work. The test now awaits the actual
invalidation promise before requesting refresh and checks that the refreshed
source remains stored. Production ingress already sequences those operations;
no runtime guard or cache failure is suppressed by this test correction.
The full integration suite, TypeScript check and ADR metadata check pass after
this correction. Hosted CI still requires the follow-up commit and rerun.
