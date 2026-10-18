# Native world context and module maintenance

Core **0.19.1** supplies complete maintenance, bounded relations and the
CR64-01–22-R1 corrections recorded in [ADR-0064](adr/0064-module-world-context-and-data-migrations.md).
Selected Core native v13/v14 evidence remains valid; module adoption is separate.
The [four-issue G8 correction amendment](adr/0064-module-world-context-and-data-migrations.md#g8-integration-correction-amendment--october-18-2026)
reopens only CG-7 (pack lock defaults), CG-9 (permission-driven collection refresh),
CG-10 (packaged SDK error recognition) and CG-5 (shared roll-dialog keyboard use).
These corrections are implemented on the corrective branch, not released in
0.19.1. Independent review and focused final-source native v13/v14 acceptance
passed. The user's October18 conditional closeout is satisfied; supporting publication
remains pending. CG-5 is not a migration blocker.
Module work is held for this selected Core point-release sequence. Earlier dated
review sections below retain historical evidence, not additional active gates.
See [maintenance runtime](MAINTENANCE_RUNTIME.md) for lifecycle owners, recovery
limits and durable-format compatibility.

## Compatibility and adoption

The current released baseline is **0.19.1** (`v0.19.1`, local release commit
`10213980`). Modules should require the tested supporting Core release and pin
both validation and release toolchains to it. Corrections selected on October 18
need a later published point release; its version is confirmed at release time,
not inferred from a development checkout. No module metadata changes in this
Core-only slice.

| Surface | Provided in Core 0.19.1 | Module compatibility requirement when adopted |
| --- | --- | --- |
| Aggregate SDK | 3.4.0 | Informational; no separate `sdkVersion` manifest property. |
| `module-api` | 1.6.0 | Migration catalogs retain a 1.5.0 introduction floor; bounded relations require `>=1.6.0 <2.0.0`. |
| `ui-extension-api` | 3.2.0 | `>=3.2.0 <4.0.0` when using its client setting/context APIs. |
| `roll-engine-api` | 1.0.0 | Retain the module's existing compatible range. |

Core 0.19.0 supplied SDK 3.3/module-api 1.5; 0.18.1 lacks the world-context and
migration contracts. The four selected fixes aim to preserve existing public
contracts. Do not pre-bump SDK/API versions without an actual surface change.

The current correction uses native v13/v14 lock precedence: the world's
`core.compendiumConfiguration[packId].locked` overrides the package-ownership
default. A verified world pack defaults unlocked; system/module packs remain
excluded from migration writes even when unlocked. `metadata.locked` is not the
native override. Unavailable/malformed configuration or unresolved ownership
blocks required work. Package envelopes supply provenance and world namespaces;
a `world.` prefix or hydrated read cache alone never proves write permission.
Live snapshots and final dispatch retain lock/authority/revision fencing; no
automatic unlock, required-target omission or approval change is introduced.

Versions come from `src/shared/sdk/contractVersions.ts`; modules access public
exports through `@sheet-delver/sdk`, never private host imports. Declare API
requirements under `info.json.compatibility.apiContracts`, separately from
`compatibility.coreVersion` and the module's own release version.

Adoption includes authoritative settings, bounded dependency refresh, packaged
pure migration hooks and caller-safe projections. Non-full-GM `/api/system/data`
requests require `getSystemDataForUser`; the host returns 403 when it is absent.
Test the Core/module pair's player flows before deployment. Existing bootstrap
caches and a GM-only test run cannot establish caller-safe compatibility.

### Selected correction and module-work hold

The earlier complete-maintenance hold was satisfied by the reviewed Core work and
0.19.1 release. G8 resumed, then exposed the integration findings now selected in
the [four-issue G8 correction amendment](adr/0064-module-world-context-and-data-migrations.md#g8-integration-correction-amendment--october-18-2026).
Module implementation/acceptance and dependent publication are held again until
this correction/review/point-release sequence completes. Core-owned acceptance
may consume an unchanged module archive in isolation; it does not establish full
module compliance. Only CG-7 directly concerns migration eligibility; the other
selected rows have their own access/error/UI acceptance criteria.

### Retained complete-maintenance behavior and evidence

The selected design stops the ordinary Core/Next runtime and restarts a
maintenance-only composition under the existing supervisor. Only maintenance
UI/admin controls, one necessary service-account transport/observation path and
the migration controller/workers remain active. Normal routes, user sockets,
session restores, module callbacks and background jobs remain stopped. Full
authoritative inventory/planning and reviewed write approval occur after that
isolation; an online dry-run is advisory. Verified completion and a controlled
fresh serving activation are required before access reopens.

Healthy work must complete across every required supported target without a
whole-job timeout or manual batch resubmission. Interruption by transport/process
failure retains maintenance and durable progress for verified continuation.
Readiness requires the real host/native v13/v14 coverage matrix, including world
packs, deltas, representative size, background-work isolation, recovery and
rendered maintenance—not only passing hook fixtures. No unconditional immunity
to external failure is implied. The remaining sections describe released behavior
and historical evidence. The October 18 amendment above governs the current
selected corrections and hold.

**Historical review:** the independent review of `5013e86` found five Core defects
despite passing automated suites. Their corrective implementation and evidence are in
[ADR-0064 CR64-01–05](adr/0064-module-world-context-and-data-migrations.md#independent-core-review--october-16-2026).
Tracked regressions now cover preview consistency, reference-dependent resume,
managed repair digests, first-upgrade browser reload and failed-context recovery.
Isolated rendered/replacement checks are distinct from native acceptance
and module adoption. The [corrective independent review](adr/0064-module-world-context-and-data-migrations.md#corrective-independent-review--october-16-2026)
identified CR64-06 (observed pack-content fencing) and CR64-07 (player theme
acceptance). Both are now corrected with failing-before/passing-after evidence in
the [follow-up](adr/0064-module-world-context-and-data-migrations.md#cr64-0607-corrective-implementation--october-16-2026),
with [independent confirmation](adr/0064-module-world-context-and-data-migrations.md#cr64-0607-independent-confirmation--october-16-2026) of the original reproductions and current suites.
The [native v14 pass](adr/0064-module-world-context-and-data-migrations.md#native-v14-acceptance-and-cr64-08--october-16-2026)
verifies actual14.367 writes, setting refresh, role enforcement, supervised
activation and admin recovery, with measured test-world inventory costs. It also
corrects CR64-08's null-delta enumeration. The [native v13 pass and G8 handoff](adr/0064-module-world-context-and-data-migrations.md#native-v13-acceptance-and-g8-handoff--october-16-2026)
verify13.351 with the same native system4.0.6. At that checkpoint G8 adoption
and user review remained pending; the measured small worlds did not establish
large-world capacity. Later complete-maintenance evidence is recorded in the ADR.
Do not treat generic Core fixtures as module compliance or migration-release approval.

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
After failure, an admin can **Retry world preparation** from Installed's
**World preparation requires attention** diagnostics.
The retry reruns source compatibility and preparation; it does not authorize repairs
or release unrelated gates. A hook timeout cannot cancel module JavaScript: Core
prevents overlapping preparation, including across world teardown, until that hook
settles. The admin diagnosis recommends a Core restart if it never settles.

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

**Unreleased CR64-10 correction:** `reads.relations` selects `parent`, `ancestors`
(closest first), or `baseActor`, independently of world-pack names. For example:

```json
{"reads":{"relations":[{"relation":"ancestors","forKinds":["ActiveEffect"],"fields":["type","system.category"],"required":true}]}}
```

Each declaration projects only its safe source `fields` (1–64 paths); at most
three distinct relations are allowed. Entire `items`/`effects` collections and
prototype paths are rejected. Canonical UUID/kind/pack/base identity remains
attached. Missing required relations reject the exact target with a reason;
optional absent relations stay absent. Null and partial ActorDelta fields stay
null/partial; `baseActor` is separate, never a materialized delta. Hook input
and pre-send dependency evidence bind selected relations. No world pack ID is
hardcoded by Core. This addition requires module-api 1.6.0; the old broad
`reads.targets`/`reads.packs` contracts and historical steps remain supported.

Packaging separately bundles each hook as `.cjs`, rewrites the packaged definition,
and validates the same catalog. Relative imports must remain confined; remote,
builtin and other external imports are rejected. Execution verifies code digests
and uses a timeout-bound VM with no supplied clock/network/filesystem/random API.
This extends the trusted-plugin model, **not an OS security sandbox**. Each hook
has a one-second limit. **Unreleased CR64-09 correction:** complete computation
runs in Core-owned workers with durable progress and no global five-second
inventory ceiling. Compiled scripts are reused within a job; every invocation
still receives a new isolated VM. Initial/final inventories are complete. Bounded
plans refresh relevant native roots during execution and group compatible native
updates (at most 50 rows/512 KiB per envelope). These are automatic transport
bounds, not total inventory limits or new approval boundaries. Every target
intent precedes send, exact readback follows it, and uncertain batches reconcile
without blindly replaying confirmed writes. Legacy broad dependencies retain
complete reads rather than weakening approval semantics.

**Unreleased CR64-11/12 corrections:** specific bounded step/target/phase reasons
survive planning and durable recovery; public clients receive generic maintenance
only. General v13 pack reads follow native role ownership, including Player
OBSERVER access, separately from combat-management permissions. Caller checks
and warm-cache revocation remain mandatory; no privileged fallback is introduced.

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
Preview reads are isolated from serving Stores and prepared/context publication.
Only declared source domains are read; live scope/revision changes invalidate the
snapshot. Managed repair copies packaged hooks byte-for-byte rather than compiling
them again, preserving historical integrity. Gated preparation, not preview, owns
serving reconciliation and rebuild.

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
Each operation records its exact reference membership/content and approved
simulation effects. Resume checks dependencies before native intent/send, including
earlier approved transformations. An uncertain write is reconciled only against
approved readback; changing dependencies requires a new reviewed plan. This is not
native atomic compare-and-swap or a lock against external Foundry clients.

Pack content has a separate, Core-owned observation revision: accepted document
mutations, batch entries, autosaves and catalog mutations advance it synchronously
before asynchronous cache invalidation. Snapshots capture the applicable writable
world packs and exact declared read packs, even when no adapter is ready. A change
observed during multi-pack reads or before the final dispatch retires that source
snapshot; pack metadata alone is not a content fence. Ordinary reads/cache
population do not advance this revision, and cache failure or late completion
cannot restore an old stamp. Module `compendiumPacks` declarations and context
refresh are not prerequisites for migration fencing.

Retirement before native intent sends nothing. Retirement after durable intent
retains possible-write/uncertain evidence, even if the final send was blocked.
Resume still requires exact dependency/source readback; changed inputs need a new
review and backup acknowledgement, retaining prior approval/outcome history. This
does not detect edits Core has not observed after dispatch and is not native CAS.

The current 0.19.0 sequence is inspect → approve/quiesce → retain/promote → restart in
maintenance → migrate/read back → verify/prepare → activate/complete. Files installed,
adapter serving and world-data ready are distinct outcomes. Job acceptance is HTTP
202, not completion. A retained previous package protects pre-write installation
recovery, not world data. Interrupted pre-write file/registry transitions require
admin cancellation/review; never guess which package is safe after possible writes.

The complete-maintenance addendum supersedes that execution order for the
correction: optional online preflight → persistent maintenance and normal-worker
shutdown → maintenance-only startup → complete authoritative plan → reviewed
approval → retain/promote → migrate/read back → verify/prepare → activate/reopen.
Entering maintenance does not itself authorize writes. An approved unchanged job
does not need another approval per batch, elapsed interval or ordinary resume.
The pre-approval preview expiry must not expire an executing approved job.

The corrective journal stores complete logical plans in digest-verified paged
`plan-content/` bundles (`core-migration-plan.v3` references), with exact dependency
deltas rather than repeated whole-world maps in metadata. Individual records
retain32MiB bounds; total inventory is not truncated. Preview/job HTTP reviews
retain all targets, patches and logical approval digest, omitting private
dependency/effect maps. Catalogs/hooks and the module SDK input do not change.
Legacy inline approvals remain readable; oversized inline records are imported
with their exact digest and retained original `.legacy-inline` bytes. Prior
approvals and receipt streams remain durable. Preserve the entire directory
during recovery; no block pruning or downgrade-to-0.19.0 recovery is supported.
Existing v2 loose blocks remain readable. Core owns a serialized storage worker:
encoding, digest checks, cold/legacy loading and fsynced atomic publication finish
before approval authority or native sends. Modules need no new hook/SDK contract.
The runtime guide describes worker ownership, cancellation and recovery boundaries.
Diagnostic progress is process-local between durable state checkpoints. It is
not an approval, receipt, inventory limit or signal to dispatch/replay a write.

First approval publication is recoverable: a provisional maintenance intent pins
the exact operation, plan, artifact, principal and lease before the first durable
job. It grants no promotion/write authority. Cancellation/startup joins the writer
and reads back outside the aborted computation signal. A published job is bound
only after complete validation and re-established durability; an unpublished
intent can return through proven-drain cancellation without manual journal edits.
Missing/corrupt previously active approvals or orphan receipts remain gated,
never treated as permission to clear maintenance. The same exact approval survives
lost acknowledgements; no automatic native replay or new SDK/module mechanism is
introduced. See the runtime guide for lease takeover and recovery boundaries.

Single and batched native readback must match the exact approved resulting source
(apart from supported `_stats` normalization) and still-current snapshot before
confirmation. Unrelated changes retain intent/recovery; they do not authorize
replay or undo. Every exit from isolation requires a proven durable ordinary-send
drain, regardless of diagnostic text or process restart. Final asynchronous
bootstrap validation rechecks freshness before readiness/publication. Admin
preparation retry shares normal lifecycle readiness events and authorizes no new
repair. See [the runtime guide](MAINTENANCE_RUNTIME.md) for operator recovery rules.

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
Even null-to-first activation retires an already-observed browser. Its old code
retains its old mutation header until reload; it cannot adopt replacement authority.

Restricted targets include world Actors/Items/effects, explicit unlinked ActorDelta
data and unlocked world-owned Actor/Item packs. Shared bases are enumerated once;
tombstones remain tombstones and no full synthetic Actor is written into a delta.
Native unlinked tokens can store `delta: null`: with a valid base Actor, there are
no persisted overrides to migrate. Core skips that empty delta without creating
one. Tokens with no Actor association are also skipped; broken Actor references
and malformed stored deltas still block required enumeration.
System/package packs are not unlocked or migrated. Pack receipts remain outside
primary world Stores. Native13.351 and14.367 target/readback acceptance passes
for the controlled scope recorded in the ADR; module-specific hooks still require
their own acceptance.

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

Tracked regressions include `src/tests/unit/world/module-world-migrations.test.ts`,
`src/tests/integration/module-upgrade-boundaries.test.ts` and
`src/tests/integration/adr0064-corrections.test.ts`. The earlier integration fixture
uses actual bootstrap, archive renames, Core dispatch/ingress and Stores with an
offline wire and injected restart. It is not a native permission or actual process-
replacement acceptance result. The corrective suite separately exercises production
host snapshot/coordinator/source/installed compatibility/admin-route composition.
Explicit isolated operator checks (not part of default service startup):

```sh
npx tsx src/tests/acceptance/adr0064-supervised.test.ts --run-isolated
SD_PLAYWRIGHT_MODULE=/absolute/isolated/playwright/index.mjs node src/tests/acceptance/adr0064-rendered.mjs
SD_PLAYWRIGHT_MODULE=/absolute/isolated/playwright/index.mjs node src/tests/acceptance/adr0064-player-rendered.mjs
```

The browser checks use existing external tooling, never runtime dependencies.
The supervised check copies only Core source/configuration into a temporary
workspace, uses generated data and a fake loopback upstream, and replaces the real
manager's Core/Next children. It does not connect to native Foundry. Inspect
listeners first; the ADR records qualified native evidence and pending release/adoption work.

G8 module adoption is separate: declare native settings with versioned provenance;
create lossless source-derived catalog/hooks and tests; implement dependency refresh;
use caller capabilities on all served collections/cards; remove caller/UI repair
routes. After a supporting Core release exists, adopt its tested SDK/toolchain minima.
Do not publish a dependent module against an unavailable host release.


### Current native acceptance and adoption hold

Core 0.19.1's SDK 3.4 / module-api 1.6 implementation has passing selected
native v13/v14 coverage: representative and 3,194-write inventories, independent
source/receipt comparisons, public install/upgrade/source-switch, recovery,
settings/permissions and rendered maintenance. Focused CR64-21 publication
cancellation/crash/retry also passes on both generations. That Core scope was
closed and released; it does not cover all later G8 integration cases. The
October 18 amendment now owns the scoped correction and renewed module hold.
The current evidence and measured operating costs are in
[ADR-0064](adr/0064-module-world-context-and-data-migrations.md#fresh-complete-maintenance-native-v13-acceptance--october-17-2026).

User review identified an additional Core admin UI follow-up:
[CR64-22](adr/0064-module-world-context-and-data-migrations.md#cr64-22-admin-migration-visibility--october-17-2026).
Independent review confirms the final placement, disclosures and Audit history.
[CR64-22-R1](adr/0064-module-world-context-and-data-migrations.md#cr64-22-r1-correction-and-core-closeout--october-17-2026)
corrects mounted-page navigation: unavailable or malformed targets retire prior
source drawers, previews and controls with an accessible explanation. History
navigation resolves the exact source anew; stale revision checks remain in force.
Manual Details/close choices and disclosures survive stable refreshes. The
backend and retained native migration evidence are unchanged.
Core 0.19.1 provides one Core-owned migration-status projection.
Overview and unrelated admin pages show a compact notice only for required,
blocked, in-progress or recovery states. Installed owns the full status panel
(including unknown, unavailable, checking and passing results), without a duplicate
global notice. Module cards/reviews retain source-specific detail; the restricted
maintenance shell keeps its full reason/progress/next action.
Installed status and source migration cards default collapsed unless they need
attention. Click/keyboard expands them; new attention opens automatically, routine
results collapse, and stable polling does not undo manual toggles. The explicitly
opened source-review drawer stays detailed. **Audit → Migration job history** owns
past jobs, receipts and retained-file/recovery controls. Installed shows only
current status and actionable preparation diagnostics, with a link to history.
“Migration job history” remains separate: empty history, Enabled status, catalog
presence and old completion do not establish current readiness. Each source says
no catalog, unknown/checking/unavailable, freshly up to date, required, blocked,
in progress or recovery required. Known counts are shown; unknown counts are not
invented. A catalog's presence alone does not establish required world changes.

An attention notice identifies the module, actual world, local/managed source and known
version. **Review migration** opens that exact source/world revision on Installed;
**Review migration plan** loads its existing fresh advisory without scanning.
**Check world data** deliberately runs the existing read-only advisory check. A
stale link is rejected rather than redirected to another copy. Inactive copies
are explicitly labeled and cannot inherit the selected source's result. Opening
either action does not switch sources, enter maintenance or authorize writes.

Fresh evidence comes from existing bootstrap checks or explicit source previews,
not page renders. Core retires it on observed world/context/document/pack,
connection/authority or source-file changes. Normal browser status polls are
metadata-only; failed/overdue responses clear the display. A process restart
requires fresh evidence rather than reviving a historical green result. These
are observed-revision diagnostics, not a substitute for execution-time checks.

The standalone shell presents a plain-language reason, exact known identity,
progress and next action before the full technical plan/recovery details. Its
admin-only explanation does not load Next or module code. Required backup
acknowledgement and exact authoritative approval remain separate from advisory
inspection. No migration approval, source-selection or execution contract changed.

CR64-18–21 storage responsiveness, pack metadata, permission-error classification
and first-job publication are Core responsibilities. Module work remains held;
do not add timeouts, manual migration batches, private transports, pack-name
heuristics or UI repair paths to compensate. Native Core fixtures do not establish
compliance of a system module. Supporting application/SDK/toolchain release
versions must be identified after publication; private fixture versions are not
release floors. Bounded relations require module-api 1.6, while existing 1.5
catalog semantics remain supported.

A native source transport returning a pack record does not establish caller
visibility. Both native generations returned hidden records that Core correctly
withheld based on current pack metadata. v13 Assistants retain native GM-like pack
read visibility, while Core's service account must still have role 4. Continue
using caller-bound SDK capabilities, including checks after asynchronous reads
and cache revocation.

Module adoption must preserve exact historical hook bytes: relocated/recompiled
source is not automatically the same artifact (including compiler header bytes).
The native positive source-switch fixture uses its canonical packaging source;
byte-different history was rejected, not normalized or excused. Do not add module
workarounds for Core, silently change published steps, or infer a release floor
from private fixture version numbers. No module work was performed by the native
Core acceptance. Both disposable worlds were restored and test services stopped.
