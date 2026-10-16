# Core ADR-0064: Module World Context and Data Migrations

**Status:** Accepted/open — CR64-01–07 corrected and offline/isolated checks pass; native acceptance, realistic inventory measurement, G8 and user acceptance remain pending
**Date:** October 16, 2026
**Related:** Core ADR-0021, ADR-0027, ADR-0028, ADR-0038, ADR-0056, ADR-0057, ADR-0063; Shadowdark module ADR-0001

The [independent Core review](#independent-core-review--october-16-2026) of
`5013e86` supersedes the implementation checkpoint's completion implications.
At review, existing suites passed but five probes reproduced defects. The
[corrective evidence](#corrective-verification-results--october-16-2026) below
records their initial corrective results. The [corrective independent review](#corrective-independent-review--october-16-2026) found two further defects; the [CR64-06/07 follow-up](#cr64-0607-corrective-implementation--october-16-2026) records their corrections and evidence. The [independent confirmation](#cr64-0607-independent-confirmation--october-16-2026) verifies those corrections against the original reproductions and current tests. The earlier G0–G7/Core G9 table is not native acceptance.

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
admin diagnostics are implemented but unreleased under G0a; operator setup guidance
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

This is **implemented but unreleased; published Core 0.18.1 does not enforce it**.
Configure the dedicated Foundry account named by `foundry.username`
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
must distinguish this unreleased enforcement from published behavior.

### Module-owned catalog, version directories and migration hooks

Use a fixed root **`migration.json`** filename, discovered by Core/packaging without
importing module code. Keep migration contents and entry paths out of `info.json`;
that file remains the module identity/version/general compatibility authority.
Prefer the migration-specific name over `system.json`, which can be confused with
Foundry's native system package manifest. A missing catalog means no declared
migrations for an existing migration-free package; a malformed catalog or missing
referenced definition/entry is an error, never silently treated as absence.

Illustrative source layout and catalog (unreleased contract):

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

The implementation checkpoint below records verified progress. Each gate records source anchors, changed paths, failing/
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

The checkmarks below record Core implementation/offline verification, **not**
native/operator acceptance. The separate acceptance matrix remains open where
evidence is absent. No application release version is assigned by this work.

- [x] G0a: require a full-GM service account before world readiness on every connect/
      reconnect/world switch; block missing/unknown/Assistant roles and demotion,
      fence pending writes, show an actionable admin-only reason and recover by
      fresh admin retry. Preserve ordinary user/Assistant permissions. Update all
      operator/configuration documentation and release notes with the enforcement
      version; current documentation must not claim it is already implemented.

- [x] G3a: root migration.json and per-version definition schemas, confined relative
      entries compiled/packaged and health checked; derived release summary parity,
      compatible old-host behavior and cumulative migration chain.
- [x] G3b: separate candidate planner loading and world-required preview; exact
      plan identity, expiry, access review and no-mutation proofs.
- [x] G4a: durable job/lease/file-transition model and admin status/recovery API;
      distinguish installed, serving and world-data versions.
- [x] G4b: HTTP/socket/dispatch admission and in-flight drain/fence; shared player
      maintenance modal and safe public/admin projections; no native-client lockout.
- [x] G4c: retain prior package, promote without activation, restart into the same
      job, seed source without candidate initialization, migrate/read back/prepare.
- [x] G4d: crash/partial/cancel/downgrade/restore recovery, postcondition verification,
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
Migration-free modules retain the catalog-free installation path. This does not
promise unchanged access to every legacy endpoint: the implemented G6 privacy
boundary makes `/system/data` full-GM-only unless the adapter implements
`getSystemDataForUser`, and legacy Scene inspection is full-GM-only. Inventory and
communicate those behavioral changes before release; G8 adoption must cover affected
player/Assistant consumers without restoring privileged-cache exposure.
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

## Core implementation checkpoint — October 16, 2026

Work continues on `feat/adr-0064-world-context-and-migrations`, based on the
documentation checkpoint. Core-only implementation; no module repositories,
release metadata, remote operations or live services are part of this pass.
G8 remains separately authorized adoption, not an implicit module task.

Implemented boundaries under verification:

- `WorldWorkGate` supplies admission, generation fencing and dispatch drain;
  `ServiceAccountAuthority` compares the selected and authenticated user IDs
  against a fresh role-4 User, separately from ordinary Assistant permissions.
- `ModuleWorldContextService` resolves declared world rows/default provenance,
  excludes user rows, freezes snapshots, tracks context revisions and retires
  old-world handles. Bootstrap source checks precede adapter loading.
- The conventional catalog/definition reader validates paths, dependency order,
  compiled hook digests and old-host exclusion. Hooks are synchronous pure JSON
  computations, separately bundled as `.cjs`; the VM has no supplied transport,
  filesystem, network or clock. This is not an OS sandbox.
- The admin coordinator persists exact previews, backup-warning approval,
  world leases and per-target intent/readback. Archive promotion retains prior
  files rather than finalizing before migration; startup restores the gate before
  registry discovery. Bootstrap checks actual sources despite completed jobs.
- Caller pack reads use the existing native pack policy; Actor detail responses
  retain canonical references with a separate `referenceLabels` map.

Core implementation is supplied for G0–G7 and Core G9. Native acceptance, the
full operator/browser matrix and G8 remain open. The evidence below is offline,
not a claim that a production world was migrated or a release was published.

| Gate | Implementation anchors | Concrete offline evidence |
| --- | --- | --- |
| G0/G0a | ServiceAccountAuthority, injected socket guards, SystemService/controller, bootstrap/recovery, admin diagnostic/retry | Role 0–3/unknown/missing/mismatched session rejected; role 4 accepted; role loss fences dispatch. Human Assistant policy remains separate. |
| G1 | ModuleWorldContextService, SettingStore, sdk/world, manifest validation | Not-ready/absent/default/stored false/zero/null, user-row exclusion, immutable snapshots, filtered projection and retired handles. |
| G2 | Bootstrapper refresh, PreparedActorStore, request runtime, React hook/event | Actual host waits for refresh, incorporates racing Actor source, rebuilds under new rules without reinitialization; failed hook keeps gate. |
| G3/G3a/G3b | Catalog/compiler, planner/VM, archive/public/source previews | Paths/schema/dependencies/parameters/digests, old-host floor, actual esbuild/archive validation; preview never loads adapter/writes; stale plans rejected. |
| G4a/G4b | Journal/coordinator, WorldWorkGate, admin progress/Drawer, player boundary | Durable records, two-tab exclusion, generation fence/drain and delayed rejection; installed/activated/data state separated. |
| G4c/G4d | Retained promotion, startup gate, approved resume/readback, compatibility/recovery/cleanup | Three file-transition interruption points; real exited-process lease takeover; partial/uncertain readback without blind replay; restored partial job requires renewed approval; late preparation conflict blocks activation. |
| G5 | Restricted targets and existing Scene/Actor/pack Stores/ingress | v13/v14-shaped parent/pack envelopes, base-once/tombstone/delta-only handling, lock refusal and actual pack-ack isolation. Native target acceptance pending. |
| G6 | Shared nativePackPermissions, SDK/facade guards, system projection route | Player/Assistant/GM generation rules; controlled-await/cache-before-denial tests and attempted GM-subject borrowing across generic UUID/query consumers. |
| G7 | ActorService canonical detail/referenceLabels | Same-name/cross-pack UUIDs preserved; unauthorized cached labels excluded; source round-trip unchanged and no-detail request denied. |
| Core G9 | Central SDK3.3/module-api1.5/UI API3.2, exports/mocks/guides/changelog | Core unit/client/integration, type/lint/diff checks; generic fixture compilation/packaging, not module adoption. |

Tracked evidence: `src/tests/unit/world/module-world-migrations.test.ts` and
`src/tests/integration/module-upgrade-boundaries.test.ts`, plus existing bootstrap,
SDK, ownership, archive/release/history, admin isolation and client suites.
Commands pass: `npm run test:unit`, `npm run test:client`, `npm run test:integration`,
`npx tsc --noEmit --incremental false`, `npm run lint`, `git diff --check`.
Application and module release versions remain unchanged.

### Implemented recovery and resource limits

- `reads.targets/packs/settings` declares reference dependencies. Step parameters
  require `parameterSchema`. Package references may be read-only inputs, never
  write targets. Failed simulated verification cannot schedule an advisory patch.
- Entire inventories are visited (0/1/100/101/201 fixtures). Per-hook1s, plan5s
  and byte/tree bounds fail closed without approving a truncated plan. Large-world
  budget refinement requires evidence; no silent first-page limit is introduced.
- Busy guards span per-request coordinators as well as durable leases. A losing
  approval leaves no extra job; late acknowledgements cannot undo cancellation.
- Interrupted pre-write file/registry transitions require explicit cancellation
  and new review, not guessed forward promotion. After possible writes there is
  no deployment/world undo. Fresh recovery approval retains earlier plans/outcomes.
- Completed artifacts have no automatic expiry; admin cleanup is explicit and
  confined. Corrupt journals gate world work without preventing admin startup.
  Empty/cross-host orphan locks require operator reconciliation, never TTL stealing.
- Adapter refresh has a five-second bound, but cannot cancel trusted module code
  already executing. Adoption must keep caches revision-aware and side-effect-free.
- Opaque legacy system caches are full-GM-only unless the adapter supplies
  `getSystemDataForUser` using caller-bound capabilities. Legacy Scene inspection
  is full-GM-only; no player Scene/canvas SDK is introduced.

### Remaining acceptance and module handoff

G8 is separately authorized. Module adoption must declare source-verified native
settings/defaults; supply lossless catalog/hooks with explicit dependencies; refresh
preparation/caches by context revision; use current caller document/pack permissions
and caller-safe system-data output; remove UI/caller repair routes; and resolve its
own review findings. Validate against a supporting **released** Core toolchain
before changing minima or publishing. No module was inspected or changed here.

Separately authorize a disposable v13/v14 world and isolated Core stack for service
identity/reconnect/demotion/retry, settings/privacy, dry-run/backup acknowledgement/
apply, real supervised restart, delta/world-pack writes/readback, partial/uncertain
recovery and external restore with an unchanged completed ledger. Verify blocked
players, admin re-login/recovery, stale assets/dialogs and retained native ingress;
new and existing clients may become ready only after source/preparation success.
Include narrow/desktop, both themes and keyboard/focus in the rendered flow.
Controlled wire/restart fixtures are not that acceptance. No native lockout, world
backup/restore, inverse migration or undo is introduced. Keep the ADR open.

Coordination policy: processes serving the same Foundry instance must share one
durable migration lock directory (`SHEET_DELVER_MIGRATION_LOCK_DIR`) on a shared
filesystem. The default is installation-local and therefore supports a single
installation only. Leases have no time-based steal. Same-host restart recovery
requires the prior PID to be absent; cross-host orphan recovery requires explicit
operator reconciliation. No native-client/global database lock is claimed.

## Independent Core review — October 16, 2026

**Reviewed:** `5013e86` on `feat/adr-0064-world-context-and-migrations`, relative to
documentation baseline `f9011cd`. The worktree was clean on review entry: the pasted
implementation summary's "uncommitted" status was stale. This review changes only
documentation/local evidence. No module repository was inspected, no application
source was changed, and no live Core/Foundry service, native world, owning-repository
Git mutation or remote operation was used. The pre-review ADR was saved byte-for-byte
before these annotations.

The architecture is substantially implemented, but **Core is not ready for closeout**.
Five independently reproduced defects remain. The following records are
self-contained so a clean checkout does not need the ignored probe files.

### Independently verified evidence and limits

Existing offline checks all passed again, using installed executables:

- `node_modules/.bin/tsx src/tests/unit/run.ts`
- `node_modules/.bin/tsx src/tests/unit/client/run.ts`
- `node_modules/.bin/tsx src/tests/integration/run.ts`
- `node_modules/.bin/tsc --noEmit --incremental false`
- `node_modules/.bin/eslint`

The integration suite uses real Core components with controlled wire/restart and
injected compatibility/snapshot callbacks. It does not call production
`freshMigrationSnapshot`, `createHostUpgradeCoordinator`,
`checkInstalledWorldCompatibility` or the admin upgrade router. Its fixture
packaging test compiles once. The client suite does not render the new maintenance
controls. Passing results therefore do not establish those composition boundaries.
This is a coverage finding, not a reason to discard the useful existing tests.

Independent probes used temporary catalogs/journals, fake read/write transports and
Core-owned fixtures. All five reproduced the behavior described below, including
the real production snapshot service against isolated Stores. No native write was
sent. Current readiness assessments are:

| Gate | Review disposition |
| --- | --- |
| G0/G0a, G1 | Mechanisms and existing offline role/settings checks verified; native identity/reconnect acceptance remains pending. |
| G2 | Correction required: CR64-01 and CR64-05. |
| G3 | Correction required: CR64-01 and CR64-03; test actual preview/source wiring. |
| G4 | Correction required: CR64-02–04; actual process-replacement acceptance still pending. |
| G5 | Restricted target/envelope implementation and offline fixtures present; native v13/v14 semantics remain unproven. |
| G6/G7 | Shared caller checks/canonical identity and offline regressions present; adoption/role/privacy acceptance remains pending. The `/system/data` behavior change is intentional, not optional backward compatibility. |
| G8 | Separately authorized module work; not reviewed or implemented in this pass. |
| Core G9 | Existing checks pass; new regressions, production wiring and rendered acceptance remain open. |

### CR64-01 — P1: preview silently replaces live sources without rebuilding prepared data

**Anchors:** `src/server/services/world/migrations/ModuleUpgradeService.ts:50`
(`freshMigrationSnapshot`) and
`src/server/core/documents/primary/PrimaryDocumentCacheCoordinator.ts`
(`reconcileAll`). Preview invokes the production snapshot service while the world
may still serve users. It reseeds shared Stores, discards the returned publication
callback and calls `moduleWorldContext.refresh()` outside the adapter/preparation
barrier. This can also consume a settings change before the ordinary refresh path
observes it.

**Reproduction:** seed an Actor with `system.hp=1` and a declared boolean setting
false; configure/rebuild the real PreparedActorStore. Have the fake read transport
return hp=2/setting=true, then call `freshMigrationSnapshot` with an Actor catalog.
Observed live source hp=2 and context=true, prepared hp=1/context=false, zero Actor
or context publications, and an open world-work gate.

**Correction/checkpoint:** collect read-only preview inputs separately from serving
Stores, or route every serving-source replacement through the existing gated,
revisioned refresh/rebuild/publication lifecycle. Preserve source/permission
freshness and failed-preview usability; simply publishing the discarded callback
before preparation is not sufficient. Add a production snapshot/preview test with
interleaved reads and a concurrent source/setting change. Pass only when users
cannot observe mixed source, context and prepared revisions, and no native writes
or candidate initialization occur. Include preview failure and unchanged-source
cases, plus bounded read scope rather than unnecessary full-world sweeps per target.

### CR64-02 — P1: resumed operations do not validate changed reference inputs before writing

**Anchors:** `ModuleUpgradeCoordinator.ts:126–168` and `planner.ts` in
`src/server/services/world/migrations/`. A plan hashes the inventory at approval,
but resume checks only world/settings and each write target's source hash. A
declared cross-document/pack input may change during restart or between writes
without invalidating the exact pending patch. Hook verification is then too late.

**Reproduction:** an Actor-A step declares `reads.targets=["Actor"]`, plans
`A.system.value = B.system.value`, and verifies equality. Approve with A=0/B=10;
change only B to20 before resume. Observed A written to10, then post-write
verification failure. Expected zero writes under that obsolete approval.

**Correction/checkpoint:** persist and validate the relevant read dependencies and
source eligibility for every pending operation, accounting for prior approved
steps' expected transformations. Reconcile confirmed/uncertain outcomes without
blind replay. Reject known stale dependencies before intent/send and require a
fresh exact review if the remaining plan changes. A whole-original-inventory hash
comparison after every legitimate write is not sufficient either. Cover changed,
deleted and newly eligible references, pack dependencies, restart and between-write
changes, and valid multi-step plans. This narrows known stale input; it does not
promise native CAS, prevent all external edits or introduce native-client lockout.

### CR64-03 — P1: managed same-version repair changes historical hook identities

**Anchors:** `sourceCandidates.ts:17–29`,
`src/modules/registry/migrations/compile.ts:9`, and
`ModuleUpgradeCoordinator.ts:43–46`. Source candidate preparation calls the
compiler for both local source and already packaged managed hooks. Rebundling the
packaged CommonJS changes hook bytes and step digests, which the historical-step
immutability check correctly rejects.

**Reproduction:** compile a fixture, complete a write-bearing upgrade with that
artifact, then restore its Actor to the legacy value without changing the package.
Previewing the original package succeeds with one repair. Compiling that package
again, as managed source preview does, changes the step digest and fails with
`Historical migration step removed or changed; use a new stable step ID`.

**Correction/checkpoint:** preserve verified packaged definitions and hook bytes
when snapshotting a managed candidate. Keep local source compilation explicit and
stable; do not remove the historical integrity guard, mint new IDs for unchanged
steps or discard job history. Test actual source preview/apply after a completed
archive upgrade and external restore, repeated same-version repair and genuine
historical hook changes. Unchanged managed steps must keep their original digest;
changed steps must still be rejected.

### CR64-04 — P2: first upgrade can authorize stale browser code without a reload

**Anchors:** `src/client/ui/api/worldRuntime.ts:1–9` and
`src/client/ui/context/RealtimeContext.tsx:153–159`. Null represents both an
unobserved runtime and a previously observed runtime with no completed upgrade.
The first non-null token does not report a change, but is immediately attached to
future mutation requests.

**Reproduction:** a tab observes null, is disconnected during the first upgrade
and misses `serverRestarting`, then receives the new job token. The helper returns
false (no reload) and `worldRuntimeHeaders()` supplies the new token to old code.
The normal announced-restart path does not cover a tab which missed that event.

**Correction/checkpoint:** distinguish first observation from a change to an already
observed runtime, and do not grant replacement-runtime mutation authority to stale
assets before reload. Cover initial cold load, null→first token, token→new token,
missed restart/reconnect, guest/auth transitions and prevention of reload loops.
Add a rendered reconnect case; checking only the server header rejection is not
enough because the old client currently adopts the accepted token.

### CR64-05 — P2: successful same-world recovery leaves a failed refresh latched

**Anchors:** `WorldBootstrapper.ts:421–437,655–670` and
`src/server/routes/admin/registerAdminWorldRoutes.ts:57–66`. A failed dependency
hook sets `contextRefreshFailed` and blocks `context-refresh`. Successful same-world
recovery rebuilds and reports ready without clearing that failure/gate or publishing
the recovered context. Ordinary bootstrap may return early because its ready check
does not include this blocker. The existing admin retry route only accepts the
closed lifecycle, while this failure leaves the lifecycle active.

**Reproduction:** bootstrap a fixture, change a declared setting, make its refresh
hook fail once, then allow the hook to succeed and call real `recover()`. Observed
`ready:true` with `worldWorkGate.hasBlock('context-refresh') === true`. The existing
integration fixture verifies fail-closed behavior but resets for cleanup rather
than testing successful recovery.

**Correction/checkpoint:** define an explicit admin recovery path for this failure;
clear only the current failed revision after successful refresh, compatibility and
preparation, then publish the recovered context/invalidation. Never clear unrelated
upgrade/authority gates or let an older timed-out hook overwrite current caches.
Test failure→retry, failure→transport recovery, concurrent queued refresh, late
hook completion and another blocker remaining active. Provide a bounded admin
reason/retry action while public clients remain generically unavailable.

### Remaining work and acceptance checkpoints

1. **Core corrections, offline:** promote the five reproductions into tracked
   regressions, observe each fail against `5013e86`, fix through the shared owners
   and record passing evidence per CR64 ID. Exercise the real host coordinator,
   source candidate, compatibility and admin-route composition with isolated data
   and controlled native transport. Keep existing guard/integrity tests. Do not
   replace production services with callbacks that bypass the condition under test.
2. **Admin diagnostics and review completeness:** verify every non-job bootstrap
   failure has an admin-visible reason and recovery path. Currently
   `installedWorldCompatibility.ts:29–47` assigns diagnostics only for returned
   plan blockers; discovery, source-read, unsupported-version and preparation
   exceptions can leave it null. This source-level concern still needs a route
   reproduction. Render source-repair and recovery previews with the exact world,
   artifact, target/path scope and exclusions; those two controls currently show
   counts rather than the detailed operation view provided by the catalog preview.
   Confirm auth expiry, progress after reload, cancellation and cleanup behavior.
3. **Rendered acceptance, isolated:** test the actual Core admin/player components
   with controlled services, including narrow/desktop, both themes, keyboard/focus,
   non-dismissible player gating and CR64-04 reconnect. This can proceed without
   live Foundry authority; it is not established by the current client unit suite.
4. **Real supervised replacement, isolated:** use a separate data/config directory,
   inspect listeners/process ownership, then exercise the actual manager restart
   path with a controlled upstream. Record old/new PIDs, persisted job/lease/phase,
   startup admission before adapter loading, admin reachability, player gating and
   final activation. Killing an isolated lease worker or injecting a restart
   callback is not this result. Start/stop only task-owned processes; never use the
   root production-connected configuration.
5. **Native v13/v14, separately authorized:** obtain explicit disposable-world and
   write scope before connecting. Test full-GM/Assistant/missing/demotion/retry;
   setting create/change/delete and user/world collisions; Actor/world Item/embedded
   effect/unlinked delta/world-pack envelope and readback; tombstones/base identity;
   locked/package packs; lost acknowledgement, conflict, partial resume and external
   restore with an unchanged ledger/package. Assert zero unrelated changes. Record
   exact builds, fixture counts, inputs/outputs and remaining uncertainty. Measure
   planning/read cost at realistic inventory sizes without silently truncating.
6. **G8/release handoff:** keep module repositories untouched in this Core task.
   Provide the eventual adopter tested schemas, hook/digest rules, context refresh,
   caller projection contract and exact available host/SDK minima. Explicitly call
   out non-GM `/system/data` rejection without `getSystemDataForUser`; inventory
   affected consumers in the separately authorized module task. Do not weaken the
   caller boundary or claim all old modules retain every workflow. Core release
   approval, module adoption/publication and application version bumps are separate.

CR64-01–05 are **open**. Core corrections and independently runnable acceptance
come before any request for native test authorization. The ADR stays open until
the applicable corrective and acceptance evidence is recorded, with G8's separate
status explicit. No native lockout, broad Scene SDK, backup/restore/undo engine or
parked D&D experiment is added by this review.

### Corrective implementation checkpoint — October 16, 2026 (uncommitted)

The user authorized CR64-01–05 implementation on the existing branch. The review
above is retained as historical evidence, not overwritten by the corrections.
Five tracked correct-behavior cases in
`src/tests/integration/adr0064-corrections.test.ts` were added before source edits;
each failed against `5013e86` at its intended assertion: live Actor hp2 versus hp1
(01), one obsolete write versus zero (02), changed packaged digest (03), missing
first-token reload (04), and a retained failed-refresh latch (05). The ignored
review probes are not used as correctness tests.

Implemented, with focused offline checks passing:

| Finding | Correction / evidence |
| --- | --- |
| CR64-01 | Isolated, declared-domain source GETs suppress acknowledgement ingestion. Local Setting/context snapshots do not replace serving Stores or consume context notifications. Runtime/Store/pack/context fences reject interleaved ingress. Serving reconciliation is restricted to gated preparation, followed by the real adapter/prepared lifecycle. |
| CR64-02 | Approved operations retain exact reference membership/content hashes plus approved simulation effects. Resume checks these before native intent; already-applied approved effects reconcile unknown acknowledgements without granting new repair authority. Matrix covers changed/removed/new references, package references, between-write changes, sequential writes and uncertain readback. |
| CR64-03 | Managed snapshots copy verified catalog/definition/hook bytes; only local author sources compile. Historical step immutability remains enforced. Real source preview/apply plus installed compatibility detects an external restore and completes same-version repair with unchanged digests. |
| CR64-04 | Browser state distinguishes an initial observation from an observed null. A changed runtime retires the browser once and never replaces its pinned mutation header before reload. Cold/null/token/repeated observations covered. |
| CR64-05 | Recovery serializes outstanding refresh work, refuses overlap with a still-running timed-out hook, and releases only its context gate after current preparation succeeds. Admin receives a bounded diagnosis/retry; unrelated gates remain. Further queued/late-hook and rendered checks are in progress. |

The production-composition case controls only the upstream wire: actual CoreSocket
dispatch/ingress, host snapshots, source candidates, installed compatibility,
coordinator/journal, registry adapter loading/preparation and authenticated admin
routes are exercised. Discovery failures now have admin diagnostics, not just plan
blockers. Source/catalog/recovery controls share exact plan details; cleanup has an
explicit confirmation. Rendered and actual supervised-replacement acceptance are
still being completed. Native v13/v14 and separately authorized G8 remain pending;
this is not ADR closeout or release approval.

### Corrective verification results — October 16, 2026

**Implementation report at this checkpoint:** CR64-01–05 were reported resolved
for Core implementation and independently runnable verification. The subsequent
[corrective independent review](#corrective-independent-review--october-16-2026) confirms the original regressions pass but finds an additional pack-content
fence gap and qualifies player theme acceptance. Earlier “open” labels
in the independent-review section describe the reviewed baseline, not the current
tree. Required native evidence, G8 and user acceptance are still open.

- **CR64-01:** production snapshot regression now preserves live Actor/prepared/
  context values and the open gate, rejects failed/interleaved reads, and avoids
  unrelated document domains. The host-composition case changes a native setting
  without ingress: preview leaves the serving context alone, then real gated
  preparation produces the migrated Actor with the approved setting revision.
- **CR64-02:** changed, removed, newly eligible and declared pack references reject
  before intent. Approved sequential/cumulative transformations and first/later
  uncertain acknowledgements reconcile without duplicate writes. The later-unknown
  case initially failed during this corrective pass (a confirmed prefix was compared
  with an applied later result); the regression now passes with only exact approved
  effects overlaid. A production scope fence also runs at final dispatch. Native
  editing between observation and receipt remains possible: no atomic CAS is claimed.
- **CR64-03:** actual managed source preview/apply → installed compatibility → host
  coordinator completes, detects external restore, then completes same-version
  repair without changed catalog/step digests. Genuine packaged hook mutation is
  still rejected as historical change. Failed source previews clean only their
  newly created candidate snapshot, retaining journal/history evidence.
- **CR64-04:** cold, observed-null, existing-token, repeated and retired browser
  cases pass. The actual RealtimeProvider rendered check misses `serverRestarting`,
  reconnects with the first token and performs exactly one real browser reload.
  Replacement assets remain stable. The real HTTP stale-mutation fence is 409.
- **CR64-05:** failure→retry/transport recovery, a still-running timed-out hook,
  queued notification, late completion and teardown/replacement all pass. The real
  promise barrier survives teardown because registry adapters may be cached; new
  preparation cannot overlap the old hook. Successful current recovery publishes
  authorized recovered context keys and releases only its context gate. An unrelated
  blocker is preserved. Never-settling module code requires an operator Core restart,
  not an unbounded retry or claimed JavaScript cancellation.

Production-composition coverage controls only the upstream wire and unrelated
status/broadcast inputs. It uses real CoreSocket acknowledgement handling,
FoundryEventIngress, Stores, host snapshots, source candidates, registry loading,
installed compatibility, coordinator/journal and the complete admin router with
network/origin/account/auth/CSRF/audit middleware. Discovery, unsupported source,
read and preparation exceptions produce bounded admin phase/remediation; ordinary
clients remain generic. Source/catalog/recovery share exact world/artifact/expiry/
target/path/exclusion details; stale approval, stop and completed-file cleanup retain
their existing authorization boundaries. Admin drawers use native modal focus/Escape
behavior and restore the asynchronous review trigger.

Verification (all exit0):

| Check | Result |
| --- | --- |
| `npm run test:unit` | Full Core unit suite passed. |
| `npm run test:client` | Full client unit suite passed. |
| `npm run test:integration` | Existing integration plus nine isolated corrective cases passed, including production composition. |
| `npx tsc --noEmit --incremental false` | Passed; no application/module version changes. |
| `npm run lint` | Passed, zero reported errors/warnings. |
| Documentation | `git diff --check` and 42 local link targets in the affected public guides/ADR passed. |
| `adr0064-rendered.mjs` | Actual admin components, 320/390/820/1440, light/dark; exact details, acknowledgement, focus/Escape/return, auth expiry, progress after reload, stop and confirmed cleanup passed. |
| `adr0064-player-rendered.mjs` | Actual boundary/realtime with controlled transport/context inputs; eight viewport/theme cases, nondismissible maintenance, inert actions and missed-first-upgrade reload passed. |
| `adr0064-supervised.test.ts --run-isolated` | Actual manager/Core/Next replacement against fake loopback upstream, separate data and copied Core workspace passed. |

Supervised evidence: actual Core PID **1074170 → 1074453**; manager child wrapper
PIDs **1074098/1074099 → 1074400/1074401**. Job
`bd06905b-377c-46da-b6cd-b9599d0101ca` persisted restarting → verifying → completed
with a valid resumed lease and exactly one controlled Actor write. No adapter was
constructed before compatibility passed; during held preparation admin returned200
and player work503; activation rejected an old mutation header409. Task processes
were stopped; the user's port30000 listener was not contacted or changed.
These are controlled upstream results, **not native Foundry permission/envelope proof**.

### Remaining acceptance and G8 handoff

1. User review/acceptance of this uncommitted corrective tree and the updated
   maintenance/recovery presentation. No Git or release operation is authorized here.
2. Fresh, scoped authorization for disposable v13/v14 worlds and intended writes.
   Record exact builds; exercise the native matrix in the independent-review
   acceptance checkpoint (service roles/demotion, settings collisions/deletion,
   Actor/Item/effect/delta/pack writes and restrictions, uncertain/partial recovery,
   external restore and zero unrelated changes). Measure realistic inventory cost.
   The isolated upstream does not establish either native generation's behavior.
3. Separately authorized **G8**: adopt the generic contract without modifying Core
   to accommodate a system. Declare version-proven settings/defaults/exposure;
   provide lossless catalog/check/plan/verify hooks, immutable historical IDs and
   explicit references; implement bounded dependency refresh and caller-safe
   `getSystemDataForUser` using the request runtime. Inventory all non-GM consumers:
   absent caller-safe projection remains full-GM-only, not a privileged fallback.
   Validate with Core-owned examples, explicit module typing/packaging and the
   eventual released host/toolchain. Development SDK3.3/module-api1.5/UI3.2 are
   unchanged; released Core0.18.1 does not promise these additions. Select host/module
   release minima with the user; no version/adoption/publication is implied here.

No module repository was inspected or modified. ADR-0064 remains open.


### Corrective independent review — October 16, 2026

**Disposition:** the five original reproductions are corrected, and all existing
checks pass independently. Two further findings remain open: **CR64-06 (P1)** and
**CR64-07 (P2, acceptance evidence)**. CR64-06 extends the snapshot/reference
boundary reviewed in CR64-01/02; passing their existing cases does not establish
all declared pack dependencies are fenced. CR64-07 does not establish a production
theme defect. Native acceptance, realistic inventory measurement and separate G8
adoption remain pending. This review changes documentation and ignored probes only.

Reviewed the uncommitted corrective tree over `5013e86` on the existing
`feat/adr-0064-world-context-and-migrations` branch. No module repository was
inspected, no application source/version changed, no Git write or remote operation
performed, and no existing Foundry service contacted. A byte-identical ADR snapshot
was saved before this addendum (90,417 bytes; SHA-256
`09ce8f40a84b6657278b29c3f8efa39f43e130c53fe68f7e2571e443d31efb6a`).
This tracked record contains the reproduction and checkpoints without depending on
that ignored snapshot or machine-local evidence.

#### CR64-06 — P1 / corrected below: observed pack-content changes do not retire migration snapshots

**Source anchors:**
[`freshMigrationSnapshot`](../../src/server/services/world/migrations/ModuleUpgradeService.ts),
[`CompendiumStore.invalidatePackContent`](../../src/server/core/compendium/CompendiumStore.ts),
[`FoundryEventIngress.invalidatePackEntry`](../../src/server/services/world/FoundryEventIngress.ts),
[`WorldBootstrapper.refreshWorldContext`](../../src/server/services/world/WorldBootstrapper.ts)
and [`ModuleUpgradeCoordinator.resume`](../../src/server/services/world/migrations/ModuleUpgradeCoordinator.ts).

The snapshot stamp contains primary Store mutation revisions, context/runtime
identity and `listPackMetadata()`. Pack document ingress clears content/index
caches while preserving that metadata and does not advance a revision captured by
this stamp. Context refresh is not a substitute: it returns early without a ready
adapter, and ignores packs absent from the adapter's ordinary compendium declaration.
A migration's `reads.packs` can declare such a pack. This matters during maintenance
before adapter construction as well as during ordinary serving.

**Independent reproduction, controlled wire only:**

1. Use the real host fixture, service-role verification, Stores, CoreSocket and
   FoundryEventIngress. Declare an Actor migration reading `system.references`
   followed by a second empty pack, `system.barrier`. Put reference value10 in the pack and an Actor requiring repair in the world;
   the exact approved patch copies that reference into `system.fixed` (a fixture
   field, not a proposed system schema).
2. During the real pre-operation snapshot, return reference10 from the first pack
   GET. While the second pack GET is pending, change the first reference to20 and
   deliver its valid pack-scoped `foundry:modifyDocument` update through real
   ingress. Await invalidation before returning the second GET. The first pack
   index is now null, proving Core observed the change; metadata is unchanged.
3. `snapshot.assertCurrent()` still succeeds. The real host coordinator/maintenance
   dispatch writes Actor value10, persists `possibleWrite:true`, then its fresh
   post-write read fails verification against20. Observed result: reference20,
   Actor10, one write (`Actor.a`). A correct-behavior assertion requiring zero
   writes fails (`1 !== 0`). A separate snapshot-only assertion requiring retirement
   after this observed ingress also fails (missing expected exception).

The probe controls only generated wire responses, ingress while a second pack
read awaits, and unrelated promotion/restart/preparation callbacks;
its snapshot, ingress, coordinator, intent journal and final host write path are
production code. This is an already-observed mutation escaping the dispatch fence,
not the explicitly excluded race with an unobserved native edit after dispatch.
The existing `CR64-02-matrix` pack case changes a synthetic snapshot between calls;
it does not exercise this production invalidation gap.

**Implementation checkpoints:**

1. Add a tracked correct-behavior regression through the real host/ingress path;
   observe failure on this corrective tree before fixing it. Preserve the existing
   CR64-01–05 cases. Assert zero intent and zero sends when ingress precedes the
   pre-intent fence, plus rejection at final send when ingress occurs after intent.
   A persisted possible-write marker remains conservative; do not erase it to make
   a test pass.
2. Give pack-content observations a Core-owned monotonic revision/fence that
   advances synchronously when accepted ingress arrives, before async cache work.
   Capture/check the applicable writable and declared read-pack scope in snapshots.
   Cover update/create/delete, batches and compendium autosave through their shared
   owners. Keep catalog/membership, world/runtime and authority checks intact.
   Do not rely on an initialized adapter, successful cache hydration or module
   `compendiumPacks` declarations to retire migration dependencies.
3. Prove ordinary source reads do not advance mutation revisions, previews remain
   isolated, and late invalidation completion cannot revive a retired snapshot.
   Exercise a migration-only pack, an adapter-declared pack, a writable world pack,
   absent/preparing adapter, unchanged pack, and mutation during multi-pack reads.
   Preserve fresh reapproval, sequential/partial/uncertain recovery and no replay.
4. Rerun focused/full Core checks and the isolated replacement path, then update
   this finding, guide and handoff with evidence. Do not weaken exact approval or
   introduce native lockout, package-pack writes or module-specific repair code.

#### CR64-07 — P2 / corrected below: player theme acceptance does not activate player themes

**Source anchors:**
[`adr0064-player-rendered.mjs`](../../src/tests/acceptance/adr0064-player-rendered.mjs),
[`PlayerAppearanceContext`](../../src/client/ui/context/PlayerAppearanceContext.tsx)
and [`globals.css`](../../src/app/globals.css).

The player harness labels eight runs light/dark but sets `body[data-theme]`.
Core's player styles use `data-sd-appearance` on the body or `.sd-player-root`;
this harness mounts no appearance provider or matching scope. Its Foundry context
stub supplies no replacement component theme. As a result, the claimed dark
screenshot shows an unthemed light surface, and a direct computed-style assertion
finds `--sd-ui-surface-raised` empty. That assertion fails on the first labeled
light run as well. Screenshot names and loop iterations alone do not prove themes.
The separate admin harness correctly uses `data-admin-theme`; its theme evidence
stands.

**Implementation checkpoints:** render through the real player appearance owner,
or reproduce its actual scoped attributes using Core-owned fixtures. Assert the
selected scope and nonempty expected computed panel/text/backdrop tokens, and
prove light/dark resolved styles differ. Rerun 320/390/820/1440 in both appearances,
visually inspect representative captures, and retain nondismissible/inert gating,
keyboard behavior and the missed-first-upgrade reload checks. No module checkout
or runtime browser dependency is needed. Correct the acceptance record only after
those checks pass; change product styling only if a real defect is then observed.

#### Independently rerun evidence and remaining sequence

| Verification | Independent result / limit |
| --- | --- |
| Unit, client, integration runners | All exit0, including nine existing corrective cases. These do not cover CR64-06. |
| TypeScript and ESLint | Both exit0; no incremental output requested. |
| Documentation | Whitespace check and 56 local link targets/heading references passed; module paths excluded. |
| Admin rendered harness | Exit0 at four widths × two actual admin themes; narrow dark and desktop light screenshots inspected. |
| Player rendered harness | Exit0 for gating and actual missed-first-token reload; appearance claims withdrawn pending CR64-07. |
| Actual supervised replacement | Exit0 in copied workspace/generated data with fake loopback upstream; no native Foundry evidence. |
| New pack snapshot/send probes | Correct-behavior assertions fail as described in CR64-06; they are defect evidence, not passing regressions. |
| New player appearance probe | Computed token assertion fails as described in CR64-07. |

Independent replacement recorded actual Core PID **1092163 → 1093344**, supervisor
child wrappers **1092085/1092086 → 1093294/1093295**, and job
`733f6d9a-c0af-4d05-853b-846600aea2e7`. The durable lease survived replacement;
exactly one controlled Actor write occurred. Adapter construction remained blocked
until compatibility passed; held preparation returned admin200/player503; activation
rejected the stale mutation409. The harness stopped its services. These results
confirm the prior supervisor report and do not excuse the separate ingress gap.

Complete CR64-06/07 before treating corrective implementation/isolated acceptance
as complete. Then obtain scoped disposable v13/v14 authorization for the existing
native matrix. Record exact builds, world/target scope, allowed writes and backup
acknowledgement; never infer permission from an existing listener. Measure read
count/bytes, planning time, journal size, memory and UI responsiveness with realistic
Actor/Item/effect/delta/pack counts. Include no-op, write-bearing and partial-resume
plans: per-operation snapshots/read sets can multiply cost. The five-second planner
budget must fail clearly without approving a partial inventory. Synthetic sizing
can precede native testing, but cannot establish native latency or envelope safety.

G8 remains a separately scoped module task after proven Core contracts: version-
proven settings/defaults/exposure, lossless hooks and stable historical identities,
bounded context refresh, and caller-safe `getSystemDataForUser`. Non-GM rejection
without that projection remains intentional. Select release minima with the user;
no module inspection/adoption, release bump, commit, push or ADR closeout is implied.

### CR64-06/07 corrective implementation — October 16, 2026

**Disposition:** CR64-06 and CR64-07 are corrected in the uncommitted Core tree
over `5013e86`. The review above remains the historical reproduction, not the
current defect status. All existing CR64-01–05 changes and review material were
preserved. Before editing this ADR, saved an exact 101,204-byte snapshot, SHA-256
`71f9add1c2dfaaafdafa7ec965122e1ecbff5d29cb9eddc2ba0ba70bffe5796c`.
No application/contract versions, module repositories or native Foundry services
were changed; no staging/commit, branch or remote operation was performed.

#### CR64-06 evidence and boundary

Tracked cases in
[`adr0064-corrections.test.ts`](../../src/tests/integration/adr0064-corrections.test.ts)
were added before the fix. The snapshot case failed with a missing expected
exception; the pre-intent and final-send cases each failed because an obsolete
Actor write occurred when zero was required. They use the real host snapshot,
ingress, coordinator, journal and maintenance dispatch; only upstream wire replies
and unrelated promotion/restart/preparation callbacks are controlled. A second
pack read holds the real snapshot open while the first pack's mutation arrives.
The final-send case changes the reference after durable intent, then invokes the
production dispatch guard rather than bypassing it.

The final tracked fixtures were also rerun in a copied Core workspace with only
the pack-content stamp removed from the snapshot fence: all three fail at those
same assertions (exit1). With the fence present all pass. These are correct-behavior
regressions, not the earlier ignored probes that assert a defect exists.

CompendiumStore now owns monotonic per-pack content revisions. The existing shared
invalidation owner advances them synchronously, before any awaited persistent
cache work, for accepted document mutations, batches, autosave and catalog changes.
Snapshots capture exact declared read packs and applicable Actor/Item world packs
alongside existing metadata, Store, authority, context and runtime fences. Reads
and cache population do not advance content revisions. Clear/reset, asynchronous
failure and late completion cannot restore a captured stamp. No initialized adapter
or ordinary module compendium declaration is required.

| Required boundary | Tracked passing evidence |
| --- | --- |
| Content change with identical metadata | `CR64-06-snapshot`: immediate snapshot rejection after real ingress; index invalidated, metadata unchanged. |
| Mutation during multi-pack read, before intent | `CR64-06-before-intent`: zero wire sends, `possibleWrite:false`, no outcomes. |
| Mutation after intent, before final send | `CR64-06-final-send`: zero sends, preserved `possibleWrite:true` and uncertain outcome; old approval rejected. Fresh review approves20 rather than10, preserves prior evidence and writes once. |
| Shared ingress owners | `CR64-06-ingress-matrix`: create/update/delete, batch, autosave and confirmed dispatch acknowledgement advance synchronously during maintenance without an adapter. GET, failed responses and unrelated-pack contents do not retire the unchanged scope. |
| Writable pack and membership | `CR64-06-world-pack`: canonical writable world Actor target fenced without `reads.packs`; catalog create/delete use the same revision owner. Existing Item/permissions/target regressions remain passing. |
| Module-declared and preparing adapter | `CR64-06-adapter-lifecycle`: real registry/bootstrap with Core-owned fixture, held initialize, then ready adapter; both retire snapshots before context hydration/refresh. Migration-only packs are covered separately. |
| Cache timing/failure/reset | CompendiumStore unit tests: delayed and rejected invalidation, no active system, reads/population and reset do not revive an old revision. |
| Partial/uncertain recovery | Three real-host recovery cases: stop after one write; unchanged dependencies reconcile a lost receipt without replay; changed pack inputs reject old approval and require a fresh exact plan, preserving prior outcomes. Completed jobs do not replay. Existing sequential/cumulative reference cases still pass. |
| Preview isolation | Existing CR64-01 assertions retain serving source, prepared and context snapshots across successful/failed previews; new content tests send no preview writes. |

Retiring before intent creates no possible-write marker. After intent, even a
blocked final send retains conservative uncertain evidence. Exact source/reference
readback and explicit reapproval remain authoritative; the revision is not an
approval substitute, native lock or atomic compare-and-swap. Unobserved native edits
after dispatch remain outside this guarantee. No package-pack write grant was added.

#### CR64-07 evidence and rendered acceptance

The tracked player harness first gained a nonempty computed-token assertion while
retaining its old `data-theme` setup. It failed at320/light because
`--sd-ui-surface-raised` was empty (exit1). It now mounts the actual
PlayerAppearanceProvider and chooses its appearance through the provider's existing
preference key. No product CSS change or replacement module theme was necessary.

All eight cases (320/390/820/1440 × light/dark) assert the actual root/body/html
`data-sd-appearance` scope and nonempty panel/text/backdrop tokens. They assert
resolved panel/text/backdrop colors and distinct light/dark results, not just file
names. Light resolves to `rgba(250,253,255,0.98)` / `rgb(23,40,60)` /
`rgba(14,29,47,0.55)`; dark to `rgba(28,48,72,0.97)` / `rgb(241,245,251)` /
`rgba(3,12,24,0.72)`. All eight captures were visually inspected: readable centered
panels, bounded narrow wrapping, no horizontal overflow and visibly distinct themes.
Escape, pointer and keyboard cannot dismiss maintenance or reach inert Actor
actions. The actual missed-first-upgrade reload remains exactly once; appearance
is reapplied after reload. No browser dependency was added to application runtime.

#### Verification and remaining gates

- `npm run test:unit`, `npm run test:client`, `npm run test:integration`,
  `npx tsc --noEmit --incremental false`, `npm run lint` and `git diff --check`:
  exit0. Corrective integration now has18 isolated cases, including the original
  nine. Root tests do not substitute for native Foundry permissions.
- Both tracked rendered harnesses pass at four widths × two actual themes.
  Admin keyboard/focus, authorization expiry, exact plan, stop and cleanup checks
  remain passing; player assertions above replace the withdrawn appearance claim.
- Actual isolated supervised replacement rerun: Core PID1151569→1151799;
  supervisor wrappers1151460/1151461→1151743/1151744; job
  `7cb39cba-b4c0-4516-96f8-0fa02ecd76b0`. Its lease survives restart, no adapter is
  constructed before compatibility, exactly one controlled Actor write occurs,
  held preparation gives admin200/player503, and stale mutation gives409 after
  activation. Task services stop in harness cleanup. This is controlled upstream
  evidence, not native target/envelope verification.
- Public migration, architecture, API and authoring guides now describe the
  content fence and its limits. Existing terse changelog feature snapshots cover
  these corrections without a second transcript of unreleased work. The active
  audit and stable handoff record commands, artifacts and pending scope.

**Still pending, not deferred or implicitly accepted:** scoped disposable v13/v14
native target/write acceptance with backup acknowledgement; realistic inventory
cost measurement (counts/bytes/planning/journal/memory/UI for no-op, write and
partial-resume); separately authorized G8 adoption; user review/acceptance. No
existing listener was reused. ADR-0064 stays Accepted/open; no release or publication
approval is implied.


### CR64-06/07 independent confirmation — October 16, 2026

**Review result:** CR64-06 and CR64-07 are resolved for the reviewed Core
implementation and isolated acceptance. No new confirmed corrective blocker was
found. This confirms the preceding implementation report; it does not close the
ADR or establish native Foundry behavior, realistic capacity or G8 adoption.
Reviewed the uncommitted tree on `feat/adr-0064-world-context-and-migrations` over
`5013e86`; this pass edited documentation only and preserved all source/test changes.

- **CR64-06:** reviewed the shared synchronous revision owner, reset behavior,
  declared/writable pack scope, and pre-intent/final-dispatch checks. Independently
  reran the original snapshot and multi-pack send probes from the prior review,
  unchanged. Both now pass. The latter observes reference20 while retaining the
  original Actor value, with `writes:[]` and `possibleWrite:false`; the obsolete10
  write no longer occurs. The 18 tracked corrective cases also pass, including
  no adapter, lifecycle transitions, post-intent rejection, explicit changed-source
  reapproval and partial/uncertain recovery without replay. Store unit tests cover
  delayed/failed invalidation and reset behavior.
- **CR64-07:** reviewed actual PlayerAppearanceProvider composition and computed
  panel/text/backdrop assertions, then reran the player harness. All eight captures
  (320/390/820/1440 × light/dark) were independently inspected. Themes are visibly
  distinct, text wraps within the panels and no horizontal overflow was found.
  Inert keyboard/pointer protection, nondismissible maintenance and the actual
  missed-first-upgrade reload pass. No production styling fix was needed.
- **Regression checks:** complete Core unit/client/integration runners, TypeScript
  without incremental output, ESLint, both rendered harnesses and real isolated
  supervised replacement all exit0. The admin harness retains its theme/focus/
  expiry/stop/cleanup assertions. Whitespace and 61 local document target/heading
  checks pass, excluding module/ignored paths. These are controlled upstream results.

Independent supervised evidence: actual Core PID **1164269 → 1165049**, child
wrappers **1164095/1164096 → 1164985/1164986**, job
`29b7bfc9-df32-4d08-a041-439b09829a92`. The lease/job survives replacement, one
controlled Actor write occurs, adapter construction waits for compatibility,
held preparation returns admin200/player503, and the stale mutation returns409
after activation. The harness stopped its services; no existing Foundry listener
was contacted. No module repository, version, Git index/history or remote state
was changed.

Before this documentation revision, saved and verified the exact 109,108-byte ADR,
SHA-256 `83ffd41ca775b9f71dae9e5d46c93fa0b52a4511f75bd64daaf5360f8b77fee9`.
The tracked cases and reproduction descriptions above remain the durable evidence;
local artifact paths are recorded in the handoff rather than required by this ADR.

**Next work:** no additional CR64-01–07 source correction is indicated by this
review. The next offline task can measure realistic synthetic inventories through
production snapshot/planner/journal paths, separately timing no-op, write-bearing
and partial-resume plans. State fixture assumptions, document/embedded/pack counts,
bytes, reads, wall time, memory and journal size. Include bounded failure at the
existing computation budget; do not approve truncated plans or increase limits to
make a measurement pass. Identify measured problems before proposing optimizations.
Synthetic timings do not establish native latency or envelope/permission behavior.

Native v13/v14 acceptance still requires explicit disposable-world/build/target/
write authorization and the selected backup acknowledgement. G8 remains separately
scoped module work; ordinary user rights and caller-safe projection requirements
remain unchanged. User acceptance and any checkpoint/release require their own
scope. The ADR and active audit stay open for these named gates; do not reopen
historical corrected findings or move the audit to completed yet.
