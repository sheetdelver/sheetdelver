# Core ADR-0064: Module World Context and Data Migrations

**Status:** Completed — CR64-28 build-tracing correction verified October 20, 2026; local checkpoint prepared for user-owned push/merge and point release 0.19.4. Core 0.19.3 is released; its CR64-27 operator acceptance remains valid. The [CR64-28 amendment](#cr64-28-maintenance-proxy-build-tracing--october-20-2026) records the warning-free build and preserved maintenance behavior. SDK/API contracts and module artifacts are unchanged; 0.19.4 publication is not claimed.
**Date:** October 16, 2026
**Related:** Core ADR-0021, ADR-0027, ADR-0028, ADR-0038, ADR-0056, ADR-0057, ADR-0063; Shadowdark module ADR-0001

Previous disposition: [Responsive roll-dialog correction and Core closeout](#responsive-roll-dialog-correction-and-core-closeout--october-18-2026), following [native v13 verification](#final-source-native-v13-verification--october-18-2026), [native v14 verification](#final-source-native-v14-verification--october-18-2026), [independent G8 verification](#independent-g8-verification--october-18-2026) and the
[G8 integration correction amendment](#g8-integration-correction-amendment--october-18-2026).
The [October 17 Core closeout](#cr64-22-r1-correction-and-core-closeout--october-17-2026)
remains the historical disposition of the released work. Its then-current
"no confirmed Core gap" and pending-release statements do not describe the new
G8 findings or the current release state. Earlier open findings and pending
acceptance statements below are dated history, not new obligations; valid
evidence and its limitations remain preserved.

Preceding implementation evidence: [CR64-22 admin migration visibility](#cr64-22-admin-migration-visibility--october-17-2026), following [fresh complete-maintenance native v13 acceptance](#fresh-complete-maintenance-native-v13-acceptance--october-17-2026), [independent CR64-21 verification](#independent-cr64-21-verification--october-17-2026), [CR64-21 recovery correction and focused native verification](#cr64-21-first-approval-recovery-correction--october-17-2026), [CR64-18–20 corrections and native v14 repeat](#cr64-1820-correction-and-native-v14-repeat--october-17-2026) and [complete-maintenance implementation](#complete-maintenance-implementation-and-isolated-acceptance--october-17-2026). Earlier pending-native statements below retain their historical scope.

The [independent Core review](#independent-core-review--october-16-2026) of
`5013e86` supersedes the implementation checkpoint's completion implications.
At review, existing suites passed but five probes reproduced defects. The
[corrective evidence](#corrective-verification-results--october-16-2026) below
records their initial corrective results. The [corrective independent review](#corrective-independent-review--october-16-2026) found two further defects; the [CR64-06/07 follow-up](#cr64-0607-corrective-implementation--october-16-2026) records their corrections and evidence. The [independent confirmation](#cr64-0607-independent-confirmation--october-16-2026) verifies those corrections against the original reproductions and current tests. The earlier G0–G7/Core G9 table is not native acceptance.

The subsequent [native v14 acceptance](#native-v14-acceptance-and-cr64-08--october-16-2026)
records actual Foundry writes, settings ingress, recovery and the admin UI. It
supersedes earlier statements that no native testing was authorized or performed.
The earlier [native v13 acceptance](#native-v13-acceptance-and-g8-handoff--october-16-2026)
completed the then-selected smaller matrix, not the subsequent complete-maintenance
correction/repeat gate. The latest addendum now supplies fresh v13 acceptance of
the current implementation. G8 remains module-owned work; no Core fixture run establishes compliance
of an adopting system module.

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

This is the original design inventory. The implementation/corrective evidence and
native addenda below record its cumulative disposition; native testing does not
by itself check every scenario in the aggregate rows or establish module adoption.
The final native group is now verified on13.351 and14.367. Reconcile the remaining
aggregate rows against their Core and module evidence at final ADR closeout.

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
- [x] Separately approved disposable-world native run: setting changes and admin
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

**Next work at that review (superseded by the native pass below):** no additional CR64-01–07 source correction is indicated by this
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

### Native v14 acceptance and CR64-08 — October 16, 2026

The user selected native testing first, v14 followed by v13, with G8 adoption
afterward. They launched `shadowdark-test` on loopback port30000 and supplied
the passwordless GM account. Runtime identity was **Foundry14.367 / Shadowdark4.0.6**;
the account resolved to `Gamemaster`, role4. Testing used a copied Core workspace,
generated isolated configuration and a Core-owned fixture module. No SheetDelver
system-module repository, root production settings, version or remote was changed.
This is Core contract acceptance, not Shadowdark G8 compliance.

#### CR64-08: native null ActorDelta sources

The initial real bootstrap and admin preview failed before writes with
`Required unlinked-token delta/base Actor is unavailable`. Six existing unlinked
tokens had a valid base Actor and native `delta: null`. Installed v14
`common/documents/token.mjs`, `ActorDeltaField.initialize`, confirms that a delta
can materialize lazily; a null source contains no persisted overrides. Treating
every null as an unavailable migration target prevented valid worlds from using
required ActorDelta migrations.

`targets.ts` now enumerates each base Actor once, skips null deltas with a valid
base, and skips tokens with no Actor association. It does not invent a delta ID,
materialize synthetic data or copy inherited items into stored overrides. Broken
non-null Actor references and malformed non-null deltas still block required
enumeration. Stored deltas and their own children remain canonical targets.

The added regression in `src/tests/unit/world/module-world-migrations.test.ts`
failed against the previous enumerator with the native error, then passed after
the correction. It checks lazy/decorative tokens, base-once enumeration, owned
delta children and rejection of missing bases/malformed deltas. The native
workflow then advanced through the same real scenes without altering their
existing tokens or inherited-child tombstone. This is a Core compatibility fix;
modules must not add a workaround or synthesize deltas.

#### Native results

| Boundary | Observed result |
| --- | --- |
| Full-GM connection | Real service login/bootstrap succeeds as role4. Temporary Assistant and missing account are rejected. Demoting the temporary active service account to3 blocks player access503 and preview409; restoring4 plus the admin retry restores readiness. Existing human roles were untouched. |
| Read-only preview | Actual source preview checks106 targets and proposes11 fixture-only updates; no blockers after CR64-08. Native Actor readback is unchanged by preview, and the candidate adapter has not been constructed while compatibility is blocked. |
| Target dispatch/readback | Eleven confirmed updates: world Actor, embedded Item and its effect, Actor effect, world Item and its effect, unlinked ActorDelta and its own Item, world Actor pack document and its embedded Item, world Item pack document. All use canonical native parent/pack envelopes. The existing tombstone remains unchanged; package packs are excluded. |
| Pack policy | Locking a dedicated world pack makes the required preview return409. Restoring its unlocked setting allows a zero-write preview. No package pack was unlocked or written. |
| Durable activation | Actual Core/Next supervised replacement resumes the approved native job. During held adapter preparation, admin remains200 and player access503. Completion activates the job token; a stale mutation returns409. The11-write journal is14,941 bytes. |
| Settings and preparation | Native `shadowdark.usePulpMode` update false→true refreshes the adapter context and prepared Actor, while its retained initial snapshot stays false. Restore returns preparation to false. Create/update/delete events, user-scoped same-key collision and registered-default fallback pass through real ingress and the authenticated context endpoint; context revisions advance1→5 in the lifecycle run. |
| Scalar decoding | Dedicated native test Setting rows containing JSON false,0 and null round-trip through SettingStore without falsy fallback. These rows are fixture values, not invented Shadowdark registered defaults. |
| Caller authority | A temporary player's Actor write is rejected by Foundry before ownership, succeeds as owner, and is rejected after revocation. `/system/data` returns403 for the fixture adapter without `getSystemDataForUser`, as intended for pending G8. |
| Restored source | Reverting only an acceptance Actor's version flag while preserving the completed Core journal makes reconciliation block readiness without repairing it. Fresh preview/approval completes exactly one repair through another supervised replacement. This simulates restored document content; it is not an actual Foundry backup restore. |
| Uncertain receipt | A controlled exception after a real native dispatch records an uncertain outcome and stops maintenance. Resume reads back the applied result, performs the other write and completes with two distinct sends total. Repeating completed resume sends nothing. Receipt loss is injected; the writes/readback are native. |
| Partial conflict and admin UI | A deliberate edit to the remaining fixture Item stops the partial job, initially at the source revision fence. Retrying the old approval then rejects a dependency conflict. The actual `/admin/modules` page shows106 checked/one remaining write, requires the backup-limit acknowledgement, and completes that revised plan. Prior outcomes remain in the journal. |

The real admin recovery Drawer was rendered and visually inspected at390 and1440
pixels: readable wrapped identities/paths, bounded layout, disabled approval until
acknowledgement and no page errors. The revised plan was approved using its actual
button. Earlier eight-case player/theme acceptance remains separate evidence;
this native pass did not repeat the entire appearance matrix.

#### Inventory observations and limits

The supplied world had9 Actors with71 embedded Items and14 Item effects,2 Scenes
with7 tokens (six null deltas and one stored delta containing a tombstone),32
Settings,4 Users and no world Items/packs. Its21 package packs exposed1,091 index
rows; package document contents were not hydrated for migration. Primary source
reads measured approximately0.89s, including94,358 Actor bytes and15,600 Scene
bytes. Dedicated acceptance data added the target domains needed for the test.

The native11-write preview checked106 targets in429ms and produced8,884 bytes;
the zero-write preview took276ms and produced1,279 bytes. A two-operation
lost-receipt/resume cycle took1.74s, including70 fresh native GETs /1,384,850 response
bytes; its journal was3,524 bytes. Test-process RSS rose from279,171,072 to465,408,000
bytes during that cycle. These are observed small-world costs, not peak-memory,
leak or large-world capacity guarantees. Repeated fresh snapshots and hook VM
allocation deserve measurement against the adopting modules' real inventories;
do not raise limits or approve incomplete inventories to make a test pass.

#### Cleanup, verification and next checkpoint

All four native jobs finished. Dedicated Actors, Items, Scene, packs, users and
test settings were removed; Pulp Mode and compendium configuration were restored.
Final membership and document content match the captured Actor/Item/Scene/Setting/
User baseline after excluding native `_stats` metadata. Original Actor and Scene
byte counts are unchanged. Isolated services/browser were stopped; the user's
Foundry PID398540 remained running on30000. No native browser/runtime dependency
was introduced.

Core unit/client/integration suites, including18 prior corrective integration
cases, TypeScript and lint pass with CR64-08. No commit, release or push was made
in this native slice. Before editing this ADR, its exact113,413 bytes were saved
and verified with SHA-256
`b901c586b9ea78a5a6a1528fe270704d13946c6df7d376b60d42b9993be7e40f`.

**Next:** the user switches the local instance to v13 and launches the disposable
test world; verify its runtime identity and repeat native acceptance before G8.
Do not infer v13 behavior from this pass or restart/manage the user's Foundry
process. G8 remains separate module work with proven settings, lossless hooks,
refresh and caller-safe projections. ADR/audit remain open for v13, G8 and user
review. Native CAS/lockout, backup/undo and broader capacity claims remain outside
the established evidence.

### Native v13 acceptance and G8 handoff — October 16, 2026

After the user switched the local instance and confirmed readiness, runtime
identity was **Foundry13.351 / Shadowdark4.0.6**, world `sd-adr61-v13`, port30000.
The passwordless `Gamemaster` account was verified as full GM. The world initially
contained no Actors, Items, Scenes or world packs, four Settings and one User.
Fresh acceptance data and a separate copied Core workspace/configuration were
used. The v14 evidence and private baseline were preserved separately.

**Result: the selected native Core acceptance gate now passes on both generations.**
V13 required no additional Core source change. CR64-08's correction was exercised
against native v13 null deltas, including linked and actorless tokens. This does
not certify Shadowdark module rules, native browser preparation or G8 adoption.

| V13 acceptance | Result |
| --- | --- |
| Native target coverage | Eleven checked targets and11 confirmed writes: world Actor, embedded Item/effect, Actor effect, world Item/effect, unlinked ActorDelta/owned Item, world Actor pack/embedded Item and world Item pack. Preview leaves native Actor source unchanged and does not construct the candidate adapter. |
| Delta preservation | One stored delta contains both an inherited-child tombstone and an owned Item. Its own fields/Item migrate; the tombstone retains the base Item ID and has no invented flags. The base Item is targeted once. Three other token sources retain null deltas: inherited-only, linked and actorless. |
| Upgrade/activation | Actual supervised Core processes1242717→1243015→1243268 cover initial readiness, approved migration and same-version repair. During held preparation admin remains200/player503; completion activates the job token and stale mutation returns409. |
| Settings | Native Pulp Mode create/update/delete, world/user same-key collision, registered-default fallback and false→true→false preparation refresh pass. Context revisions advance1→5 through the authenticated endpoint; retained old snapshots stay unchanged. Separate native fixture rows preserve false,0 and null through SettingStore. Installed4.0.6 source proves the Pulp default; no default was guessed. |
| Authority | Full-GM service succeeds; Assistant/missing service accounts are rejected. Temporary service demotion to3 blocks player access503 and preview409; restore4/admin retry recovers. Native player writes fail before ownership, succeed with owner permission, and fail after revocation. A module without caller-safe projection returns403 for player `/system/data`. |
| Packs | Required locked world pack makes preview return409. Unlock restores a zero-write plan. System/package packs remain excluded. |
| Restore detection | Resetting only a fixture Actor's version flag with the completed journal intact blocks preparation without an automatic repair. Fresh reviewed approval performs one native repair. This is restored-source simulation, not a Foundry backup/restore exercise. |
| Lost receipt | An injected exception after a real native write leaves an uncertain outcome. Native readback on resume confirms it; the remaining operation runs. Two distinct sends total, no replay on completed resume. |
| Partial conflict | Editing the remaining fixture Item stops the first run at the source revision fence. Old approval rejects the changed dependency, with one native write confirmed. The actual admin page reviews11 targets/one remaining write, requires acknowledgement and completes the revised plan; prior approval/outcomes remain journaled. |
| Rendered recovery | Actual `/admin/modules` Drawer inspected at390 and1440 pixels: paths and identities wrap, no horizontal overflow or page errors, approval disabled before acknowledgement. Its actual button completed the native repair. |

All four native jobs completed. The partial-conflict harness intentionally stopped
with a recoverable job for the subsequent UI run; both harness processes passed.
No retry of old approval silently accepted the changed Item.

#### Measurements and cleanup

The empty-world primary inventory read took423ms. With fixtures, the11-write
preview took111ms and produced8,880 bytes; its final journal was14,937 bytes.
The zero-write preview took76ms and produced1,275 bytes. Two-operation uncertain
recovery took702ms, including70 native GETs /213,060 response bytes; the journal
was3,520 bytes and test-process RSS168,353,792→200,658,944 bytes. The stopped
partial-conflict check took432ms /56 GETs /170,536 response bytes before UI review.
The supplied world's21 package indices contained1,091 rows; their document
contents were not migrated. These are small fixture costs. Use the populated v14
world measurements separately; neither establishes large-world capacity.

Cleanup removed every test Actor/Item/Scene, world pack, temporary user and setting.
Because this world originally had no Pulp Mode row, cleanup restored that absence
instead of leaving a persisted default. Original Actor/Item/Scene/Setting/User
membership and content match the captured baseline excluding native `_stats`.
The result is zero Actors/Items/Scenes, four Settings and one User, with no world
packs. Task services/browser are stopped. User Foundry PID1241960 remains running
on30000; its process was not managed by the acceptance harness.

No additional application source, release version, module repository or Git history
change was needed in the v13 slice. Existing full unit/client/integration18,
TypeScript and lint evidence for the unchanged CR64-08 source remains applicable;
it was not misrepresented as a fresh full-suite rerun. Fresh v13 workflow, access,
delta, recovery, rendered and cleanup checks all passed. Before this addendum,
the exact122,177-byte ADR was saved and verified with SHA-256
`88a96ea21727bc6435da592dfb329a4c54b2463d51ace616a6be9a77da707ba3`.

#### Next implementation checkpoint: G8

The next work belongs to the adopting module, beginning with its own guidance,
handoff, ADR-0001 and active audit. Core's native acceptance is no longer a reason
to defer that work. Preserve unrelated module changes and obtain any required
branch/Git authorization for that separate task. No module was inspected here.

1. Declare proven native world settings (including `usePulpMode` and
   `autoConsumeAmmunition` where consumed), exact version ranges, default provenance
   and exposure. Use the host context throughout preparation/actions; distinguish
   unavailable, registered default and stored false/zero/null.
2. Supply the separate migration catalog, versioned definitions and packaged
   pure check/plan/verify hooks. Preserve custom/unknown data and historical hook
   identities; use real4.0.6 source shapes. Test lossless changes, no-op/repeated
   runs, unresolved shapes and required bootstrap blocking before removing any
   prototype repair. Do not manufacture damage, effect fields or token deltas.
3. Refresh module caches and prepared projections through the bounded context
   lifecycle. Prove live Pulp/ammunition changes reach all affected consumers;
   stale dialogs/actions must refresh or reject using context provenance.
4. Implement caller-safe `getSystemDataForUser` and use caller-bound document/pack
   access. Test player/Assistant/GM views and revoked access with warm caches;
   preserve canonical UUIDs and private/identified content boundaries.
5. Remove caller/UI migration execution once the Core-owned approved migration
   path is proven. Owner permission, adapter initialization and sheet rendering
   must not become substitutes for admin approval or privileged migration access.
6. Validate the module's own outstanding audit corrections, types, tests and
   isolated package against these actual Core contracts. Record a real module
   upgrade/settings/projection acceptance before marking G8 complete. SDK3.3 /
   module-api1.5 / UI3.2 remain unreleased; Core0.18.1 does not provide them. Do not
   invent a published host minimum, pre-bump releases or claim these generic
   fixtures establish module compliance.

ADR-0064 and the active audit remain open for G8 and user/closeout review. Native
v13/v14 acceptance is complete for the recorded scope. Native CAS/lockout,
world backup/undo and broad capacity certification remain outside that result.

## G8 corrective follow-up — October 16, 2026

The user requested independent verification of Shadowdark's adoption, challenged
the five-second migration ceiling, and selected a related Core follow-up after
the module annotations. This ADR is already Accepted/open; no duplicate ADR or
reopening of ADR-0063 is needed. **CR64-09–12 below are confirmed and unresolved.**
This pass changes documentation only. Its baseline is Core `main`, tag v0.19.0,
`2f71597` (package 0.19.0; SDK 3.3.0, module-api 1.5.0, UI 3.2.0, roll 1.0.0).
Earlier references to these contracts as unreleased describe historical state.
The user reports publication; the local release tag and versions were verified.

Before this revision the exact 131,139-byte ADR was saved, SHA-256
`2b49b4563085062cdf43886787bbdf601aebc9c9aa22c4626c5060940f08a0cf`.
The new findings do not erase the previous native write/readback/recovery evidence.
Those small fixtures did not establish realistic module migration capacity or
all native player compendium policies.

### Independent evidence

Shadowdark was reviewed on `fix/adr-0001-native-alignment`, `af24b8e` plus its
uncommitted adoption, manifest 0.9.4, native reference `release-4.0.6` (`9677d16b`).
All eleven module suites, explicit module typing, isolated checking/packaging and
the supplied 11-case actual-Core-code harness pass again. The harness exercises
Core services and route handlers; it is not a real HTTP/UI process, native world
or `WorldBootstrapper` recovery run. The module-owned audit/ADR retain the detailed
module results and a separately reproduced UI initial-load race, RV-08. Core
does not fix that provider or claim G8 complete in this follow-up.

The following focused reproductions use actual Core planner/catalog/permission
code, compiled module hooks and synthetic sources, without any Foundry connection.
The v13 comparison uses the local native source's actual role evaluator. These
are defect reproductions, not new native acceptance results.

| Finding | Severity | Confirmed behavior |
| --- | --- | --- |
| CR64-09 | P1 | A complete required check of already-current effect data exceeds the global five-second plan deadline at 30 Player Actors / 900 embedded Items / 300 effect targets. Bootstrap uses the same planner. |
| CR64-10 | P1 | World-pack targets are enumerable/writable, but a pack effect cannot obtain its parent through a generic declared relation; only exact world-specific `reads.packs` IDs expose it. |
| CR64-11 | P2 | Planner catch handling drops hook reasons and stage information, leaving `source check/plan unavailable` where the module identified a specific missing parent. |
| CR64-12 | P1 | General v13 player pack reads are denied even where native pack ownership grants OBSERVER. The reused combat helper has a generation-14-only ordinary-player branch. |

### CR64-09 — Complete migration computation without a whole-inventory deadline

`src/server/services/world/migrations/planner.ts:planWorldMigrations` sets
`Date.now() + 5000` once for the entire synchronous step/target traversal. This
is **not a Foundry rule or a five-second limit on the whole upgrade job**. It is
separate from `hooks.ts`'s one-second limit for each synchronous pure hook and
the adapter context-refresh timeout/settlement barrier in `WorldBootstrapper`.
Do not conflate or remove all three protections to address one defect.

Fresh measurements using the module's supplied benchmark, all effects current:

| Player Actors | Embedded Items per Actor | Effect targets | Serialized Actor bytes | Check-only result |
| --- | --- | --- | --- | --- |
| 9 | 8 | 36 | 138,349 | 308 ms, complete |
| 20 | 20 | 140 | 697,721 | 3,826 ms, complete |
| 30 | 30 | 300 | 1,536,091 | 5,013 ms, `Migration computation budget exceeded; no partial plan is approved` |

These are machine-dependent synthetic costs, not a fixed world-size threshold.
Each Player has two Actor effects and an effect on every fourth Item. Required
parent reads currently include every non-pack Actor/Item/ActorDelta reference,
with embedded content duplicated. `hooks.ts` serializes that data, reads/checks
the hook and creates a VM/script for each invocation. Even a current target runs
check and verify. Write-bearing planning additionally hashes/synchronizes the
simulated inventory. Parent scoping helps but cannot alone eliminate an arbitrary
whole-plan deadline or repeated invocation cost.

The same planner serves installed compatibility at bootstrap, upgrade preview,
pre-apply revalidation, post-write checks/preparation and recovery. Thus this can
hold an already-migrated world unavailable on every startup; it is not merely a
slow optional preview. The original decision to reject partial plans remains
correct. Its global wall-clock ceiling now needs replacement, rather than asking
operators to accept incomplete coverage or an unusable world.

**Required behavior:** process the complete applicable inventory with bounded
individual work, useful progress and responsive admin access. Use an asynchronous
coordinator and yielding work units and/or isolated workers; pure module hooks
may remain synchronous. A healthy job can take longer than five seconds. During
approved execution, maintenance persists until full verification/recovery, not
until a timer releases users. Preview must preserve the serving adapter/context;
it must not enter write authority merely to compute. Bootstrap compatibility may
gate readiness while checks progress, and must still detect externally restored
legacy sources even when a journal says completed.

Optimize job-local immutable hook loading/compilation and dependency hashing where
appropriate, without sharing mutable hook globals, weakening digest checks or
trusting old source as current. Reduce repeated reference payloads with CR64-10.
Preserve per-invocation runaway protection and bounded inputs/outputs. Exceeding
an individual bound or a real unresolved source remains an actionable error;
ordinary total inventory size must not produce a five-second terminal failure.

### CR64-10 — Declared bounded parent and ancestor dependencies

`planner.ts:hookInput` filters pack rows exclusively through exact `reads.packs`;
`reads.targets` applies only to non-pack rows. Core already enumerates world-owned
Actor/Item packs and their embedded targets, preserves canonical UUIDs and can
write an effect with the correct pack parent. The missing facility is a generic
bounded reference selection for the current target's relevant ancestors.

Reproduction: expand a Player Actor `Compendium.world.review.Actor.pc` with a
legacy AC effect using Core `expandMigrationTargets`. The current Shadowdark
catalog (ActiveEffect targets only) checks zero pack rows. A scratch catalog
adding `WorldPack` reaches the effect, but the hook reports the parent Actor type
unavailable. Add `reads.packs: ['world.review']` and the same input yields one
valid effect operation, without changing Core transport. A distributable module
cannot hardcode IDs for every user's world packs. Whole-parent `effects`/`items`
array replacement is also not a supported workaround: the current catalog
validator does not permit those write paths.

**Required contract:** allow a step to declare bounded parent/ancestor (and, when
needed, delta base) inputs for its target, independent of arbitrary pack IDs.
Specify the SDK types, catalog validation, packaging, source enumeration,
hook-input representation and behavior when a required relation is absent.
Prefer only the needed fields/provenance rather than passing a large complete
Actor with every embedded Item to each effect. Choose the exact public shape
during implementation; this addendum does not invent an already-available API.

Every selected dependency must be represented in approval, freshness/revision
checks and recovery hashes, including simulated ancestor changes caused by
earlier operations. Preserve source Actor vs ActorDelta identity, partial
overrides/tombstones and inheritance; do not materialize a delta into a second
Actor. Verify actor-level Player/NPC and embedded Item type decisions. World packs
remain limited to supported world-owned targets with existing authority/lock
checks; package packs remain read-only. Omitted references must never silently
turn a required migration into a successful no-op.

### CR64-11 — Actionable, bounded migration diagnostics

The same pack probe produces a module check reason naming the missing Actor type
and exact parent UUID. Core instead emits only
`shadowdark-effect-keys-4.0: Compendium.world.review.Actor.pc.ActiveEffect.e: source check/plan unavailable`.
The planner throws away `check.reason`, `plan.reason` and failed verification
information before its generic catch. A required legacy check can also report
only a step-level `maintenance required`, without the affected target.

Preserve a structured step, target, phase, classification and bounded sanitized
reason through plan/compatibility results, durable recovery and the admin UI.
Distinguish ordinary migration-needed, unresolved source, invalid patch/output,
hook timeout, changed artifact/dependency and failed verification. Do not expose
raw source documents, credentials or arbitrary stack traces to players; their
maintenance message stays generic. Admin should be able to identify and address
the actual source/configuration problem without editing application code.

### CR64-12 — Native v13 player compendium access

`src/server/core/documents/primary/base/nativePackPermissions.ts` uses
`nativeCombatPermissions.ts:canReadCombatActorPack` for every pack. After its
GM/Assistant branches, that helper returns false whenever generation is not14.
This manager-oriented fallback now denies all v13 Player/Trusted pack reads.

Native v13 `CompendiumCollection` in the locally inspected `temp/foundry-v13.mjs`
uses configured ownership, then metadata/default ownership, role-threshold
evaluation and an OBSERVER visibility threshold. With effective ownership
`{PLAYER: 'OBSERVER', ASSISTANT: 'OWNER'}`, executing its `getUserLevel` for role1
returns2 (OBSERVER); Core's predicate returns false for the identical case on13.
This confirms a regression, rather than an unresolved product-policy decision.

Implement a shared native pack-read policy reflecting each supported generation's
actual ownership/default/override semantics. Preserve manager-only combat rules
where required rather than accidentally broadening those operations. Keep
caller-bound reads and before/after-await capability checks; fix Core's decision
instead of bypassing it in modules. Exercise ordinary player, trusted, Assistant,
GM, explicit denial and warm-cache revocation through real serving paths, with
native v13/v14 source or runtime oracles for expected policy.

### Corrective implementation checkpoints

**Superseded execution order:** the complete-maintenance addendum below retains
these findings but replaces C64-A–F with reconciled C64-A–H. Module work,
including independent RV-08 correction, is now held by the user's explicit
decision; it must not proceed in parallel with Core remediation.

These checkpoints move the working migration path forward; regression tests
support each implementation and do not replace it. No source correction has
been made in this documentation pass.

1. **C64-A — Core/SDK design and compatibility.** Define the ancestor-input and
   asynchronous computation/progress contracts, lifecycle ownership and any
   durable continuation representation. Audit all planner callers, including
   installed checks and recovery. Decide actual SDK/module-api increments for
   additive public contracts; policy-only fixes need not create unrelated APIs.
   Keep existing shipped step/history/digest validation valid. Update authoring,
   manifest, migration, API/UI and architecture docs for implemented contracts.
2. **C64-B — Complete planner and maintenance workflow.** Implement CR64-09/10
   across enumeration, check, plan, approval revalidation, apply, readback,
   verification and recovery. Show target/step progress and terminal reasons in
   admin while it remains responsive. Approval must still bind the full reviewed
   artifact/catalog/world/source/dependency plan. If preparation is interrupted,
   safely restart or resume it from validated inputs; never approve a partial
   inventory. Preserve single-writer intent journaling, exact approval and
   uncertain/partial-write no-replay behavior. A recoverable stop must not reopen
   player access to unverified data or automatically undo native writes.
3. **C64-C — Diagnostics and player policy.** Implement CR64-11/12 with durable
   reason reporting and actual caller route coverage. Prove an accessible v13
   pack is visible to a player, a denied pack remains hidden, and revocation
   defeats warmed caches. Keep existing v14 behavior and combat authority intact.
4. **C64-D — Complete offline host scenario.** Use the actual module hooks in an
   isolated Core installation/package, not only a planner mock. Include current
   and legacy Actor/Item/effect data, partial deltas and arbitrarily named world
   Actor/Item packs. The reproduced 30/900/300 inventory must complete, as must
   a larger declared representative inventory; record counts, bytes, time,
   memory and dependency-input size. Show a healthy computation lasting over
   five seconds can finish with admin progress. Exercise no-op bootstrap,
   write-bearing preview/apply/readback, post-write bootstrap, external-restore
   detection and interrupted recovery. Every required target is accounted for;
   progress counters cannot hide exclusions. Preserve the serving context during
   preview and the existing CR64-01–08 protections. Run appropriate Core suites,
   types/lint and package/contract validation after implementation.
5. **C64-E — Operator/native verification.** Review real admin/player maintenance
   presentation, long-running progress, actionable stop/recovery and v13 player
   collections. On scoped disposable v13/v14 worlds, exercise the corrected
   paths and measure representative inventories. Previous native fixture writes
   remain evidence for their old scope; they do not establish these new results.
   Live connection/write authority must match the current task; isolated offline
   work can proceed independently. Native-user lockout and world backup/undo
   remain outside scope; keep the agreed backup acknowledgement.
6. **C64-F — Module adoption and release handoff.** Publish the corrected Core
   release through separately authorized release work before dependent module
   publication. Supply the actual tested Core/contract floors and toolchain tag,
   not a guessed next version. Module agents then finish their catalog activation,
   pack coverage, UI/recovery and native gates in their own repositories. In
   Shadowdark, RV-08 is independent module work; M4 is partial, M5/A01 remain open.

Neither increasing the global timeout, accepting it as a world-size policy,
omitting world packs, nor leaving the catalog permanently inactive closes these
findings. Complete migration coverage and recoverable failures are compatible:
maintenance blocks access while work proceeds, but cannot make conflicting or
unknown data safe to overwrite. Core owns execution; modules continue to provide
pure system-specific transformations and authorized caller projections.

## Complete maintenance and migration acceptance — October 16, 2026

### Decision, precedence and module hold

The user requires a thorough backend implementation before any further module
work. This addendum supersedes the earlier execution order and any suggestion
that module adoption or independent module corrections should proceed while Core
is incomplete. **All module implementation, catalog activation, module acceptance
work and dependent releases are on hold**, including Shadowdark RV-08. Preserve
their worktrees and findings. This Core phase may consume existing immutable
module artifacts as acceptance inputs, but must not modify module repositories
or declare their adoption complete. The Core handoff and active audit own this
hold; it is not a request to change module files.

CR64-09–12 remain confirmed defects. Add **CR64-13: complete maintenance isolation
is not established by the current runtime contract/evidence (P1)**. This is a
design and acceptance gap, not a claim that the earlier tests observed an
unauthorized migration write. Core owns correcting the planner, supporting data,
execution lifecycle and evidence. Modules supply system-specific transformations;
more caller privileges or a module-owned transport cannot solve these defects.

Before this revision the exact 146,335-byte ADR was saved; SHA-256
`41d3de4955f967a981eee5cf8167a90a6a7e0e2c2bcfce8ad9debe83c6161cfd`.
This slice prepares documentation only. It does not implement the new runtime,
start/stop services, change versions or authorize Git/remote operations.

### Completion guarantee and acceptance boundary

For supported v13/v14 sources, a valid migration package, a stable available
Foundry world, sufficient host resources and unchanged approved dependencies,
**Core must migrate every applicable target, verify the result and return the
application to service without an avoidable Core interruption, manual batch
resubmission or arbitrary whole-job timeout**. Ordinary inventory size, long
healthy computation, missing generic parent plumbing or normal SheetDelver
background activity must not block completion. All of those are Core obligations.
Required targets may not be skipped, truncated, silently treated as current or
reclassified as optional to make a test pass.

That is a testable completion contract, not a promise that power loss, a stopped
Foundry process, lost write receipts, changed external source or invalid module
logic cannot occur. The companion guarantee for those cases is persistent
maintenance, preserved progress/approval, exact readback reconciliation and a
defined continuation or actionable recovery state. A transport/process retry
must not silently change the plan, duplicate a confirmed write or restart normal
service on partially verified data. Once the cause is resolved, the recorded
recovery scenarios must demonstrate eventual completion of the approved work.
Do not label a controlled stop as a successful migration, or claim uninterrupted
execution based only on a recovery test.

Scope is complete coverage of the supported update contract: Actors, world and
embedded Items, their ActiveEffects, persisted ActorDeltas/owned children and
world-owned Actor/Item packs with embedded children. Scenes supply persisted
delta containers; arbitrary Scene-root, User, Setting or other document writes
are not currently part of that contract. Enumerate these boundaries explicitly
in preflight and the authoring guide. A declaration requiring an unsupported
operation must reject before installation/write authorization, not become a
partial successful plan. Any newly identified capability essential to the
selected real migration must be implemented in Core before readiness is claimed.
Native-user lockout and native world backup/undo remain outside scope.

### CR64-13 — Stop the normal runtime, retain only maintenance services

Current evidence: `WorldWorkGate.dispatch()` counts final mutation sends;
`drain()` waits for that counter, not every route, adapter promise, timer,
session restore or background listener. `src/server/index.ts` restores the gate
but then composes normal system, session and realtime services. The manager's
`cycleServices()` stops its Core/Next children and calls normal `start()` again.
Those mechanisms provide request fencing and process replacement, but do not
establish a maintenance-only runtime. The migration must not rely on the absence
of active browsers to make normal runtime activity harmless.

**Selected implementation: supervised maintenance-only boot.** Persist the mode,
operation identity and world/instance scope before shutting down normal workers.
The existing supervisor stops and confirms exit of its normal Core/Next children
and owned descendants, then starts only the restricted maintenance composition.
Do not kill Foundry or unrelated processes. A cold start, crash restart or
intermediate package restart must read that durable mode before normal registry,
adapter, session or gameplay initialization. An environment flag alone cannot
override the journal and reopen service.

Every Core process sharing the data directory must honor that persistent mode
and exclusive lease. Cover both supported development and production launch
paths; a direct or second launch must not bypass isolation. Clients retain the
maintenance display across supervised replacement and reattach to the same job;
an admin HTTP/socket connection is never the owner of migration execution.

The maintenance composition reuses Core's admin authentication, transport,
journal and supervisor facilities. It is not a second module application or
privileged SDK exposed to callers. Only these functions may remain live:

- Maintenance/status shell and authenticated admin inspection, approval,
  progress, cancellation where safe, and recovery. Normal admin tools that can
  alter the selected runtime, package or world remain blocked during the job.
- One Core-owned full-GM transport for the selected running world, minimal native
  authority/identity/change observations, and migration source reads/writes.
- The single migration controller, isolated computation workers, durable journal,
  lease/health supervision and necessary logging.

Normal player and human-GM routes, login/session restore into Foundry, module
routes, gameplay websocket delivery/actions, user transports, adapter timers,
context refresh, serving-cache rebuilds and background jobs must stop. A status
poll or browser reconnect must not recreate them. Browser clients receive the
maintenance state and retire stale UI work; enforcement also occurs server-side
before authentication helpers can establish ordinary user transports. Existing
session credentials may remain stored for later reauthentication, but cannot
activate a session during maintenance. Cached pages confer no authority.

Native ingress is split by purpose: retain authority/world identity, document/
pack revision observations, acknowledgements and conflict detection required by
the runner. Suppress normal module hooks, serving preparation, broadcasts and
unrelated cache hydration. Do not disable observation to make source checks pass.
Use the existing primary-document/UUID normalization and source readers; avoid
building another competing public world Store. Final fresh serving preparation
is owned by the controller at the end, with ordinary work still stopped.

Before terminating normal workers, close admission and stop new queued work,
then settle outstanding sends and retire/cancel producers. Process exit prevents
late local callbacks, but cannot retract an already dispatched Foundry write.
Capture/reconcile outstanding outcomes before sealing an authoritative plan;
unknown native outcomes require diagnosis, not an assumed empty drain. A drain
deadline must not release maintenance or permit overlapping writers. This is a
failure path to prove, not a normal reason to make an operator restart batches.

### Reconciled upgrade, repair and bootstrap sequence

| Phase | Required behavior and completion evidence |
| --- | --- |
| Optional online preflight | Inspect package/schema/history, world/authority, declared scope and readiness without changing serving Stores/context. Existing read-only previews remain advisory; they grant no writes and need not stop normal service. Clearly label their status. |
| Enter maintenance | Persist the operation/mode and acquire exclusive ownership; close all ordinary access; stop/drain producers and confirm normal worker exit. Start maintenance-only Core/shell and prove no ordinary runtime resumes. Entering this phase authorizes disruption, not migration writes. |
| Authoritative inventory and plan | Freshly enumerate all declared source domains after isolation. Classify every target; supply bounded declared dependencies; compute the complete simulated result and verify it. Store the exact artifact/catalog/world/dependency/plan evidence durably. Unresolved required data is explained before any file promotion or write. |
| Existing admin review/approval | Present the complete plan, counts, exclusions, reasons and backup limitation. One approval authorizes that exact work; no new approval per chunk, target, elapsed interval or unchanged restart. A changed artifact/source requires explicit fresh review, preserving prior outcomes. The old 15-minute preview TTL must not terminate an approved job. |
| Retain/promote and maintenance restart | Stage/promote files without starting the module's serving runtime. Persist transitions first. Any necessary restart returns to the same maintenance controller/job; it must never briefly expose the ordinary application. Preserve historical hooks/digests and pre-write file recovery. |
| Migrate and read back | Visit every approved operation with bounded computation and native I/O; record intent before dispatch and confirmation after authoritative readback. Keep progress visible. Resumption uses confirmed results and reconciles uncertain sends, without blind replay or whole-world rereads per effect. |
| Verify and prepare | Run complete final compatibility checks; reconcile fresh authoritative data, construct the candidate adapter and prepared projections under the controller while normal work remains disabled. Validate world/authority/dependencies again; invalidate all old runtime/client generations. |
| Activate and reopen | Persist verified completion and transfer the serving generation/lease through an ordered activation barrier. Start/resume normal services once. A crash at any point must produce either continued maintenance or the fully verified generation, never an unverified serving interval. |

Final authoritative planning and write approval now occur **after full normal
runtime isolation**. This supersedes the earlier approve-then-quiesce sequence
for the execution path. An advisory online dry-run may still help an admin
prepare, but may not be silently converted into write authority. Preserve the
existing approval meaning, backup acknowledgement and admin security; do not add
repeated confirmation prompts for unchanged work.

Same-version repair uses this same controller. At ordinary bootstrap, first
establish required compatibility without starting player/module serving work.
A completed journal is not proof current data is compatible after an external
restore. Required repair enters/persists maintenance and awaits its reviewed
plan; a previously approved pending job resumes only after world/artifact/source
validation. All-current large worlds must finish the full check and start
normally without an arbitrary five-second ceiling or unnecessary repair approval.

### Complete data handling and bounded computation

CR64-09/10 must be fixed throughout the lifecycle, not just in a preview helper.
Use asynchronous coordination with isolated, cancellable computation and bounded
work units so admin/status remains responsive. Keep deterministic pure hook
semantics. Select and document precise parent/ancestor/base relations and field
projections in the public SDK/catalog; package/validate them end to end. Include
all selected values and membership in approval/recovery evidence. Preserve delta
identity, inherited-child tombstones, omitted values, unknown fields and canonical
UUIDs. Whole-kind references must not be copied into every effect invocation.

Audit I/O as well as CPU: the present coordinator takes full declared-domain
snapshots around individual operations. A CPU fix alone can leave migration cost
growing with world size times operation count. Use a complete initial inventory,
indexed dependencies and targeted fresh checks/readback where their correctness
can be established; preserve observation and membership fences, then perform a
complete final verification. Never trade fresh native evidence for an unchecked
cache. Record actual read counts/bytes, memory, journal growth and wall time for
the full apply/recovery path, not only a no-op planner.

Reuse immutable hook loading/compilation safely, with no mutable globals leaking
between targets. Stream/page or checkpoint large work as needed without dropping
inventory pages or making approval cover only a prefix. Check source/step order
and cumulative upgrades. Bound individual runaway hooks, malformed output and
stalled external I/O with clear reasons; remove arbitrary healthy whole-inventory
deadlines. Review preparation and supervisory waits too: do not merely move the
same bulk-work failure to final initialization. Retain CR64-05's prevention of
late hook overlap when changing timeout/worker behavior.

Progress reports phase, step, total discovered/classified/remaining targets,
planned writes, confirmed writes, uncertain outcomes and last useful activity.
Totals may grow during enumeration but become fixed for approval. A worker yield,
HTTP request timeout or disconnected admin tab does not cancel a durable job.
Status/recovery after restart retrieves the same job identity and evidence.
Cancellation follows write state: before possible writes, validate safe file/
runtime restoration; after possible writes, remain in maintenance with recorded
outcomes. Do not imply native transaction rollback or exactly-once delivery from
the journal alone. Confirm effects through readback.

### Reconciled implementation gates

These **C64-A–H** gates replace the earlier C64-A–F execution checklist. All are
open. Implement the working path; focused regressions prove each correction but
cannot substitute for whole-workflow acceptance. The user hold remains until
the completion evidence below is satisfied and reviewed.

| Gate | Implementation and accountable Core surfaces | Required evidence before completion |
| --- | --- | --- |
| **C64-A — Lifecycle and contract inventory** | Map every normal-work producer and maintenance exception across `src/server/index.ts`, route registration, `AppSocketGateway`, `FoundryUserConnectionService`, `SystemService`, `WorldTransportController`, `EngagementService`, `FoundryEventIngress`, `WorldBootstrapper`, module registry and `src/scripts/start-server.ts`. Define durable modes, state transitions, ancestor inputs, compatibility/version implications and supported source/operation matrix. | Reviewed owner/stop/start inventory covers each surface; no unnamed background producer or speculative SDK capability. Preserve old contract/history semantics or specify their tested upgrade. |
| **C64-B — Exclusive maintenance runtime** | Implement CR64-13 with supervised stop, maintenance-only startup, restricted routes/session behavior, minimal native observation and single writer ownership. Startup/reconnect cannot enable the normal stack while the persistent mode is active. | Actual managed Core/Next replacement with normal users, pending callbacks and background jobs; observed old worker exit, zero ordinary callbacks/dispatches/user sockets after the barrier, and no reopening during restart. Test direct APIs, websocket reconnects, status polls and administrative bypass attempts. |
| **C64-C — Complete source/SDK support** | Implement CR64-10 across catalog validation, SDK types, source enumeration, reference selection, packaging and dependency hashes. Cover every selected target in world, embedded, delta and arbitrary world-pack locations. | Independently enumerated expected UUIDs match the full plan; correct parent/type/base inputs with bounded payloads; missing required relations reject explicitly; all supported fields serialize losslessly. Real v2 archive includes compiled hooks and validates against the declared API floor. |
| **C64-D — Scalable complete execution** | Implement CR64-09 throughout bootstrap, authoritative planning, apply, final preparation and recovery. Remove whole-plan deadlines and repeated unnecessary whole-world CPU/I/O work; provide durable progress independent of browser/request lifetime. | The original 30 Actors/900 Items/300 effects completes; a larger declared representative inventory and a healthy job lasting over five seconds also complete. Record full no-op and write-bearing costs, all pages, native read counts, memory/journal growth and responsive status/UI. No artificial truncation or manual batching. |
| **C64-E — Recovery and diagnostics** | Implement CR64-11 through all phases with actionable bounded reasons, durable artifact/source/step/outcome evidence and safe continuation. Preserve CR64-01–08 approval, cache, revision and no-replay protections. | Process termination/restart, disconnected admin, lost receipt, delayed send, stale dependency, invalid output, hook failure and preparation failure produce their documented outcomes; resume/readback reaches the correct final state without duplicate confirmed writes or premature activation. |
| **C64-F — Access and serving restoration** | Correct CR64-12's native v13 policy and verify player/Trusted/Assistant/GM behavior, denied packs and revocation. Restore normal services only from final verified sources; all former client/runtime generations retire. | Real routes/UI show correct v13/v14 access, fresh settings/prepared data, no privileged cache disclosure, and working post-maintenance sheets/collections. Module-specific RV-08 stays held and is not silently repaired in this Core phase. |
| **C64-G — Full host/native coverage** | Exercise the complete public admin flow and actual supervisor/HTTP/realtime boundaries with a migration-bearing package using the supported SDK. Existing real module hooks may be consumed immutably in a Core-owned fixture; any glue belongs to that fixture, not the module repository. Complete both generation matrices below. | Passing isolated whole-host, native v13 and native v14 runs, expected-vs-actual source comparison, representative inventory metrics, rendered admin/player evidence, fixture cleanup and appropriate Core suites/types/lint/package checks. No native gate closed by offline mocks. |
| **C64-H — Readiness and hold release** | Reconcile all CR64-09–13 findings, coverage, release compatibility and operator/module-authoring instructions in the ADR/audit/handoff. Identify the actual supporting Core/SDK release; release operations remain separately scoped. | Every selected gate is complete with reviewable evidence and no known Core blocker for the acceptance contract. User reviews the result before module work resumes. Dependent publication requires the corrected Core release; no speculative version floors or claims of module-native completion. |

### Required end-to-end coverage

Maintain one evidence matrix in the active Core audit, summarized durably here
at closeout. It must identify build/native system, package/catalog digest, input
inventory, expected operations, actual outcomes and cleanup. A fixture can cover
several rows, but each cell must have an independent expected result. Passing
unit counts alone do not fill cells.

| Coverage dimension | Mandatory cases |
| --- | --- |
| Source locations on v13 and v14 | Player and NPC Actor effects; world Items; Actor embedded Items/effects; nonempty unlinked ActorDelta with its own fields/children; null/inherited-only delta; tombstones/partial overrides; linked/actorless tokens; arbitrarily named world Actor and Item packs with embedded effects. Confirm package/system packs remain read-only and required locked packs are diagnosed before writes. |
| Transformation shape | Current, legacy and mixed sources; multi-change/order/phase/priority preservation; unknown fields; missing fields vs null; multiple version milestones/skipped upgrades; declared dependencies; unchanged/no-op targets and unresolved required data. Compare resulting source against an oracle independent of the runner's own verify hook. |
| Complete workflow | First migration-bearing install, upgrade, all-current bootstrap, completed-job no-op, same-version repair, externally restored old source with completed ledger, source switch/local-to-managed where supported, and interrupted file promotion. Use identical controller semantics rather than a test-only execution path. |
| Isolation | Active player and human-GM sessions, stale pages, pending requests/rolls, a session restore in flight, user sockets, module/background callbacks, context refresh and browser reconnection. After the barrier, only enumerated maintenance activity may run. Confirm actor/chat/combat/module/debug and non-maintenance admin mutations cannot bypass it. |
| Continuation | Restart before writes, between confirmed operations, after native write but before receipt/journal confirmation, during final checks/preparation and at activation. Transport loss/return and dependency conflict are distinct cases. A stopped process has no surviving worker/writer; approved unchanged work resumes without another approval. |
| Capacity and responsiveness | Empty, one-target, multiple-page, original failing 30/900/300 and larger representative inventories; current and write-bearing cases; world-pack and delta content included. A long healthy run completes while maintenance/status remains responsive. No 100-row/page or time ceiling can masquerade as success. |
| Operator and post-activation | Real admin workflow: prepare maintenance, inspect full plan, approve once, progress, precise failure/recovery and completion. Player maintenance across both themes/mobile/desktop and reconnect; after activation, source/settings/permissions/collections and stale-mutation rejection are correct. Confirm original data restoration after disposable fixtures. |

Use scoped disposable worlds for native writes, never production configuration.
If a required environment is unavailable, record the missing evidence and retain
the hold; do not substitute another offline test or declare the gate complete.
Prior native Core evidence is useful regression coverage, not a waiver of this
matrix. This requirement introduces no new module implementation task.

### Closeout standard

The earlier audit established important write/restart/recovery protections but
did not prove complete real-module migrations at representative size. Correct
that acceptance gap explicitly. Do not call this utility ready because a catalog
can be parsed, three hooks can run, or a small fixture migrates. Readiness requires
the complete supported workflow, full maintenance isolation, source preservation,
measured execution and demonstrated recovery on both supported generations.

Until C64-H is evidenced and reviewed, all module work remains held. The ADR and
active audit remain open; no success, interruption-free execution or universal
failure immunity is claimed by this planning addendum.

## Complete-maintenance implementation and isolated acceptance — October 17, 2026

This checkpoint supersedes the preceding planning-only implementation statuses,
not its C64-A–H acceptance requirements. Work is uncommitted on
`fix/adr-0064-complete-maintenance`, based on released Core0.19.0. The three
starting documentation edits were preserved. Before any revision, the current
170,282-byte ADR was saved and byte-compared; SHA-256
`a18f40272622177904a6485d34fa7f43e2d648cb2f2c52c8c733051c8fbc5033`.
No module checkout, application/module release metadata or remote was changed.

### Corrections implemented

| Finding | Implemented behavior | Regression/acceptance boundary |
| --- | --- | --- |
| CR64-09 | Complete Core-owned computation workers; no global five-second inventory ceiling. Job-local compiled scripts/new VM per call, indexed ancestor synchronization, native root refreshes for bounded plans, bounded compatible update envelopes and incremental fsynced receipts replace repeated whole-world/whole-journal work. | Correct-behavior legacy300-effect regression failed at the old deadline and completes after correction; 30/900/300 and larger complete host runs below. Individual hook/input/output safety bounds remain. |
| CR64-10 | Public `reads.relations` for projected parent/closest-first ancestors/separate base Actor, with kind filters/required relations; arbitrary world-pack IDs and persisted partial deltas retain canonical identities. Catalog, packaging, hook input and dependency hashes share the declaration. | Missing relations, API floor, rejected child-array projection, exact world-pack ancestors, false/zero/null partial/base fixtures, v2 package/install and full source oracle. |
| CR64-11 | Bounded step/target/phase and hook reason survive check/plan/verify, native dispatch and durable recovery; admin status retains proposed paths and progress without exposing raw source values publicly. | Specific reason regression fails before/passes after; lost/partial receipts and failed preparation retain actionable maintenance evidence. Public status contains generic phase/message only. |
| CR64-12 | Shared ordinary pack reads use native generation-specific role ownership rather than the generation14-only combat predicate. Caller identity, configured overrides, warm-cache revocation and native Assistant distinctions remain. | Player/Trusted/Assistant/GM policy checks; real HTTP→SDK→hydrated-pack reads on controlled v13/v14 protocols. These are not native-server permission acceptance. Combat management policy is unchanged. |
| CR64-13 | Durable composition selection, manager/Core runtime leases, normal admission/drain/producer stop and confirmed owned process-group exit; restricted maintenance Core only, with one full-GM transport and observation-only ingress. | Actual supervisor2→1→2 workers; active player/GM sessions and pending native ACK settle; old adapter timers/user sockets stop; reconnects and normal/admin/debug/module APIs cannot restore work. Separate manager/direct-Core launches lose the exclusive lease. |

The producer/owner map and public operational contract are in
[Maintenance runtime](../MAINTENANCE_RUNTIME.md), with routes in
[API](../API.md#module-world-context-and-maintenance-apis-unreleased) and relation
examples in [the migration guide](../MODULE_MIGRATIONS.md#catalog-and-pure-hooks).
Existing Stores/content revisions and dispatch authorization remain authoritative;
no module-owned cache/transport, SDK writer or native-client lockout was added.

### Actual workflow and recovery compatibility

Optional online preflight → durable disruption consent → close ordinary admission
and settle sends → stop/confirm normal Core/Next groups → maintenance-only startup
→ complete authoritative inventory/plan → exact admin approval with backup warning
→ retained file/registry promotion → approved writes and readback → complete checks
and fresh read-only preparation worker → terminate preparation worker → controlled
normal replacement → fresh normal bootstrap → serving. Native Foundry stays up.
Entering maintenance cannot approve writes. A failed/unproven ordinary-send drain
remains actionable recovery and cannot be overridden by a new plan/approval.

During isolation only necessary auth/status/recovery, supervisor/journal,
controller/compute/preparation workers and one full-GM transport/observation path
exist. User credential restoration, normal realtime delivery, module routes and
normal background producers do not start. Observation-only ingress still advances
existing source/pack revisions and enforces service-user demotion/deletion.
Preparation cannot dispatch writes or create another native connection; owned
adapter callbacks/timers are terminated before activation. Old client mutation
tokens remain retired, including the first upgrade from a null token.

Compatible native envelopes contain at most50 updates/512KiB. Every target's
dependency/source check runs against the exact approved sequential simulation;
all target intents are durable before the send. Each resulting source is read
back exactly and verified. This is automatic bounded transport, not manual chunks
or per-chunk approval. Lost/partial receipts remain uncertain until authoritative
readback; confirmed writes are not repeated. Old broad dependency catalogs retain
their complete fresh read semantics. Preview expiry does not expire an executing
approved job; a tracked resume regression sets it to zero and still completes.

The immutable job plan now uses an approval-namespaced append-only, fsynced
`.json.receipts` stream. Old inline0.19 outcomes are copied durably before metadata
updates discard their inline representation; the tracked lease-update regression
failed before this preservation fix. Reapproval preserves earlier approvals and
receipts. Pending0.19 jobs enter the restricted composition without acquiring new
write authority. Corrupt mode/journal data opens diagnostic-only admin recovery,
not normal serving or an automatic native writer. Incomplete receipt tails stop
for evidence-preserving reconciliation, not truncation. Do not resume new-format
jobs with0.19.0; keep mode, journal, receipts, locks and retained package files
together. There is still no world backup, restore or migration undo.

### Isolated evidence and measurements

Tracked fixtures are Core-owned, system-neutral, packaged pure hooks—not changes
to held modules. `src/tests/acceptance/adr0064-supervised.test.ts` uses actual
manager/Core/Next, public admin HTTP, Socket.IO, the real catalog/packager,
controller, source candidates, coordinator, Stores/ingress and read-only final
preparation. Only native upstream/database and failure timing are controlled.
Its independent UUID/source oracle does not call the planner or verify hooks.
All source locations include world/embedded Items/effects, persisted owned delta
children, null/inherited/linked/actorless tokens, tombstones, unknown fields and
arbitrarily named world Actor/Item packs. Package packs remain unchanged/read-only.

| Scenario | Actual completed result |
| --- | --- |
| Original reproduced inventory | 30 Actors/900 Items/300 Actor+Item effects, plus world Item, delta and pack fixtures; **1,243 writes**, all source values/identities equal the independent oracle. Browser-approved host run55.504s;2,200 native reads/63,391,091 response bytes;3,250,053 journal bytes; peak sampled CoreRSS1,142,764KiB; max sampled status1,875ms during concurrent validation. |
| Larger interrupted inventory | 60 Actors/2,400 Items/720 effects plus the same location fixtures; **3,193 writes** in127.618s, including partial lost receipt and forced Core termination, same approval resumes and no duplicate confirmed writes.5,203 reads/258,500,418 response bytes;8,318,223 journal bytes; peak sampled CoreRSS2,425,380KiB; max sampled status72ms. |
| Complete current/no-op checks | 30/900/300 checks1,232 targets in1.717s;100/6,000/1,700 checks7,802 in9.406s,932 event-loop ticks. Legacy whole-kind300-effect no-op completes in7.101s; the released implementation fails its five-second deadline. |
| Public no-op approval | Current27-target location fixture,34 step checks, **zero native writes**, complete approval/preparation/activation;19.034s including eight browser captures;160 reads/236,302 bytes;8,923 journal bytes. No fake write/possibleWrite marker. |
| Package/workflow matrix | Real release-schema-v2 artifact first install with cumulative1.0/2.0 native milestones; managed upgrade with a recorded previous artifact; same-version repair and local→managed source switch all complete. Small fixtures27 writes each. |
| Completed ledger then restored legacy | Controlled native disconnect/reconnect returns old source after first job completed. Readiness enters new maintenance, **zero repairs before fresh approval**, then27 further writes and verified normal serving.54 writes across two distinct jobs, not duplicate replay under one approval. |
| Runtime/recovery | Pending ordinary ACK drains before stop; active player/GM transports/timers disappear. Lost receipt, crash mid-apply and separate crash during held final preparation recover to completion. Preparation restart sends no confirmed write again. Cold second manager/direct Core cannot join the same data directory. |
| Unapproved restart/cancellation | Killing maintenance Core in review retains the exact unapproved plan and sends zero writes before approval; subsequent approval completes27 writes. Public cancellation of a current no-op review returns to freshly validated serving with zero writes and no fabricated job. |
| Rendered | Actual Core shell, existing admin recovery components and player boundary at320/390/820/1440, both themes; computed theme distinction, no horizontal overflow, keyboard/focus, inert player actions, backup guard, stop/cleanup and first-token reload. Captures were visually inspected. |

Measurements are controlled loopback results, not production guarantees. Wall
time includes startup/replacement, deliberate holds and browser work. Sampled
CoreCPU for the larger run is11,899 ticks (CLK_TCK100:118.99s); logical Core I/O
380,498,402 read chars/47,190,072 write chars. These exclude Next/browser/upstream
and are not physical disk totals or a soak/leak proof. Memory remains material
(about2.3GiB peak in that run); do not promise tiny-host capacity. The prior
per-target larger run consumed19,411 reads/540,381,289 bytes/285.020s, compared
with5,203/258,500,418/127.618s after bounded execution. No rows were dropped.
Native costs and operator capacity acceptance remain required.

The recovery experiment exposed and fixed a real lease handoff defect: verified
replacement ownership must be persisted in the existing job, not only the mode.
An unplanned kill loses the opaque admin cookie: re-login is needed, not another
migration approval. Planned replacement retains existing admin session handoff.
Early failed harness runs (missing copied aliases, missing previous artifact,
undeclared hydrated UUID pack, old admin cookie) are not completion evidence;
their corrected whole-host scenarios above pass without altering application
authorization or fabricating source data.

Reproducible isolated commands (never use root production settings for services):

```sh
npx tsx src/tests/acceptance/adr0064-supervised.test.ts --run-isolated --complete-matrix --inventory=30,30
npx tsx src/tests/acceptance/adr0064-supervised.test.ts --run-isolated --complete-matrix --inventory=60,40 --recover-writes
npx tsx src/tests/acceptance/adr0064-supervised.test.ts --run-isolated --complete-matrix --inventory=2,3 --archive-op=install --cumulative
npx tsx src/tests/acceptance/adr0064-supervised.test.ts --run-isolated --complete-matrix --inventory=2,3 --archive-op=upgrade
npx tsx src/tests/acceptance/adr0064-supervised.test.ts --run-isolated --complete-matrix --inventory=2,3 --no-op
npx tsx src/tests/acceptance/adr0064-supervised.test.ts --run-isolated --complete-matrix --inventory=2,3 --local-switch
npx tsx src/tests/acceptance/adr0064-supervised.test.ts --run-isolated --complete-matrix --inventory=2,3 --restore-legacy
npx tsx src/tests/acceptance/adr0064-supervised.test.ts --run-isolated --complete-matrix --inventory=2,3 --restart-preparation
npx tsx src/tests/acceptance/adr0064-supervised.test.ts --run-isolated --complete-matrix --inventory=2,3 --restart-review
npx tsx src/tests/acceptance/adr0064-supervised.test.ts --run-isolated --complete-matrix --inventory=2,3 --cancel-review
npx tsx src/tests/acceptance/adr0064-supervised.test.ts --run-isolated --complete-matrix --inventory=2,3 --online-entry --generation=13
```

Repeat the last with `--generation=14`. That flag selects a controlled protocol,
not a native Foundry installation. Render scripts require an existing isolated
`SD_PLAYWRIGHT_MODULE`; no browser package is added to runtime dependencies.

### Gate disposition and remaining approval

| Gate | Current disposition |
| --- | --- |
| C64-A | Implemented/inventoried; lifecycle/SDK/old-format compatibility documented and tested. |
| C64-B | Isolated actual host isolation, pending ACK, reconnect, cold second process and restart checks pass; native/operator gate remains. |
| C64-C | Complete Core fixture locations, relation/dependency validation, packaging and source oracle pass; native generations pending. |
| C64-D | Original/larger, >five-second no-op/write workflows complete with measured cost/progress; native costs pending. |
| C64-E | Tracked approval/source/content/partial/uncertain protections and actual apply/preparation restart reach verified completion; native interruption matrix pending. |
| C64-F | Shared policy/SDK and actual controlled HTTP reads pass for13/14; real native access/restoration acceptance pending. |
| C64-G | Isolated public-host/rendered/package matrix passes; **fresh native v13 and v14 matrix not authorized or executed**. |
| C64-H | **Open**: native evidence, operator review, supporting Core release decision and hold-release approval remain. |

SDK3.4.0/module-api1.6.0 are justified additive relation contracts from the
canonical authority; UI3.2.0/roll1.0.0 remain unchanged. Core package/lock stay
0.19.0. Dependent modules must wait for the actual tested supporting release and
separate adoption authorization. G8/RV-08/catalog activation remain held.

Full Core unit, client and integration suites, TypeScript (`--incremental false`),
lint and whitespace checks pass. Integration includes the original18 corrective
cases plus9 complete-maintenance cases; archive CLI/package parity and rendered/
supervised checks above are separate acceptance, not native permission evidence.

Native fixture plan: identify an explicitly disposable world on each generation,
record exact native/system versions and baseline membership/source, use a separate
loopback Core data/config and Core-owned migration fixture, and create marked
Actor/Item/effect/delta/world-pack rows plus scoped role subjects only with
approval. The native variant must use valid installed-system Actor/Item types and
native schema defaults, not the offline fixture's fabricated `system.fixed`
field. Its bounded generic transformation uses a fixture-owned flag namespace
and marked effect changes, skips unmarked documents, and supplies a Core-owned
alias matching the disposable world's system. It does not modify/adopt the real
module checkout or run system repairs. Inspect the exact proposed paths/IDs
before approval; existing world data is read for inventory, never migration
targets unless explicitly included in fixture scope.
Back up with Foundry first and acknowledge no SheetDelver undo. Run the
same source/role/isolation/install/repair/recovery matrix, including locked-pack
rejection and post-activation current/stale callers. Remove only recorded fixture
IDs/users/packs, restore any changed settings/permissions, compare baseline
membership/source (native `_stats` separately), and stop only task-owned services.
No existing listener or earlier native permission authorizes this run.

The minimum missing authority is endpoint + disposable world ID for each
generation, its scoped fixture/account/write/cleanup permission, and backup-warning
acknowledgement. No native endpoint was contacted in this correction. ADR-0064
and the active audit remain open; all module work remains held.


## Independent complete-maintenance review — October 17, 2026

This review supersedes the preceding checkpoint's readiness implications, while
retaining its passing evidence. The inspected worktree is
`fix/adr-0064-complete-maintenance` at `2f71597`, with the implementation uncommitted.
This review changes documentation and local review resources only. Application,
SDK and module source/version files were not changed by the reviewer. No native
Foundry endpoint or module repository was inspected or contacted in this review.

The immediately preceding ADR was saved byte-for-byte before these annotations:
`temp/adr-snapshots/0064-before-independent-complete-maintenance-review-20261017.md`,
186,894 bytes, SHA-256
`337a40aa1bfd9b0bfc93d1c55948bf53fa1168f541dfc66a2da75da51510b9b2`.
This section contains the durable findings and reproduction requirements; the
ignored snapshot and scratch probes are supplementary evidence only.

### Verified progress and evidence limits

The implementation introduces an actual separately composed maintenance runtime,
supervised worker replacement, isolated planning/preparation workers, complete
inventory computation without the former five-second ceiling, declared relations,
and durable receipt streams. It is substantive progress toward the selected design.
SDK 3.4.0/module-api 1.6.0 are development contracts; package/lock version remains
0.19.0 and no supporting release is assigned here.

The reviewer independently reran the full unit, client and integration suites,
TypeScript (`--noEmit --incremental false`), ESLint and whitespace checks; all passed.
Integration includes the 18 prior corrective cases and nine complete-maintenance
cases. Four additional offline reproductions below expose paths those passing
suites do not cover. They use Core-owned fixtures and injected source transports,
not live Foundry or module-specific behavior.

Retained whole-host evidence was inspected rather than rerun in this review. The
original run records 1,243 writes, 2,200 reads, 55.504 seconds and peak Core RSS
1.090 GiB; the larger run records 3,193 writes, 5,203 reads, 127.618 seconds and peak
Core RSS 2.313 GiB. Both identify a successful independent source oracle and
`native: false`. No-op, restored-source and preparation-restart records also retain
the reported results. Rendered/operator and native coverage are not newly claimed
by this review. Those measurements do not establish a small-host capacity guarantee.

### CR64-14 — Single-write readback accepts an unapproved source change (P1)

**Confirmed:** `ModuleUpgradeCoordinator.resume` computes the expected single-write
source, persists intent and dispatches the approved patch. Its single-write
readback then accepts the module's `verify` predicate without comparing the actual
source with that expected source. The new batch path makes that exact comparison;
the fallback for one operation does not. Final check-only planning validates the
migration predicate again, so it does not recover the missing comparison.

**Reproduction:** use the existing `fixture()` catalog with one `Actor.a`,
`system.fixed: false` and `flags.untouched: "preserve-me"`. Approve the sole patch
`{"system.fixed":true}`. Have the injected writer apply it and additionally change
`flags.untouched` to another string. The unmodified coordinator records a confirmed
outcome, calls activation and returns `phase: completed`, retaining the unexpected
flag value. No acknowledgement loss, concurrent user or module bug is necessary
for the coordinator to accept this mismatched readback.

**Required correction:** share the exact approved-source comparison across single
and batched writes, preserving only the existing explicitly permitted native
metadata normalization. Assert the readback snapshot is current before confirming
its receipt. Unexpected changes must retain diagnosable recovery and original
intent evidence; do not silently widen the patch, adopt the changed source as the
approved result, replay the write or attempt an unapproved undo.

**Checkpoint:** a tracked regression must fail on this tree and pass after the
fix. Cover a one-operation job and a batch tail of one; verify no activation or
false confirmation on unrelated-field changes. Exact approved readback must still
complete, and supported native `_stats` changes must not cause a false conflict.

### CR64-15 — Cancellation can bypass an unproven drain (P1)

**Confirmed:** `MaintenanceController.cancel` rejects an unapproved operation with
`drained: false` only when its free-text `failure` contains `"drain"`. Persistent
safety therefore depends on diagnostic wording. A crash before drain completion
can leave an isolated operation without that message; maintenance HTTP is available
before the native transport reconnects and automatic planning runs.

**Reproduction:** persist a valid candidate/preview and its held world lease,
`stage: isolated`, `drained: false`, no approved `jobId` and no failure string.
Call the real controller's `cancel()` with a counted restart callback. It releases
the lease, persists `stage: activating` while `drained` remains false and requests
one normal-runtime restart. No live transport is required. By comparison, calling
`plan()` first rejects the unproven drain; its resulting text happens to include
`"drained"`, which masks the cancellation defect in that order.

**Required correction:** enforce the durable drain state independently of human
messages on every path that exits maintenance. Unknown ordinary-write outcomes
remain in recovery until explicitly reconciled. Keep pre-write cancellation
available after a proven drain. Do not infer safety from process exit, missing
approval, a changed error string or a successful schema check during normal bootstrap.
Expose the rejected cancellation reason through the admin recovery state.

**Checkpoint:** test cold replacement followed by cancellation before native
reconnect, absent/changed failure messages, and successful cancellation with a
proven drain. The unsafe cases must retain the gate/lease and request no normal
restart. Include the public cancellation route in the affected whole-host rerun.

### CR64-16 — A complete legacy plan cannot be read from its own journal (P1)

**Confirmed:** legacy whole-kind dependencies are duplicated into each planned
operation. `UpgradeJournal.savePreview()` writes an unrestricted JSON record, but
`preview()` rejects that record above 32 MiB. Moving receipts to a separate stream
does not bound the immutable plan embedded in previews and job metadata.

**Reproduction:** use `maintenanceInventory(36, 30, false)` and the fixture's effect
migration alone. Declare `targets: ['ActiveEffect']`, no step dependencies, and
legacy `reads.targets: ['Actor', 'Item', 'ActorDelta']`; use the ordinary source-key
check/patch/verify without the new `relations` input. The production coordinator
successfully computes 360 operations with zero blockers, saves a **39,167,891-byte**
preview, and the production journal immediately rejects it with
`Invalid or oversized upgrade journal record`. This took 26.686 seconds locally.
At the original 30/900/300 scale, the same catalog produces a readable but already
27,211,097-byte preview. These probes do not dispatch native writes.

The existing legacy-capacity test rewrites every hook to return current/valid and
produces no operations. It establishes removal of the old time ceiling for checks,
not compatibility of write-bearing legacy plans. The larger successful whole-host
run uses bounded relation declarations and does not cover this representation.

**Required correction:** provide scalable durable plan/dependency storage with
bounded, validated records and exact approval/history identity. Preserve existing
1.5 catalogs and old journal recovery; do not require a module rewrite, partial
inventory or manual batches. Do not treat merely raising 32 MiB as complete capacity
work. An accepted preview must remain readable for review, approval, execution,
restart and recovery. Preserve corruption/oversize protection for individual
records and return actionable diagnostics on actual resource failure.

**Checkpoint:** exercise a write-bearing legacy catalog beyond the demonstrated
boundary through preview, public review, approval, interruption/resume and complete
readback. Retain all dependency/conflict/no-replay guarantees. Record plan/journal,
HTTP review payload, CPU, memory and I/O costs separately from bounded-relation
results, and retain the complete original/larger inventory scenarios.

### CR64-17 — Final asynchronous bootstrap validation can reopen stale sources (P1)

**Confirmed:** `checkInstalledWorldCompatibility` asserts the initial snapshot is
current after its first compute worker. After preparation it obtains another
snapshot and awaits a second compute worker, but does not call that snapshot's
`assertCurrent()` before releasing `migration-compatibility` and publishing.
Native revisions can advance while that worker checks its captured source. The
coordinator's final approved-job path already has the corresponding assertion;
the ordinary installed/bootstrap path lacks it.

**Reproduction:** use the existing isolated host fixture and a managed packaged
catalog with an initially current Actor. After the post-preparation Actor read,
schedule a source regression (`system.fixed = false`) and an Actor observation
revision while the final worker runs. The real compatibility function resolves,
returns a null diagnostic and opens `worldWorkGate`, although the native fixture
now requires migration. The probe controls only native reads/observation; it does
not replace the compatibility function, journal or worker.

**Required correction:** fence the final snapshot after asynchronous validation
and before readiness/publication. Retain the gate and actionable diagnosis on
changed sources, authority, connection, settings or pack scope. Review other newly
asynchronous completion boundaries for the same missing revalidation, without
loosening legitimate source conflicts or restarting a stale approval automatically.

**Checkpoint:** a deterministic regression changes the source revision during the
second computation, requires readiness to remain blocked and proves a fresh valid
retry can succeed. Exercise this through normal bootstrap/reconnect and the final
maintenance-to-normal activation path in isolated host acceptance.

### Revised gate disposition and next implementation task

| Gate | Current disposition after independent review |
| --- | --- |
| C64-A | Lifecycle/contract inventory retained; reconcile cancellation and final-readiness invariants with CR64-15/17. |
| C64-B | Isolation evidence retained; exit from maintenance is incomplete until CR64-15/17 pass. |
| C64-C | Declared-relation/source coverage retained; exact single-target readback still needs CR64-14. |
| C64-D | Bounded-relation capacity evidence retained; legacy write-bearing completeness needs CR64-16. |
| C64-E | Recovery evidence retained; confirmation/cancellation/journal paths need CR64-14–16. |
| C64-F | Existing permission/rendered evidence retained; no new defect confirmed in those surfaces. Native acceptance still pending. |
| C64-G | Fresh native v13/v14 remains pending. Correct and verify CR64-14–17 before scheduling those runs. |
| C64-H | Open for these Core corrections, native evidence and user review/release decision. Module hold remains. |

Continue on the existing approved corrective branch, preserving all starting
changes. This is Core implementation work; do not change module repositories or
activate their catalogs. Add failing-before/passing-after tracked regressions for
CR64-14–17, implement the corrections, then run the affected actual supervisor/
public-flow scenarios and required unit/client/integration/type/lint checks.
Demonstrate complete workflows as well as focused regressions: successful one-write
and batched migrations, unknown-drain recovery, a write-bearing legacy inventory,
and verified final activation. Reuse the existing complete-maintenance harness
and source oracle; do not restart the design or replace host tests with mock-only
success claims.

Update this ADR, maintenance/SDK guides, active audit and handoff with exact
results, resource limits and remaining native work. Preserve the ADR before its
next revision. Do not call these findings fixed based on the old passing suites.
No application/module release bump, Git write, remote operation or new native
write is authorized by this review. Once Core corrections pass review, obtain the
previously specified fresh disposable-world scope and backup acknowledgement for
native v13/v14. All module work remains held until the existing release gate is met.

## CR64-14–17 corrective implementation — October 17, 2026

This follow-up qualifies, rather than erases, the independent review above. The
existing implementation/tests/review annotations and original documentation were
checkpointed with explicit user approval before corrections. The then-current ADR
was saved byte-for-byte (199847 bytes, SHA256
`a14547356e59179923536305552075d4fba4928eb6cea867e2d68614b7cfc2c4`);
the local handoff records its snapshot location and checkpoint SHA. Subsequent
corrections remain uncommitted. Application/lock version stays0.19.0; the existing
SDK3.4/module-api1.6 development changes are preserved. No module checkout or
native Foundry instance was inspected/modified for this pass.

### Implemented corrections and tracked regressions

| Finding | Correction | Failing-before → passing-after evidence |
| --- | --- | --- |
| CR64-14 | Single and native-batch readback share an exact approved-source comparison; only existing native `_stats` normalization is ignored. Snapshot/authority/lease freshness precedes receipt confirmation. Mismatch retains intent and recovery, never automatic undo/replay. | `complete-maintenance.test.ts`: single unrelated flag mutation formerly completed; now rejects with no activation/false receipt. Covers51-target batch tail, stale readback, permitted metadata and successful single/batch writes. |
| CR64-15 | Durable drain proof guards cancellation, planning, approval, resume and activating/serving persistence. Unsafe historical exit records select restricted composition. Diagnostic text is not authority; unknown outcomes retain lease/recovery. Legacy restoration is service-owned and only uses historically persisted post-drain evidence, not process exit. | Same suite: cold cancellation without/with changed failure text formerly restarted normal serving; now refuses all variants and retains lease. Proven cancellation succeeds. Direct unsafe exit persistence and cold composition are checked. |
| CR64-16 | Immutable SHA-256 content blocks, paged lists and dependency deltas replace repeated inline plan storage. Exact complete logical digest and membership remain unchanged. Review projections omit internal dependency/effect proofs, not targets/patches. | Same suite:360-operation/39167783-byte logical preview formerly saved then failed its own read; now saves/reloads completely. Oversized old inline preview **and job** import losslessly with retained originals/outcomes; restarted readers reject tampered blocks. |
| CR64-17 | Final installed/bootstrap worker results are followed by snapshot and authority assertions before readiness/publication. Admin preparation retry uses the existing SystemService recovery facade/readiness event. | `adr0064-corrections.test.ts`: deterministic async-worker interleaving formerly released the gate after a source revision changed; now rejects at post-preparation-source-check and a fresh retry succeeds. Public acceptance also caught/fixed retry failing to finish activation despite valid preparation. |

The four correctness regressions were first run against the authorized checkpoint
and failed with their documented expected-behavior assertions (missing rejection
for14/15/17; oversized saved record for16). Scratch probes are not counted as
corrected-behavior coverage. Existing artifact/history checks, caller-bound
dispatch, intent fsync, dependency conflicts and uncertain-write reconciliation
remain in force. No logical approval, catalog or module input was relaxed.

### Complete isolated host verification

Tracked runner: `src/tests/acceptance/adr0064-supervised.test.ts --run-isolated`.
It copies Core into task-owned configuration/data, uses controlled loopback
upstreams, actual manager/Core/Next replacement, public admin HTTP, packaged hooks
and an independent source oracle. It never uses root production settings or a
native endpoint. Add these flags for the affected cases:

- No extra flags: successful one-operation migration through verified serving.
- `--complete-matrix --inventory=51,0`:166 writes, including the first Actor
  group's50+1 batch tail, complete source comparison and stale-client rejection.
- `--unexpected-readback`: native fixture changes a flag outside the sole patch;
  recovery retains intent, ordinary access stays503, resume does not replay and
  there is no undo. Only explicit changed-source review and new backup-acknowledged
  approval completes the already-current source without another write.
- `--complete-matrix --inventory=2,1 --unknown-drain`: an ordinary player's native
  send remains outstanding; kill only its task-owned normal watcher group, hold
  upstream unavailable, then cancel through public HTTP before reconnect/planning.
  All three diagnostic variants retain recovery, both leases and closed admission;
  no normal shell is restarted and no migration write is sent. This correctly
  stopped scenario is **not** counted as a completed migration.
- `--complete-matrix --inventory=2,1 --cancel-review`: proven pre-write cancellation
  completes normal fresh serving with zero writes and the independent source match.
- `--readiness-race`: an acceptance-only async-worker observer signals the
  external fixture to send native Actor observations during final computation.
  It replaces no host callback. Final activation and reconnect both block stale
  readiness/publication, expose post-preparation diagnostics, then complete fresh
  public admin retry without new repair approval.
- Add `--readiness-bootstrap` to the small proven-cancellation case: the same
  observation/fresh recovery is verified on initially current cold bootstrap.
- `--complete-matrix --legacy-writes --inventory=36,30 --recover-writes`: complete
  legacy broad-read effect catalog, not a relations rewrite. Review/approval,
  lost receipt after write7, public resume, forced Core termination after a
  confirmed prefix, automatic same-approval continuation, read-only preparation,
  final verification and fresh normal serving complete without duplicate writes.
  It covers360 Actor/Item effects plus3 loose/delta effects; pack sources, source
  identities, unknown fields, null deltas and tombstones remain unchanged.

The first complete legacy run recorded363writes,3894source reads,843130324wire
bytes,242856ms elapsed,39615948logical plan bytes,150291review bytes and843419
journal bytes. Sampled status maximum90ms; peak Core RSS2815212KiB (2.68GiB).
At100CPU ticks/second the last samples per Core incarnation totaled257.96CPU
seconds; sampled read/write character totals were905325729/8289170bytes. These
are sampled process counters, not physical disk traffic or a hardware guarantee.
Existing inline imports retain their large original backup in addition to compact
blocks; the compact new-job measurement does not imply those backups disappear.
Full logical plan materialization/hook inputs still incur memory/CPU cost with
broad read sets. Do not infer small-host capacity from durable compression.

The final-tree repeat completed the same363writes/source oracle with the same
logical/review/journal sizes and3894reads/843130324wire bytes:271406ms elapsed,
peak2883000KiB Core RSS (2.75GiB),sampled status maximum150ms,264.04sampled
CPU seconds,909773439read characters and8277045write characters. Timing reflects
concurrent validation load; counters cover task-owned Core incarnations, not
the manager/Next/browser or unsampled process startup/exit work.

The original30/900/300 complete source matrix was rerun:1243writes,192265ms,
837049logical plan bytes,372727review bytes,2045164journal bytes,peak1382608KiB
Core RSS. Its eight320/390/820/1440 light/dark maintenance captures were visually
inspected: readable wrapping, bounded scrolling review, distinct backgrounds,
no horizontal viewport overflow or button overlap. Browser checks retained
keyboard/Escape, backup-disabled approval, actual browser approval and first-token
mutation fencing. Wall time includes browser work and concurrent offline checks;
the old earlier isolated measurements remain valid historical evidence.

The final larger60/2400/720 run also completes:3193unique writes,4900reads,
248524222wire bytes,389533ms elapsed,2134869logical plan bytes,946637review
bytes,5228942journal bytes,peak2786180KiB Core RSS and135.24sampled CPU seconds.
The sampled status maximum is2778ms under concurrent validation load, not a
subsecond responsiveness promise. Original/larger tests both compare complete
expected source/UUID inventories and verify ordinary503 access during preparation,
admin continuity, closed native user transports and stale mutation409 afterward.

### Final verification and cleanup

All required commands exit0 on the corrective tree:

- `npm run test:unit` (includes SDK/catalog/packaging contracts, existing native
  pack policy, legacy import UTF-8/escapes, malformed encoding/JSON/depth and
  prototype-key safety).
- `npm run test:client`.
- `npm run test:integration` (existing lifecycle/host boundaries,19 corrective
  cases and15 complete-maintenance cases, including all four new findings).
- `npx tsc --noEmit --incremental false`.
- `npm run lint`.
- `git diff --check`.

Public/supervisor runs above exit0; complete source comparisons are independent
of migration hooks. They supplement, not replace, tracked correctness regressions.
All test services are stopped. An orphan dev watcher from the incomplete first
unknown-drain trial was identified by its exact task-owned process group/workspace
and stopped; the final listener/process inspection finds no retained acceptance
service. Pre-existing Foundry30000/PID1274293 was not contacted or stopped.
Ignored evidence remains local; the implementation, tests and self-contained
contract/documentation changes remain uncommitted for user review.

### Current gate disposition

| Gate | Current disposition |
| --- | --- |
| C64-A | Lifecycle/contract inventory retained; drain and final-readiness invariants implemented. |
| C64-B | Actual normal-worker isolation retained; unknown-drain exit refused and proven cancellation completes. |
| C64-C | Complete source/relations coverage retained; exact single/batch confirmation corrected. |
| C64-D | Complete write-bearing legacy plan now survives durable review/restart/execution beyond32MiB; memory costs explicitly recorded. |
| C64-E | Intent, uncertain acknowledgement, changed-source approval and no-replay recovery verified through completion. |
| C64-F | Public HTTP/rendered/permission evidence retained; this pass adds actual exit/readiness races, not native generation proof. |
| C64-G | **Pending:** fresh disposable native v13/v14 complete-maintenance acceptance. |
| C64-H | **Pending:** user review, native evidence and supporting-release/hold-release decision. |

The ADR stays open. All module work (including G8, catalog activation, RV-08 and
dependent publication) stays held. Native acceptance requires separately identified
disposable v13/v14 endpoints/world IDs and scoped account/Actor/Item/effect/delta/
world-pack writes, backup-warning acknowledgement and recorded-ID cleanup.
Historical permission/results and the existing port30000 listener are not fresh
authorization. No world backup/undo, native lockout or published supporting release
is implied. Public API, architecture, migration, authoring and runtime guides
describe the corrective contract independently of ignored reports.


## CR64-14–17 independent confirmation — October 17, 2026

**Disposition:** CR64-14–17 are independently confirmed corrected on the current
uncommitted tree above checkpoint `6a2f1b3bd8af49fc8e9321a10ed374b5ae9aa696`, on
`fix/adr-0064-complete-maintenance`. No new confirmed Core blocker was identified
in the reviewed changes. C64-A–F retain their qualified isolated evidence; the
next substantive acceptance work is native v14 and v13 under C64-G. C64-H, release
approval and the module-work hold remain open. This is not native sign-off or a
guarantee against external interruption/resource exhaustion.

Before these annotations, the complete current ADR was saved and byte-compared:
`temp/adr-snapshots/0064-before-cr64-14-17-independent-confirmation-20261017.md`,
211316 bytes, SHA-256
`a5d1a6d564561b7c361135f3bf34daff8c1b1155315f1d8521e5010014401f80`.
The reviewer changed documentation and ignored review resources only. Implementation,
module repositories, release versions and Git history/index were not changed by
this review. No native Foundry service was contacted.

### Independently verified corrections

| Finding | Review and fresh verification |
| --- | --- |
| CR64-14 | Single/batch paths share exact normalized expected-source comparison and revalidate before confirmation. Repeating the original unexpected-flag probe now retains intent/recovery, performs no activation and does not undo the changed source. Tracked one-operation-tail, freshness and native-metadata cases pass. |
| CR64-15 | Durable drain proof is enforced independently of diagnostic wording, including persisted exits and cold composition selection. Repeating the original cancel-before-reconnect probe requests zero normal restarts, retains its lease and records recovery. Tracked message variants and proven cancellation pass. |
| CR64-16 | The original36/1080/360 legacy write-bearing plan saves and reloads through a new journal instance. A deep comparison confirms every logical field, operation and dependency is unchanged, not merely the operation count/digest. The39,167,891-byte logical preview uses a698-byte preview reference; referenced content blocks are additional disk storage. Full legacy import, old outcomes, malformed encoding and tampered-content regressions pass. |
| CR64-17 | The original source-regression/observation probe now rejects after the final worker, keeps the gate closed and exposes the post-preparation diagnostic. The deterministic tracked case permits a fresh valid retry. Fresh real-supervisor acceptance also verifies normal activation and reconnect both block stale results and recover through the public admin retry. |

The reviewer inspected the recorded failing-before assertions: missing expected
rejection for14/15/17 and oversized-journal rejection for16, consistent with the
original independent reproductions. The full unit, client and integration suites
were then independently rerun and passed, including19 corrective and15
complete-maintenance cases. TypeScript (`--noEmit --incremental false`), ESLint
and whitespace checks also passed. Logs and the rerun original reproductions are
in `temp/adr0064-correction-review/`; the durable findings and acceptance criteria
remain in this ADR, not only in ignored scripts.

Fresh isolated supervisor command:

```sh
node --import tsx src/tests/acceptance/adr0064-supervised.test.ts --run-isolated --readiness-race
```

It passed with actual manager/Core/Next replacement, one completed migration
write, two externally observed final-computation races (activation and reconnect),
blocked stale readiness followed by successful public retry, admin200/player503
during preparation and stale-client mutation409 after activation. It ran in a
copied workspace with a fake loopback upstream; evidence explicitly records
`native: false`. Evidence root: `/tmp/sd-cr64-supervised-jI0IQD` (18.578seconds).
All task-owned services exited, and process inspection found no retained review
service. The pre-existing Foundry listener was untouched.

### Retained whole-host evidence and qualifications

The reviewer inspected the current implementation's retained whole-host evidence
and compared changed production source files with the copied workspaces. The final
legacy run `9ti9WQ`, large run `TWe9yE`, original matrix `VYnIsI`, unexpected-readback
`XSdsUE`, unknown-drain `YbrJYG`, batch-tail `wTtA6u`, readiness `5BvxGE` and cold
bootstrap/cancellation `xgXn3B` match the reviewed production changes. Some test
files changed afterward; these runs are retained implementation evidence rather
than new executions by this reviewer. Earlier single/cancellation runs used
intermediate source revisions, so the later matching runs and fresh supervisor
run supply the relevant final-path evidence.

The final legacy metrics recompute from the evidence:363 unique writes with the
independent source oracle,39,615,948 logical plan bytes,150,291 review bytes,
843,419 journal bytes,271.406seconds,2.749GiB peak Core RSS and264.04sampled CPU
seconds. Sampled read/write characters are909,773,439/8,277,045bytes. The larger
matrix records3,193 unique writes and2.657GiB peak Core RSS. These values agree
with the implementation report within rounding. This review did not rerun those
large supervisor scenarios; the fresh original legacy plan and full suite runs
provide separate current-tree verification.

Two retained rendered captures were visually sampled (320px light and1440px dark):
wrapping, bounded scroll area and controls remain visible. This is not a claim
that the reviewer repeated all eight rendered/operator checks. The shell exposes
technical JSON review; final operator acceptance must establish that the actual
world/target/patch review is understandable in use, in addition to layout checks.
No new UI defect or additional implementation gate is declared by this observation.

### Remaining work and next-step guidance

Proceed to the existing native C64-G matrix, not another generic offline edge-case
pass. Obtain the identified disposable v14 world/endpoint/build and scoped fixture,
account/pack/delta writes and cleanup approval plus backup acknowledgement; then
repeat for v13. Use the Core-owned generic fixture and independent source baseline,
real public upgrade/recovery workflow, native permissions/pack/delta behavior,
representative inventory and recorded-ID cleanup already specified above.

Record memory and timing on the actual test host. Paged durable storage reduces
journal/review size, while the complete plan and broad-reference hook inputs still
consume substantial memory/CPU. A measured2.75GiB Core peak excludes other service
processes and does not establish operation on a2GiB host. This is a resource
qualification for native/release planning, not a reason to reintroduce inventory
caps, whole-job deadlines or module-side workarounds.

Keep ADR-0064 open and all module work held pending native evidence and user review.
No new application release version is assigned: package/lock remains0.19.0 and
SDK3.4/module-api1.6 remain development contracts. Preserve the journal-format
rollback warning; unmodified0.19.0 cannot resume the new format. The authorized
checkpoint is already committed; subsequent fixes and this review remain
uncommitted for the user's next checkpoint/release decision.


## Fresh complete-maintenance native v14 acceptance — October 17, 2026

The user authorized checkpointing and native acceptance against localhost:30000,
then will switch to v13 after this run. Checkpoint
`140f838893f5841d4ee1025ee9a7a42e518b0eb8` contains CR64-14–17 and the independent
review on `fix/adr-0064-complete-maintenance`. This acceptance changes no production
source, module checkout, release version or remote state. App/lock 0.19.0,
SDK 3.4 / module-api 1.6 remain development versions, not a new published release.
Before editing this ADR, the 218829-byte prior version was saved and byte-compared;
SHA256 `ddfeec801dc0987898cbdde1cdfe2f3b3f84d4d25e993dbef35ff24ead90c5df`.

### Scope, independent oracle and provenance

Actual Foundry **14.367**, world `shadowdark-test`, native system **Shadowdark 4.0.6**.
A separate Core source copy, data directory, app/API ports and passwordless fixture
full-GM account were used; root production configuration and the user's Foundry
process were left intact. A Core-owned fixture package uses the matching system
ID solely to exercise the supported contracts. It is not the Shadowdark module
implementation or evidence of G8 adoption. Its module-api floor is 1.6.0 because
it declares ancestor/base-Actor relations.

Baseline original collection counts: 9 Actors, 0 Items, 2 Scenes, 32 Settings, 4 Users and
0 world packs. All native writes are confined to recorded fixture documents/accounts,
pack configuration and temporary settings/permission changes. The private ledger
records original settings and every created root/pack/user ID for cleanup.

Initial inventory: 30 Player/NPC Actors, 900 embedded Items, 300 Actor/Item effects,
one world Item/effect, one inactive Scene with nonempty unlinked/inherited-only/
linked/actorless token cases and two arbitrarily named world Actor/Item packs.
The persisted delta includes own children and native tombstones. Effects retain
native v14 `system.changes` data. An independent recursive source walker predicted
**1,244** changed UUIDs, without calling Core's target expansion/planner/verify.
The migration changes only each marked fixture's version flag. Full native source
comparison preserves all other values, embedded content/order, native effect
shape, unknowns, false/zero/null, tombstones and canonical pack/delta identity;
only native `_stats` bookkeeping is excluded. This is generic host coverage,
not a claim that real module schema/formula transformations have been accepted.

The test copy has an explicitly scoped transport observer that records actual
native acknowledgements and drops one successful receipt to exercise uncertainty.
It does not fabricate source data, successful writes or Core lifecycle results.
A known task-owned Core process is also killed after a confirmed write prefix;
Foundry is never stopped. Normal manager/Core/Next and public admin APIs perform
the upgrade, journal recovery and activation.

### Verified native results

| Native case | Observed result |
| --- | --- |
| Public archive 0.9.0→1.0.0 upgrade | Real release-v2 package; read-only advisory; authoritative maintenance review checks 1,339 targets and lists 1,244 patches. Logical plan 953,639 B, review 392,826 B. |
| Normal-to-maintenance barrier | Active player and human-GM sessions; normal Core/Next stop; adapter timers stop; restricted Core only. Actor/chat/combat/module/debug and world-launch/login routes return 503. Browser reconnect sees generic maintenance and cannot authenticate. Incorrect plan/backup acknowledgement rejected before writes. |
| Native uncertainty and crash | First real native write committed before the test drops its receipt. Maintenance retained with the exact target/reason. Public resume plus subsequent Core termination/replacement completes the same approval. **1,244 unique actual upstream writes, 1,244 confirmed receipts, no duplicated write**, complete source equality. |
| Final preparation and activation | Admin 200/player 503 while preparation held; activation reaches ready; old mutation returns 409 and runtime token is the completed job ID. |
| Restored source with completed journal | Restore one fixture flag to 0; cold bootstrap retains completed history and requires a fresh one-target review. One new exact approval repairs it; source oracle passes again. Completed history does not authorize repair. |
| Completed no-op/cancel | Zero-operation review; pre-write cancellation restores verified serving. |
| Settings and service identity | Native create/update/delete and user-scoped collision; Pulp and auto-consume values reach caller context. Earlier snapshot remains immutable; revisions advance. Native owner update succeeds then fails after revocation. Assistant service login rejected; demoting only the fixture service account to 3 gates players 503; promotion to 4 plus retry restores readiness. |
| Native pack policy | Player/Trusted/Assistant/full-GM allow/deny decisions reflect live metadata and warm-cache revocation. Locked required pack blocks preview 409; unlock yields no-op. Native raw source reads can return hidden records, so successful transport access must not replace Core caller authorization. Denials expose the HTTP classification defect below. |
| Rendered maintenance | Actual native-connected maintenance shell at 320/390/820/1440 px in light/dark: computed colors differ, no page overflow, approval disabled before acknowledgement. All eight admin captures visually inspected. A separate player-view pass at four widths in each theme confirms generic status, hidden plan details, distinct themes and no overflow; those eight captures were also visually inspected. This proves these layouts, not final human operator acceptance. |

Initial workflow resource sampling (includes bootstrap, migration, recovery,
activation and a later timed-out acceptance-client retry): peak Core RSS
1,451.97 MiB, 113.12 sampled CPU seconds, 86,624,215 read characters,
17,208,593 write characters across 232.86 s. Core only; not total host RSS or a
small-host guarantee. A 10 s acceptance-client timeout interrupted the subsequent
retry-context observation after the main job had completed. The unchanged host
was restarted and public restored-source/no-op acceptance completed separately;
this timeout is not reported as a failed migration or concealed as one clean run.

### Fresh corrective findings

**CR64-18 — synchronous durable plan persistence blocks status (open).**
During the first native write-bearing archive advisory, an independent
`GET /api/status` timed out after 5.021 s. The actual Core process was observed in
`jbd2_log_wait_commit`. `MigrationPlanStorage.save/put` synchronously creates and
fsyncs content files and the containing directory per record on the serving
thread. Owned computation workers do not isolate this persistence phase. The
advisory eventually returned and the migration completed; this is a responsiveness
defect, not another global migration-time limit.

The larger cold advisory reproduced **135 consecutive failed 1.5-second HTTP
probes**, spanning about **135.53 seconds**, without a planned runtime restart in
that phase. The complete advisory took 205.19 s. During an independently sampled
stall, Core had 11,263 content files totaling only 2,928,926 logical bytes: small
per-record durable files amplify filesystem work. The run ultimately succeeded;
this still fails the required responsive status/operator boundary. Other phases
include expected replacement outages and are reported separately, not all
classified as this defect. Existing isolated checks sampled final preparation;
that does not establish responsiveness during first cold plan persistence.

Required correction: move complete plan encoding/persistence/loading work that
can monopolize the event loop behind an owned worker or asynchronous durable
storage boundary, and reduce avoidable per-record file/fsync fan-out without
weakening publication ordering. Register that worker with the same lifecycle
ownership/drain/termination rules; a replaced/cancelled writer must not overlap a
new plan. Keep compatibility with existing v2 and legacy plan/receipt journals. Preserve atomic publication, dependency/digest
verification,
fsync-before-authorization/write, immutable approvals and crash recovery. Do not
remove durability, truncate inventory, silently cap dependencies or introduce a
new job deadline. Check cold plans/legacy import, authoritative review, approval,
resume and final activation while independently polling admin/player status;
include disk-waiting persistence, not just CPU-worker progress.

**CR64-19 — ordinary arbitrary Actor-pack index ignores metadata (open).**
Read-only native comparison: `world.cr64full14dwky0m-actor` has declared and
stored type Actor; direct native index and full source each return 1 record.
`CompendiumService.getPackEntries` returns 0 after 10,011 ms and logs that all
strategies failed. The similarly named Item pack returns 1 in 2 ms.
`fetchPackEntries` calls `inferDocumentType(packId)` without the available metadata;
it chooses Item except for a name heuristic for tables. Migration inventory
reads use the correct type and migrated this pack successfully. Ordinary
freshness/index reads still need correction. A failed index is also collapsed
to `[]`, which can be mistaken for a successfully empty pack by hydration.

Required correction: propagate canonical pack metadata/declaration type through
all index/freshness strategies. Distinguish unreadable/failed from valid empty
indexes and never publish a false empty freshness result. Verify arbitrary
Actor/Item/other supported pack names, native v13/v14 transport shapes, cached
refresh after actual content changes and permission revocation; preserve the
migration's correct canonical identities and package-pack read-only boundary.

**CR64-20 — caller denial becomes HTTP 500 (open).**
After native pack ownership is revoked, Core correctly denies the Player,
Trusted and v14 Assistant callers while the full GM retains access. The public
`/api/foundry/document` route returns 500 for these expected denials.
`moduleDocumentServices` throws `SdkError('permission_denied')` but
`registerUtilityRoutes` flattens every exception to 500. No hidden document was
returned through Core; this is error classification/consumer behavior, not an
observed authorization bypass.

Required correction: preserve typed authorization failures at the public HTTP
boundary using the existing SDK/domain error mapping (403 for permission denied),
with bounded safe responses. Verify denied, absent/malformed and actual upstream
failure cases independently; retain authorization before and after async reads
and warm-cache checks. Do not relax permissions to make transport results match.

### Larger inventory, measurements and cleanup

The follow-on native package 1.0.0→1.1.0 retained the historical hook unchanged and
added a dependent second step on a separate fixture flag. Its input has 60 Actors,
2,400 embedded Items, 720 Actor/Item effects and the same loose/pack/delta cases.
Both steps check 6,578 targets across 3,289 source targets; the independent oracle
predicts 3,194 patches. Restarting the restricted Core before approval retained the
same review and made no writes. One exact approval then produced **3,194 unique
native writes and 3,194 confirmed receipts**, complete independent source equality,
completed journal and ready normal runtime. No tail/page was omitted and no
manual batches or repeated approvals were required.

| Larger native measurement | Observed value |
| --- | ---: |
| Source inventory JSON | 3,527,993 B |
| Authoritative public review | 1,000,946 B |
| Cold archive advisory | 205.189 s |
| Advisory start through verified normal readiness | 674.346 s |
| Peak Core RSS across owned processes | 3,952.00 MiB / 3.859 GiB |
| Sampled Core CPU across owned processes (100 ticks/s) | 560.19 s |
| Sampled Core read/write characters | 143,027,902 / 18,498,707 |
| Native GET acknowledgements during the larger maintenance operation | 8,485 |
| Observed native acknowledgement JSON bytes during that operation | 253,232,906 B |
| Retained complete acceptance journal (all runs) | 8,014,388 B |
| Retained content blocks (all runs) | 11,488 files / 5,084,456 logical B |

Resource samples span 715.12 s including initial startup and packaging; the 674.35 s
workflow window starts at advisory dispatch. Numbers include acceptance observer
cost and worker CPU within Core; they exclude supervisor/Next/native Foundry and
test-driver RSS and are not physical disk/network-byte measurements. Do not
promise a 4 GiB or smaller host can run this configuration. Logical paging avoids
the old 32 MiB rejection, but does not make complete computation low-memory.

Continuous HTTP probes: advisory 203 samples/135 failed; maintenance-plan 71/14 failed;
execution 323/2 failed; activation 77/6 failed. Replacement/restart phases include
expected brief unreachability. Advisory has no intentional replacement and its
135-probe failure streak is the confirmed CR64-18 evidence. Longest successful
response in execution was 1,121 ms; sampling must cover persistence rather than
report only healthy worker intervals. A preparatory larger test attempt created
its recorded inventory but hit a client fetch failure before archive upload;
the successful retry reused those same fixtures and retained that failed-attempt
log. No native migration writes occurred in that preparatory attempt.

Artifact/catalog identities (SHA-256):

| Core-owned fixture | Archive | Catalog |
| --- | --- | --- |
| 1.0.0 | `1a928aff22e9dc729173f7361084f8c85aeecbda2302d3876baaa6cc9b2d804b` | `26f6e7b534164ae3e13b272e9c30f7d26dab7f19d2131f62359a466f66cd587b` |
| 1.1.0 | `67328593925c64343748d3882ad02bbbe31ebdd9414b78e212adddfe5e429353` | `9d3505558105eee91b352321b933cd46a9a01c86c5b2a121c2c81d833b44e6ab` |

After stopping all owned Core/Next supervisors, recorded-ID cleanup removed the
fixture roots/users and both world packs and restored original settings. Fresh
native reads match original membership **9 Actors / 0 Items / 2 Scenes / 32 Settings / 4 Users**
and all original source fields (excluding `_stats`) with **zero differences**.
World-pack membership returned to its original empty set. User-owned
Foundry port 30000/PID 1274293 remained running; isolated 41985/34611 listeners are gone.
The user may now switch to v13. Private source/ledger/evidence artifacts are
retained for reproducibility; no source data is copied into tracked docs.

### Remaining native work and gate disposition

| Gate / case | Current disposition |
| --- | --- |
| CR64-09–17 | Implemented/checkpointed; qualified independent isolated evidence retained, plus the native cases above. No reclassification of those confirmed fixes as unimplemented. |
| CR64-18 | Open Core correction: first cold durable plan persistence can block the whole HTTP event loop for over two minutes. Preserve durability and completion while fixing responsiveness. |
| CR64-19 | Open Core correction: ordinary arbitrary Actor-pack index/freshness path ignores native type and returns false empty. Migration source transport itself passed. |
| CR64-20 | Open Core correction: permission is enforced but public SDK denial is misclassified as 500. |
| C64-G native v14 | Representative and larger upgrades, partial/delta/pack sources, declared follow-on dependency, crash/lost-receipt/review restart, restored-source repair, no-op/cancel, settings/permissions/full-GM gate and 16 rendered layouts evidenced. **Not a full gate pass** while the fresh findings and unfilled matrix cells remain. |
| C64-G native v13 | Fresh current implementation run pending user switch; earlier small-fixture result remains historical. |
| Other full-matrix cells | Native first install/source switch, multiple catalog milestones/skipped upgrade, file-promotion interruption, transport loss/return distinct from a process crash, additional pending-action/session/context races and native effect-array/schema transformations are not established by this scalar-fixture pass. Existing isolated evidence retains its scope; focused native follow-up must fill these cells before full closeout. |
| C64-H / G8 | User/release acceptance pending; all module work remains held. These Core-owned generic fixtures do not establish module compliance. |

Correct CR64-18–20, verify their original native reproductions and carry forward
these complete source oracles and approval/recovery checks. Continue v13 discovery
only after the user switches the endpoint; do not infer a native pass from test
counts. This acceptance establishes completion/correctness for the exercised
real sources and documented interruptions, not universal failure immunity.

## CR64-18–20 correction and native v14 repeat — October 17, 2026

This addendum supersedes the preceding instruction to switch to v13: implement
the known Core corrections and complete their v14 repeat first. The branch stays
`fix/adr-0064-complete-maintenance` at checkpoint `140f838`; subsequent changes
are uncommitted. The three initial documentation edits were preserved. Before
revision, the ADR was saved byte-for-byte (235749 bytes, SHA-256
`59f4cb160ca1dd3a7d098fb13c1561e545b7beb1c810d766ec8647b291cec5c0`).
No application/module release or public SDK contract version changes are needed.
Module implementation/adoption remains held.

### Corrective implementation and regressions

| Finding | Implemented correction | Correct-behavior regression evidence |
| --- | --- | --- |
| CR64-18 | `AsyncUpgradeJournal` owns one serialized storage worker. Complete encoding, digest validation, persistence, receipt processing and cold/legacy loading execute off HTTP. Atomic v3 bundles replace per-record file/fsync fanout; file fsync, rename and directory fsync still precede durable metadata authority. Archive/file transitions, intent and receipts are awaited. Reused bundles re-establish durable publication after a lost acknowledgement. Lease/final-send fences read only small metadata. Cached maintenance review is diagnostic, never write authority. Cancellation joins a retired worker, drain/close prevents overlapping replacements, and HTTP disconnect does not cancel a job. | The tracked cold-storage HTTP regression first failed with966 main-thread fsync calls. It now passes with zero, real HTTP polling, exact digest reload and cancellation during a real temporary-bundle write followed by joined replacement. The360-operation, over39MB legacy plan round-trips through a cold worker while HTTP/timers continue. Inline originals, v2 blocks, outcomes and historical approvals survive; corrupt bundles reject recovery. |
| CR64-19 | Ordinary index, freshness, hydration and full-read strategies carry canonical native pack type or explicit declaration, with metadata taking precedence over names/caller guesses. Valid empty arrays/envelopes remain empty; exhausted/invalid reads throw and cannot replace a prior valid index. Current metadata/content revisions fence awaited publication. | The new arbitrary Actor-pack regression first returned0 instead of1. It now passes for Actor, Item, JournalEntry, RollTable, Scene, Macro, Playlist, Cards and Adventure, both response shapes, valid emptiness and failed refresh preserving prior content. Typed transport denial terminates the fallback ladder. |
| CR64-20 | Generic document routing preserves the established SDK error/status contract. Permission denial is403 with safe bounded detail; malformed UUID400, authorized absence404, unexpected upstream/internal500 with server-only diagnostics. Session compendium checks before/after reads throw typed denial, not generic errors. | The new public route test first returned500 instead of403. It now covers actual UtilityService/Store authorization before read, warm-cache revocation during await, underlying typed denial, malformed input,404 and genuine500. No blanket forbidden classification or transport-based authorization is introduced. |

The additional asynchronous storage awaits are followed by freshness fences:
preview publication rechecks source/authority, the installing-phase ACK rechecks
source/authority/lease before file promotion, and completion rechecks them before
readiness/gate release. Tracked await-boundary regressions demonstrate that the
preview and promotion would previously proceed after a source retirement, then
reject after correction; the completion regression retains recovery and lease.
CR64-14–17 exact readback, safe cancellation, durable legacy and final-readiness
coverage remains required. Bundles change private durable storage, not logical
approval digests, catalog/hook inputs, native normalization or caller permissions.
Older v2 and inline journals remain readable; downgrade-to-0.19.0 recovery is not
supported. Preserve the entire journal directory and retained originals.

The first full repeat exposed a second CR64-18 fanout: each diagnostic progress
update still fsynced the maintenance file on HTTP. The actual host-progress
regression failed with2 main-thread fsyncs for one update, then passed with zero.
Progress now uses an operation/file/stage-scoped in-process overlay; durable
stage/drain/lease transitions checkpoint it. The complete plan and receipt ledger,
not counters, reconstruct recovery and determine work. Tests cover visible
progress without a disk rewrite, durable checkpointing and overlay retirement
on replacement. No admission, approval, drain or receipt durability is removed.
The final large native repeat below includes this correction; the earlier repeat
is retained as qualified evidence, not silently relabeled failure-free.

### Repeat acceptance status

Native evidence uses a newly verified Foundry14.367 / Shadowdark4.0.6 /
`shadowdark-test` on localhost30000, fresh marked fixtures, isolated Core source,
data, accounts and loopback ports. Core-owned fixture catalogs exercise generic
contracts; no module checkout is inspected or adapted. The original Foundry
process remains user-owned and running. Fixture cleanup and final gate disposition
are recorded below. This is not a blanket C64-G/H acceptance claim.

### Completed native v14 matrix

| Workflow / protection | Actual repeat evidence |
| --- | --- |
| Representative upgrade | 30 marked Actors,900 embedded Items and300 Actor/Item effects, plus loose Item/effect, persisted ActorDelta/owned children/tombstones, inherited-only/linked/actorless null deltas and arbitrary world Actor/Item packs.1,244 unique actual native writes and confirmed receipts, independent complete source equality, lost-receipt and Core-process crash/resume, final preparation and normal activation. |
| Larger upgrade and final same-version repair | Full60 Actors/2400 embedded Items/720 effects inventory plus the same other source locations. The final repeat completed3,194 unique actual native writes and3,194 confirmed receipts, with zero duplicate sends and independent full source equality. It reconciled a real successful ACK withheld from Core, resumed the same approval, verified and activated. Restart before approval retained the exact review with zero writes in the earlier larger upgrade. No targets were omitted and no manual migration batches or whole-job timeout were introduced. |
| First install / current bootstrap / source switch | Separate isolated host with no installed system fixture completed a six-write first install with source equality. All-current bootstrap stayed normal. Public local→managed selection (with the preceding local selection) completed no-op maintenance, fresh preparation and source equality with prior history retained. The positive case uses the canonical source directory that built the immutable fixture package. Relocating and recompiling it changed esbuild header bytes and was correctly rejected by the historical-step guard; no hash normalization/bypass was added. |
| Cumulative native milestones / arrays | A fixture artifact skipped an intermediate package version and retained prior steps across native milestones4.0.5/4.0.6. Five actual native effect arrays/keys and one Actor field migrated, with six confirmed receipts and full source equality. The source/patch/oracle uses native numeric effect values. This is Core fixture coverage, not adoption of Shadowdark rules. |
| File-promotion interruption | Test-copy observer terminated only the restricted Core after durable previous-files-retained evidence and before native intent. Replacement retained recovery with unchanged world source; public cancellation restored the prior fixture files and normal validated readiness. A fresh public review then completed the intended upgrade. |
| Transport loss and return | Actual service socket disconnected after a real ACK, without stopping Foundry or the Core process. Maintenance retained uncertain intent and ordinary-work503/admin recovery access. Same-job resume reconciled source; a late reconnect observation retired final validation, so an additional explicit admin resume revalidated the same approval. Six actual unique sends total, no replay, full source equality and activation. |
| External restore / context retirement | Restoring a completed fixture Actor to a legacy flag required a fresh one-target review/approval, not authority from the old completion marker. Changing a declared world setting after review rejected approval before native writes; restoring it and cancelling the unwritten job recovered through fresh normal validation. |
| Ordinary pending send / sessions | A real player socket ACK was withheld before delivery to the production transport promise/guard. Entry persisted `drained:false`, new ordinary work returned503, the late request returned503, then the proven drain allowed cancellation and normal validation. Full source remained unchanged except supported timestamps; missing/old runtime mutation requests returned409. Initial harness placement after the guard correctly reported an already-proven drain and was not counted as unknown-drain evidence. |
| Pack index / permissions | Arbitrarily named Actor and Item packs each returned1 through Core index, native index and full source reads, including rename/invalidate/refresh. Actor sequence including refresh/restore took7ms; Item4ms. A real empty Actor pack remained a valid empty index and was deleted. Native system Item pack index7 matched, while the Core migration boundary remained read-only. Public Player/Trusted/Assistant/GM requests returned200 or typed403 according to current pack policy, including warm-cache revocation. Native raw transport returned hidden data that Core correctly withheld. Authorized missing UUID404 and malformed UUID400 were also verified publicly. Other canonical pack types and array/envelope/error handling are offline coverage, not nine native pack-class claims. |
| Settings / full-GM authority | Stored/create/update/delete/default paths, excluded user-scoped collision, immutable context/revision refresh and authenticated projection passed. Ordinary owner revocation denied native writes. Assistant service login rejected; active service demotion blocked ordinary work503 with admin diagnosis; restoring full GM and explicit retry recovered. Required locked world pack blocked preflight409 and unlocked no-op passed. Ordinary Assistant document permissions were not broadened or restricted. |
| Rendered / operator | Actual native-connected maintenance/admin and public pages:320/390/820/1440, light/dark,16 captures visually reviewed, nonempty distinct styles, no viewport overflow, private detail absent publicly and approval disabled without acknowledgement. Separate actual-component admin/player suites verify appearance scope, keyboard/focus, auth expiry, nondismissible gating and first-upgrade missed-restart reload; these are distinguished from native permission evidence. |

The native observer exists only in the isolated Core copy: it observes real ACKs,
can withhold one receipt/socket callback or terminate a marked test Core, and
fabricates no source, ACK success, authorization or lifecycle result. No module
repository, root production settings or unrelated Foundry data was used.

### Responsiveness, storage and capacity

Independent probes target both `/api/status` and authenticated
`/admin/module-maintenance`,1500ms timeout, approximately500ms cadence. They run
in a separate process, beginning before cold advisory and continuing through
review, approval, recovery and activation. The final cold advisory explicitly
records its request start/end rather than inferring them from a file timestamp.

| Final measured interval | Per-endpoint result |
| --- | --- |
| Cold complete3,197-operation advisory (69.776s, read-only; no package promotion or native writes) |139 probes each, all200, zero timeouts, maximum100ms. Complete durable plan published; source unchanged and installed fixture remained1.3.0. The private1.3.1 test artifact is not an application/module release bump. |
| Authoritative planning in final3,194-write repair |100 probes each, zero timeouts; status max39ms, admin max40ms. |
| Execution/resume/verification/preparation before replacement |771 probes each, all200, zero timeouts, maximum121ms. |
| Supervised startup/composition changes | Brief listener outages remain:2 startup,9 maintenance-entry/replacement and13 activation/replacement timeouts per endpoint in the sampled run. They are not hidden or counted as successful probes. Responses after replacement max444ms. This is responsive durable computation, not zero-downtime service replacement. |

The final larger job completed in596.083s. Core peak RSS was4.128GiB (including
its threads, excluding Foundry, Next, watchers and driver),682.37 sampled CPU
seconds,167.01MiB logical reads and24.84MiB logical writes. Sampling spans592.681s
and does not capture every startup/exit instruction. Logical syscall I/O includes
harness/HTTP/cache/log costs, not a physical-disk benchmark. The host has62GiB
shared RAM; these numbers establish **no small-host capacity guarantee**. The
earlier3.86GiB measurement was not a small-host bound, and resource/elapsed
differences between runs are not a controlled speed benchmark.

Final larger review payload:1,001,128 bytes; durable metadata6,222 bytes; one
content-addressed plan bundle4,363,780 bytes; receipt stream2,081,771 bytes. All
3,194 operations and dependencies remain present. The first repeat completed
but retained shorter stable-phase stalls until diagnostic fsync fanout was
corrected; its512.825s/4.065GiB result is qualified historical evidence, not the
final latency pass. The initial larger driver also omitted second-flag wire IDs:
its source/receipt proof is retained, but exact wire accounting comes from the
subsequent successful repairs above.

### Verification, cleanup and disposition

- Core `test:unit`, `test:client`, `test:integration` (24 corrective cases plus15
  complete-maintenance cases), TypeScript `--noEmit --incremental false`, lint
  and whitespace checks pass. CR64-14–17 remain covered. Extra error-envelope
  regression proves failed `{error,result:[]}` cannot clear a valid index;
  underlying resolver typed denial also fails before/passes after correction.
- Actual isolated supervisor readiness-race and complete-fixture interrupted-
  drain/cancellation workflows pass on final code; no native claims derive from
  controlled upstreams. The first unknown-drain invocation omitted its required
  complete-fixture flag and timed out at fixture bootstrap; the corrected
  `--complete-matrix --unknown-drain --inventory=2,2` run passes.
- The first array fixture planned string `"2"` while native v14 stores number2.
  Core correctly retained uncertain intent/reference conflict, no activation,
  replay or undo. That isolated negative journal is retained as **unresolved
  invalid-fixture evidence, not a completed migration**. A new isolated host with
  valid native numeric patches completed the positive case; no normalization or
  historical-integrity exception was added to product code.
- The large fixture was partially cleaned after its first exact-wire proof,
  then only those marked test sources were re-expanded to repeat full native
  latency acceptance after the progress correction. This is fixture preparation/
  cleanup, not a product world-restore feature, target cap or migration batching.
- Final direct native cleanup matches original membership **9 Actors /0 Items /
  2 Scenes /32 Settings /4 Users**, zero source differences excluding supported
  `_stats`, and the original empty world-pack set. All marked fixtures and five
  fixture accounts are removed; original settings restored. All task services,
  probes and browser contexts stopped. Foundry PID1274293/port30000 remains
  running, untouched as a process. Retained private evidence is not a runnable
  future fixture: do not reuse its removed IDs or archived configuration.

CR64-18, CR64-19 and CR64-20 are **resolved in the exercised Core contract**.
C64-A–F retain their qualified evidence; C64-G's repeated v14 matrix passes,
but its fresh v13 component remains pending. C64-H user/release review and G8
module adoption remain pending/held. Sequence: Core corrections → successful
v14 repeat (now recorded) → fresh identified/authorized v13 world acceptance →
user review/clearance → separately scoped module adoption. Keep this ADR open.
No staging, commits, branch/version changes, remote operations or publication
were performed in this corrective pass.


## Independent review of CR64-18–20 — October 17, 2026

Review baseline: `fix/adr-0064-complete-maintenance` / `140f838`, including the
uncommitted corrective implementation and its native v14 addendum. The preceding
ADR was saved byte-for-byte before this review annotation: 252688 bytes, SHA-256
`e3e44ae90ccc437ef5643110465a8827f1bc3dc92e387943cc54f42dbc5f7da4`.
No production source, module, version, Git or native-world changes were made in
this review. The independent checks did not reconnect to Foundry.

CR64-18–20 have substantive corrections in the production paths: owned serialized
storage and bundled durable plans, authoritative compendium types with failed
reads distinguished from emptiness, and typed safe permission responses.
Independent full unit (including client) and integration suites, TypeScript
`--noEmit --incremental false`, lint and whitespace checks pass. Integration
includes the 24 corrective and 15 complete-maintenance cases. CR64-14–17 coverage
remains in place.

Retained native evidence was inspected, not rerun: the final larger job records
3194 unique native sends and confirmed receipts, no duplicates, independent
source equality and completed activation. The cold advisory records 139 probes
per endpoint, all200 with maximum100ms; stable execution records 771 per endpoint,
all200 with maximum121ms. Cleanup records the original9 Actors/0 Items/2 Scenes/
32 Settings/4 Users and zero source differences under the documented timestamp
exclusion. The4.128GiB Core measurement and replacement listener outages remain
qualified exactly as above. Those successful cases are not invalidated by the
additional, previously uncovered cancellation boundary below.

### CR64-21 — first approval cancellation leaves an absent job reference

**Status: open; high-priority Core recovery correction before switching to v13.**

The host lease callback in `ModuleUpgradeService.createHostUpgradeCoordinator`
persists `maintenance.jobId` before `ModuleUpgradeCoordinator.approve` awaits the
first durable job save. If the administrator cancels while that asynchronous
save has not published a job, the storage operation rejects. The coordinator
releases the lease, but the maintenance record still identifies that nonexistent
job. `MaintenanceController.cancel` then follows the approved-job branch and
fails reading it with `ENOENT`. No file promotion or native write is necessary
to strand the operation in maintenance.

This was reproduced with the real host lease callback, `AsyncUpgradeJournal`,
coordinator and controller work/cancel lifecycle in an isolated temporary root.
A test-only yielding boundary before the first job save makes the cancellation
ordering deterministic; source snapshots are offline fixtures and no native
transport is used. The correct-behavior assertion that an unwritten approval
remains administratively cancellable fails. Observed state:

- Approval rejected with `Maintenance scheduling stopped by administrator`.
- Durable maintenance stage `recovery-required`, `drained:true`, with `jobId` set.
- Durable job list empty; file promotions0, native writes0, restarts0.
- Actual controller Cancel rejected with missing `jobs/<operation-id>.json`.

Source inspection also shows Plan/Resume and maintenance startup expecting that
job once `jobId` is set; a process restart alone is not a documented repair.
This is an availability/recovery defect, not a demonstrated unauthorized write
or source corruption. It does not reopen the three corrected defect mechanisms.
The prior first-approval crash/storage-error window also needs reconciliation;
the worker makes cancellation during the initial save an ordinary reachable path.

Required implementation checkpoints:

1. Make the relationship between the persistent maintenance operation, its lease
   and the first durable approval explicit and recoverable. Do not publish an
   authoritative job reference without a durable job or a defined provisional
   state that startup and the admin controller can reconcile.
2. After cancellation/storage failure, join the writer and inspect durable
   outcome independently of the aborted computation signal. Distinguish proven
   no-job/no-promotion/no-write cancellation from a successfully persisted job
   whose acknowledgement was lost. Preserve exact approval identity and valid
   lease ownership for the latter. Corrupt or uncertain evidence stays gated.
3. Support both crash orderings: before first job publication and after job
   publication but before maintenance binding/acknowledgement. Simply moving one
   assignment after an await is insufficient without recovery for the other side.
   Do not treat every missing job as permission to clear maintenance or delete
   evidence; disappearance of a previously active job is a different condition.
4. Add tracked failing-before/passing-after controller regressions for the
   reproduced cancellation, first-save failure, lost durable acknowledgement and
   restart reconciliation. Retain unknown-drain, possible-write, exact approval,
   receipt and worker-join protections; no manual file editing should be the
   normal recovery path for an approval that never wrote anything.
5. Run relevant Core checks and a focused v14 public/admin cancellation and
   recovery/activation follow-up. Retain the existing larger native evidence;
   repeat its expensive inventory only if the correction changes the exercised
   storage/execution mechanics or reveals another relevant concern.

The failing local probe is supplementary evidence; this tracked description is
self-contained. **CR64-18–20 remain resolved; CR64-21 is open.** The exercised v14
matrix remains positive evidence, but readiness to switch to v13 is withdrawn
until this recovery correction is verified. Keep v14 running. ADR-0064 stays
open and all module work remains held. No source correction or commit was made
by this review.

## CR64-21 first-approval recovery correction — October 17, 2026

**Disposition: implemented and verified; the preceding open finding is resolved.**
CR64-18–20 and their independent/native evidence remain valid. This corrective
pass stays on `fix/adr-0064-complete-maintenance` / `140f838`; all changes remain
uncommitted, including the prior storage-worker files. Before revision the ADR
was saved byte-for-byte:258607B, SHA-256
`f296da2a3efbf48b8fa5a07880b6e5fa2748e1dc37abdd5530346ed80e5929da`.
No module repositories, versions or Git/remote state were changed.

### Implemented publication/recovery protocol

The original defect bound `maintenance.jobId` in the lease callback before the
first job save. Cancelling the asynchronous save could therefore leave a bound
but absent job, release its lease and make actual Cancel fail with ENOENT.

The host now persists a provisional `initialApproval` intent under the existing
maintenance operation/lease. It binds job ID, exact plan ID/digest, artifact,
catalog/tree, idempotency key and approving principal, but confers no promotion
or native-write authority. The first durable job is then saved, bound as `jobId`,
and the provisional intent retired **before** promotion can begin.

If save/binding acknowledgement fails or computation is cancelled, the
coordinator joins the owned storage writer and performs serialized recovery
readback independently of the aborted computation signal. Recovery validates the
complete existing job and re-syncs its metadata/receipts/directories before
accepting visible publication; it does not rewrite identity or fabricate receipts.
It distinguishes:

- **No durable job:** only a matching provisional intent, with no orphan
  receipt/legacy evidence, can be retired. The maintenance operation retains its
  lease until proven-drain admin cancellation. No fake cancelled job is created.
- **Durable job, interrupted ACK/binding:** exact identity and ownership must
  match. The job is bound with its original approval, plan and evidence. No
  promotion/write is replayed merely because acknowledgement was lost.
- **Previously active/bound job missing or corrupt, inconsistent provisional
  evidence, or failed recovery durability:** retain maintenance and diagnostics.
  Arbitrary missing files are never classified as safe unwritten cancellation.

Startup reconciles the provisional state before transport/lease takeover;
controller Plan/Resume/Cancel uses the same protocol. Both crash orderings are
covered. Cancel owns controller admission through its final asynchronous readback
and release, prevents a second finalizer/writer, preserves durable drain proof,
and can reclaim only the same dead operation's lease—not another owner. Existing
legacy/v2/v3 jobs and old bound references retain their strict meaning. No manual
journal editing is required for a provably unpublished first approval. Existing
corrupt/absent active records still require evidence-preserving reconciliation;
this is intentional, not a generic missing-file repair.

### Independently executed regression evidence

The tracked `CR64-21-first-publication-cancel` correct-behavior regression failed
before correction with actual host/controller/AsyncUpgradeJournal ENOENT and no
writes/promotions. It passes after correction; the original independent review
probe also passes without changing its expected behavior. New tracked cases in
`complete-maintenance.test.ts` exercise:

| Boundary | Verified result |
| --- | --- |
| Cancel before publication / injected initial-save failure | No durable job or promotion/write; actual controller Cancel activates the prior validated runtime. |
| Lost first durable ACK / aborted computation after publication | Exact original approval remains bound and leased; cancellation retains a durable cancelled job with empty outcomes and no replay. |
| Actual subprocess exit before and after publication | Production startup reconciliation handles both; same-dead-PID lease takeover and controller cancellation succeed. |
| Missing/corrupt bound job / orphan receipts | No activation, deletion or inferred absence; evidence remains gated. |
| Another operation owns the lease | Cancel rejects and leaves the other owner's locks untouched. |
| Concurrent work during cancellation finalization | Plan/second Cancel reject while the original finalizer owns admission. |
| Actual recovery metadata-fsync failure | Publication stays provisional/unbound, bytes unchanged; restoring storage allows joined readback and actual cancellation. |

Full Core unit/client/integration suites, TypeScript `--noEmit --incremental false`,
lint and whitespace pass. Integration retains24 corrective cases and now27
complete-maintenance cases (12 additional CR64-21 cases; crash children are setup,
not extra counted tests). Initial storage failure is deliberately injected at
the first save boundary; no claim of testing physical disk failure immunity is
made. These offline cases are separate from native results below.

### Focused public/native v14 verification

Reverified localhost30000 **Foundry14.367, shadowdark-test, Shadowdark4.0.6** before
fresh marked fixture writes. New isolated data/source/config/ports, one fixture
Actor and one dedicated full-GM fixture account; root settings and module
checkouts were unused. An immutable Core-owned fixture package exercises the
actual supervisor, HTTP admin approval/cancel, maintenance controller, journal,
native transport and activation. Delays/forced Core exits exist only in the
copied test harness; native responses and writes are real.

| Public native case | Verified outcome |
| --- | --- |
| Cancel before first durable job | No job, promotion or native write; normal readiness and exact prior source restored through public Cancel. |
| Cancel after first durable job but before ACK/binding | Original plan ID preserved, durable cancelled job/empty outcomes, zero promotions/writes, normal readiness. |
| Kill restricted Core before publication | Supervisor replacement reconciles absence; public Cancel succeeds without editing journals or promoting files. |
| Kill restricted Core after durable publication before binding | Startup finds/binds the original approval; public Cancel retains its cancelled history with no promotion/write. |
| Fresh subsequent approval | One real native write, one confirmed receipt, zero duplicates, independent complete persisted-source match, completed/verified job and successful activation. |

All four interruption cases leave installed fixture0.9.0 unchanged; successful
retry promotes the private1.0.0 fixture. These are isolated fixture versions,
not application/module repository bumps. Nineteen changed/new Core server files
match the final isolated copy byte-for-byte, excluding its explicit test entry
observer. The prior3,194-write/large-inventory evidence is retained, **not rerun**:
this correction changes first-publication reconciliation, not bulk plan format,
approved execution/readback or batching. No new capacity/latency claim is made.

The first native follow-up passed before final cancellation/durability hardening.
An intermediate repeat used an invalid explicit test-key prefix; Core correctly
rejected startup, only the verified test manager was stopped, and baseline cleanup
passed. That attempt is not acceptance evidence. The final corrected-key/final-code
run independently passes the complete focused matrix above.

Final native cleanup restores original **9 Actors/0 Items/2 Scenes/32 Settings/
4 Users**, original pack metadata and zero source differences except supported
`_stats`. Marked Actor/account removed; all task-owned supervisors/Core/Next
workers and probes stopped. User Foundry PID1274293/30000 remains running and was
never stopped. Old cleaned fixture IDs/configuration must not be reused.

**Ready for fresh v13 acceptance after user environment identification.** Keep
v14 until the user switches; no switch occurred in this task. ADR-0064 remains
open for fresh v13/C64-H user review and release readiness; G8/all module work
remains held. No new release/SDK requirement or publication is authorized.


## Independent CR64-21 verification — October 17, 2026

Reviewed the uncommitted correction on `fix/adr-0064-complete-maintenance` /
`140f838`. The preceding ADR was saved byte-for-byte before this annotation:
266774 bytes, SHA-256 `6b45323b14522860ee083e50c6242a18b193c16bd7a99330902f1e2f2911dbea`.

The original independent first-approval cancellation probe now passes unchanged:
actual Cancel succeeds, the operation reaches `activating`, no durable job is
fabricated, no native writes or promotions occur and one restart is requested.
Review of provisional identity, joined recovery readback, lease retention and
controller/startup reconciliation found no additional confirmed blocker.

Fresh independent full unit (including client) and integration suites pass;
integration includes24 corrective and27 complete-maintenance cases. TypeScript
`--noEmit --incremental false`, lint and whitespace checks also pass. This review
reran offline checks; it did not connect to Foundry or repeat native fixtures.

The final focused native v14 evidence and harness were inspected: public Cancel
and real Core restart before/after publication recover without journal editing;
a subsequent approval completes1unique native write/1confirmed receipt with an
independent persisted-source comparison. Baseline cleanup and stopped task
services are recorded. All19 changed/new server files other than the documented
observer entry byte-match the native-tested copy. The existing3194-write evidence
remains retained, not rerun or expanded into a capacity guarantee.

**CR64-21 is independently verified resolved. Fresh v13 acceptance is the next
step; no further confirmed Core blocker was found in this review.** ADR-0064
remains open for that acceptance and user/release review; module work remains
held. Source, versions, Git and the user's Foundry process were unchanged by this
review. Preserve all existing uncommitted implementation and documentation.

## Fresh complete-maintenance native v13 acceptance — October 17, 2026

**The selected Core native matrix now passes on both supported generations.**
This fresh v13 run complements the retained v14 large-inventory and CR64-21
results; it does not rerun or expand their claims. No additional confirmed Core
defect was found. C64-H user/release review and the module hold remain open.

The user switched the approved local endpoint and confirmed it was started.
Before writes, runtime probes independently verified **Foundry 13.351**, world
**`sd-adr61-v13`**, Shadowdark **4.0.6**, and a passwordless full-GM account.
Acceptance used private data directories, isolated Core/Next supervisors and
ports, Core-owned fixture packages, recorded marked documents/accounts/packs,
and temporary settings with original values retained. Root production settings
and module repositories were unused. Twenty-three changed/new Core runtime,
registry and supervisor files match both tested copies; only explicit observer
entry imports differ. No production source, versions, Git history or index changed.

Before documentation edits, the preceding ADR was saved and byte-compared:
268,722 bytes, SHA-256
`e96101cfab7b1a99436c1e5db4c60352ca823687ff6314bcdc60c3ff11f8da31`.

### Native coverage and independent outcomes

| Case | Fresh v13 result |
| --- | --- |
| Original representative inventory | 30 Actors, 900 embedded Items and 300 Actor/Item effects, plus world Item/effect, Scene/ActorDelta and arbitrary world Actor/Item packs. All **1,244** independently enumerated operations were written once and confirmed; the complete persisted source matched an independent oracle. |
| Larger inventory | 60 Actors, 2,400 embedded Items and 720 Actor/Item effects plus the same other locations. Two historical/dependent steps checked **6,388** targets and produced **3,194** exact unique writes/confirmed receipts. Source comparison passed before any fixture reduction. |
| Source relations and exclusions | Required effect ancestors and delta base Actors resolved, including pack parents. Native persisted tombstones, partial overrides, null/inherited-only deltas, linked/actorless tokens and unrelated fields remained unchanged. v13 effects use top-level `changes`, numeric modes and string values. |
| Isolation and readiness | Actual normal Core/Next workers exited; player/human-GM sessions, ordinary routes, login, non-maintenance admin mutation and module timers stopped. Reconnecting sockets exposed maintenance without restored authority. Final preparation held player requests at 503 while admin remained available; fresh activation retired stale mutations with 409. |
| Lost receipt and restart | Withheld a real native acknowledgement after one write, explicitly resumed the original approval, then killed the isolated Core during execution. Supervisor recovery completed all 1,244 writes without duplicate confirmed sends or journal editing. |
| Unapproved review restart | Killed restricted Core after the complete 3,194-operation review. The exact plan survived; independent comparison proved zero writes before approval. |
| Restored source and no-op | Restoring old fixture data despite a completed ledger triggered a fresh one-write review/approval. Completed-job no-op and public cancellation returned to readiness without new writes. |
| Promotion, milestones and reconnect | Interrupted file promotion before native intent; public Cancel restored retained files and unchanged source. A skipped private package version traversed catalog milestones 4.0.5/4.0.6: five native effect arrays across Actor, world Item, delta and both world-pack kinds plus one dependent Actor patch produced six confirmed writes. Real transport loss after ACK resumed the same approval and matched the full source oracle. |
| Install and source switch | First migration-bearing install from no managed module completed six writes with source equality. Canonical local-source and local-to-managed switches were no-ops with exact historical hook integrity and readiness. |
| Pending caller and stale review | A real player callback held before guard delivery kept durable drain unproven. New and late work returned 503; only acknowledged drain allowed cancellation/activation. Changing native settings after review rejected approval before writes; restoring context allowed public recovery. |
| Settings and authority | Pulp/ammunition create/update/delete refreshed immutable contexts; user-scoped collisions were excluded and registered defaults remained distinguished. Non-GM system-data projection without a caller-safe adapter returned 403. Native owner revocation blocked writes. Assistant service login/demotion blocked readiness; restoring full GM and explicit retry recovered. |
| Pack/index and route policy | Arbitrarily named Actor/Item packs matched native index/full counts and refreshed after renames; valid empty packs remained empty. System packs stayed read-only. Required locked packs rejected preview. Player/Trusted revocation yielded safe 403; malformed UUID 400 and authorized missing document 404 stayed distinct. |
| Rendered operator/player | Sixteen actual maintenance layouts across 320/390/820/1440 widths and both themes passed computed-style/privacy/overflow checks and visual inspection. Approval stayed disabled without backup acknowledgement; player pages omitted private world/document details. |

v13 Assistants retain native GM-like pack read visibility; that does **not** meet
Core's role 4 service-account requirement. Raw native document reads also returned
records hidden from Player/Trusted metadata permissions. Core correctly enforced
caller visibility independently of transport availability. Do not infer permission
from a successful privileged or raw read.

After the full 3,194-write proof and manager shutdown, 58 marked volume Actors and
76 marked embedded Items were removed. Subsequent install/source/session/array
cases used the retained smaller fixture set with their own full source comparisons.
This was disposable-fixture cleanup, not truncation or manual batching of a
migration. The large plan, receipts and before/after evidence remain intact.

### Focused CR64-21 publication recovery

A separate fresh isolated run, after the first baseline cleanup, created one
marked Actor and a dedicated full-GM fixture account. Public Cancel and real Core
process exits were tested both **before** first durable publication and **after**
publication but before ACK/binding. All four cases restored normal readiness
with zero promotions/writes and unchanged sources. Unpublished cases created no
fake job; published cases retained the exact original plan and cancelled durable
job with empty outcomes. A subsequent fresh approval completed **one unique native
write and one confirmed receipt, zero duplicates**, with independent complete
source equality and verified activation. No manual journal repair was needed.

Fixture identities below are evidence, not release versions (all digests SHA-256):

| Run | Artifact | Catalog |
| --- | --- | --- |
| Representative 1,244 | `48d6d7deecd2c39038ca7db7a35de5726840e55e3f92c6228f852a0578f30053` | `b1a37d7c065a4ce89787ffbfe22c9b4fa685718b59b2869f9c3af1e0b967660e` |
| Larger 3,194 | `7264fc03c3471c67684ab9ac25d79cc93dcb27640a8fc27317771f903a8c6689` | `cfaaf2423069d0c1b0e9d4bbbdb809f16b7384c52358111e477fda2055cf5cab` |
| Focused CR64-21 | `f2af79f5eadf72ab6d1d1209e237adae34cd185c5003e66c5e6a7c27fb061712` | `9fc81818035d3d9241964a7ba1a568fefe10935d87bd9a51e04c927908b54382` |

### Measured cost and qualifications

| Larger v13 measurement | Result |
| --- | ---: |
| Cold advisory | 45.705 seconds; 3,194 operations |
| Advisory through verified normal readiness | 430.969 seconds, including review/render and the deliberate unapproved restart |
| Logical plan / complete public review | 2,430,132 / 1,000,938 bytes |
| Durable plan bundle | 4,363,777 bytes |
| Job metadata / separate receipt log | 5,027 / 2,081,474 bytes |
| Approved-job native reads / response bytes | 8,487 / 210,637,016 |
| Sampled peak Core RSS | 3.819 GiB |
| Sampled Core CPU | 470.14 seconds across owned Core processes/threads |
| Sampled Core read/write characters | 194,258,376 / 28,562,022; process I/O counters, not physical-disk byte claims |

Independent 500 ms probes used a 1.5-second request bound. The cold advisory had
92 polls per endpoint, zero failed requests, maximum 85 ms status/84 ms admin.
Authoritative planning had 91 per endpoint, zero failures, maximum 19 ms;
execution had 541 per endpoint, zero failures, maximum 16 ms. Actual supervised
entry, deliberate review restart and activation still briefly interrupted
listeners; these failed connection polls are retained separately, not erased or
called continuous availability. Final preparation and normal bootstrap contribute
to the measured elapsed time. Memory excludes Foundry, Next and the test driver;
the shared host had approximately 62 GiB RAM. Together with the earlier 4.128 GiB
v14 peak, this is **not a small-host guarantee** or immunity to external failures.

Three driver-only attempts are excluded from positive acceptance: a Node 24
undici parser assertion before migration, a retained `serving` record mistaken
for pending work, and a premature advisory during bootstrap that Core correctly
rejected as a changed snapshot. Only verified owned managers were stopped.
The ignored driver now uses real `node:http` responses and waits for initialized
normal readiness. Core's transport/guards were unchanged; no replies, receipts or
source comparisons were fabricated. Final successful runs include these harness
corrections. Prior offline full suites/types/lint remain independently verified;
this native-only pass did not repeat them or change production source.

Both fixture cleanups restored original **0 Actors/0 Items/0 Scenes/4 Settings/
1 User**, original pack metadata and zero persisted source differences other than
excluded `_stats`. All owned managers/Core/Next/probes stopped; no test listeners
remain. The user's Foundry PID 478233 on 30000 was never stopped and remains running.

### Gate disposition and next work

| Gate | Current disposition |
| --- | --- |
| C64-A–F | Existing implementation/offline evidence retained and supplemented by the native source, lifecycle, recovery, access and capacity results above. No new confirmed Core blocker. |
| C64-G | Selected whole-host/native coverage passes with fresh 13.351 and retained 14.367 results, independent oracles, rendered evidence and cleanup. Generic Core fixtures do not establish module compliance. |
| C64-H | Open for user review, supporting-release decision and explicit hold-release. ADR remains open; no Git/release action is inferred. |

The next substantive step is review/checkpoint and release preparation under
separate authorization, followed by module adoption after the user clears the
hold. Released Core 0.19.0 has SDK 3.3/module-api 1.5; this unreleased corrective
tree has SDK 3.4/module-api 1.6, UI 3.2 and roll 1.0. No application release number
is assigned here. Modules using bounded relations require the 1.6 contract and
the actual supporting Core/SDK/toolchain release once published. Older 1.5 catalogs
retain their semantics; they do not need private transports or rewritten history.
G8, Shadowdark RV-08, catalog activation and dependent publication remain separate
module-owned work. No further generic offline edge-case loop is required absent
a new change, reproduced defect or specific missing acceptance requirement.

## CR64-22 Admin migration visibility — October 17, 2026

**Open Core admin UI work, identified during C64-H user review.** The migration
execution and native acceptance evidence above remains valid. This finding concerns
whether an administrator can recognize a required migration, identify the affected
world and module source, and reach the correct review. No implementation is claimed.
The preceding ADR was saved byte-for-byte before this addendum: 280,356 bytes,
SHA-256 `c60c3c0c6e927eca6a7db074ca0eb4b289f3114c5b80e5efda794978d193aece`.

### Observed behavior and limits of the evidence

The user's Installed-page screenshot shows an active local Shadowdark source and
a disabled managed 0.9.4 copy. The open drawer belongs to the managed copy, with a
world-data check inside a disclosure and a Preview world maintenance button.
The page's World maintenance section says “No recorded module upgrade jobs.”
There is no explicit current-world migration status on the active module card.
This establishes a discoverability problem; it does **not** establish that either
source declares a catalog or that the world actually needs migration.

Source inspection confirms the distinction:

- `src/app/(admin)/components/ModuleUpgradeStatus.tsx` displays job history and
  compatibility/context diagnostics. Empty history is rendered independently of
  readiness; it is not a successful source check.
- `SourceMigrationReview.tsx` provides a manual advisory check inside Details.
  `ModuleDetailPanel.tsx` passes the selected card's source, so inspecting the
  inactive managed copy does not check the active local copy. No wrong-source
  write defect was demonstrated.
- `CatalogModulePanel.tsx` exposes migration checks after release dry-run. A
  release containing migrations and a world requiring writes are distinct facts.
- `src/server/app/maintenanceShell.ts` exposes phase and technical plan/recovery
  JSON. The primary admin explanation should identify the affected module,
  source and world without requiring interpretation of raw identifiers.

### Required behavior

Use one Core-owned status projection derived from catalog discovery, current
compatibility evidence, previews and durable maintenance/job state. Reuse existing
services and authorization. Do not implement a second migration checker in React,
execute hooks from the browser, or infer readiness from Enabled/Disabled, version
direction or a completed historical job. Bind evidence to the actual world,
module, local/managed source, artifact and relevant context/source revisions.

| Situation | Admin-facing meaning and action |
| --- | --- |
| No declared catalog | “No migrations declared” for that source; not a claim that all world data has been validated. |
| Unknown, checking or unavailable | Explicit state and reason, such as world stopped, inactive system, stale evidence or check failure. Offer Check world data when applicable; never present unknown as current. |
| Fresh checks pass | “Up to date” for the named source/world with freshness information. A prior completed job alone is insufficient. |
| Fresh checks require changes | “Migration required,” concise reason and known proposed-write count, plus Review migration. Omit unknown counts rather than inventing them. |
| Blocked or recovery required | Explain the actual blocker or uncertain outcome and offer the applicable existing recovery/review action. A failed check is not proof that a migration is required. |
| In progress or completed | Show authoritative phase and confirmed progress; successful completion remains distinct from final activation/readiness. |

Surface required attention on the active module card. Overview and unrelated
admin pages show only a compact notice for required, blocked, in-progress or
recovery-required states, with the module/world/source/version and direct next
action. Detailed status in all states belongs on Installed and source cards,
not global chrome; Installed suppresses the shared notice to avoid duplication.
Routine unknown/checking/unavailable, current and no-catalog results do not create
global notices. Installed/source migration cards start collapsed for routine states
and expand for attention, with manual pointer/keyboard control. Stable polls retain
the user's choice; changed status or world/source scope restores the appropriate
default. Explicit review drawers and the restricted shell retain full explanation.
Keep migration job history under Audit, separate from Installed's current readiness
and actionable preparation diagnostics. Keep lifecycle status
separate from migration readiness. Job history may retain an empty state, but it
must not stand in for world health. A new release may separately say “Includes
migrations”; only checks against the relevant world establish required changes.

For duplicate local/managed entries, label the inactive source explicitly. Its
preview must say which source is being assessed and must not inherit the active
source's warning or passing result. A review action must preserve exact source
identity across navigation, refresh and runtime replacement; it must not silently
switch sources, enter maintenance or authorize writes merely by opening a notice.

In the standalone maintenance shell, show the affected module/world/source and
plain-language reason and next step before technical details. Preserve full plan
review and existing backup acknowledgement, approval, resume and cancellation
semantics. Keep the restricted shell independent of Next and module code. Private
diagnostics remain admin-only; players retain the generic unavailable presentation.
Use existing themes/components, keyboard access and text beyond color alone.

Invalidate or mark stale any displayed passing result when its world/source/
artifact/dependency identity changes. Reconnect and maintenance transitions must
refresh the same authoritative status. Do not run a full inventory scan on every
render or poll; consume existing evidence and deliberate server-owned checks.
Read-only inspection never grants mutation authority. No new SDK version or module
work is implied; prefer existing or internal admin contracts unless review proves
a public contract change is necessary.

### Implementation checkpoints and acceptance

1. Inventory existing status/diagnostic sources and specify the unified projection,
   identity, freshness and state precedence. A durable active/recovery job takes
   precedence over an old passing check; unavailable evidence never becomes green.
2. Add the admin notice, active-card status and direct review/check action. Make
   inactive-source inspection explicit and separate history from current readiness.
3. Improve the restricted maintenance shell's primary explanation while retaining
   technical details and the existing exact-plan authorization/recovery boundaries.
4. Verify meaningful state combinations: required changes with no jobs; no catalog;
   offline/unknown/stale state; active local versus inactive managed and the reverse;
   migration-bearing candidate with zero writes; in-progress/recovery/completion;
   and source/world changes during navigation or reconnect. Verify ordinary users
   cannot obtain the admin projection or private reasons.
5. Review overview/Installed and restricted-shell layouts at the existing four
   widths and both themes, including keyboard access and a direct route to the
   correct review. Earlier rendered captures establish their recorded layout and
   privacy results, not acceptance of this newly identified discoverability need.
6. Update operator/API documentation for the actual implemented behavior and
   record evidence here and in the handoff. Run checks appropriate to changed
   components/services. Existing native v13/v14 results remain retained for a
   presentation-only change; reassess affected native coverage if orchestration,
   authority, source selection or public contracts change.

CR64-22 is the next substantive Core follow-up under C64-H. It supersedes the
preceding “review/checkpoint and release preparation” next-step statement until
this UI work is implemented and reviewed. Module work remains held. This addendum
changes documentation only; no source, versions, Git state or live services were
changed, and no native or module inspection was needed.

### CR64-22 implementation and isolated acceptance — October 17, 2026

The preceding CR64-22 paragraphs record the planning baseline. Its six checkpoints
are now implemented on `fix/adr-0064-complete-maintenance`, based on `b5574cb`;
changes remain uncommitted for review. The ADR was saved byte-for-byte first:
288,185 bytes, SHA-256
`2b85e9731c965d64ff986ed85473f5926cab0c469dd1a128618233e76798af45`.

**Authoritative diagnostic evidence.** `migrationAttention.ts` projects current
status from existing catalog metadata, compatibility checks, explicit source
previews and durable controller/journal evidence. `migrationEvidence.ts` observes
the existing checks; it neither replaces their decisions nor grants approval.
Evidence binds module/source directory/category/version and source-file revisions
to world identity/context, service authority, connection generation and primary/
pack revisions. Known artifact/catalog digests and counts are retained. Passive
unref'ed filesystem watchers belong to normal Core and exit with it; watcher
failure cannot establish passing evidence. Old previews expire, reconnects and
observed changes retire evidence, and process replacement starts unknown until
fresh checks finish. This is observed-revision diagnostic freshness, not immunity
to unobserved external edits or a replacement for execution-time exact checks.

`GET /admin/module-migrations` reads metadata/evidence, never hook execution or a
world inventory. It distinguishes no catalog, unknown, checking, unavailable,
freshly up to date, required, blocked, in progress and recovery required. A failed
check is not labeled required. Empty history, Enabled, catalog presence and old
completed jobs cannot produce green status. Active/recovery durable work takes
precedence. Restricted composition returns only maintenance evidence, without
normal source discovery or adapter initialization. It warms durable diagnostic
candidate/job/review identity once via the existing storage worker independently
of native reconnect, without altering approval, leases or write scheduling. A
tracked cold-process/offline case proves source/version/world/count recovery.
Native world identity must also align with prepared context; the transition
between observing a new world and priming its context cannot reuse old success.

**Actual admin integration.** One authenticated provider supplies compact,
attention-only global notices (including Overview), the detailed Installed panel,
both source cards and the review drawer. Installed does not duplicate the global
notice. It refreshes
evidence every5s while visible, retires responses across sessions/runtime changes,
and clears failed/overdue data instead of retaining success. The notice names
the actual world/module, local/managed source and known version. Inactive copies
are explicit and keep independent results. Exact-source links carry an opaque
world/source scope; a stale/missing target requires reopening the current review,
never silently selecting another copy. Cached review GET rechecks identity after
storage reads and revalidates administrator authentication before transmission.
**Check world data** deliberately runs the existing advisory. Opening a notice or
cached plan performs no scan, source switch, maintenance entry or write approval.
Migration job history is under Audit; Installed retains actionable preparation
diagnostics and a history link. Narrow header/URL overflow and card-content
compression found during actual320px review were corrected, not hidden by clipping.

**Restricted shell.** The dependency-free shell now presents a plain-language
reason, known module/world/source/version, progress and next step ahead of the
complete technical plan/recovery disclosure. Proposed updates remain available,
not just path names. Authentication failure clears private details; plan/artifact
changes clear backup acknowledgement. Existing exact approval, backup warning,
durable drain, recovery and cancellation semantics are unchanged. No ordinary
runtime or new privileged transport is introduced.

| Evidence | Result / scope |
| --- | --- |
| `src/tests/integration/migration-attention.test.ts` |9 real-host/HTTP cases: required with empty history; active/inactive local and managed in both directions; checking/current/blocked/no catalog; zero-write candidate; context/Actor/User/pack/source revisions; offline/reconnect/world replacement; expired/late evidence; historical completion versus current source; durable recovery precedence; admin-only routes, cached review without scans, stale source409 and revoked admin401 including during awaited storage. No fixture writes. |
| `src/tests/acceptance/adr0064-supervised.test.ts --run-isolated --complete-matrix --inventory=2,2 --migration-attention --restart-review` | Actual manager/Core/Next and public HTTP/browser workflow, Core-owned packaged hooks and controlled loopback upstream only. Overview→exact managed review→Installed at320/390/820/1440 in light/dark; inactive local zero-write result remains separate. Navigation emits no POST or inventory read. Unapproved review survives a real isolated Core exit/replacement with zero writes. Authoritative maintenance review, exact backup approval,25 unique writes/32checks, independent complete source oracle, activation and stale-client409 pass. |
| Restricted shell in that workflow | Four widths ×both themes; known identity/reason/next step, full technical patches, disabled unacknowledged approval, keyboard stop dialog/focus, private data absent when unauthenticated and status401. Distinct computed themes; no horizontal overflow. |
| `src/tests/acceptance/adr0064-rendered.mjs` | Eight actual-component recovery captures, failed-refresh retirement, expired session, exact plan detail, focus confinement/return, stop and retained-file cleanup controls. Controlled browser responses are component evidence, not native evidence. |
| Core suites | Full unit, client and integration suites, TypeScript without incremental cache, lint and whitespace checks pass. Existing24 corrective and27complete-maintenance integration cases preserve CR64-18–21 coverage. |

Rendered captures were visually inspected, including the corrected mobile cards
and review identity. Initial harness attempts exposed fixture source selection,
compiled hook filenames and obsolete selectors/expectations; those attempts are
not passed acceptance. The actual320px overflow/compression failures were corrected
and the complete rendered/public workflow rerun. Browser tools remain external
to application dependencies; no production settings, module repositories or
native Foundry endpoints were used.

This is a visibility/read-only diagnostic correction. No migration executor,
lease/publication/storage durability, native authorization, approval identity or
source-selection behavior changed; existing native v13/v14 evidence remains
retained rather than repeated. Internal admin DTO/routes require no SDK/API or
application-version bump. Existing journals/catalogs remain compatible; diagnostic
caches need no migration and are deliberately not restored as passing evidence.

**Still open:** C64-H user acceptance of discoverability, wording and source
clarity; supporting Core release and explicit module hold-release. Suggested user
check: find attention on Overview, follow it to the intended source, compare an
inactive copy, check a named world deliberately, and review the maintenance reason/
next action before exact approval. No module adoption or release is authorized by
these results. ADR-0064 stays open.

### CR64-22 placement refinement — user review, October 17, 2026

The user rejected the full status panel on every admin page. The approved
refinement is implemented: Overview/unrelated pages show only compact required,
blocked, in-progress or recovery attention with exact-source navigation. Routine
states and polling errors stay in Installed's detailed panel; failed reads remove
old shared attention rather than inventing a migration requirement. Installed
suppresses duplicate global chrome and retains complete freshness/reason/counts,
refresh/check controls, and source-specific cards/reviews. The restricted shell
is unchanged. This supersedes the initial all-page/full-panel presentation, not
the authoritative status, freshness, authorization or approval contracts.

The ADR was saved byte-for-byte before this refinement:295,515 bytes, SHA-256
`bc9bf5244d1f39195100b0da0c2f1481c2de7e45821f7b9fc447b76bc74d85a9`.
Focused rendering covers all nine status states and failed refreshes; actual
isolated admin routes cover healthy Overview/Cache without notices, attention-only
Overview/Cache and detailed Installed without duplicate chrome at all four widths
in both themes. Earlier complete backend/native evidence remains retained; no
backend, module, contract/version or approval behavior changes in this refinement.
User acceptance of the final presentation remains pending.

Fresh refinement checks pass: client suite, TypeScript without incremental cache,
lint and whitespace; the component harness exercises all nine visibility states,
failed refresh, authentication retirement and recovery controls. The actual
isolated supervisor/Core/Next run includes16 quiet Overview/Cache captures and32
attention Overview/Cache/Installed/review captures, plus review-identity/shell
coverage, at320/390/820/1440 in both themes. Installed has one detailed panel and
no duplicate notice. Keyboard exact-source navigation and no-scan inspection pass;
the retained small public workflow also completes25unique controlled-upstream
writes/32checks, Core review restart, independent source comparison and activation.
Captures were visually inspected; narrow notices use the full text width and put
their action below it. This is isolated/browser evidence, not a renewed native run.

### CR64-22 collapsed information and Audit history — user review, October 17, 2026

The user refined routine migration information to occupy less space and moved
migration job history into Audit. Installed's current-world panel and per-source
migration cards now use native keyboard-accessible disclosures. Non-attention
states start collapsed with status/source identity retained in the summary;
required, blocked, in-progress and recovery states start expanded. Manual toggles
survive stable polls. Changed semantic state or world/source scope resets the
default, so new attention opens and resolved attention collapses. Explicit source
reviews remain expanded because the user already requested those details. Opening
a disclosure performs no scan, source switch, maintenance entry or write.

**Audit → Migration job history** owns job records, receipts and the existing
review/recovery/retained-file controls. Installed shows no historical jobs or empty
history panel. Current service-account, compatibility and world-context diagnostics
and **Retry world preparation** remain on Installed when actionable; a healthy
diagnostic view renders nothing. The expanded current-status panel links directly
to Audit's history anchor. Existing authenticated routes, exact approval, backup
acknowledgement, recovery and restricted-shell behavior are unchanged.

Before this refinement the ADR was saved byte-for-byte:298,215 bytes, SHA-256
`821d6e070311d6fe737e40738ed660705009b6b95a6743a1bbfdbc6bbc5cb7d4`.
Focused component checks cover all nine defaults, new/resolved attention,
keyboard toggles, stable-refresh preservation, failed reads/auth retirement and
the retained recovery controls. Actual isolated admin-route acceptance covers
collapsed healthy Installed/source cards, manually expanded details, automatic
attention expansion, and job history on Audit rather than Installed at all four
widths in both themes. Full backend/native evidence remains retained; no backend,
SDK/API/version, module, approval or source-selection change is implied. ADR-0064
and C64-H remain open for user acceptance.

Fresh checks pass: client suite, TypeScript without incremental cache, lint and
whitespace; actual-component tests exercise all nine disclosure defaults, manual
keyboard toggles across stable refreshes, automatic reopening/collapse on state
changes, failed reads, and actionable diagnostics remaining separate from history.
The actual isolated supervisor/Core/Next workflow verifies healthy collapsed
Installed/source cards, attention expansion and Audit history at320/390/820/1440
in both themes, plus keyboard navigation and no-scan disclosure/review inspection.
It completes25unique controlled-upstream writes/32checks and independent source
comparison/activation, then renders the completed job and25confirmed receipts on
Audit with no current migration notice. No new native run was required. Captures
were visually inspected; all task services exited. Existing user dev services and
module repositories were left untouched. Changes remain uncommitted for review.

## Independent CR64-22 review and deliverable reconciliation — October 17, 2026

The user requested review of the final collapsed-card/Audit refinement and
conditional ADR closeout before release and module resumption. Reviewed the
uncommitted tree on `fix/adr-0064-complete-maintenance`, checkpoint `b5574cb`.
The previous ADR was saved byte-for-byte before annotation: 301,764 bytes,
SHA-256 `767ef4913c9a5b3a1324130e8978ac91085c7aa5b660b66c7dda3a8eef2c5f68`.
Production source was not edited during this review.

### Verified final behavior

Independent full unit/client and integration suites pass, including the existing
24 corrective, 27 complete-maintenance and 9 migration-attention cases. Fresh
TypeScript, lint and the actual-component browser checks pass. The final UI has
routine disclosures collapsed, attention expanded, manual toggles preserved on
stable refresh, compact attention-only global chrome, and one Installed status
panel with actionable preparation diagnostics. Job history and completed receipts
are under Audit. Failed/session-retired evidence is removed; source checks remain
deliberate. No SDK/API/application versions changed.

A fresh isolated actual supervisor/Core/Next run exercised the final UI at
320/390/820/1440 widths in both themes, including quiet and attention pages,
source reviews, the restricted shell and completed Audit history. Normal exact
source navigation, cached review without scans, keyboard controls, backup gating
and stale-link rejection pass. The public workflow survives unapproved review
replacement, completes **25 unique controlled-upstream writes / 32 checks**, and
matches an independent complete source oracle. Admin remains available at 200
during preparation, player work returns 503, and stale post-activation mutations
return 409. All owned services stopped. This is isolated host evidence, not a
new Foundry run; previous native v13/v14 results remain retained.

### CR64-22-R1 — unavailable navigation target retains the prior drawer

**Resolved, P2; correction and failing-before/passing-after evidence below.** At review, in
`src/app/(admin)/components/ModuleLifecycleControl.tsx`, the query-selection effect
sets `selectedKey` only when it finds the requested card. An unavailable target
leaves the previous selection intact. The separately rendered missing-target
alert is behind the still-open modal; `expectedMigrationScope` becomes undefined
for that old selection, leaving its Check world data control enabled.

Reproduced against the actual final Next interface using its supported same-page
history navigation:

1. Open `/admin/modules?module=fixture&source=managed&migration=<current-scope>`
   and confirm the managed fixture drawer opens.
2. Change the URL in the same mounted page to
   `/admin/modules?module=removed-fixture&source=managed&migration=retired-target`.
3. The page reports that the requested source is unavailable, but the prior
   fixture's drawer remains visible with Check world data enabled. Independent
   evidence records one visible prior drawer and an enabled prior check.

This contradicts the required exact-target navigation experience. The probe did
not click that control, switch the selected runtime source, enter maintenance or
authorize an unintended write. The backend's exact-plan authority remains intact;
this finding does not invalidate native migration/recovery acceptance.

Required correction: reconcile the drawer with explicit navigation intent. An
unavailable or invalid requested target must retire the prior drawer/preview and
leave an accessible explanation, without silently displaying another card.
Preserve manual Details interaction and disclosure choices during stable polls.
Add a regression that starts with a drawer already open and then exercises a
missing module, unavailable source and malformed source through same-page
navigation/history; verify valid links still open the exact target and ordinary
manual drawers remain usable. A fresh full-page load with no previous selection
does not cover this defect. Keep this correction within Core UI and existing
identity contracts; no new migration engine or native inventory run is needed.

### Proposed deliverables reconciled

The original aggregate checklist is historical design inventory. This table maps
its Core-owned obligations to cumulative evidence and separates module adoption
and release operations. It does not turn generic fixture results into validation
of a module's native formulas, hooks or UI.

| Deliverable / gates | Current coverage and disposition |
| --- | --- |
| Full-GM identity and caller separation — G0/G0a | Implemented; initial/reconnect/demotion/retry and ordinary caller distinctions have unit, actual-host and retained v13/v14 evidence. No automatic account promotion. |
| Declared settings and immutable refresh — G1/G2 | Implemented; Store availability/default provenance, false/zero/null, user-key exclusion, filtered projection, retired handles and preparation races are covered by `module-world-migrations.test.ts` and corrective integration. Native setting create/update/delete and recovery supplement them. Module-specific consumption belongs to G8. |
| Separate catalogs, compilation, release metadata and previews — G3, C64-A/C | Implemented; schema/path/dependency/digest/history validation, v2 packaging, old-host gates, skipped steps, isolated read-only previews and artifact/world fencing have unit/integration and public workflow evidence. Migration-free compatibility is retained. |
| Maintenance ownership and lifecycle — G4, C64-B | Implemented; supervised normal Core/Next shutdown, ordinary-session/callback drain, restricted admission, durable leases and restart composition have isolated and native evidence. No module/player write authority is added. |
| Complete planning/execution and targets — G4/G5, C64-C/D | Implemented; independent UUID/source oracles cover world/embedded/delta/arbitrary world-pack locations and bounded parent/base relations. Original and larger native inventories complete, including 3,194 unique writes on each generation. Legacy 39.6 MB plan evidence is retained. Recorded memory peaks and brief replacement listener interruptions remain qualifications, not hidden capacity guarantees. |
| Approval, file transitions, readback and recovery — G4, C64-E | Implemented through CR64-21; file/publish/intent/receipt crashes, partial or uncertain outcomes, cancellation drain, source restore/conflict and final preparation have independent corrective plus native evidence. No blind replay, world undo or native-user lockout is promised. |
| Caller/pack permissions and canonical identity — G6/G7, C64-F | Implemented; shared generation-aware policy, revocation with warm caches, safe 403, canonical UUID preservation and permitted labels are covered by unit/integration and retained native access tests. Non-GM `/system/data` requires the module's caller-safe projection. |
| Whole-host and native acceptance — Core G9, C64-G | Selected v13.351/v14.367 matrices, full independent source/receipt accounting, operator/player layouts and cleanup are evidenced. Latest isolated final-UI run passes its normal workflow. No further native execution blocker was found. |
| Admin visibility and exact source review — CR64-22, C64-H | Final placement/disclosure/history behavior independently verified. CR64-22-R1 is corrected and verified by the mounted-page regression below; no known Core blocker remains. |
| Documentation, compatibility and release — Core G9, C64-H | Contracts/guides and evidence are present; this review corrects the completion claim and records the final narrow action. Application remains 0.19.0; current tree SDK 3.4.0/module-api 1.6.0/UI 3.2.0/roll 1.0.0. Published 0.19.0 supplies SDK 3.3/module-api 1.5 and does not contain these complete-maintenance corrections. Supporting release identification/publication remains separate. |
| Module adoption — G8 | Still module-owned and not established by Core fixtures. Resume after the Core correction/review and selected release sequence; preserve exact historical migration hooks, adopt actual available SDK/Core/toolchain floors, and perform module-owned native acceptance. No module repository was inspected in this review. |

### Closeout and release sequence

At independent review, the user's conditional closeout request was **not yet met
because CR64-22-R1 was confirmed**. The ADR and active audit therefore stayed open.
Correct that one UI selection path, prove the regression fails before/passes after,
then rerun the affected component/navigation checks and normal type/lint checks.
Retain the passed broad and native evidence unless the correction changes those
behaviors. No generic repeat of the entire migration/native matrix is requested.

Once that correction is independently verified, reconcile C64-H and close the
Core implementation scope under the user's conditional instruction. Checkpoint/
merge and release remain separately scoped operations; use `docs/RELEASING.md`
and the release helper after merge, with an actual chosen application version.
Do not pre-bump metadata or invent a dependent module's release floor. Then hand
G8 back to the module agent using the published supporting Core/SDK/toolchain;
bounded relations require module-api 1.6.0, while historical 1.5 catalogs retain
their semantics. This review adds no module task beyond the already selected G8
adoption and does not authorize remote writes or publication.

## CR64-22-R1 correction and Core closeout — October 17, 2026

**Resolved. Core implementation closed under the user's conditional instruction.**
The ADR was saved byte-for-byte before this revision: 311,519 bytes, SHA-256
`8a81bc7873ac516ecf7a754bb15969485a8cdc6cd3f118dc83fda400b258b68f`.
The existing uncommitted CR64-22 implementation and original documentation were
preserved on `fix/adr-0064-complete-maintenance`, checkpoint `b5574cb`.

### Bounded correction

`ModuleLifecycleControl` now binds manual selection/close state to the relevant
module/source/revision navigation intent. A changed intent cannot render the
previous selection while an effect catches up. Only an exact installed match
opens automatically; missing modules, unavailable sources and malformed links
retire the drawer and child review, with an accessible alert. Duplicate target
parameters, missing source and explicitly empty revisions are rejected rather
than silently discarding a scope check. Back/Forward resolves each target anew.
Unmounting the existing review retires its pending response sequence and loaded
preview. Valid source/revision changes remount it; old controls cannot survive.

Manual Details and close choices remain usable and survive stable refreshes.
Manually opening the exact source named by a stale link still retains that
link's revision check. Unrelated query changes do not reset selection. Existing
card/disclosure defaults and manual toggles are preserved. No backend migration,
source activation, authority, approval, journal or native execution changed.

### Regression and acceptance evidence

The tracked actual-interface test is
`src/tests/acceptance/migrationAttentionBrowser.ts`, exercised by
`src/tests/acceptance/adr0064-supervised.test.ts`. Its isolated managed-only fixture
distinguishes an unavailable source from a missing module. It starts with an open
drawer and loaded plan, then navigates within the mounted Next page (not a fresh
load) to six invalid targets: missing module, unavailable source, invalid source,
missing source, duplicated source and empty revision. It asserts no drawer,
review or old maintenance control, visible explanation, Back/Forward retirement,
fresh exact local/managed links, retained stale-scope denial, ordinary manual
Details, manual close across refresh and stable disclosure toggles.

Before the correction this regression **failed** on the missing-module case:
one previous drawer and source review remained (`1 !== 0`). After correction the
six-case matrix passes at 320/390/820/1440 in both themes. The same actual
supervisor/Core/Next workflow passes quiet/attention pages, Audit history,
read-only cached reviews without POSTs or source scans, unapproved review
replacement, restricted-shell gating, **25 unique controlled-upstream writes /
32 checks**, complete independent source comparison and activation. Admin200,
player503 and stale-client409 boundaries remain intact. These are isolated host
results, not new native acceptance. The original v13.351/v14.367 evidence and
3,194-write comparisons remain valid, with their recorded capacity limitations.

Fresh `npm run test:client`, `npx tsc --noEmit --incremental false`, `npm run lint`,
`git diff --check` and the actual-component rendered harness pass. The latter
retains nine-state disclosures, stable toggles, failure/auth retirement,
diagnostics/history separation, keyboard/focus and recovery controls across both
themes/four widths. Selected missing/malformed-target captures were visually
inspected: warnings are unobscured, with no prior modal. The earlier independent
full unit/integration checks remain retained; no broad/native rerun was needed
for this client-only correction. A first post-fix browser attempt passed all six
retirement cases but stopped on an incorrect fixture link selector; that test
selector was corrected to read the existing public status projection. It is not
represented as a successful full run.

### Final Core disposition and explicit remaining work

| Scope | Disposition |
| --- | --- |
| C64-A–G, Core G0–G7/G9, CR64-01–22 including R1 | Implemented and verified with the cumulative qualified evidence above; no confirmed Core gap remains. |
| C64-H | Core readiness/documentation reconciled; conditional Core closeout satisfied after the R1 regression passes. Release execution and module work are not implied. |
| G8 | Separately authorized module adoption remains pending. Generic Core fixtures do not establish any module's hook/rule/UI compliance. No module repository was inspected or changed. |
| Supporting release | Independent review passed; checkpoint authorized. Merge and an actual selected release remain pending through `docs/RELEASING.md`. Package/lock remain0.19.0; no supporting application version is assigned here. Published0.19.0 has SDK3.3/module-api1.5 and lacks the complete-maintenance corrections. The current tree has SDK3.4/module-api1.6/UI3.2/roll1.0; those contracts are not yet a published host/toolchain. |

Archive the completed Core audit; retain G8/release sequencing in the stable
handoff and DW-16 ledger. After the user's review and explicit module resumption,
the module agent must use its own guidance/handoff, preserve historical catalog
semantics, resolve its module-owned findings, adopt actual available Core/SDK/
toolchain floors (bounded relations require module-api1.6), and perform its own
native acceptance before dependent publication. No module release floor,
version bump or publication is authorized by Core closeout. Only isolated task
services were used and stopped; no native Foundry or root production configuration
was contacted.


### Independent R1 verification and checkpoint review — October 17, 2026

The final correction was independently reviewed before the user-authorized
checkpoint. Relative to the preceding independent source review, only
`ModuleLifecycleControl.tsx` and its two tracked acceptance files changed;
previously reviewed backend behavior is unchanged. The ADR was saved before
this annotation: 317,226 bytes, SHA-256
`cd2c7bbb9cadc0b8f60a24670af94bc7b87348be09bc445b4e355f1651eb3add`.

A fresh isolated real supervisor/Core/Next run of
`adr0064-supervised.test.ts --run-isolated --complete-matrix --inventory=2,2 --migration-attention --restart-review`
passes all **48 invalid-navigation cases** across four widths and both themes,
including mounted history, exact-source transitions, stale-scope guards and
manual controls. Captured cases have zero retained drawers, reviews or stale
maintenance actions. Desktop dark and narrow light warnings were visually
inspected. The same public workflow completes **25 unique writes / 32 checks**,
with an independent full-source oracle, unapproved-review restart, activation,
admin HTTP 200, player maintenance 503 and stale-client rejection 409. This
83.612-second controlled-upstream run is not new native or capacity evidence.

Fresh client tests, TypeScript, lint, documentation links and whitespace checks
pass. The prior full unit/integration and native v13/v14 evidence remains valid
within its recorded scope; this client-only correction does not warrant repeating
native inventories. All owned processes and listeners were verified stopped.
API, architecture and runtime guides were reconciled to remove stale open-Core
wording while preserving operating limits and the separate module hold.

No confirmed Core implementation blocker remains; Core/C64-H closeout stands.
The user authorized this local checkpoint and will perform push, PR/merge and
release separately. Application/lock versions remain 0.19.0; no supporting
release number is invented. Published 0.19.0 still lacks these corrections and
SDK 3.4/module-api 1.6. G8 adoption requires explicit resumption and the published
supporting host/toolchain before dependent module publication. No module
repository, live Foundry instance or production configuration was accessed.

## G8 integration correction amendment — October 18, 2026

### Selection, chronology and ownership

The user selected **four Core corrections** after actual Shadowdark adoption of
released Core 0.19.1: CG-5, CG-7, CG-9 and CG-10. Reopen this ADR only for the
checkpoints below. CG-5 is included here at the user's explicit request for the
same correction/release slice; it is **not a migration defect, maintenance gate,
or reason to block migration testing**. All four are selected release deliverables.

Core `main` at `10213980` has package/lock 0.19.1, SDK 3.4.0,
module-api 1.6.0, ui-extension-api 3.2.0 and roll-engine-api 1.0.0. The user reports
0.19.1 published after squash-merge; local release commit `10213980` follows
`091adc08` (ADR-0064 corrections). This amendment did not query remote CI or
publication. Prior complete-maintenance, approval, execution, recovery and admin
navigation evidence stands within its recorded scope. These findings do not
establish that those fixes regressed.

CG-5/CG-7 were recorded during G8's isolated real-Core review; CG-9 was recorded
during subsequent installed-consumer testing. The October 18 native v14 run
confirmed those three. **Only CG-10 is new from that native run.** The prior Core
closeout and generic fixtures did not establish all packaged-module integration
paths. The next closeout must report migration, live access refresh, packaged
error handling and UI accessibility separately.

The originating evidence belongs to Shadowdark ADR-0001 and its tracked audit,
`docs/audits/2026-10-15-native-alignment.md`, sections "Core observations",
"Additional Core dependency CG-9" and "Native v14 acceptance". Core's reproducible
requirements and observations are restated here so this ADR does not depend on
an ignored report or a module checkout. Implementations and new regression tests
belong to Core; module source, catalogs, workflows, versions and working trees
remain unchanged. A read-only copy of the existing module package may be used in
an isolated Core-owned harness.

| Core ID | Origin | Classification | Selected outcome / status |
| --- | --- | --- | --- |
| CR64-23 | CG-7 | Migration eligibility defect | Correct native world-pack lock defaults consistently; open. |
| CR64-24 | CG-9 | Caller-data freshness after access changes | Retire/refetch loaded and pending collections through the existing public context mechanism; open. |
| CR64-25 | CG-10 | Packaged SDK error contract | Preserve safe typed status handling across supported module loading boundaries; open. |
| CR64-26 | CG-5 | Shared UI accessibility | Correct shared sheet roll-dialog keyboard/focus behavior; open, independent of migration acceptance. |

Earlier module observations CG-4 (reconnect pack freshness), CG-6 (untyped context
conflicts), CG-8 (package/history determinism), advisory-status omissions and an
intentional-lock exclusion policy are **not selected by this four-issue request**.
Do not mark them fixed or silently add them to this implementation. If a selected
correction demonstrably requires one, record the specific dependency and seek a
scope decision while completing independent work. Explicitly carry their status
into the follow-up handoff. No new general migration inventory or module feature
program is implied.

### CR64-23 / CG-7 — authoritative world-pack lock defaults

**Observed failure.** A new native world Actor pack on Foundry 14.367 had no
`locked` metadata field and no `core.compendiumConfiguration` entry. Native
`game.packs.get(id).locked` was false. Core bootstrap instead reported
"Required world pack is locked or unreadable" and withheld readiness. Setting
only the fixture's configuration to explicit `locked:false` admitted it. The
failure occurred before writes; this is not an interrupted migration.

Both locally inspected Foundry v13/v14 `CompendiumCollection#locked` implementations
use `this.config.locked ?? (this.metadata.packageType !== "world")`.
Core `src/server/services/world/migrations/targets.ts`, `packIsWritableWorld`,
currently falls back through metadata to true. The blanket default is wrong for
proven world-owned packs. Do not use a `world.` prefix alone as proof of native
package ownership, or infer writability from a populated read cache.

Required implementation:

1. Trace authoritative metadata/configuration through fresh discovery, isolated
   preview, maintenance enumeration and execution. Centralize the verified native
   lock rule where all those paths can share it; distinguish an absent override
   from unreadable configuration or unresolved package identity.
2. Apply explicit native lock configuration with native precedence; a verified
   world-owned pack without an override defaults unlocked. Non-world packs stay
   outside migration writes, even if individually unlocked. Unknown ownership,
   failed reads and insufficient authority remain explicit blocked outcomes.
3. Retain required migration completeness. Never fix this by making required
   world-pack steps advisory, skipping targets, changing Foundry configuration,
   auto-unlocking packs, or allowing module bootstrap to write.
4. Recheck relevant lock/access state before approval and at the final native
   write boundary. A pack locked after preview must invalidate obsolete approval
   or stop safely before the affected write. Preserve intent/receipt recovery for
   any earlier writes. Reuse existing dependency fencing and diagnostics.

Acceptance: a tracked regression fails on an otherwise valid required pack with
no lock override; the corrected public bootstrap/preview/apply migrates all its
fixture targets. Cover explicit true/false, native precedence, non-world packs,
missing/failed metadata and configuration, and lock changes after preview.
Use native v13 and v14 focused fixtures with **absent configuration**, not fixtures
that pre-insert `locked:false`. Verify complete sources and confirmed receipt
counts; clean up only the fixtures. Intentionally locked required packs still
block with an accurate explanation. Choosing an exclusion policy is separate.

### CR64-24 / CG-9 — invalidate loaded collections on access changes

**Observed failure.** A Player opened the Gear picker and loaded Rope. Revoking
PLAYER access to its native compendium made fresh requests return 403, while the
old Rope row stayed visible. Index/collection request counts remained 1 to 1.
Changing an unrelated declared Pulp setting finally retired/refetched the data.
Permission restoration plus manual Retry recovered it. The native run confirms
correct fresh-request authorization but missing automatic retirement.

Current ownership: `SystemService` observes SettingStore changes;
`WorldBootstrapper.refreshWorldContext()` returns when no declared setting value
changed and no pack was named. `ModuleWorldContextService.refresh()` compares only
declared module settings. `AppSocketGateway` restricts raw Setting events to their
privileged audience, while already publishing authorized `worldContextChanged`
revision hints. A capability change needs invalidation, not raw configuration
exposure. The module already retires caches on supported context revisions.

Required implementation:

1. Recognize effective pack-access changes from authoritative Core ingress and
   reconciliation, including override deletion/reset. Determine affected current
   callers/dependencies without publishing ownership maps or native Setting rows.
2. Prefer the existing revisioned world-context/dependency publication and SDK
   consumer path. Publish a meaningful revision even if declared rule-setting
   values did not change; empty visible setting-key lists must not suppress it.
   Do not invent a required module callback when existing consumers can handle
   the correction. If a public extension proves necessary, document its exact
   compatibility impact before claiming no contract change.
3. Invalidate affected server projections and ensure mounted public consumers
   retire both loaded results and in-flight requests, then refetch with current
   caller authority. Late responses from a superseded revision cannot restore
   revoked content. Preserve relevant manual search/tab state and actionable
   loading/denial/retry states. Restoring access must be observable too.
4. Keep notification ordering consistent with Store updates and preparation;
   coalesce redundant events. Reconnect must reconcile an access change missed
   while disconnected. Do not add periodic module polling, a second settings
   cache, privileged module reads or normal-runtime work during maintenance.

Acceptance: mount a real public-SDK consumer with a Player's collection loaded,
revoke only compendium ownership, and prove automatic retirement/refetch without
Pulp changes, remount, reload or manual Retry. Repeat with a delayed old response,
restore-only changes, deletion/reset and reconnect. Verify fresh denied reads
remain 403, another caller's private data/settings never enter the payload, and
normal setting notifications still work. A fresh read alone cannot close this
finding. Include the unchanged packaged module in the isolated Core UI run.

### CR64-25 / CG-10 — SDK errors across managed package boundaries

**Observed failure.** A Player with OBSERVER access could read the fixture Actor
but could not update its owned Item ActiveEffect, as intended. Source remained
unchanged. The actual module effect route returned sanitized HTTP 500/internal
instead of the host's typed `permission_denied` / 403. OWNER writes worked;
LIMITED detail/write paths returned legitimate concealment 404.

A separate no-network probe invoked the exact installed `dist/server.js` route
with a runtime throwing Core's `SdkError('permission_denied', ...)`; the packaged
handler still returned 500. In an adjacent external data directory a `.js`
importer saw different SDK constructors and failed `isSdkError` in both directions;
a `.mjs` importer shared identity. The tested archive has `.js` server output
outside Core's ESM package boundary. This supports a CJS/ESM loading identity
failure in that configuration, not a Foundry permission bypass or a claim about
every installation layout. The public helper currently uses `instanceof` alone.

Required implementation:

1. Reproduce using an actual managed archive and configured data directory outside
   Core's package tree. Trace `src/modules/registry/core/bootstrap.ts`, package
   output/SDK resolution and `src/shared/sdk/errors.ts`; a same-constructor unit
   mock is insufficient. Retain a development-module comparison.
2. Make error recognition reliable across supported host/module loaders, through
   consistent loading and/or a deliberately validated SDK error representation.
   Existing valid managed archives must work without editing module source or
   rewriting their catalog/historical hooks. A packaging-only change that fixes
   newly built archives but leaves the tested archive broken is incomplete.
3. Preserve the public taxonomy and safe HTTP mapping: permission_denied and
   out_of_scope 403, not_found 404, conflict 409, validation 400, not_ready 503,
   internal/unknown 500. Do not classify arbitrary errors by message text, trust
   an unvalidated object/status, disclose internal exceptions, elevate authority,
   or replace intentional nonowner 404 concealment with 403.
4. Preserve supported custom status behavior and document any chosen identity
   validation. Verify SDK helpers in both import directions and actual route
   responses, rather than only comparing constructors. No module-specific hack.

Acceptance: track a failing-before/passing-after external-data `.js` archive case,
with an in-tree managed and local-development comparison, in supported development
and production launch modes. Cover typed codes, malformed/unknown errors and
sanitization. Repeat the native OBSERVER write denial with exact unchanged-source
proof; verify OWNER success and LIMITED concealment. Run existing authorization
regressions, including CR64-20. Its earlier safe-403 evidence did not cover this
specific packaged boundary; do not rewrite that evidence as a passed CG-10 case.

### CR64-26 / CG-5 — shared roll-dialog keyboard and focus

**Observed failure.** Eight native-backed width/theme cases found that opening
Core's shared sheet roll dialog did not move focus inside, Tab escaped to the
page, Escape did not close it and focus was not restored. Module resource dialogs
passed the same checks. `SheetRollDialog` uses `RollDialogFrame` with a ref and
ARIA role but does not use the existing Core `useModalFocus` convention.

Required implementation:

1. Correct the shared Core sheet roll-dialog lifecycle using the existing modal
   focus mechanism. Choose a single owner; avoid duplicate traps/listeners when
   the frame or another consumer already manages focus.
2. Enter focus on open, contain Tab/Shift+Tab, close the appropriate top dialog
   on Escape and return focus to a still-connected invoker. Clean up listeners
   and body scroll state on close/unmount. Check invocation from a resource card
   so closing the roll dialog does not incorrectly close its parent.
3. Preserve roll arguments, defaults, manual input, persisted roll mode, theme,
   backdrop/close-button behavior and the initiative variant. Do not implement
   another module-local roll modal or change game rules.

Acceptance: reproduce with the actual SDK-provided component, then exercise
keyboard open/close/reopen, both tab directions, confirm/cancel and invoker
unmount. Inspect narrow and desktop light/dark rendering; retain the established
320/390/820/1440 matrix where the harness supports it. A focused browser test does
not require native writes or a migration job. Report this row as **UI acceptance**,
not a migration prerequisite or justification to gate a world.

### Implementation checkpoints and evidence

| Checkpoint | Deliverable | Completion evidence |
| --- | --- | --- |
| F1 — baseline | Core-only corrective branch; preserve this documentation and all unrelated/module work. | Record HEAD, release/contracts, immutable artifact identity, owned listeners and exact baseline failures for the four IDs. |
| F2 — corrections | Implement CR64-23–26 with tracked regressions. | Each original defect fails before and passes after; actual call/loader/component paths exercised. |
| F3 — integration | Isolated Core with public admin/player flows and an unchanged migration-bearing managed package. | No invented unlock, unrelated settings trigger, same-constructor-only mock or replacement module UI. Complete source/receipt oracle, context invalidation and error/keyboard outcomes recorded separately. |
| F4 — regression | Appropriate full Core suites and clean-checkout/build validation. | Unit, client, integration, TypeScript, lint and whitespace pass; managed generation and production build use isolated data. Prior large inventories remain retained unless changed behavior requires a repeat. |
| F5 — native | Focused native v14 and v13 coverage of the selected native-dependent behavior. | Exact world/version/fixture scope, absent-lock pack, access revoke/restore, observer refusal, source comparison and cleanup recorded. No unexecuted generation or UI-only result reported as a native migration pass. |
| F6 — release readiness | Independent review, current guides/handoff and concise changelog; four rows explicitly disposed. | No unexplained selected failures; no claim that deferred observations or full module A01 acceptance are complete. User owns commit/merge/publication unless separately delegated. |

Use isolated data/configuration and inspect listeners before launching or stopping
services. Existing explicit authorization for the disposable local v14 fixture
run is recorded with the module evidence; verify that the endpoint still serves
the same intended disposable world before using that scope. It does not authorize
production, a different world or unrelated writes. A v13 operator switch is still
needed for fresh v13 checks; finish independent work first and state exactly which
focused native rows await it. Do not replace or stop the user's Foundry process.
No native connection is needed to implement the fixes or reproduce the controlled
failures. Stop owned test services, remove fixtures and verify the original
baseline after native use. Existing backup limitations/acknowledgement remain;
this amendment adds no backup/undo or Foundry-user lockout capability.

The preserved native v14 module baseline was Foundry 14.367 / Shadowdark 4.0.6,
world `shadowdark-test`, isolated Core 0.19.1 and managed module 0.9.4. Its archive
SHA-256 was `2fcacac74dc0accbcefc5829611afcec6cae588ecf757ec97ad57d8234a7d971`.
Eight initial fixture effects and one deliberately restored effect migrated with
full source comparison and fresh approval. This proves the exercised migration
execution/restart/restore paths; CG-7's absent-lock case was independently blocked.
It is not a large-inventory rerun or full Shadowdark A01-01–10 acceptance. Prefer
Core-owned generic tracked fixtures for reproducibility from a clean checkout;
consume the real package read-only as additional integration evidence, never make
Core CI depend on an ignored module checkout or local evidence directory.

### Point release and module resumption

The intended next release is a **Core point release after 0.19.1** (normally
0.19.2; confirm the available version at release preparation). During correction,
update terse Unreleased changelog entries only. Keep package/lock versions at
0.19.1 and module metadata unchanged. Use `docs/RELEASING.md` and `release:tag`
after review/merge; this documentation task does not authorize commits, tags,
pushes, workflow dispatch or publication. Do not pre-bump SDK/API versions simply
because the application is getting a point release. Prefer corrections within
existing contracts; if an actual public addition is necessary, record the exact
surface, compatibility rationale and required version decision.

Update architecture, API/error/context guidance, module authoring/manifest and
migration/runtime guides with implemented behavior and limits. Preserve this
amendment's plan as history and append actual evidence/disposition; a checklist or
passing unrelated suite does not close a finding. Close the reopened Core scope
only after the four selected corrections are verified and reviewed; identify
publication separately if it has not happened yet.

After the supporting point release is published, resume the separately owned
Shadowdark work: adopt the actual published Core/toolchain floor in its later
module task, then finish outstanding native/module acceptance. This Core task
must not change module manifests, versions or CI pins. CG-5's inclusion in the
selected release never changes migration readiness semantics. Carry unselected
CG-4/6/8 and policy questions forward explicitly; their disposition requires a
separate decision, not a claim that these four fixes resolved them.

## Selected G8 corrections — implementation and verification, October 18, 2026

The four selected corrections are implemented, not merely audited. Fresh v14
and independent offline work are complete; **fresh native v13 and review remain
open**. No module compliance or release is inferred. Work is uncommitted on
`fix/adr-0064-g8-integration`, from main `10213980`, preserving all eight original
documentation edits. Before revision the ADR was saved byte-for-byte:338790B,
SHA256 `e4422ebb384dbf7f767c88e87f03e6544d3e70a06ac9943b4ca21fbe847b431f`.

### Corrections and failing-before/passing-after evidence

| Finding | Implemented behavior and regressions |
| --- | --- |
| CR64-23 / CG-7 | Existing native pack policy now owns lock precedence: explicit configuration, otherwise the verified package-ownership default. World defaults unlocked; `metadata.locked` is not an override. Unknown ownership, unavailable/malformed configuration (including a present Setting without a value), explicit locks and non-world write targets fail closed. Compendium seeding retains authoritative envelope provenance and world-scoped manifest names instead of creating phantom system-scoped entries. Required targets, approval/dependency fences and final-envelope checks remain intact. The tracked absent-lock regression failed `false !== true` before correction. It now covers complete enumeration, metadata/configuration precedence, true/false/null, missing/unreadable input, package exclusions and changes after a snapshot. Native v14 migrated both absent-lock fixture packs without inserting `locked:false`. |
| CR64-24 / CG-9 | The existing world-context service privately fingerprints access dependencies from authoritative Stores. Ownership-only changes, restoration and override removal advance its revision even with no declared-setting change. The existing preparation/publication path then emits a revision hint, possibly `keys:[]`, never raw ownership/Setting rows. Identical observations coalesce; replacing recovery publishes current context. The original real-ingress/bootstrap regression failed because the revision did not advance. It now passes with empty public keys and reconnect coverage; the SDK bus test also preserves empty-key events across reattachment. Mounted unchanged-package consumers are verified separately below. |
| CR64-25 / CG-10 | `isSdkError` uses a non-wire `Symbol.for` brand on an actual Error plus validated own taxonomy/status data, not constructor or message matching. Integer custom error statuses400–599 and valid subclasses remain supported. Plain objects, malformed codes/statuses and unbranded exceptions are not typed errors. Unknown host module-route exceptions are sanitized500/internal; expected403 and concealment404 remain distinct. The external-data `.js` regression originally failed cross-loader recognition. Both import directions, actual compiled archive/registry/proxy HTTP routes, in-tree managed and local-development comparisons now pass. Existing archives/catalogs/hooks are not rewritten. |
| CR64-26 / CG-5 — UI only | Sheet and initiative rollers each use Core's existing modal-focus convention, not a second frame/document trap. Focus enters, both tab directions remain contained, Escape affects the top dialog and return targets must still exist. The shared convention tracks active dialogs so nested close/tree unmount restores scroll correctly. The original actual SDK component failed focus entry; expanded coverage then exposed nested-unmount `overflow:hidden` leakage, corrected with the same owner. Manual/default arguments, persisted mode, module theme, close/backdrop and initiative presentation remain unchanged. This does not gate migrations. |

Tracked coverage is `src/tests/integration/adr0064-g8.test.ts` (four isolated
cases, included in `test:integration`), existing native-generation boundary tests
and `src/tests/unit/client/sdk-event-bus.test.ts`. The generic managed archive is
compiled and installed by Core tests; CI has no dependency on a module checkout
or ignored artifact. `src/tests/fixtures/maintenanceInventory.ts` now uses absent
lock metadata, not an explicit unlock. The actual public supervisor workflow
completes25unique writes/32checks and the independent source oracle. Existing
explicit-lock tests now set the native configuration rather than relying on an
incorrect metadata field. No required step was made advisory or omitted.

### Public, rendered and native integration

The unchanged additional managed archive has SHA256
`2fcacac74dc0accbcefc5829611afcec6cae588ecf757ec97ad57d8234a7d971`.
It was copied read-only into isolated Core-owned data outside this repository.
No module source, manifest, catalog, hook, branch or workflow was modified.

Fresh disposable native identity was verified before writes: loopback30000,
Foundry14.367, `shadowdark-test`, Shadowdark4.0.6; the user-owned Foundry process
was inspected and never stopped. A fresh baseline/fixture ledger was created;
old cleaned IDs were not reused. The module's actual catalog proposed exactly
eight marked fixture effects across world/owned/delta/world-pack sources. Both
new Actor/Item world packs lacked lock metadata and lock overrides. Public
review/backup acknowledgement/approval completed eight unique intents and eight
confirmed receipts. Independent literal-key/full-source comparison matched all
intended changes; ordinary restart required no further migration.

In **development and built production mode**, actual public HTTP and mounted
managed-package browser flows verify:

- A Player's loaded Rope collection retires/refetches on ownership-only denial
  and restoration, without Pulp changes, reload, remount or manual Retry. Search
  and the original mounted search element survive; request count grows1→3.
- A held positive response from the old revision cannot restore content after
  a new denial. Override removal and access changes missed while disconnected
  recover automatically. Fresh denied requests remain403; no page exception.
- OBSERVER reads succeed but owned-Item effect writes return
  `permission_denied`403 with the entire Actor source unchanged. LIMITED and
  nonowner detail/write paths retain404 concealment. OWNER writes succeed via
  that same packaged route, change exactly the intended field, then restore it.
- The unchanged module invokes Core's shared SDK sheet roller with working
  focus, Tab/Shift+Tab, Escape and return at320/390/820/1440 in both themes.
  These keyboard checks submit no native roll/chat write and are UI acceptance,
  not evidence of another migration.

The standalone actual-SDK browser harness
`src/tests/acceptance/adr0064-g8-roll-dialog.mjs` additionally verifies manual
arguments, initiative, nested resource-card behavior, removed invokers and whole
nested-tree unmount. Actual player appearance scopes produce distinct nonempty
light/dark styles; captures were visually inspected. The existing admin/recovery
rendered harness also passes, preserving its focus/stop/cleanup behavior.

### Checkpoint disposition and limitations

| Checkpoint | Actual disposition |
| --- | --- |
| F1 | Approved corrective branch, original docs preserved, immutable artifact and original four failures recorded. |
| F2 | Four bounded implementations and failing-before/passing-after regressions present. No new SDK/API surface or release-version bump. |
| F3 | Actual public routes/registry/archive loading, supervised workflow and unchanged packaged browser consumers pass; development and production launch modes distinguished. |
| F4 | Full Core unit/client/integration, TypeScript, lint and whitespace checks pass; clean managed-generation regression and isolated production build pass. The latest integration includes24 prior corrective,27 complete-maintenance,9 attention and4 G8 cases. Prior large-inventory evidence is retained, not rerun or relabeled. |
| F5 | Focused native v14 passes, with fresh baseline restoration. **Fresh v13 remains pending an operator switch and identification of its disposable world/accounts.** Controlled generation13/14 boundary tests and old native evidence are not that fresh acceptance. |
| F6 | Guides, changelog, active report and handoff updated. Independent/user review, selected point release and subsequent module resumption remain pending. Keep this amendment open. |

Harness corrections are not hidden successes: initial native UI stopped at an
unpopulated isolated login-world cache; the existing Core import CLI populated
that isolated cache from credential-free exports and the host was restarted.
An initial copied-workspace build failed because Turbopack rejects external
dependency symlinks; physical isolated dependencies allowed the real build.
Production startup then exposed the world-manifest provenance defect corrected
under CR64-23 above. A subsequent harness retry encountered its already-created
admin account; setup was made idempotent, not bypassed in Core. Final production
startup, native permissions and mounted ownership recovery pass. These failed
attempts are not counted as completed acceptance.

Cleanup restores original9Actors/0Items/2Scenes/4Users and original pack membership,
with no source differences; temporary settings/overrides, users and documents are
removed. Source comparisons omit native `_stats` bookkeeping; original User
identity/role/character roster is compared without exporting credentials. Only
owned test Core/Next/manager/browser processes were managed and stopped. Root
production configuration was never used. No native13 run or full Shadowdark
A01/M5 acceptance is claimed. Unselected CG-4/6/8, advisory-status omissions and
intentional-lock exclusion policy remain in their separate ledger, unchanged.

Application/lock remain0.19.1; SDK3.4/module-api1.6/UI3.2/roll1.0 remain unchanged.
The corrections are **unreleased**. Concise Unreleased notes target the next Core
point release after review (normally0.19.2; confirm availability at preparation).
No commits, remote operations or publication were performed. Module adoption
waits for that supporting published host/toolchain and separate authorization.


## Independent G8 verification — October 18, 2026

**No new blocking defect found in the four selected corrections.** Independent
review of the uncommitted Core diff on `fix/adr-0064-g8-integration` / `10213980`
confirms the original CG-5/7/9/10 paths are corrected. Fresh native v13 acceptance
and user review remain pending; this is not ADR closeout or release authorization.
The ADR was saved before annotation: 348,950 bytes, SHA256
`bfcc55efcbc20b75fe7faa9cb70882bd45d107f0c4453961ded1acd291918a28`. No application source was changed by this review.

### Independent checks

- Full Core unit suite (including client checks), full integration suite,
  TypeScript, lint and whitespace pass. The integration run includes the four
  tracked G8 cases, 24 retained corrective cases, 27 complete-maintenance cases
  and nine migration-attention cases. The real managed archive/registry/router
  cases exercise external and in-tree data roots plus local development.
- A fresh real supervisor/Core/Next isolated workflow with the current source,
  absent-lock pack fixtures, `--complete-matrix --inventory=2,2 --restart-review`
  completes **25 writes**, with a complete independent source oracle, durable
  review restart, readiness and replacement/authority checks. Elapsed32.830s.
  This uses a controlled upstream, not native Foundry or a new capacity claim.
- A fresh actual SDK-component browser run passes all eight width/theme cases,
  including focus entry, both tab directions, Escape/return, manual arguments,
  initiative, nested resource cards, disconnected invokers and whole-tree
  unmount/scroll restoration. Narrow light and desktop dark captures were
  visually inspected. CG-5 remains UI acceptance, independent of migrations.
- Code review confirms private access fingerprints advance existing public
  context revisions without exposing raw ownership settings; final lock/write
  fences remain in place; SDK cross-loader recognition validates actual branded
  Error/code/status data and unknown route exceptions stay sanitized.

### Retained native and production evidence qualifications

The recorded v14 result files were inspected: eight scoped effect migrations
across world/owned/delta/Actor-pack/Item-pack locations; complete source comparison
and no-op restart; loaded/pending access revoke/restore/reset/reconnect behavior;
OBSERVER403, OWNER success/restoration and LIMITED/nonowner404; eight UI cases
in both development and production; cleanup with `differences: []`.
These remain the implementation agent's native runs, not new independent native
execution in this review. No native connection or write was made here.

Source comparison confirms all **11 changed runtime files** in the final
production acceptance workspace match the reviewed tree byte-for-byte. The
retained production build log records completion. That build was inspected,
not independently repeated after the unchanged-source comparison.

The earlier development/native migration workspace predates five final file
refinements: package-envelope provenance, unavailable-configuration/unknown-scope
handling, subclass error recognition and nested-modal cleanup. Its eight native
writes must not be described as a fresh rerun after those refinements. Later
current-source production bootstrap/access/error/UI evidence and this independent
current-source isolated migration workflow supplement that earlier native result.
This distinction does not establish a new defect or reopen the prior large
inventory work. The focused fresh v13 row remains the next outstanding acceptance.

### Disposition

F2–F4 have independent passing evidence within the scope above; F5 retains the
qualified v14 evidence and awaits fresh v13. F6's independent review is complete;
user acceptance, the selected point release and later module resumption remain.
No extra implementation correction or SDK/API bump is requested by this review.
Unselected CG-4/6/8 and policy observations remain unselected, not implicitly fixed.

Only review documentation/handoff changed. No module repository, application
version, staging, commit or remote operation changed. All independently started
test processes/listeners exited; the existing user Foundry listener was left
running and untouched. The next task is focused v13 acceptance of these changes,
not another general audit or a repeat of all historical migration inventories.


## Final-source native v14 verification — October 18, 2026

**The final reviewed CR64-23–26 source passes focused native v14 acceptance.**
This fresh run supersedes the preceding review's qualification about the earlier
native migration workspace predating final refinements. It does not close fresh
v13, user review, release or full Shadowdark A01/M5 acceptance. CG-5 remains a
separate UI correction, not a migration prerequisite.

### Identity and scope

The operator authorized the running disposable instance on loopback port30000.
Discovery verified Foundry14.367, native Shadowdark4.0.6, world `shadowdark-test`
and the passwordless full-GM `Gamemaster` account. Core branch remains
`fix/adr-0064-g8-integration`, HEAD `10213980`; all17 changed/new source/test files
match the independent review hashes. The reused production workspace matches all
751 source files, with its completed build retained. Application metadata remains
0.19.1 plus the uncommitted corrections; this is **not** released0.19.1 behavior.
SDK3.4/module-api1.6/UI3.2/roll1.0 are unchanged.

The unchanged managed Shadowdark0.9.4 archive has SHA256
`2fcacac74dc0accbcefc5829611afcec6cae588ecf757ec97ad57d8234a7d971`.
Fresh fixture IDs, isolated Core data/admin configuration and independent source
snapshots were used. Module repositories and production configuration were unused.
The ADR was saved before this annotation: 353,464 bytes, SHA256
`413aa5c3e12f768acc2f01d5eea18255df2ca93d0e2957c69138fb319c03c79d`.

### Results

| Boundary | Fresh native result |
| --- | --- |
| Required migration / CR64-23 | Actual public preview and approved maintenance complete exactly eight fixture ActiveEffect writes: world Actor, owned Item, world Item, ActorDelta and its Item, Actor-pack Actor and owned Item, Item-pack Item. Native world packs have no explicit lock override. Complete independent source comparison matches the intended literal-key transformation; unrelated world data is unchanged. |
| Durable execution | Eight unique operation keys, eight intents and eight confirmed receipts. Real supervisor restart serves current data without another migration or source change. |
| Native lock precedence | Explicit `locked: true` produces409 and a locked/unreadable explanation. Explicitfalse, null and absent overrides produce200 with no blockers or operations after migration. Every preview leaves all compared sources unchanged; original configuration is restored. |
| Ownership-only changes / CR64-24 | Development and production each pass revoke/restore on the same mounted Gear picker, held stale positive response rejection, override removal and offline/reconnect reconciliation. Search and mounted element persist; initial revoke/restore requests advance1→3. No Pulp change, page reload, manual Retry or page errors. |
| Packaged SDK errors / CR64-25 | Development and production each pass nonowner404, LIMITED detail/write404 with authorized card200, OBSERVER detail200/write403, and OWNER200 through the same managed JS route. Denials preserve the complete Actor source; owner change and restoration match the exact intended field. |
| Shared roller / CR64-26 | Actual unchanged managed module → Core SDK passes focus entry, both tab directions, Escape and focus return at320/390/820/1440 in both appearance selections, separately in development and production (eight cases each). No native roll/chat submitted. Layout qualification below remains explicit. |

Production initially failed before the sheet appeared because the acceptance
harness reused a matching build with a different API port from its compiled
Next.js rewrites. The failed browser attempt was retained. After stopping the
isolated host and matching its configuration to the build's free ports, all
production checks above passed. This was a harness setup correction; no Core
source was changed, and the failed attempt is not counted as passing evidence.

### Presentation observation and cleanup

At320px, the Shadowdark-themed roller clips the right side of the Disadvantage
button in development and production. The earlier native captures show the same
layout; this patch leaves the action-row layout unchanged. Keyboard acceptance
passes, but these captures are **not** evidence of a fully correct narrow layout.
Record a separate presentation follow-up to determine the shared layout/theme
interaction and verify both Core and module themes. It is outside the selected
focus correction and has no migration impact; it does not reopen CG-5 as a
migration blocker or authorize module changes.

All ledgered fixture documents, accounts and world packs were removed. Original
settings and pack membership were restored. Baseline verification reports no
source differences:9Actors,0Items,2Scenes,4Users. Actor/Item/Scene comparisons
exclude only native `_stats` bookkeeping; safe User identity/role/character and
selected Setting values are compared without exporting credentials. All task
Core/Next/manager/browser processes exited. The operator's Foundry process was
left running. No source, module, version, index, commit or remote changes occurred.

F5's native14 portion now has independent final-source evidence. **Fresh v13 is
next, after the operator switches the disposable instance.** Recheck identity
before using a fresh fixture ledger; do not reuse the cleaned IDs. F6 still needs
user review and the supporting Core point release before separately authorized
module resumption. Prior larger inventories remain retained, not rerun or claimed
as a new capacity measurement.


## Final-source native v13 verification — October 18, 2026

**The selected CR64-23–26 Core acceptance now passes on both native generations.**
The operator switched the disposable endpoint and confirmed readiness. Fresh
checks verified Foundry13.351, Shadowdark4.0.6, world `sd-adr61-v13`, port30000
and passwordless full-GM `Gamemaster`. This completes the amendment's F5 native
row alongside the final-source v14 result above. User review and supporting
point release remain pending; module A01/M5 acceptance remains separate.

### Reviewed source and native fixtures

The approved branch remains `fix/adr-0064-g8-integration`, HEAD `10213980`.
All17 reviewed changed/new source/test files remain byte-identical; the retained
production build's workspace matches all751 source files. Metadata remains
Core0.19.1 plus uncommitted fixes, SDK3.4/module-api1.6/UI3.2/roll1.0. No release,
SDK bump or claim that published0.19.1 contains these fixes is implied.
The unchanged managed Shadowdark0.9.4 archive retains SHA256
`2fcacac74dc0accbcefc5829611afcec6cae588ecf757ec97ad57d8234a7d971`.

The v13 world was empty:0Actors,0Items,0Scenes,1User and no world packs.
A fresh ledger recorded four marked Actors, one world Item, one Scene, two world
packs and two temporary users. Basic Player/NPC fixtures used native Foundry
system defaults; the authorization case used a neutral owned Item/effect, not
invented weapon rules or imported v14 effects. Migration fixtures persisted
**top-level `changes` with numeric modes and string values**, verified by native
readback before approval. Eight intentionally old keys were distributed across
the same world/owned/delta/Actor-pack/Item-pack locations as the v14 matrix.

The ADR was saved before this revision:359,117 bytes, SHA256
`f1aded730a60e2577829f2d4ecd724ed04b77a17777815c9e664b72b9a3f858c`.
Core-owned isolated data/configuration, immutable package copies and existing
external browser tooling were used. Module repositories and operator production
configuration remained untouched.

### Fresh v13 outcomes

| Boundary | Result |
| --- | --- |
| Required migration and source oracle | Actual public preview identified exactly eight fixture effects, with no explicit pack unlock. Approved maintenance completed all eight writes. Complete independent source comparison matched only the literal-key repair, preserving native modes, values and unrelated fields. |
| Durable execution and restart | Eight unique operation keys, eight intents and eight confirmed receipts. Real supervisor restart served current data with no additional migration or source change. Production bootstrap also found no further work. |
| Lock defaults and precedence | Explicittrue produced409 with the lock/readability reason. Explicitfalse, null and absent overrides produced200 with zero current operations/blockers. All four previews preserved every compared world/pack source; original settings were restored. |
| Ownership-only invalidation | Development and production each passed all four mounted-consumer cases: revoke/restore, held stale positive response rejection, override removal and offline/reconnect reconciliation. Original search element and query persisted; initial requests advanced1→3 without Pulp, remount/reload or Retry. No page errors. |
| Actual managed SDK error handling | Development and production each passed nonowner404, LIMITED detail/write404 with authorized card200, OBSERVER detail200/write403, OWNER200 and exact field restoration. Whole Actor sources were unchanged by denied writes. |
| Shared roller keyboard behavior | Development and production each passed all eight320/390/820/1440 width/appearance cases for focus entry, Tab/ShiftTab containment, Escape and return. No native roll/chat was submitted. CG-5 remains UI acceptance, not a migration condition. |

The production host reused the matching build with its original free compiled
proxy ports, so the v14 harness port mismatch was not repeated. No failed native
v13 case required an application correction. The known320px Shadowdark-themed
Disadvantage clipping is also visible on v13; desktop controls fit. The separate
presentation observation above remains carried, not silently fixed or promoted
to a migration blocker. Keyboard results do not establish complete narrow-layout
correctness.

### Cleanup and disposition

All ledgered fixtures/accounts/packs were removed. Original selected Settings,
world membership and safe User identity/role/character roster were restored;
cleanup reports **no differences**,0Actors/0Items/0Scenes/1User and no world
packs. Full document source comparisons exclude only native `_stats` bookkeeping;
credentials were not exported. All task Core/Next/manager/browser processes exited.
The operator's Foundry13 process remained running on30000.

F1–F4 retain their passing implementation/independent evidence; **F5 is complete
for the four selected corrections with fresh final-source v13 and v14 evidence**.
F6 documentation is current; user acceptance and the selected supporting Core
point release remain. No additional selected implementation blocker was found.
Do not repeat historical large inventories or infer a new capacity guarantee from
these focused runs. No source, module, metadata, staging, commit or remote changes
were made. Resume module work only after the supporting release and the user's
instruction; unselected CG-4/6/8 and policy findings remain unselected.


## Responsive roll-dialog correction and Core closeout — October 18, 2026

**Core scope is closed under the user's instruction to fix the clipping if small,
then close out and commit.** The fix is contained to two layout class changes in
Core's shared sheet and initiative dialogs. No module change or new SDK contract
is needed. The previously deferred DW-18 observation is completed as CR64-26-R1;
it has never been a migration gate.

### CR64-26-R1: keep themed action buttons visible

The sheet roller used one nonwrapping flex row for Advantage/Disadvantage.
Shadowdark's uppercase, spaced labels had a combined minimum width larger than
the narrow dialog. The frame's scrolling/overflow behavior then clipped the right
button. Initiative's fixed two-column breakpoint could create the same mismatch
between available space and label width. Both rows now use wrapping flex layout:
controls share a row when they fit and occupy separate rows when they do not.
Theme classes, full labels, focus behavior, manual input and roll arguments remain
unchanged. No font shrinking, truncation, new breakpoint or module-specific branch
was introduced.

The isolated browser reproduction used the actual Core components plus the exact
roll theme functions and scoped CSS from the unchanged managed Shadowdark0.9.4
artifact, not a substitute dialog. Before correction at320px, the dialog's visible
right edge was304px and the Disadvantage button extended to359.56px; scroll width
was340px for280px client width. The bounds assertion failed with the original
screenshot retained. After correction, all **28 width/appearance/presentation
cases** passed:320/390/400/420/640/820/1440, light/dark, Core/packaged Shadowdark.
Each case checked sheet, selected sheet and initiative controls (84 bounds
measurements), full label containment and absence of horizontal overflow.

The same run verified the Disadvantage callback value and prior manual arguments,
focus entry, bidirectional Tab containment, Escape/return, nested card dismissal,
disconnected invoker and whole-tree scroll cleanup. Narrow Shadowdark sheet,
400px initiative and desktop Core captures were visually inspected. Fresh client
tests, TypeScript, lint and whitespace checks pass. No new unit test mirroring a
CSS class was added. These were browser-only checks; no Foundry service or module
repository was contacted or changed in this final slice.

The preceding full unit/client/integration, isolated public/supervisor/package/
build and fresh native13/14 results remain valid for the unchanged server and
contracts. The native captures predate these two layout classes; final layout
acceptance comes from the fresh rendered checks above. Native migrations and
large inventories were not rerun or relabeled. The saved pre-closeout ADR was
364,713 bytes, SHA256
`293c283cf88365c270f5312ed2af47065a6354f23a19cf7586650b7264a51519`.

### Final selected-scope disposition

| Checkpoint | Disposition |
| --- | --- |
| F1–F2 | Approved branch/scope, original defects, four corrective implementations and tracked regressions preserved; responsive UI follow-up also complete. |
| F3–F4 | Actual public/managed/development/production boundaries and independent Core checks pass; final layout/client/type/lint evidence added. |
| F5 | Fresh scoped native13.351 and14.367 acceptance, full source/receipt comparisons and baseline cleanup complete. Final browser-only layout correction is separately evidenced above. |
| F6 | User's conditional closeout criteria met; tracked guides, changelog and handoff reconciled; active Core audit archived. Authorized checkpoint commit follows. Publication is a separate remaining operation. |

No confirmed blocker remains in this selected Core scope. CR64-23–26/R1 are not
in publishedCore0.19.1: the supporting point release is still required before
module adoption resumes. Package/lock0.19.1 and SDK3.4/module-api1.6/UI3.2/roll1.0
remain unchanged. The user normally owns push/PR/squash merge/publication; this
instruction authorizes the local commit, not remote or release operations.
Unselected CG-4/6/8, advisory exclusion/status and intentional-lock policy remain
explicitly unselected. Core closeout does not close Shadowdark A01/M5 or authorize
module work. All task services are stopped and the operator's Foundry stays
untouched. Earlier pending/hold/observation statements are dated history, with
this closeout owning the current Core disposition.


## CR64-27: Normal admin access during maintenance — October 18, 2026

The operator reported that, after starting the Shadowdark 0.9.5 upgrade on
Core 0.19.2, both the client URL and `/admin` presented a separate maintenance
page with a nonfunctional administrator form. The user reconfirmed the agreed
behavior: clients see only **“SheetDelver is in maintenance”** The regular
admin interface and login remain available; authenticated administrators see
maintenance attention and review/recovery actions in the existing panel.
A maintenance page must not include a login form, admin link, world details,
progress, migration reasons or recovery instructions for clients.

### Confirmed defect and missed verification

The old standalone shell called `/admin/auth/login` and `/admin/auth/me` directly,
but the existing HttpOnly session cookie is scoped to `/api/admin`. A real browser
accepted the login response and stored that cookie, then omitted it from the
`/admin/auth/me` request. The endpoint returned 401. The shell caught that error,
cleared its state and hid the failure: the login form remained without feedback.
The same page was mounted at `/`, `/admin` and `/admin/modules`.

An isolated reproduction using the actual old shell and cookie helper confirmed
login **200 → identity 401**, no cookie on the identity request, and an empty
visible error. Earlier browser acceptance manually injected a cookie with a
broader inferred path; direct HTTP checks also supplied Cookie headers explicitly.
Those checks bypassed normal browser cookie scoping and did not establish that
an operator could sign in. Their migration/write evidence remains valid within
its recorded scope; their operator login coverage was inadequate.

### Corrected agreement and implementation

1. Preserve the ordinary Next admin route group, login component, auth provider,
   `/api/admin` proxy, HttpOnly cookie scope, CSRF, host and network policies.
   No second login, cookie workaround or replacement admin application.
2. The supervisor still drains and replaces ordinary Core and its owned process
   tree. Restricted Core retains only maintenance transport, observation,
   reviewed migration/recovery and approved admin endpoints. Player/user sockets,
   session restore, module runtime callbacks and ordinary mutation APIs remain
   stopped or fenced. The supervisor also starts the **regular Next frontend**
   so the normal admin panel remains available.
3. Next's server proxy reads the small, validated maintenance record from the
   supervisor-selected data directory before rendering player routes. During
   maintenance it returns a no-store 503 page containing only the client notice.
   Admin routes continue through their unchanged origin/host checks. Corrupt
   maintenance records stay closed for clients while admin recovery stays available.
   Already-mounted player boundaries show the same minimal notice.
4. Move exact-plan review, acknowledgement, approval, progress, resume and stop
   controls from the removed standalone shell into **Admin → Modules → Installed**,
   using the existing admin request helper, theme, buttons, plan details and drawer.
   The existing attention notice links there. Ordinary module lifecycle controls
   are not offered while the restricted controller owns the world. Cache, world,
   catalog and general audit pages retain their usual heading/navigation but show
   an availability message instead of mounting consumers of stopped services.
   Migration history remains available. This also corrects the operator's follow-up
   `CacheInfoPanel` 503/console-error report: a known maintenance restriction is
   page availability, not a failed cache fetch. Initial unknown status waits for
   the existing shared status provider before mounting those consumers.
5. Preserve server-side exact-plan identity, backup acknowledgement, write/drain
   fences and recovery rules. Reading the panel never approves, cancels or writes.
   Poll failure retires displayed review/acknowledgement; action failures remain
   visible. Logout/unmount retires responses from the old admin session.

This explicitly supersedes earlier ADR language requiring **all Next processes
to be absent** or a standalone admin maintenance shell. The requirement is to
stop gameplay/module work and protect world data, while retaining the normal
admin control plane. It does not authorize normal Core/player services to run
during migration. No native migration hook, SDK contract or module artifact changes.

### Verification and disposition

Required checks for this correction:

- Submit the real normal login form before and during maintenance, including an
  invalid password, a fresh context, refresh, and session continuity across actual
  supervised replacement. Do not inject, widen or manually forward browser cookies.
- Verify public root and deep actor/tool navigation show the one-line notice with
  no form or operator content; normal admin host/origin protections remain intact.
- Exercise the authenticated Modules panel, exact approval and cancellation UI,
  and the existing public/supervised migration workflow with source comparison.
  Confirm old user transports/module timers stop and gameplay remains unavailable.
- Run relevant Core unit/client/integration, typing and lint checks; visually
  inspect normal login and maintenance controls at narrow/desktop widths and both themes.
- Leave the operator's existing review/job and Foundry data untouched. The user
  will restart their instance and perform operator review after the fix is ready.

Implementation on `fix/maintenance-admin-login` passes the full unit, client and
integration suites, TypeScript, lint and whitespace checks. The new navigation
regression checks player root/actor/tool503 responses, normal admin routing,
admin host concealment and corrupt-record recovery access. The prior login
reproduction retains the failing200/401 sequence without injected cookies.

Final isolated supervisor/browser acceptance used the actual manager, Core and
Next with a controlled upstream. All eight320/390/820/1440 × light/dark normal
login contexts pass, including invalid-password feedback, the actual HttpOnly
`/api/admin` cookie, refresh and a pre-existing browser session surviving real
process replacement. Six other admin pages (Cache, World, Available, Updates,
Sources and Audit), Overview and Installed were navigated without failed admin
requests; restricted-service consumers stayed unmounted. The stop confirmation
survives a successful focus refresh and keyboard navigation, then dismisses with
Escape. Earlier verification exposed the focus handler clearing otherwise-fresh
status and unmounting the drawer; the correction retains fresh controls while
failed, overdue, session-retired and runtime-retired evidence still clears.

The isolated job was approved through the normal browser panel and completed
**18 unique migration writes**, with full independent source comparison, exact
receipts and a single ordinary fixture write settled before shutdown. Old user
transports/module producers stopped, player access returned503 and stale mutation
authority returned409 after activation. This is controlled upstream evidence,
not a new native Foundry acceptance claim. Final-source evidence is
`/tmp/sd-cr64-supervised-2R7wLU`; the tracked harness is
`src/tests/acceptance/adr0064-supervised.test.ts --run-isolated --complete-matrix --inventory=1,1 --online-entry --maintenance-login`
with the existing optional Playwright test installation.

The actual mounted player boundary also passes eight viewport/theme cases:
exact notice text, inert controls, nondismissible maintenance and recovery reload.
Root/deep-navigation client boxes were captured at320/1440 in both themes, alongside
eight normal login and eight maintenance-panel captures. Narrow/desktop client,
normal login and panel captures were visually inspected. No production build or
native Foundry run is newly claimed for CR64-27. All task-owned services stopped;
operator Core and Foundry were left running. The operator restarted their own
instance while reviewing; its existing Shadowdark review still has five proposed
changes. This task did not approve, cancel or mutate that review.

Core/application versions remain 0.19.2; SDK/API versions are unchanged. No commit,
push or release is authorized by this correction request. User review remains open.
The pre-amendment ADR snapshot SHA-256 is
`c3933c7db8cafa67898aebc929faef4190e11564a7baed49a819cd0e2c308976`.


### CR64-27 operator acceptance and release preparation — October 18, 2026

The user confirmed: “verified correct now” and “Also verified module migration
on production, all worked as expected.” This completes the outstanding operator
review for the normal admin login/interface, minimal client notice and migration
workflow. Production migration success is **user-reported acceptance**; it is not
relabeled as an agent-run native source comparison or a new v13/v14 matrix. The
previous isolated source/receipt, security and rendered evidence keeps its stated
scope. The earlier note that the production review had five pending changes is
superseded by this user report; this task did not execute that migration.

CR64-27 and the selected Core scope of ADR-0064 are closed. The active Core audit
is archived and the stable handoff now records release preparation. No confirmed
blocker remains in this correction. Earlier accepted Core corrections and module-
owned work are not reopened by historical pending statements.

Prepare **Core 0.19.3** with concise changelog entries for maintenance admin access,
client notice, unavailable-service panels and stable review controls. SDK3.4.0,
module-api1.6.0, UI3.2.0 and roll1.0.0 are unchanged; no module metadata or artifact
change is needed. The implementation checkpoint belongs on the approved feature
branch. Per the existing release workflow, package/lock versions stay0.19.2 in
that commit; after merge to main, `release:tag -- 0.19.3` applies the three release
metadata changes and creates the local tag. Push, PR/merge and publication remain
user-owned operations. No feature branch release tag or manual pre-bump.

Release preparation additionally passed a fresh isolated production build using
the unchanged dependency graph, generated managed configuration and CI fixture;
no Core service or Foundry connection was started. The production dependency
audit reports zero vulnerabilities. The exact0.19.3 changelog section validates
with the existing release-notes extractor. Build evidence:
`/tmp/sd-cr64-release-oc8qowxp/build.log`. Next reported filesystem-tracing warnings
through the maintenance reader's existing Core path helpers; compilation, typing
and route generation completed successfully. No new runtime acceptance is inferred
from compilation. The pre-closeout ADR snapshot SHA256 is
`a67de2453047dc2cdf6553bad40cbb23536dd16fb575a6939920885c687a8ca0`.

## CR64-28: Maintenance proxy build tracing — October 20, 2026

The user's production `npm run build` on Core 0.19.3/Next 16.3.8 succeeds but
reports four dynamic-filesystem tracing warnings. The import chain is
`src/proxy.ts` → `MaintenanceMode.ts` → `paths.ts`. Startup directory creation,
CLI path resolution and legacy-path checks consequently enter the Next proxy's
build graph. The same warnings were recorded during CR64-27 release preparation;
this is a scoped build-dependency correction, not a failed migration or a new
module requirement. The original log is retained locally as `temp/build-errors.txt`.

Decision: share a read-only `MaintenanceRecord.ts` between the Next proxy and
Core. It owns the record type, explicit-path lookup, existing validation and gate
predicate. Core's existing `MaintenanceMode.ts` entry points retain initialized
path defaults, progress overlays, writers, drain checks and runtime leases.
The proxy supplies its runtime data path and imports no startup/write helpers.
Do not duplicate parsing, hide warnings globally, remove maintenance protection
or change normal admin login, cookies, host restrictions or API routing.

Validation requires the real Turbopack production build and inspection of its
dependency traces. The new bundled-proxy regression in
`src/tests/unit/security/maintenance-navigation.test.ts` failed against the
original import graph and passes after extraction. Existing navigation checks
and added stage/drain/schema/size cases preserve player gating and normal admin
access. Existing integration tests cover Core's progress overlays and recovery.
An isolated workspace uses build-only configuration, never root `.env` or native
Foundry.

The fresh isolated build on Node 24.21.0 / Next 16.3.8 passes compilation,
TypeScript and all 13 generated pages with **zero warnings**. The actual
`middleware.js.nft.json` contains 111 files; its maps include
`MaintenanceRecord.ts` and exclude `MaintenanceMode.ts` and `core/paths.ts`.
The trace excludes runtime settings/maintenance records. No tracing suppression
or dependency change was needed.

The built production Next server also passed eight HTTP smoke states: absent
record, review, activating/serving with both drain values, corrupt record and
record removal. Runtime data deliberately differs from the build-time data path.
Maintenance returns player HTTP 503 with `no-store` and the existing minimal
notice; regular admin remains HTTP 200 and wrong-host admin remains 404.
Serving resumes only with the existing stage/drain predicate. The smoke starts
Next alone, with no Core or Foundry connection, and stops its owned process.
These are compiled-server routing checks, not a new native migration or rendered
operator acceptance claim.

Build/trace/smoke evidence is retained in `/tmp/sd-cr64-28-c240vcsa/` as
`build.log`, `trace-review.json` and `production-smoke.json`. The copied workspace
uses clean tracked source plus this correction, its own dependencies and CI
fixture, excluding unrelated pending scaffold edits and production configuration.

Scope: Core-only implementation and documentation, authorized local checkpoint;
user owns push/merge/release. Keep application and SDK versions unchanged in this
commit; the release helper owns the eventual **0.19.4** point-release metadata.
The corresponding changelog heading is prepared. The prior
ADR was saved to `temp/ADR-0064-before-cr64-28.md`. Existing independent module
release-tool/scaffold edits are outside this correction and must remain unstaged.

CR64-28 is complete on this scoped evidence. Fresh `npm run test:unit`,
`npm run test:integration`, `npm run lint`, explicit `tsc --noEmit --incremental
false`, `npm run build` and whitespace checks pass. Integration includes the
24 corrective cases, 27 complete-maintenance cases, nine migration-attention
cases and G8 regression group, including the unchanged Core progress-overlay
behavior. No new native acceptance is required for this dependency extraction;
prior native results retain their original scope. Node 22 CI remains for the PR.
Task-owned services are stopped; the operator's Foundry service was untouched.
