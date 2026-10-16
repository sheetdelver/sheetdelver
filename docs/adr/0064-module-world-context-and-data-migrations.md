# Core ADR-0064: Module World Context and Data Migrations

**Status:** Proposed — documentation and architecture review only; no implementation or world mutation authorized by this record
**Date:** October 16, 2026
**Related:** Core ADR-0021, ADR-0027, ADR-0028, ADR-0038, ADR-0056, ADR-0057, ADR-0063; Shadowdark module ADR-0001

## Problem and reviewed baseline

Modules need authoritative system world settings during preparation and actions,
and a way to supply document migrations which Core can run as an administrator-owned
module upgrade job.
The user selected this design after Shadowdark's native-alignment work exposed
Pulp luck/ammunition settings and obsolete stored ActiveEffect keys. The desired
migration experience is an admin-reviewed upgrade with automatic execution of its
approved migration steps, without player-triggered repair.
This is a generic extension, with Shadowdark as the first adopting module.

**October 16 design revision:** the user selected the admin upgrade boundary in
place of the earlier standing grant for automatic bootstrap repairs. Decision 3
now makes release inspection, dry-run, maintenance and migration one durable Core
admin operation. Bootstrap may resume that authorized operation; it does not
authorize new migrations. Decisions 1/2 still provide live world-setting context.
The earlier ADR was saved byte-for-byte before this revision; this record contains
the current decision and its rationale without depending on that local snapshot.

**Catalog and recovery refinement:** migration discovery moves out of `info.json`
into a conventional module-owned `migration.json` catalog and version directories.
Bootstrap must validate current source data even when the journal says completed,
so an external Foundry restore can block readiness for admin maintenance. Native
user lockout is excluded. SheetDelver provides no world backup/restore or migration
undo in this scope; admin acknowledges that limit before applying writes.

**Confirmed service-account policy:** the user requires a full Foundry Gamemaster
for Core's connection in every world, not only during migrations. Assistant is
insufficient for the configured service account. Role enforcement and actionable
admin diagnostics are pending implementation under G0a; operator setup guidance
now states the required role. Native lockout remains excluded and the backup/undo
warning policy is confirmed.

Reviewed Core: `ff65695`, application 0.18.1; SDK 3.2.0, module-api 1.4.0,
ui-extension-api 3.1.0, roll-engine-api 1.0.0. Reviewed Shadowdark:
`33ed227`, branch `fix/adr-0001-native-alignment`, manifest 0.9.4, with an
existing uncommitted ADR review addendum preserved. Native system authority is
`release-4.0.6`, `9677d16b3903b3b640f00d4efd48249142ac8334`.
Installed Foundry source inspected locally is 14.367; a 13.351 installation is
available for compatibility fixtures. No service connection or world mutation
was made. The module's proposal is input to this decision, not Core authority.

## Verified Core facts and corrections to the module proposal

| Subject | Existing implementation and consequence |
| --- | --- |
| Adapter authority | `src/shared/sdk/runtime.ts` and `createModuleRuntime.ts`: initialization has system-level **reads**, not writes. It is intentionally different from caller-bound `req.runtime.documents`; modules are not universally unable to update Actors. |
| Caller writes | `moduleDocumentServices.ts` exposes Actor/Item writes and embedded Item/ActiveEffect mutations, including nested parents gated on the root. Writes must use the bound user's transport. Adding a GM-shaped access object cannot impersonate a GM. |
| Maintenance transport | `CoreSocket.dispatchDocumentSocket` already sends `modifyDocument` and emits confirmed ingress events. `CoreSocket` resolves the configured service account by name; login does not guarantee a GM role. Core can implement a runner without exporting that transport to modules. Actual Foundry permissions still govern it. |
| Settings | `SettingStore` already seeds and follows Setting changes. `getValueByKey` selects rows with `user == null`, decodes JSON strings and returns undefined for absent rows. Settings are not in the module document allowlist. Existing Setting invalidations are audience-scoped, not a ready-made public module setting stream. |
| Native setting model | Foundry 14 `client/helpers/client-settings.mjs` implements registration, typed/default values and client/world/**user** scopes; `world-settings.mjs#getSetting` qualifies by key and user. World source rows are not the browser registration registry. Browser `onChange` callbacks are not server SDK methods. |
| Preparation | `WorldBootstrapper` hydrates packs, seeds Stores, initializes the adapter, then builds `PreparedActorStore` before readiness. Same-world recovery refreshes Stores/packs and rebuilds Actors **without initializing the adapter again**. Settings-only changes currently do not become preparation-context revisions. |
| World identity/persistence | `runtime.dataStore` is module-scoped under `<moduleId>/datastore/`; keys are flat. It is neither world-scoped nor a transactional migration ledger. Client `useModuleSettings` is localStorage scoped by world and module; it is not native system settings. |
| Scene/token data | `SceneStore` already mirrors Token/ActorDelta trees, including embedded changes and inherited-child tombstones. General Scene access is deliberately not public. A bounded maintenance target does not require exposing scenes to ordinary module routes. |
| Packs and permissions | Core already retains pack metadata and evaluates v13/v14 Actor-pack access in `nativeCombatPermissions.ts` and `CombatManagerService`, using UserStore, `core.permissions` and `core.compendiumConfiguration`. That policy is not yet a general module capability. Declared hydration is not caller permission. |
| Batching | Despite the SDK comment, `documents.commit` currently preflights then dispatches operations sequentially. It is neither one round trip nor atomic; the migration runner needs explicit bounded batching and recovery semantics. |
| Canonical identity | `ActorService#getActorById` recursively replaces `Compendium.*` strings with names in the prepared response. This is a confirmed separate Core defect, not a reason for modules to reverse-map names. |
| Admin distribution | `registerAdminModuleRoutes.ts` routes public releases/catalogs and uploaded archives through verified archive preparation. Admin network/origin, account, session and CSRF checks already exist; admin login is separate from Foundry GM identity. |
| Current dry-run | `publicReleaseOperations.ts` downloads/verifies the release; `archiveOperations.ts` stages and validates it, checks governance, then discards staging. It checks no world data, migration plan or service-user rights. Apply reacquires the release rather than consuming a pinned world-plan approval. |
| File transaction | `archiveTransaction.ts` promotes by same-filesystem directory renames and keeps a temporary previous directory. `applyLocalModuleArchive` commits/deletes that backup after registry success, before runtime restart. This covers files, not world data or crash-resumable migrations. Its operation lock is only a process-local Set. |
| Restart and readiness | Successful admin mutations schedule a supervised full-stack restart. `WorldLifecycleStore` has offline/setup/startup/active/closed, with no maintenance job state. HTTP `ensureInitialized`, socket readiness checks and `PlayerWorldBoundary` already gate availability, but no durable upgrade admission/drain barrier exists. |
| Release metadata | `releaseManifest.ts` uses `sheet-delver-release.v1` and copies identity, compatibility, permissions and dependencies, not migration metadata. Archive-to-manifest equality checks omit it; the packager currently compiles UI/logic/server entries. All require coordinated extension. |

Source paths above are relative to Core. Native settings defaults were checked
against Shadowdark `system/src/settings.mjs`: `usePulpMode=false` and
`autoConsumeAmmunition=true`. A missing SDK capability is not evidence that the
world is using either default. No conclusion about arbitrary package secrets or
native per-user Setting visibility is inferred from a service-account snapshot.

## Decision 1: a Core-owned, versioned module world context

Add a bounded immutable world-context snapshot, available at adapter initialization,
in the synchronous Actor preparation context, and on request runtimes. Illustrative
names below are design proposals, not callable SDK exports today. Immutable means
each snapshot is stable; a Foundry setting change publishes a new snapshot during
the same session, without requiring a restart:

- `runtime.world.identity`: opaque Foundry-instance identity, world ID, actual
  system ID/version, Foundry generation/build, runtime epoch and context revision.
- `runtime.world.settings.get(key)`: a typed result from the current declared-key
  snapshot, with value/provenance or an explicit unavailable state.
- `ActorPreparationContext.world`: immutable, user-invariant rule inputs and
  their context revision. No mutable Store or transport is exposed.
- `adapter.onWorldContextChanged(next, change)`: optional bounded refresh hook
  for declared setting/pack dependencies, completed before dependent preparation
  and publication. Its exact name/signature is to be finalized at G0.

Identity comes from Core's verified active-world snapshot, not a request body,
module ID, Foundry display name or raw credentials. Modules can namespace local
non-secret work and caches using opaque identity; lifecycle authority stays in
Core. An old runtime handle becomes unusable after retirement. Same-world
transport recovery and new-world bootstrap are distinct events.

Preparation remains synchronous and deterministic. Preload asynchronous declared
reference inputs outside preparation; never call an asynchronous setting API
from each Actor preparation or add a hidden native browser. Core keeps source
revision separate from dependency/context revision. Prepared validity is at least
`(runtimeEpoch, actorSourceRevision, contextRevision)`; changing a setting must
not pretend the Actor source changed or reuse an ambiguous revision.

On setting create/update/delete, Core validates and publishes a new immutable
context, refreshes dependent module inputs, rebuilds affected prepared Actors,
and only then invalidates their authorized client projections. Unrelated keys
need not rebuild Actors. A failed refresh must expose a bounded unavailable state,
not silently retain authoritative-looking values from the old context. Source
mutations that race with a rebuild must be replayed/rechecked before publication.
Recovery performs the same refresh before rebuilding/publishing, even though the
adapter instance is retained. Teardown, module replacement and reconnect cancel
stale work. Pack revision changes follow the same dependency lifecycle.

## Decision 2: declared world settings, not unrestricted Setting documents

Add a separate manifest declaration, tentatively `worldSettings`. Do not overload
the existing browser preference `settings` field. Each declaration specifies:

- exact namespace/key and supported system-version range;
- native scope (`world` in this first delivery), JSON value type/schema and any
  enum/range limits; no executable constructor or native callback;
- native registered default **when independently established**, with source/version
  provenance; a default is optional so an unknown default can stay unavailable;
- whether it affects preparation and which permitted client projection needs it;
- read exposure (`server`, authenticated module UI, or GM UI) under Core policy.

Default namespace allowance is the active module's declared native system, not an
arbitrary prefix supplied by a request. Additional package/core keys need a reviewed
explicit grant. A namespace is not sufficient classification for public exposure:
server-only values must not flow into shared client views, API errors or logs.
Keep raw Setting rows, unrelated keys and `core.permissions` out of module UI.

Resolution distinguishes at least:

| Result | Meaning |
| --- | --- |
| `world` | A ready current-world row exists and passes declared schema validation. Preserve false, zero, empty string and allowed null. |
| `registered-default` | Store is ready and the world row is absent; the declaration supplies a version-verified native default. |
| `unavailable` | Not ready, unsupported version/scope, invalid stored value, missing unproven default or denied declaration. Include a bounded reason, not a fabricated value. |

Clone and freeze nested values; do not return a mutable `getValueByKey` object.
Deletion returns to a proven default only after Store readiness is established.
Distinguish world rows from v14 user-scoped rows with the same key. Native browser
client settings remain out of scope; user-scoped settings require a separate
caller-only contract and are not inputs to shared Actor preparation.

Provide an authorized module-context read projection and a host-backed React
hook, tentatively `useWorldSetting`, using the existing SDK event infrastructure.
Send filtered revision/key invalidations, then refetch the authorized snapshot;
do not broadcast raw Setting documents or merely forward the existing GM-only
Setting event. Reset on world/session/module change and revalidate permissions.
Server action preparation reads the current context, not a client's supplied
setting or stale dialog snapshot. Setting-dependent dialogs must refresh or
reject stale requests with a clear reason.

A future `settings.set` is a separate capability: exact declared writable keys,
current GM authority on a user-bound request, schema/version validation, create vs
update handling, concurrency checks and normal Setting ingress. It must not use
maintenance privilege as a player fallback or promise execution of native browser
`onChange`/`requiresReload` behavior. This first delivery selects read access and
migration-ledger maintenance, not a generic world-settings editor.

## Decision 3: administrator-owned release upgrades and migrations

### Ownership and authorization

Use Core's existing admin module manager as the sole entry point for approving
and running module data maintenance. A module supplies native schema knowledge
and pure plans. Core owns release acquisition, plan review, world selection,
authorization, maintenance admission, document enumeration, dispatch, progress,
recovery and activation. No module runtime gains a privileged `migrate()` or
maintenance-write method; `initialize(runtime)` and preparation remain read-only.
Ordinary caller-bound SDK writes keep their existing rules.

An authenticated **SheetDelver administrator** approves an exact release/world
upgrade plan through the existing admin network/origin/session/CSRF boundary.
This is distinct from being a Foundry Actor owner or GM. Core executes approved
operations through its configured service transport only after resolving its
actual current Foundry identity. Core requires a full Foundry GAMEMASTER service
account (role 4) for every world connection, bootstrap and recovery, independently
of migration declarations. Ordinary player/Assistant request writes retain their
existing ownership rules. Admin login,
module trust, declared paths and an archive checksum do not confer Foundry rights.
Do not borrow an online GM session or fabricate `ModuleAccessContext`. Recheck
identity, epoch, lease and rights before dispatch; Foundry is the final authority.

The approval authorizes one durable job, including interruption/restart recovery
within its recorded scope. It is not a standing module grant to run new repairs
on every bootstrap. A scope expansion, changed artifact/plan, different world or
incompatible native version requires renewed review. Progress is automatic after
the admin applies the reviewed upgrade; no player or GM browser action is needed.
This proposal does not authorize executing it against the current world.

The authority requirement is concrete, not an unknown transport capability:

- CoreSocket already authenticates the configured `foundry.username` account and
  sends `modifyDocument`; resolution currently checks account presence, not GM role.
- Installed Foundry 13.351 and 14.367 `dist/database/backend/server-backend.mjs`
  binds document operations to the socket's authenticated user and enforces
  `canUserModify` for updates. A requested user ID cannot grant another identity.
- Native `common/abstract/document.mjs` dispatches per-document permissions;
  Actor updates require OWNER, with field-specific restrictions. Native `isGM`
  includes Assistant as well as full GM. Requiring role 4 here is the selected
  Core connection policy, not a claim that Foundry rejects every
  Assistant or owner update.
- Resolve the service user from the fresh current-world UserStore, verify the
  socket identity matches and reject missing/banned/demoted users. A dry-run checks
  those facts and target capabilities without a test write or role escalation.
  Document validation, supported update envelopes and pack policy still apply.

No new login protocol, player impersonation or privileged module SDK is needed.
Prior bounded native write evidence in Core ADR-0061 concerns caller-bound combat
operations; it does not certify this runner. Remaining research/acceptance is a
small target matrix against supported native builds: actual service-GM updates of
Actor/Item/embedded effects, later Scene/ActorDelta and permitted world packs;
non-GM/missing/demoted account rejection; invalid data, disconnect and readback.
Do not inspect production credentials or silently promote a configured account.

### Full-GM service account: connection and recovery prerequisite

This is a **confirmed design requirement, not implemented role enforcement in
Core 0.18.1**. Configure the dedicated Foundry account named by `foundry.username`
as **Gamemaster** in every world SheetDelver serves. Assistant Gamemaster (role 3),
Trusted, Player, banned, missing or unknown roles do not satisfy it. Verify the
actual supported native GAMEMASTER role (4); native `isGM` is insufficient because
it includes Assistants. Do not add a role setting in SheetDelver that claims to
override the Foundry user document, and do not promote the account automatically.

Implement this within existing connection/lifecycle ownership:

1. Resolve the configured account using authoritative world user data. A known
   non-GM role can block during discovery. If discovery omits the role, authenticate
   only as needed to obtain the current user/snapshot; missing evidence never passes.
   Verify the authenticated socket identity matches the selected account and its
   fresh full-GM role before completing world bootstrap, loading/initializing the
   module adapter or publishing prepared data. Do not require an already-ready
   world to perform the role check.
2. Recheck on every initial connection, world switch, restored service session and
   same-world reconnect. Watch current service-user changes/removal while active.
   On demotion/deletion or loss of reliable identity, immediately gate world work,
   fence delayed dispatch/approved migration jobs, stop world-data publication and
   retire readiness. A cached GM role must not keep the world accessible.
3. Surface an admin-only blocked reason (illustratively
   `service-account-gm-required`) with configured account, observed role, required
   role and remediation. Public/player status uses “World unavailable” without
   exposing account identity, permissions or credentials. Keep the admin surface
   reachable. This is a service configuration failure, not proof Foundry stopped.
4. Use the existing ADR-0005/WorldTransportController recovery pattern: halt repeated
   login/bootstrap attempts for the known blocked world, retain passive discovery
   for world/setup changes and allow a scoped admin retry after correction. Do not
   introduce an infinite initialization/retry loop or a generic-adapter bypass.
5. The administrator changes the account to Gamemaster **in Foundry**, then retries
   the Core connection. Retry obtains fresh role/identity evidence and performs
   normal data compatibility checks before reopening the world. Promotion grants
   no automatic authority to execute a new migration job.

Suggested administrator message:

> SheetDelver requires its configured Foundry service account to have the
> Gamemaster role. Assistant Gamemaster is not sufficient. Change the account's
> role in this Foundry world, then retry the connection.

Transport emits connection/identity facts; Core lifecycle services own this policy
and status. Do not place the check in shared player login negotiation or change
human Assistant/GM/owner permissions. Native Foundry validation still applies to
individual writes even with a qualified service account. Publish the behavior
change in release notes when implemented: installations using an Assistant service
account must promote it before upgrading to the enforcing Core release. Configuration,
README, contributor/security/socket guides, API/status/UI docs and test prerequisites
must distinguish the required configuration from the pending enforcement.

### Module-owned catalog, version directories and migration hooks

Use a fixed root **`migration.json`** filename, discovered by Core/packaging without
importing module code. Keep migration contents and entry paths out of `info.json`;
that file remains the module identity/version/general compatibility authority.
Prefer the migration-specific name over `system.json`, which can be confused with
Foundry's native system package manifest. A missing catalog means no declared
migrations for an existing migration-free package; a malformed catalog or missing
referenced definition/entry is an error, never silently treated as absence.

Illustrative source layout and catalog (proposed contract, not implemented):

```text
migration.json
migrations/
  3.8.0/
    definition.json
    actor-migrations.ts
  4.0.6/
    definition.json
    actor-migrations.ts
    scene-migrations.ts
```

```json
{
  "schemaVersion": "sheet-delver-migrations.v1",
  "systemVersions": {
    "3.8.0": "migrations/3.8.0",
    "4.0.6": "migrations/4.0.6"
  }
}
```

These keys identify **native game-system milestones** (e.g. Shadowdark 4.0.6),
not Foundry platform version 14.367 or SheetDelver module release 0.9.4. The sample
3.8.0 entry illustrates structure, not a promise of historical support. Each
version directory contains one `definition.json` with a well-defined steps array
and relative logic entries. Source TypeScript is compiled into separate migration
bundles; packaged definitions reference the compiled files, never a production
TypeScript loader. Paths are confined to the verified module root; reject traversal,
symlinks, remote URLs and missing/unpackaged entries.

Each definition/step describes:

- stable migration/step IDs, immutable revision, dependencies and description;
  the host binds them to the catalog/definition/compiled-code digests;
- applicable current native-system and Foundry ranges, source-data eligibility,
  target data postconditions and supported module data-read compatibility;
- affected target kinds, embedded relationships and allowed operations/paths,
  required vs advisory outcome, declared read/reference/setting dependencies;
- relative pure hook entries for **check**, **plan** and **verify**, with optional
  bounded preparation of cross-document indexes from host-supplied input;
- optional schema-validated step parameters for module-specific cases. They are
  migration inputs, not a new globally writable `customData` store.

The definition declares boundaries and ordering; TypeScript hooks express the
conditional/custom transformations. Do not attempt to describe every migration
as a static document-field map. Hooks can use several document kinds, custom
nested system/flag paths and bounded related data, but every write still returns
host-validated operations within the declared scope. An unsupported target or
operation needs a deliberate Core contract extension; arbitrary hooks never gain
raw transport, file/database access or an unbounded `customPaths` escape hatch.

Core passes cloned source and immutable context to the hooks. `check` returns
current / migration-needed / unsupported-or-unresolved with bounded reasons;
`plan` returns deterministic patches/no-op/unresolved plus source fingerprints;
`verify` checks actual post-write source against the migration's postconditions.
All are read-only computations. Core executes writes. No hook constructs the
adapter, registers server routes, imports UI, selects a user identity or performs
network/filesystem/time/random effects. Verify artifact trust before loading code,
limit input/output/time and keep preview failures isolated from the active module.
This is an extension of the existing trusted-plugin model, not an OS sandbox.

Resolve dependencies explicitly; JSON object order or lexical version sorting is
not execution order. A directory key is not an instruction to run only that version
or every older directory. Applicable native-version ranges, checks and dependencies
select the chain, including required earlier steps for skipped-version upgrades.
Two repairs for the same native version need distinct stable step IDs; do not edit
a shipped step silently. Keep historical steps needed for supported source shapes,
and block unsupported chains rather than guess conversions.

The release manifest may expose a **derived migration-present summary and catalog
integrity** for discovery/UI. It must not contain another hand-maintained migration
map or put that map back in `info.json`. Whether migration is actually required is
known only after checking the selected world's current data. The catalog and all
entries are covered by the archive digest; Core compares any release summary to the
packaged catalog and pins exact code/definition digests in the reviewed plan. Local
archives and development source validation discover the same conventional catalog.
A remote flag cannot bypass a missing/mismatched catalog or completed-data check.

Extend catalog/definition validation, packaging, artifact health, release/history
preview types, SDK types and compatibility tests together. General host/contract
minima remain in `info.json`; a migration-bearing package must refuse older hosts
that cannot enforce the catalog contract. Version the release schema if necessary.
No writable migration runtime is introduced. Shadowdark's `planEffectMigration`
needs direct tests, lossless effect serialization and typed parent addressing before
it can serve as a plan hook. Retire its caller/UI migration route on adoption;
there is no owner-level repair fallback.

### Dry-run and running-world prerequisite

Reuse the existing staged archive/governance preview, adding two explicit results:
**package checks** and **world migration checks**. Dry-run may create disposable
staging and an expiring plan record, but makes no world writes, switches no active
source, replaces no installed files and starts no world automatically.

For an upgrade requiring world migrations, Core must establish the selected
Foundry instance/world/system, a running world, fresh source Stores/reference
inputs and qualified service identity. A responding Foundry server in setup is
not a running world; SheetDelver's player-ready state is also not the prerequisite.
A maintenance connection can seed source Stores without opening player access or
initializing an incompatible candidate. This avoids a readiness deadlock.

If the world is stopped/unavailable, report **world required**, keep the current
installation intact and offer the existing admin world-launch flow with a prompt
to start the selected world and rerun dry-run. Do not shut down another active
world or mutate offline databases. Offline migration remains deferred pending a
separate storage/locking/backup design; having local files is not sufficient.
A running but wrong world, missing rights, stale connection, unresolved required
plan or unsupported targets also blocks application with a concrete explanation.

Preview includes exact current/candidate source and version/digest, verified world
identity/native versions, declared changes and affected paths, target counts,
unresolved/excluded targets, required downtime, the backup/irreversibility acknowledgement,
rollback/downgrade limitations and any access-scope expansion. Use administrator-
only details for document identities and proposed field changes. No document data belongs in public
maintenance status. Qualify a passing preview as checks passed at its revision,
not a guarantee that subsequent world writes are atomic or safe under all edits.

Issue an expiring Core plan ID bound to artifact digest, declaration/planner
revision, world identity/epoch, context/reference revisions and inventory/source
fingerprints. Apply accepts that reviewed plan plus an idempotency key, not an
unbound `approve: true`. Reacquisition must match the reviewed bytes. Under the
maintenance lease, recheck data/rights and replan conflicts before replacing files;
material plan changes require another preview. Never execute a stale dry-run patch.

### Durable upgrade sequence

| Phase | Required work and checkpoint |
| --- | --- |
| 1. Inspect and plan | Verify/stage candidate, resolve cumulative migrations, run package and live-world checks. Fail with the old installation usable and no world writes. |
| 2. Approve and quiesce | Persist the admin-approved job and exact digests. Acquire one fenced world lease plus a module-install lock; enter maintenance before file replacement. Block new SheetDelver world work, drain or fence in-flight dispatches, and refresh the plan under that boundary. |
| 3. Preserve and promote | Record prior package/registry/source selection and the acknowledged world-backup warning. Retain a durable previous package for pre-write file recovery; promote the candidate files while activation remains withheld. Journal rename/registry phases so a crash between them is recoverable. |
| 4. Restart in maintenance | Reuse the supervised full-stack restart needed for module replacement. Persist the job before requesting restart. On process start, load its maintenance gate before importing/initializing the candidate adapter or serving player routes; connect and seed required world inputs using Core. A restart is not upgrade completion. |
| 5. Migrate and reconcile | Revalidate the exact job/world/authority, load only the candidate migration entry and execute bounded plans through Core transport and normal ingress. Record per-target intent, acknowledgement/readback and unresolved/conflict states. Resume interrupted approved work without replaying uncertain writes blindly. |
| 6. Verify and prepare | Verify every required postcondition, reconcile sources and pack/context revisions, then initialize the candidate adapter and rebuild prepared data. Prove runtime/artifact health and source consistency; no generic fallback may bypass a required migration gate. |
| 7. Activate and complete | Durably record migration and activation success, publish fresh authorized state, release the maintenance gate/lease and reload clients onto the new module build. Report upgrade complete only here; apply retained-package cleanup policy afterward. |

This extends the existing archive transaction. It cannot be implemented by calling
its current apply helper and then migrating: that helper already deletes rollback
files and reports success. Split promotion from finalization; persist file and
registry transition state alongside the world job. A migration-free upgrade can
retain existing behavior. Admin job creation should return an operation identity
and accepted/running state; clients follow status through restart instead of
receiving premature success from the current restart response.

### Maintenance and recovery experience

Model **SheetDelver service maintenance** separately from the Foundry world
lifecycle: Foundry must remain running while SheetDelver world access is paused.
Add a durable job/status projection with at least blocked, planned, quiescing,
installing, restarting, migrating, verifying, recovery-required and completed
phases. Keep package installed version, serving version and per-world data readiness
distinct. Persist the gate until compatible data and a healthy adapter are ready.

Reuse `ensureInitialized`, socket readiness enforcement, status broadcasts and
`PlayerWorldBoundary`/shared `LoadingModal`; extend them with an explicit maintenance
reason/progress and a non-dismissible “Module upgrade in progress” presentation.
Prefer blocking/status-only clients over logging every user out. Suppress normal
world reads/actions, module routes, rolls/chat mutations and world-data fan-out;
keep Core's native event ingress running to detect changes. Admission checks alone
are insufficient: drain known in-flight operations and fence delayed callbacks at
write dispatch. Retired client actions must not replay automatically after upgrade.

Admin login, job/status, logs and scoped recovery controls remain available through
the maintenance gate; reauthentication after restart must recover the same job.
Public/player status contains only a bounded phase/message, with detailed progress
and failures restricted to admin. Reuse the existing theme/world background and
focus management. On success revalidate session authority and replace stale module
assets/dialog state; no old client build may issue new writes against migrated data.
Cancellation before writes can restore the old deployment; after a possible write,
stop scheduling, reconcile outcomes and expose recovery-required rather than promise
an undo. Retry and resume are idempotent job actions, not duplicate upgrade jobs.

Native Foundry user lockout/disconnection and an enforced native maintenance
window are **out of scope**. SheetDelver blocks its own clients/operations only;
there is no implementation gate requiring native kicks or a proof that all native
users stopped editing. Retain source conflict checks and stop/report uncertain
outcomes, but do not claim they provide a global lock or atomic compare-and-swap.
A recommendation to avoid external edits may accompany the upgrade notice; it is
not a new lockout feature or a separately enforced approval condition. G0 must still
define one migration writer among SheetDelver processes; the current process-local
Set is insufficient across installations.

### Target scope, journal and rollback

Initial targets are all eligible world Actors, their embedded Items/ActiveEffects,
and world Items/effects. Core owns cursor/snapshot enumeration across every page.
Validate each returned patch against declared types/paths; reject ownership, roles,
credentials, unrelated flags or undeclared fields. Start with targeted updates;
creation, deletion and broad replacement require deliberately supported operation
contracts. A source preflight hash is not a native atomic compare-and-swap.

Add unlinked-token ActorDelta and world-owned compendium targets at G5 using existing
SceneStore/pack metadata/transport. Preserve inheritance and tombstones, migrate a
shared base Actor once, and never materialize a full synthetic Actor into its delta.
Do not unlock or mutate system/package packs automatically. Prove supported v13/v14
world-pack envelopes and locks; keep pack acknowledgements out of primary Stores.
Unsupported required targets block; intentional exclusions/advisory limitations are
visible in preview and the final result, never counted as migrated.

Keep Core-owned durable job/target records outside evictable caches and module
DataStore. Scope by opaque Foundry-instance/world/system identity, module ID,
release digest, migration ID/revision/digest; store authorization scope, lease,
phase, cursor, source/post fingerprints, counts and write-outcome records. Do
not use a package-global completion flag for multiple worlds. Fencing survives
restart; stop on identity/epoch/lease loss and reconcile before resuming.

Record write intent first, then confirmed ingress/readback outcome. A timeout may
have applied: inspect source before retry. Multi-document migration is not atomic,
and no distributed transaction joins directory renames with Foundry writes.
Unresolved, failed and unvisited required targets cannot be marked complete.
Before any world write, package/registry rollback may restore the previous build.
After any possible world write, do not restore old files as an assumed undo.
Keep the world unavailable and expose resumable completion or administrator-led
external restore. Retaining package files protects installation recovery; it is
not a world backup. Journals/fingerprints help reconcile uncertain writes and do
not replace a Foundry backup. Automatic inverse migration, world snapshot/preimage
restore and a generic undo engine are excluded from this scope.

### Backup warning and external restoration

Core currently exposes no supported world backup/restore operation in its admin
routes/services. Say **SheetDelver cannot create or restore a world backup**, not
that backing up Foundry itself is impossible. Before admin applies any job with
world writes, show a concrete warning using the shared confirmation UI:

> SheetDelver cannot back up or restore your Foundry world. Migration changes
> cannot be undone from SheetDelver and may be only partly applied if interrupted.
> Back up the world using Foundry's backup tools before continuing. Recovery may
> require restoring that backup in Foundry and losing changes made after it.

Require acknowledgement of those limits, bound to the reviewed job. Record the
warning revision/acknowledgement, but do not claim to verify that an external
backup exists or force a backup-upload workflow. Acknowledgement does not weaken
source/permission checks. Cancellation after writes stops further scheduling;
it cannot undo changes already made. Supported automatic recovery is readback and
idempotent resume, not rollback of world data. After an external restore, discard
stale approval as necessary and run the bootstrap checks below before allowing use.

Existing version-selection downgrade approval is insufficient once data has changed.
Check the chosen release's data-read compatibility against the world's ledger and
actual source. Block unsupported downgrade/reinstall/source switch before promotion;
no automatic down-migration is assumed. Native system migration flags remain owned
by the native system and must never be advanced by a SheetDelver key repair.

### Activation, other worlds and later legacy data

| Situation | Selected behavior |
| --- | --- |
| Active module requires migrations, world stopped | Block the upgrade before promotion; admin starts the selected world and reruns preview. No offline database writes. |
| Active matching world and reviewed plan | Run the admin job above; completion requires both migration and candidate activation. |
| Package is inactive or another world/system is running | Package inspection/staging is allowed. Do not migrate the current unrelated world. Any artifact-only install must be explicitly inactive/pending world checks; activation later requires the same admin preparation. It must never be presented as a completed world upgrade. |
| Same package used by several worlds | Maintain independent world readiness/ledgers. Only the connected selected world is migrated; on visiting another world, assess it and hold incompatible module activation for admin review. |
| First install or source switch, including local development | Evaluate the same data requirements before activation. Preserve local source directories. Local source edits cannot auto-authorize world mutation; an explicit admin validation/maintenance job pins their exact candidate digest. |
| Process restart/reconnect during an approved job | Resume/reconcile only that durable job and approved scope before publishing readiness. If world/rights/digest changed, block for review. |
| Ordinary bootstrap, restore or new legacy import | Mandatory read-only checks against freshly seeded current data ignore prior completion as an exemption. Required pending/unknown compatibility blocks world readiness with an unavailable state; admin sees the exact maintenance reason and can preview/apply a same-version repair. No new writes are authorized by startup. |

On **every bootstrap**, after source/reference seeding and before adapter
initialization/prepared publication, execute the applicable required `check` hooks.
Repeat after reconnect/reconciliation that can have replaced the source snapshot.
A completed Core ledger entry, module version or native migration marker is never
sufficient to skip them: a backup restored outside SheetDelver can leave all those
local records unchanged. Safe caching may reuse results only for proven identical
fresh source plus catalog/code/context fingerprints; it must still cover every
required target and newly introduced document.

If checks report migration-needed, unsupported data or an unknown/failed required
check, hold **world readiness** in maintenance. Existing and newly arriving clients
see “World unavailable — maintenance required”; the admin backend shows module,
step, reason and affected counts. Keep Core source inspection and admin access
available, even if the normal adapter cannot initialize. Do not use a generic
adapter fallback to publish an affected world as ready. A restored/regressed
source that contradicts an approved job's verified outcomes invalidates that old
plan; require fresh admin review rather than silently replaying the old job.

A later native import is not a reason to grant runtime modules automatic repair
rights. Live continuous repair and offline Foundry database editing remain deferred.
The administrative workflow replaces bootstrap auto-dispatch, while bootstrap
still enforces readiness and can recover an already authorized upgrade.

## Decision 4: reusable caller permissions and canonical content

Separate rule configuration from caller capabilities. Add a bounded request-scoped
capability/pack-read surface using current UserStore role/ownership and native
version rules. Reuse and generalize `nativeCombatPermissions` with cross-consumer
tests; do not copy a second permissions engine into every module. Return effective
capabilities/authorized pack metadata, not all users, permission maps or raw settings.
Revalidate at read/write execution, after waits and when permissions change.

Preserve initialization's declared reference-data reads, but require caller policy
on every externally served document, index, collection and card. The current generic
`req.runtime.documents.fetchByUuid` compendium path requires a subject but does not
apply the combat manager's pack policy. Changing this needs a compatibility and
consumer inventory, not merely telling modules to call that method. Shared
initialization caches must not establish player access. Until the general contract
lands, module routes must consistently enforce their conservative policy.

Correct ActorService's recursive UUID-to-name replacement after inventorying Core
and module consumers. Retain canonical source strings and publish explicit labels
alongside them; preserve limited/observer/owner projections and editor round trips.
This is a separate Core correctness checkpoint (DW-14) in this follow-up. Shadowdark
already stores structured references; some cards still ignore those prepared labels
and can be corrected independently. Core card SDK/encounter integration remains
deferred (DW-13).

## Implementation checkpoints and gates

All boxes are pending. Each gate records source anchors, changed paths, failing/
passing tests, supported versions, unresolved cases and operator evidence.

| Gate | Work and concrete deliverable | Completion requirement |
| --- | --- | --- |
| G0 | Inventory admin upgrade/apply/source-switch paths, bootstrap/recovery, setting/pack/UUID consumers and supported native transports. Finalize conventional catalog/definition/hook schemas, job authorization, data compatibility and single-writer policy; implement the confirmed Core full-GM service-account prerequisite (G0a). | Versioned examples cover active/stopped/wrong world, inactive install, first install, skipped release, downgrade, local source and multiple worlds; initial/reconnect/demotion role checks and admin recovery verified; no assumed GM identity or offline database support. |
| G1 | Add declared setting/world-context types, manifest validation and per-key access review; implement ready Store-backed resolution. | Stored false/zero/null, absent defaults, invalid/unknown values, user-row exclusion, denied keys and stale epochs covered. |
| G2 | Add context/dependency revision to preparation and refresh/recovery orchestration, authorized client projection/hook and SDK mock. | Setting-only changes update every dependent sheet/card/action default before invalidation; recovery refreshes without reinitializing the adapter. |
| G3 | Add conventional migration.json discovery, version-directory definitions/check/plan/verify hooks, derived release summary, packaging/health/compatibility and admin two-part dry-run. Pin artifact/world/plan revisions and expose blockers. | Candidate is inspected without replacing or initializing the active adapter; no world writes; stopped/wrong world, chain gaps, digest mismatch, unsupported scopes and stale previews block. |
| G4 | Implement the durable admin upgrade coordinator, journal/lease, maintenance admission/drain, split file promotion/finalization and supervised restart continuation. Execute bounded Actor/Item/embedded plans. | Full seven-phase sequence and crash boundaries verified; admin stays reachable; all pages, rights/lease loss, conflicts, acknowledgements/timeouts and partial writes accounted for; no premature success or ordinary bootstrap auto-write; required source checks block readiness after an external restore despite a completed journal. |
| G5 | Add restricted ActorDelta and world-pack targets using existing infrastructure. | Native v13/v14 envelope/delta/lock tests; no base duplication, package-pack writes or pack-to-world pollution. Unsupported required domains block, intentional exclusions remain explicit. |
| G6 | Generalize effective caller/pack permissions and enforce caller reads across runtime/projections. | Player/assistant/GM, v13/v14, pack overrides and privileged-cache-before-denial tests pass for every route family. |
| G7 | Preserve canonical Actor response identity with explicit labels. | Core/module consumer inventory, same-name/cross-pack cases, limited projection and source-editor round trips pass. |
| G8 | Adopt implemented contracts in a separately authorized Shadowdark task: world settings, separate migration catalog and tested hooks, registry refresh and caller permissions. Remove caller/UI migration execution. | RV-01–07 and ADR-0001 regressions pass; actual Pulp/ammunition settings reach consumers; planner/serializer native semantics tested; admin upgrade replaces the prototype with no owner fallback. |
| G9 | Update SDK exports/mocks, API/architecture/module-authoring/manifest/release docs, changelog and compatibility gates; run approved native acceptance. | Old migration-free modules remain compatible; required migrations cannot be ignored by an old host; install/restart/recovery and player/admin UI verified. No release or world execution inferred from doc approval. |

The connection prerequisite and G3/G4 need explicit sub-checkpoints before
implementation can be called complete:

- [ ] G0a: require a full-GM service account before world readiness on every connect/
      reconnect/world switch; block missing/unknown/Assistant roles and demotion,
      fence pending writes, show an actionable admin-only reason and recover by
      fresh admin retry. Preserve ordinary user/Assistant permissions. Update all
      operator/configuration documentation and release notes with the enforcement
      version; current documentation must not claim it is already implemented.

- [ ] G3a: root migration.json and per-version definition schemas, confined relative
      entries compiled/packaged and health checked; derived release summary parity,
      compatible old-host behavior and cumulative migration chain.
- [ ] G3b: separate candidate planner loading and world-required preview; exact
      plan identity, expiry, access review and no-mutation proofs.
- [ ] G4a: durable job/lease/file-transition model and admin status/recovery API;
      distinguish installed, serving and world-data versions.
- [ ] G4b: HTTP/socket/dispatch admission and in-flight drain/fence; shared player
      maintenance modal and safe public/admin projections; no native-client lockout.
- [ ] G4c: retain prior package, promote without activation, restart into the same
      job, seed source without candidate initialization, migrate/read back/prepare.
- [ ] G4d: crash/partial/cancel/downgrade/restore recovery, postcondition verification,
      mandatory bootstrap/reconnect source checks despite completed journal, warning
      acknowledgement, final activation, stale-client refresh and retained-package
      cleanup. No world backup, inverse migration or undo implementation.

G6/G7 and module-local corrections can proceed independently once authorized.
Required migrations finish before candidate prepared publication. Admin repair of
later legacy data uses this same reviewed runner; generic settings-write UI,
offline databases, native user kicks, broad Scene SDK and Core-wide cards remain
outside these gates.

## Required test and acceptance matrix

- [ ] Setting Store not ready vs absent vs invalid; decode JSON primitives/objects;
      preserve false/zero/null; exact namespaced grants and versioned defaults.
- [ ] V14 world/user key collision; client scope unavailable; no server-only value
      in list/detail/SDK events, errors or logs.
- [ ] Setting create/update/delete, permission change, world switch, module reload,
      disconnected mutation and same-world recovery update preparation and UI once.
- [ ] In-flight Actor update vs context refresh; stale dialog/action rejected or
      refreshed; epoch/revision provenance stays coherent across surfaces.
- [ ] Catalog/definition/hook schema and derived release-summary parity; confined
      paths, missing compiled entries, multiple steps at one native version,
      native-system vs Foundry vs module-version distinction; digest mismatch, skipped
      versions, duplicate/changed IDs, dependency cycles, missing chain and old-host
      refusal. Exercise uploaded archive, public/catalog and source-switch paths.
- [ ] Dry-run blocked while world stopped/setup, wrong system/world, stale Stores,
      unsupported scope or insufficient service rights; no writes/activation or
      native world launch. Changed data/artifact/epoch invalidates the reviewed plan.
- [ ] Candidate preview never calls adapter initialize or registers routes; bounded
      planner failure/timeout leaves the old adapter usable and reports accurately.
- [ ] Duplicate apply/idempotency, two admin tabs/runners, lease loss and stale plan;
      current admin review is distinct from native GM/service authority. Full-GM
      configured account passes the policy check; Assistant/owner/missing/demoted
      service accounts block the Core world connection even without migrations.
      Cover initial/restored-session/reconnect/world-switch checks, active demotion/
      deletion, pending dispatch fencing, public diagnostic privacy, no login retry
      storm and admin retry after manual role correction. No automatic promotion.
- [ ] Maintenance blocks new HTTP/socket/module/roll/chat work and fences delayed
      writes; native ingress and admin recovery remain available. Public status
      contains no document identities or field changes; client modal cannot dismiss
      the gate.
- [ ] Crash before/after journal intent, each file rename/registry update, restart,
      acknowledged write, final verification and activation; retain artifacts and
      gate until recovered, do not auto-start an unapproved migration at bootstrap.
- [ ] Empty/1/100/101/many targets; embedded effects; shared base Actors; untouched
      custom metadata; unknown keys; exact field scope and lossless serialization.
- [ ] Native concurrent change, timeout with applied write, partial batch and
      reconnect; conflicts are surfaced without a native-user lockout requirement;
      cancellation never implies an undo or cross-system atomic transaction.
- [ ] First install, inactive package beside local source, activation/source switch,
      same package across worlds/Foundry instances, restore, new legacy import,
      same-version admin repair and unsupported downgrade after migration. A restored
      world with unchanged version/completed ledger must fail required checks and
      keep new/existing clients unavailable with a detailed admin-only reason.
- [ ] Backup warning acknowledgement precedes writes and is bound to the job; no
      claimed backup verification, snapshot/preimage restore or inverse operations;
      partial writes remain journaled and resumable, external restore is rechecked.
- [ ] ActorDelta inherited effects, deleted inherited children, delta-only effects,
      missing base Actor; locked/world/system packs and pack-cache isolation.
- [ ] Pack permission denial across generic UUID/list/index/card/spell/table routes;
      v13/v14 assistants/players/GMs and permission changes after cache fill.
- [ ] Canonical UUIDs survive prepared/detail/SDK/editor flows without expanding
      LIMITED visibility or exposing identification/GM-only content.
- [ ] SDK integrity, release/manifest/permission compatibility, lifecycle/recovery,
      module checks/typing, isolated packaging and real-host browser maintenance
      flow across restart, slow progress, failure, admin re-login and stale assets.
- [ ] Separately approved disposable-world native run: setting changes and admin
      dry-run/apply/migration with no player/GM browser trigger. Verify actual source,
      authority, counts, service reconnect, unchanged unrelated documents and the
      supported resume/external-restore detection. No native lockout acceptance gate.

The offline groups use source-derived fixtures and controlled services; the final
native group requires separate local/test-world authority. Existing tests rerun
for this design audit all pass: `module-archive-operations.test.ts`,
`module-archive-transaction.test.ts`, `module-release-manifest.test.ts` under
`src/tests/unit/modules/`, and `src/tests/unit/runtime/full-stack-restart.test.ts`.
They verify today's archive/governance/file rollback and injected restart behavior,
**not** the proposed migration coordinator or actual restart/world acceptance.
No passing module render count substitutes for those pending gates.

## Compatibility and release boundary

`src/shared/sdk/contractVersions.ts` remains the sole version authority. These
additions affect module-api and aggregate SDK; a new React hook/event also affects
ui-extension-api. The roll-engine contract need not change for settings/migrations.
Release schema/generator/packager compatibility must also prevent an older host
from installing a migration-required release while ignoring its declarations.
Select exact next versions when implementing, not in this documentation pass.
Existing modules without these optional capabilities retain their runtime behavior.
Adopting modules raise only the minima they actually need; update CI pins to an
available tested host release rather than claiming current v0.18.0 implements them.

## Alternatives declined

- Writable `initialize`/prepare or arbitrary privileged runtime: bypasses caller
  boundaries and entangles preparation with persistent mutation.
- First-online-GM/player-sheet triggers: bypass the selected admin ownership.
- Standing automatic bootstrap migration grant: superseded by the October 16
  admin-upgrade decision. Bootstrap only assesses readiness or resumes an approved
  job; later repairs require another admin plan/apply.
- File-only rollback after world writes, or a UI-only maintenance overlay: neither
  establishes data compatibility or stops server-side actions.
- Offline database mutation, native-user lockout and world backup/undo machinery:
  excluded from this scope. Recommend a native Foundry backup and explicitly
  acknowledge that SheetDelver cannot undo migration writes.
- Migration maps/logic paths in info.json: replaced by a conventional, module-owned
  migration.json catalog and version-directory definitions/hooks.
- `safe: true` self-authorization or a fabricated GM access context: no authority.
- A global migration version with "never rerun": misses new legacy data and restores.
- Broad settings/scene/pack dumps: unnecessary for bounded rule inputs and migrations.
- Defaults when the host cannot read settings: hides missing authority and selects
  wrong rules in configured worlds.
- A second module settings store, permissions engine or Foundry browser/runtime:
  duplicates capabilities Core already owns.
