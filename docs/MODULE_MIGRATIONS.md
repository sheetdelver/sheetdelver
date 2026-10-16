# Native world context and module maintenance

Unreleased Core implementation of [ADR-0064](adr/0064-module-world-context-and-data-migrations.md).
The aggregate SDK additions are 3.3.0, module-api 1.5.0 and UI API 3.2.0. They are
not present in released Core 0.18.1. Module adoption and disposable-world native
acceptance remain separate gates. Application/module release numbers are unchanged.

## Rule inputs

`info.json.worldSettings` is separate from browser-local `settings`. Declare exact
native-system keys, `scope: "world"`, a compared-triple `systemVersion` range,
`schema`, `affectsPreparation` and `exposure` (`server`, `authenticated`, `gm`).
Only the module's native namespace is accepted; arbitrary core/package keys are
not grants. A proven optional default supplies `{ value, source, systemVersion }`.
Unknown defaults stay unavailable. Schemas support JSON type, nullable, enum,
numeric minimum/maximum and string maxLength. Values are bounded JSON, not code.

```json
{
  "key": "example.useVariant",
  "scope": "world",
  "systemVersion": ">=1.0.0 <2.0.0",
  "schema": { "type": "boolean" },
  "default": { "value": false, "source": "native example 1.0.0 settings registration", "systemVersion": "=1.0.0" },
  "affectsPreparation": true,
  "exposure": "authenticated"
}
```

`runtime.world?.snapshot()` returns a deeply frozen snapshot. Its identity contains
opaque Foundry-instance identity, world/system/native versions, Foundry generation/
build, runtime epoch and context revision. `world.settings.get(key)` distinguishes
`world`, `registered-default` and `unavailable`; preserve false, zero, null and empty
strings. A ready Store with no **world** row is different from an unreadable Store.
User rows with the same key cannot supply a shared value. An old-world handle fails
closed. The optional type permits older SDK mock hosts; this host supplies it after
source seeding. It is not a writable settings API.

Preparation receives `context.world` and `context.contextRevision` independently
of Actor source revision. `onWorldContextChanged(next, {keys, recovery, packs})`
refreshes adapter dependencies before Core rebuilds and publishes prepared data.
Keep it bounded, read-only and revision-aware. Source ingress continues during the
refresh; preparation uses the latest source after the asynchronous barrier. Failed
refresh holds world work unavailable instead of publishing old values as current.
Recovery refreshes context without normal adapter reinitialization.

The React `useWorldSetting(key)` hook reads the authorized host projection, not
localStorage or native Setting documents. It returns `{result, revision}` and
retires stale HTTP results on session/world/module changes. Filtered
`world:contextChanged` invalidations contain revision/keys, never setting values.
For a setting-dependent dialog, send `X-SheetDelver-Context-Revision` with its saved
revision, or explicitly validate it using `runtime.world.assertRevision(revision)`.
Current request runtime operations also pin their starting context across awaits.

## Catalog and pure hooks

Keep migration maps and entry pointers **out of info.json**. The conventional root
file is `migration.json`:

```json
{
  "schemaVersion": "sheet-delver-migrations.v1",
  "systemVersions": { "1.0.0": "migrations/1.0.0" }
}
```

These are **native game-system** milestones, not module or Foundry versions. Each
directory has `definition.json`, for example:

```json
{
  "schemaVersion": "sheet-delver-migration-definition.v1",
  "dataReadVersion": ">=1.0.0 <2.0.0",
  "steps": [{
    "id": "normalize-example-key",
    "revision": 1,
    "description": "Normalize a legacy source key",
    "dependencies": [],
    "systemVersion": ">=1.0.0 <2.0.0",
    "foundryGenerations": [13, 14],
    "required": true,
    "targets": ["Actor"],
    "paths": ["system.example"],
    "hooks": { "check": "check.ts", "plan": "plan.ts", "verify": "verify.ts" }
  }]
}
```

Hooks default-export synchronous functions over `MigrationHookInput`. `check`
returns current/migration-needed/unresolved; `plan` returns patch/no-op/unresolved;
`verify` returns `{valid, reason?}`. Input is cloned, frozen JSON containing the
target, authoritative context, bounded related sources and declared parameters.
No runtime, adapter, transport, file/database or identity selector is supplied.
Use exact UUIDs and actual source shapes, including partial deltas. Missing or
unresolved source is not permission to fabricate a value.

Optional `reads: {targets, packs, settings}` declares cross-document world kinds,
exact world-pack IDs and declared setting keys. Omission exposes only the current
target, with no references or setting values. Each optional `parameters` property
must match its corresponding `parameterSchema` (`WorldValueSchema`); unknown or
missing parameters reject the catalog. Aggregate parameters are bounded to 64 KiB.
Partial delta targets carry `baseActorUuid`; the base remains a separate source,
not a synthetic materialized delta. Parameters/read dependencies are digest-bound.

Packaging separately bundles each hook as `.cjs`, rewrites the packaged definition,
and validates the same catalog. Relative imports must remain confined; remote,
builtin and other external imports are rejected. Execution verifies code digests
and uses a timeout-bound VM with no supplied clock/network/filesystem/random API.
This extends the trusted-plugin model, **not an OS security sandbox**. Each hook
has a one-second limit; the current synchronous plan has a five-second computation
budget and fails without approving a partial plan if exceeded.

Definitions constrain update-only targets and field prefixes. Core rejects identity,
ownership, role, core flags, undeclared flag namespaces, unsafe keys and unsupported
operations. Dependencies, not JSON/lexical version order, select cumulative steps.
Keep immutable historical step IDs/code for supported skipped upgrades; changing
or removing a previously applied step requires a new stable ID, not silent reuse.
Catalog absence is backward-compatible; a malformed catalog is never absence.
Migration-bearing modules must exclude module-api 1.4 and older. Their release
manifest uses `sheet-delver-release.v2` with a **derived** catalog digest/count;
uploaded/public archives verify parity. Migration-free releases remain v1.

## Admin operation

Existing uploaded/public archive dry-runs now include package governance and a
separate world plan. Source selection and same-version repair use the installed
module detail's world-maintenance review. Candidate hooks are compiled into Core-
owned staging for local sources; author directories remain untouched. Preview does
not initialize a candidate adapter, register its routes or write native data.

The selected world must be running, match the candidate system and have fresh
source/setting/pack inputs and a qualified service identity. Setup, stopped/wrong
world, unsupported chain, missing rights or unresolved required scope blocks before
file promotion. The admin can launch the selected world separately and rerun checks.
An inactive managed candidate beside an active local source cannot silently replace
that source or migrate an unrelated world. There is no offline database operation.

Approval pins artifact/tree/catalog/hook digests, world/native identity, context,
inventory and source fingerprints in an expiring 15-minute plan. Apply requires
that exact plan ID, an idempotency key and a current SheetDelver admin principal.
Source/artifact changes require another preview. Each write-bearing job records
the backup-warning acknowledgement: SheetDelver cannot back up/restore the world or
undo migration changes; interrupted writes may be partial. Back up through Foundry
first; an external restore may discard changes since that backup. No backup existence
is claimed or verified.

The durable sequence is inspect → approve/quiesce → retain/promote → restart in
maintenance → migrate/read back → verify/prepare → activate/complete. Files installed,
adapter serving and world-data ready are distinct outcomes. Job acceptance is HTTP
202, not completion. A retained previous package protects pre-write installation
recovery, not world data. Interrupted pre-write file/registry transitions require
admin cancellation/review; never guess which package is safe after possible writes.

Owner-only jobs/plans live under `<DATA_DIR>/config/module-upgrades`, outside
evictable/module caches. File intent and per-target native intent are durable before
side effects. A lost acknowledgement requires source reconciliation, not blind
replay. Required postconditions precede adapter initialization/preparation and
readiness. Every bootstrap/replacing recovery checks actual fresh sources even if
a job was completed: external restores/new legacy documents cannot borrow an old
completion exemption. Startup can resume an approved job, not approve new repairs.

A regressed partial job requires **Review changed source**, then a new exact plan
and backup acknowledgement. It keeps the original job/lease and historical write
outcomes; it does not quietly reinterpret the old approval. Retained files have no
automatic expiry: an admin may clean them only after completion. Journals remain.
Unreadable journal state blocks world work but leaves admin login/status reachable;
preserve the records and reconcile the filesystem before recovery. Never delete
locks because a timeout elapsed; an empty/interrupted lock needs operator review.

One shared `SHEET_DELVER_MIGRATION_LOCK_DIR` is required for multiple Core installations
against one Foundry instance. Without it only a single installation is supported.
World and module locks fence dispatch; no TTL steal is used. Same-host restart
takeover requires the old PID to be absent; cross-host orphan recovery needs operator
reconciliation. These locks do not lock native Foundry clients or supply atomic CAS.
Avoid external edits during maintenance; source conflicts remain possible.

SheetDelver gates new HTTP/module/socket work and delayed dispatches, drains sent
ordinary operations and keeps native ingress/admin inspection available. The shared
player boundary shows a non-dismissible maintenance state. Admin progress/recovery
remains reachable without waiting for player readiness. Successful activation rotates
a non-secret runtime token; stale clients must reload before new mutations.

Restricted targets include world Actors/Items/effects, explicit unlinked ActorDelta
data and unlocked world-owned Actor/Item packs. Shared bases are enumerated once;
tombstones remain tombstones and no full synthetic Actor is written into a delta.
System/package packs are not unlocked or migrated. Pack receipts remain outside
primary world Stores. Actual native v13/v14 target acceptance is still pending.

## Caller reads and identity

Request document/compendium/UUID reads share native pack authorization and recheck
it after awaited cache/resolver access. Initialization reference caches do not grant
caller access. `req.runtime.access` exposes effective pack capabilities/filtered
metadata, not raw users, permission maps or Settings. Writes remain user-bound;
maintenance transport never becomes a module permission fallback.

`getSystemDataForUser` is the caller-safe adapter projection for `/api/system/data`.
It receives caller-bound documents/compendium/access/world, not the privileged
bootstrap runtime. Do not return a previously populated privileged cache. Without
that projection the opaque legacy method is full-GM-only. The legacy Scene
inspection endpoint is full-GM-only; no general Scene SDK is added by this work.

Actor responses retain canonical source strings. `referenceLabels` is a separate
UUID-to-label map filtered by current pack access; it is not writable identity.
Same-name or cross-pack documents cannot be reverse-mapped from a display label.
LIMITED and owner-editor projections retain their existing distinct boundaries.

## Verification and adoption

Tracked regressions: `src/tests/unit/world/module-world-migrations.test.ts` and
`src/tests/integration/module-upgrade-boundaries.test.ts`. The integration fixture
uses actual bootstrap, archive renames, Core dispatch/ingress and Stores with an
offline wire and injected restart. It is not a native permission or actual process-
replacement acceptance result. The ADR records remaining matrix/gate evidence.

G8 module adoption is separate: declare native settings with versioned provenance;
create lossless source-derived catalog/hooks and tests; implement dependency refresh;
use caller capabilities on all served collections/cards; remove caller/UI repair
routes. After a supporting Core release exists, adopt its tested SDK/toolchain minima.
Do not publish a dependent module against an unavailable host release.
