# ADR-0062: Observed Player Issues and Cross-Browser Isolation

**Status:** Completed — user accepted; verification limits and publication gates recorded
**Date:** October 13, 2026
**Related:** ADR-0013, ADR-0038, ADR-0049, ADR-0053, ADR-0054, ADR-0057, ADR-0059

## Administrative reconciliation — October 15, 2026

The closeout's separate publication and C6 integration prerequisites are now
fulfilled: Core0.17.1 and Shadowdark0.9.2/Mörk Borg0.8.1 shipped; the approved
main/HUD reconciliation subsequently shipped in Core0.18.0 and its compatible
module releases. The October15 operator retest reports the original presentation,
catalog-access and Assistant fixes working. This does not expand the recorded
native-version matrix. Ordinary-journal Secret and non-roll-whisper gaps remain
unfixed and are explicitly carried into proposed
[ADR-0063](0063-player-module-corrections-and-content-privacy.md).
Conditional Next-patch maintenance stays deferred until a verified replacement.
The historical pending lists below are not reopened implementation gates.

## Closeout — October 13, 2026

The user confirmed the corrections work and authorized closing this iteration
and committing its checkpoint. The implementation, regression checks, mobile
footer/gear corrections and J1 temporary journal views are complete and accepted.
Earlier pending checklists below are historical checkpoint records, not a new
request to reopen this completed scope.

Core unit/client/integration suites, typecheck and lint pass, as do the two module checkers,
eight module regressions, explicit module-source typing and isolated rendered
fixtures. C0's copied-Next dev/build tests verify cross-browser isolation while
preserving normal HMR/restart recovery. The user confirmation is operator
acceptance; it does not assert that every native v13/v14 permission/recipient
matrix case was manually repeated, or that a fresh dependency install ran.
Native test services remain paused and have not been contacted during closeout.

The following are **separate follow-ups, not unimplemented fixes in this ADR**:

- **Publication:** merge/release Core first (target 0.17.1). Mörk Borg's CI and
  release references need that published tag; then promote its provisional
  application minimum to `>=0.17.1` and validate/package against it before
  module publication. This checkpoint intentionally keeps current development
  working; it is not authorization to publish staging metadata. Core/package
  and module release versions remain unchanged. SDK 2.3.0 / UI API 2.2.0 are
  the approved additions and remain authoritative in contractVersions.ts.
- **C6 parked integration:** reconciliation with ADR-0060/0061 and SDK/UI 3.x
  is deferred until separately authorized. Inventory/review is complete;
  branch merging and participation/native tests were not performed here.
- **Existing privacy:** ordinary-journal Secret display versus raw/editor
  projection and the pre-existing non-roll private-whisper mismatch have
  bounded plans below. They were not broadened or claimed fixed by this scope.
- **Toolchain maintenance:** remove the pinned Next development correction
  only after a supported upstream fix passes the recorded regression gates.

The audit is archived, remaining work stays in the single local follow-up
queue, and the handoff records the checkpoint and release order. PR creation,
push, squash/delete merge and release operations remain with the user.

## Context and scope

The user reports that opening an incognito browser at SheetDelver's login page,
without logging in, made an existing authenticated browser reload. This
occurred under `npm run dev`; it is not an established production failure.
Additional observations cover shared images, journals, chat attribution,
combat permissions, the official module catalog, backgrounds and module layouts.
This record defines bounded corrections and investigations, not a general UI
rewrite or a new world/session manager. The user approved implementation on
October 13, 2026; the audit findings remain the design baseline.

The inspected Core baseline is `0.17.0`, on `fix/observed-player-issues` from
local `main`. ADR-0060 (completed HUD) and ADR-0061 (managed player participation,
implementation checkpointed; native acceptance pending) exist on the separate
`audit/combat-hud-player-experience` branch, not this baseline. Number 0062 avoids
reusing their numbers. Reconcile their contracts when integrating; do not copy
or reimplement their player initiative/end-turn work in this scope.

## Findings and accepted decisions

### 1. Investigate the pre-login reload before changing lifecycle behavior

The source does **not** establish a guest-open → global reload path:

- `RealtimeContext` explicitly reloads after a `serverRestarting` announcement
  and readiness polling. The server announcement comes from the administrative
  restart path in `createAdminRouter`, not ordinary player connection handling.
- `AppSocketGateway` puts a guest in the public status room and sends its initial
  status to that socket. User-session invalidation is scoped. Normal session
  replacement in `FoundryUserConnectionService.createSession` requires login;
  it does not explain a fresh guest who has not submitted credentials.
- `EngagementService` only emits return-to-engagement on zero → positive
  connections; one → two does not do so. Its reconnect policy excludes an
  already-active world. Existing tests cover both rules.
- `PlayerWorldBoundary` scopes retirement to world, user and session epoch.
  A status/roster update, React remount, module reload or Next development
  refresh must be distinguished from a new document navigation.

Local October 13 operational logs show a dev-manager start at 13:58:16 UTC,
Core start at 13:58:20, readiness at 13:58:22, then restored-user listener
attachment. At 13:59:54 new listener attachments precede Actor/module reads.
There is no second Core start/bootstrap, world transition or logged session
invalidation in that interval. The manager records SIGINT shutdown at 14:00:32.
This is evidence of renewed browser-side activity, not proof of its trigger or
which browser initiated it. File level 3 excludes debug connection events;
the physical logs do not capture Next's inherited terminal output or browser
Fast Refresh events.

The subsequently supplied dev-console capture narrows the sequence: a GET of
`/` is followed by Actor-route requests; a guest socket connects; the previous
authenticated socket disconnects, reconnects and refetches world-backed data.
No new user login is logged. This corroborates the user's browser-refresh
report independently of any Core restart.

The retained Next 16.3.8 development trace supplies stronger evidence:

- At **13:59:50.866 UTC**, `compile-path` records trigger `/` alongside a
  server compiler invalidation; client compiler invalidation follows.
- At **13:59:52.804**, `client-hmr-latency` records an update on the existing
  Actor route, including shared CSS, SDK hooks/provider, the Actor route and
  many Shadowdark components. Actor RSC requests occur in the same interval.
- An Actor-route request without the RSC query follows at **13:59:53.757**,
  then renewed authenticated listener attachment at **13:59:54**.

Thus development HMR involvement is verified, not merely a possibility.
The installed Next hot-reloader broadcasts server-component/CSS refreshes;
its client may refresh the router tree or reload the document depending on
the HMR event/error state. The capture does not identify that final distinction
or explain the breadth of dependency invalidation. The leading diagnosis is
on-demand home/login compilation refreshing the already-open Actor client,
not guest login replacing its session. An HTTP request can trigger this before
the guest's application socket connects. Do not dismiss the disruption because
Core remained healthy or because this was a development server.

**Current diagnosis:** the later debugger/protocol capture in the October 13
checkpoint review below identifies Next 16.3.8's Webpack HMR `sync` hash check
as the full-document reload path. Cold compilation alone is not sufficient;
a subsequent HMR client connection broadcasts the new hash to the existing
connection. The initial incident trace above is retained as historical evidence,
not a continuing claim that the responsible reload path is unknown.

Proposed invariant: a new guest or unrelated authenticated user must not replace
another session, retire its world scope, navigate it, or bootstrap the world.
Preserve legitimate same-user replacement, logout, authoritative world shutdown
and explicit administrator restart behavior from ADR-0057/0059.

First capture two isolated browsers with unchanged source files, comparing a
cold Actor-first → first home/login request with both routes already compiled.
Record
main-frame navigation / `performance.timeOrigin`, boundary scope changes,
app-socket reasons, restart announcements, module lifecycle events, Core PID
and world epoch. Capture dev terminal/Fast Refresh output as well as file logs;
do not log cookies, tokens, passwords or document bodies. Inspect the affected
module graph and existing `next.config.ts` watcher exclusions; runtime JSON is
already excluded, so do not claim that adding the same exclusion is a fix.
Check actual watched writes (including atomic temporary files) and shared
module/CSS invalidation before changing boundaries. Do not patch Next internals
or globally suppress legitimate source-code HMR. Compare guest open,
guest close, different-user login and intentional same-user replacement.
Repeat on an isolated production build. Record Core/module revisions, because
the reported session used the parked HUD development line, while this branch
starts at main. Correct only the demonstrated cause; if unresolved, keep this
checkpoint open rather than disabling recovery or declaring it fixed. If the
remaining behavior is demonstrated to be framework-only cold-route HMR, propose
a supported dev mitigation or an explicit user-reviewed limitation; do not
rewrite production sessions to compensate.

### 2. Restore the official catalog without weakening distribution security

`sourceProfiles.ts` uses the GitHub Pages URL; it redirects to
`https://sheetdelver.com/module-catalog/catalog.json`. Core's default host
allowlist omits `sheetdelver.com`, so the distribution client correctly rejects
that redirect. Read-only URL checks during the audit confirmed the redirect and
a successful response from the canonical host. This is a shipped configuration
mismatch, distinct from ADR-0059's installed/incompatible inventory correction.

Use the canonical custom-domain URL for the protected official profile and add
the exact host to the default allowlist. Retain the old official host for legacy
URLs. Reuse the existing protected-profile normalization while preserving enabled
state and priority. Explicit operator allowlists remain authoritative, including
an empty list: do not silently broaden them. Explain the required host in the
configuration guide and rejection message. Keep per-hop checks, public-address
validation, DNS pinning, timeouts, size limits and artifact integrity unchanged.
Correct Core's source label to SheetDelver; catalog-description and Mörk Borg
branding edits belong to the separate catalog/site repository.

### 3. Give shared media one Core host and recipient-scoped delivery

`DashboardView` mounts `SharedContentModal` inside a backdrop-filtered panel,
which can contain its fixed overlay. Its negative-top close button can leave
the viewport. Actor/module pages mount separate copies; the persistent player
layout does not own one. Per-instance presentation refs reset on navigation,
and the dismissal storage key is not world/user scoped. Journal shares delegate
to `JournalModal` without the image modal's dismissal path.

There is also a related delivery risk, not just a CSS problem. Core currently
keeps one global `SharedContentStore`, fans it to authenticated sockets, and
returns it from `/api/shared-content` without recipient selection. Inspected
Foundry v13/v14 sharing code delivers selected-user shares to those users' sockets;
the relayed image omits its recipient list, and journal relay carries UUID/force,
not the original recipients. A service-account receipt cannot authorize all
players. A selected player may receive nothing through the service-account-only
path; a share addressed to the service account could be fanned beyond its
recipients. This is a source-backed risk, not an observed disclosure incident.

Proposed correction:

1. Receive neutral share events through the existing authenticated per-user
   Foundry transport and orchestrate delivery in server services. Keep the
   latest presentation envelope scoped to world and recipient session; the
   snapshot route and socket event must enforce the same scope. Do not infer
   public audience from missing recipient fields or fan out service-account
   receipts. Deduplicate transport/listener delivery and clear scope on terminal
   teardown. Confirm v13/v14 wire behavior in isolated tests before shipping.
2. Mount one host under the persistent `PlayerWorldBoundary`, outside page
   filter/transform containers. Reuse Core dialog/focus/Escape conventions with
   a viewport-bounded header, close control and image area. Keep Core theme
   defaults and intentional SDK component overrides; no module DOM escape hatch.
3. Keep presentation/dismissal state for the scoped share across route changes;
   closing an image or delegated journal acknowledges that share. An explicitly
   new share may open again. This is bounded ephemeral presentation state, not
   persisted Foundry content or indefinite share history.
4. Inventory existing SDK `SharedContentModal` consumers. Prefer a compatible
   delegate to the single host, with no duplicate presentation. If removal or a
   new required lifecycle contract is needed, review SDK versioning and module
   migration before editing; do not silently break installed modules.

Journal sharing must still pass entry/page authorization. Do not turn Foundry's
`force` flag into global document ownership or an unreviewed privileged read.
Unsupported force-only visibility should fail clearly; temporary permission
parity would require a separate, explicit authorization design.

### 4. Render authorized journal image pages

`JournalModal` renders `text.content` regardless of page type. The service
already filters visible pages and carries image data, so an authorized image
page becomes a false blank-page message. Add typed image-page presentation
using the existing asset resolver, caption handling and error/loading states.
Keep sanitized text rendering and text-only editing. Unsupported media types
get an explicit message, not a blank text editor. Sharing a JournalEntryPage
should select that authorized page rather than lose its UUID suffix.
No Observer threshold reduction, server-side arbitrary URL fetch, or broader
journal cache exposure is permitted.

### 5. Reconcile small Core presentation inconsistencies

- **Chat/dice:** replace the confusing mixed example placeholder with clear
  chat/roll guidance. `GlobalChat` currently supplies no Actor speaker context,
  although DiceTray/ChatTab accept a speaker. Resolve the open Actor through
  the authorized route context; use its speaker on the sheet and the user's
  default identity elsewhere. Preserve the actual message author and roll
  visibility. Do not trust a client-supplied Actor ID as authority to impersonate
  an unowned Actor. Clear context when navigating, switching world or logging
  out; reuse the Core pipeline rather than add module-specific tray behavior.
- **Participants:** distinguish Assistant GM from full GM in labels. Exclude the
  resolved service-account identity from the human participant presentation and
  its counts, not from canonical UserStore, document authorization or chat
  history. Use the resolved ID, never a hardcoded name. Audit login projections
  for consistency, but do not change login eligibility merely to hide a row.
- **Stat picker:** field identity is already path plus kind; duplicate-looking
  labels can be distinct source/prepared fields or resource/scalar views. Show
  enough path/source/kind context to distinguish them. Do not merge by label,
  drop selectable fields or invalidate saved selections. Preserve bounded
  discovery and module-neutral behavior. Module suggestions are separate below.
- **Backgrounds:** propose active world artwork → Foundry default artwork →
  Core palette when unavailable/failed, consistently on Core dashboard/tools.
  Stop selecting system artwork or default-scene artwork as the implicit Core
  fallback. Setup/closed screens remain Core palette with no stale world image.
  This explicitly revises the earlier no-world-art Core-blue fallback in
  ADR-0049/0053, per the new reported preference; module-owned sheets/tools and
  explicit component themes are not overwritten. Use a shared resolver/hook.
- **Floating tools:** hiding other tools while one is active is intentional,
  not Assistant-role filtering. Retain the consolidated menu; propose a clear
  “Back to tools” affordance and accessible focus return. An always-expanded
  toolbar is not required by this defect report.

### 6. Allow Assistant combat management only within native permissions

The user permits changing the role-4-only ADR-0049 rule **only if Foundry allows
assistants to manage combat**. Source inspection of Foundry v13.351 and v14.367
supports that condition: `User.isGM` includes Assistant; Combat inherits
Assistant create/delete and accepts GM-like updates. Foundry's
[combat guide](https://foundryvtt.com/article/combat/) also documents Assistant
turn control. [User permissions](https://foundryvtt.com/article/users/) are
configurable, so combat authority is not proof that every ancillary operation
is permitted.

Admit assistants to the manager, while checking document capabilities for
Actor copy/update/delete, compendium access, Folder create/cleanup and Combat
operations. Actor creation depends on `ACTOR_CREATE`; wildcard image operations
also depend on `FILES_BROWSE`. Use caller-bound transports, never service-account
fallback writes. Denials must not cause silent partial creation or cleanup;
preflight predictable failures and retain the existing partial-write reporting.
Shared stat configuration is a Core feature, with no native equivalent; the
proposal makes it available to authorized managers with the same server checks
and realtime invalidation audience as the manager, not all authenticated users.

The user's clarified rule is to follow **Foundry's permission for the actual
document operation**, including any limit it imposes. Assistant is GM-like for
many operations, but this is not an unconditional grant to every document or
every kind of private content. No further product choice between blanket GM
access and manager-only bypasses is needed. The implementation follow-up below
records C4's applied boundaries; native acceptance remains pending.

Native source matrix (v13.351/v14.367):

| Operation | Native boundary | Required implementation/test |
| --- | --- | --- |
| World Actor ordinary ownership | `Document.testUserPermission` grants OWNER to `User.isGM`, including Assistant; `getUserLevel` reports stored ownership | Align Actor reads/updates and their audiences with effective capability; an explicit NONE ownership entry does not remove this native Assistant capability. |
| Combat create/delete and update | Base Document create/delete requires Assistant; Combat update accepts `user.isGM` | Admit Assistant throughout manager routes, projections, UI and realtime; preserve player/trusted denial. |
| Actor create/copy and wildcard token images | `ACTOR_CREATE` and, for wildcard images, `FILES_BROWSE` | v13 checks explicit user permission before role settings; v14 checks mandatory `requiredRoles` first. In v14 both permissions are mandatory for Assistant/GM, so a false override is not a valid revocation test for that role. Exercise v13 revocation and v14 mandatory-grant behavior separately. |
| Compendium access | v13 pack `testUserPermission` grants OWNER to `user.isGM`; v14 grants the unconditional override only to full GM and evaluates Assistant through the pack's role map | Use the active Foundry generation, pack configuration and requested read capability; no service-cache bypass of caller access. |
| Folder create/delete and update | Base Document Assistant role / effective OWNER rules | Include provision, rename, cleanup and partial failures, using the caller's transport. |
| Chat content and journal pages | Document ownership and content presentation are distinct. Native `ChatMessage.visible` / `isContentVisible` retain author/recipient rules even for GMs; journal pages have their own ownership/inheritance | Do not turn the ordinary OWNER shortcut into access to every private whisper or roll result, or accidentally change page projections while fixing combat. |

Implementation sequence:

1. Inventory every consumer before changing `getEffectiveOwnership` or the
   strict `isGM` helper. Current shared-helper consumers include Actor, Item,
   Scene, Cards, Macro, Playlist, RollTable and Journal Stores, plus ActorService
   and the manager's player-owner classifier. Combat/Folder use separate strict
   short-circuits; journal pages and chat have special policies. Keep stored
   ownership, native operation capability, presentation visibility and
   SheetDelver administration separate. A shared correction requires tests for
   all affected consumers; do not grant a fake role or use unfiltered Store
   reads to work around authorization.
2. Add the smallest reusable, source-backed capability checks needed by the
   manager's Actor/Combat/Folder/pack operations, with explicit v13/v14 cases.
   Read current User, Setting and pack state, rather than retaining permission
   snapshots from login. Native Foundry remains the final write authority.
3. Apply that policy consistently to manager entry points, shared preferences,
   Actor selection, linked/copy edits, provisioning/cleanup, turn/initiative
   commands, HTTP projections and invalidation audiences. Changing only the
   two page thresholds is insufficient. Keep app-admin and world-settings
   authority unchanged.
4. Test roles 0–4, private world Actors, hidden combatants, pack restrictions,
   version-correct permission changes, role downgrade, complete and partial
   cleanup, preference fan-out and SDK readers affected by any shared helper.
   Verify native operations on approved isolated versions before accepting C4.

The broader chat-visibility discrepancy found during consumer review is recorded
below as a separate existing behavior. C4 must not amplify it through a global
role substitution; any correction beyond the manager's dependencies needs its
own bounded review.

October 13 implementation clarification: the user reaffirmed that the relevant
document policies must match Foundry, after automatic approval review rejected
an Actor authorization patch as broader than the manager. Native world Actor
OWNER capability applies to Assistant reads/updates through sheets and SDK
readers as well as manager requests; a default-private encounter copy cannot be
managed consistently otherwise. Apply that explicit Actor policy and native
Combat/Folder capabilities at their Stores and authorized projections. Keep the
legacy shared ownership helper unchanged, so this correction does not silently
alter Item/Scene/Journal/Chat or administrative policies. Test the changed
Stores, ActorService, SDK readers, manager operations and realtime audiences;
record remaining type-specific discrepancies separately. Pack access and
Actor-create/wildcard checks remain version-specific native limits.

### 7. Keep module corrections module-owned

Companion work requires approved module branches; current HUD module branches
must not be repurposed without permission. No system-name conditionals in Core.

- **Shadowdark:** fix tablet word-breaking in the simplified header; reproduce
  the generated wizard's repeated “Light spell” gear against actual Item types,
  IDs and provenance before deciding whether generation or rendering is wrong.
  Do not delete name-matching Items. Add useful `combatTracking.attributes`
  suggestions through the existing manifest contract, verified for Player/NPC
  prepared shapes. Preserve GM overrides and declare the contract minimum
  required by that existing surface (module-api 1.3), not an invented SDK hook.
- **Mörk Borg:** give the fixed mobile tab bar an opaque module-themed backdrop,
  sufficient content clearance and safe-area spacing; prevent overlap with the
  Core tool dock. Let weapon metadata wrap instead of being silently clipped.
  If reusable dock-clearance information is genuinely missing from the SDK,
  review a small additive contract before implementation, not private imports.
- **Capture art:** permission-only art is a publication/provenance review item,
  not a reason to replace users' Actors or system art. Use assets cleared for
  the intended screenshots; no legal conclusion is made here.
- **D&D 5e derived values:** acknowledged experimental limitation, explicitly
  deferred. Do not revive the parked native preparation-runtime experiment.
- **Managed player initiative/end-turn:** owned by ADR-0061, not this ADR.

## Implementation checkpoints and acceptance

Each checkpoint needs focused regressions, a reviewable diff, documentation of
actual outcomes and separately authorized commits. The list is a proposed order,
not permission to perform live tests, Git operations or releases.

| Checkpoint | Deliverable | Required evidence |
| --- | --- | --- |
| C0 | Cross-browser development-refresh diagnosis and bounded correction | Debugger/protocol capture identifies Next Webpack HMR broadcast `sync` plus stale hash comparison. Validate a supported toolchain correction against cold compilation followed by a new HMR connection, warm visits and built mode; preserve source-edit HMR and legitimate restart/session controls. A development limitation requires explicit user acceptance. |
| C1 | Catalog URL/default-policy repair | Default config, persisted official profile, legacy redirect, explicit allowlist denial, malicious/private redirect rejection, install/update discovery; no runtime imports of incompatible packages. |
| C2 | Scoped shared-media delivery, one overlay host, journal image pages | GM plus two distinct players plus guest; public and selected shares including a share to service account only; HTTP/socket agreement, no cross-recipient metadata, journal page permissions, navigation/dismiss/re-share, terminal teardown; tall/wide images and keyboard dismissal. |
| C3 | Dice speaker/placeholder, participants, stat labels, Core background/menu consistency | Sheet/dashboard navigation, author versus speaker, public/private rolls, accurate roles/counts, distinct selectable stat paths, preserved saved prefs, world/setup transitions, light/dark and explicit module theme overrides. |
| C4 | Native-parity Assistant manager access | Player/trusted denied; GM/Assistant matrix over complete manager lifecycle and shared settings; v13 permission revocation versus v14 mandatory role grants, wildcard/pack restrictions, private documents, cleanup, role downgrade, HTTP and socket audiences; v13/v14 native checks in approved fixtures. |
| C5 | Approved Shadowdark/Mörk Borg companion corrections | Module tests plus 390×844 and 820×1180 browser review, generator Item fixture comparison, suggestions with/without GM overrides, dock overlap/keyboard/scroll checks. |
| C6 | Integration, documentation and user review | Reconcile parked HUD/participation work without duplicate gates or contract-version rollback; regressions and user checks, then checkpoint/closeout only with approval. |

Use existing unit suites as baseline, adding regression cases at the affected
boundaries rather than a second session framework. Run `npm run test:unit`,
`npm run test:client`, `npx tsc --noEmit`, `npm run lint`,
`npx tsx src/tests/unit/docs/adr-metadata.test.ts` and `git diff --check` during
implementation. Rendered/native tests use isolated data/settings and an
explicitly approved Foundry instance; do not start the production-connected
root dev command as a test. The user's current Foundry use takes precedence.

Update `docs/architecture.md` and `docs/UI.md` for overlay/context ownership;
`docs/API.md` for media scope, journal shapes and manager authorization;
`docs/CONFIGURATION.md` and `docs/MODULE_CATALOG.md` for canonical distribution;
module/SDK guides only if their contracts change. Keep module details in their
repositories. Add terse changelog feature snapshots only for implemented work,
then update handoff with evidence, outstanding tests and retained processes.

## Audit validation and unresolved limits

Existing offline engagement, app-socket gateway, player-boundary policy,
public-distribution and journal smoke tests passed October 13. They validate
their current fixtures; they do not reproduce the reported incognito reload,
prove targeted-share isolation, or validate native Assistant writes. No live
service was started, production configuration changed, or world data mutated.
This paragraph records the initial audit limits; subsequent implementation and
review records below supersede its open investigations. The approved
background/menu/shared-setting choices remain bounded
to this ADR; offline implementation is not a substitute for user/native checks.

## Implementation record

### October 13, 2026 — C0 diagnosis, acceptance still open

The retained development trace contains exactly one first compile of `/` in
the incident interval, followed by a client HMR update on the existing Actor
route. Installed Next 16.3.8 documents `next dev` HMR and on-demand page entries;
the manager uses `next dev --webpack`, while production uses `next start`.
No Core world/session invalidation or second bootstrap appears in the supplied
logs. This narrows the cause to development compilation/HMR, but does not yet
prove whether the Actor document navigated, whether a warm `/` open repeats it,
or how a production build behaves under the same browser sequence. No session
or watcher change was made on that incomplete evidence. C0 remains open for
the isolated cold/warm/built browser comparison and a user-reviewed decision
on any dev-only mitigation.

### October 13, 2026 — C1 catalog source checkpoint

Core's protected official profile now points directly to the canonical
`sheetdelver.com` catalog and uses the SheetDelver brand. The default distribution
allowlist includes that exact host while retaining the legacy GitHub Pages host;
an explicitly configured list still overrides the defaults, including `[]`.
Existing persisted official enabled/priority settings survive normalization.
Configuration and catalog guides now state the canonical URL. Offline profile,
distribution-client and catalog-service tests pass, as does `git diff --check`.
The broad typecheck remains pending at this checkpoint because the parked
Shadowdark HUD branch imported an SDK 3 type unavailable on Core main; separate
module branches were approved and created without changing that parked work.
This is not a catalog failure. Live install/update discovery remains for C6.

### October 13, 2026 — C2/C3 offline checkpoint

Shared image/journal ingress no longer turns a service-account or another
user's receipt into a global broadcast. `AppSocketGateway` listens to each
authenticated user's Foundry transport, stores a per-session/per-world snapshot,
and emits only to that browser socket. The protected snapshot route uses the
same scope and rejects service-bearer presentation reads. Session and world
teardown clear snapshots. A persistent player-layout host replaces page-local
image overlays; SDK `SharedContentModal` is an inert compatibility delegate.
Journal shares retain a page ID and `JournalModal` renders authorized image
pages, reports unavailable pages/media, and limits editing to text pages.
An offline two-user-plus-guest gateway fixture now verifies distinct recipient
snapshots and no browser cross-fan-out. Native Foundry recipient/wire behavior,
image-size browser review, and journal sharing remain for C2 acceptance;
gateway/store tests pass.

Core presentation now distinguishes Assistant/full GM labels, marks the
resolved service account for participant-only filtering, shows stat paths/kinds,
offers an explicit Tools return control, clarifies the dice placeholder, and
uses one Core background resolver with world-art → Foundry-default → palette
fallback. Actor-route chat/dice can request a speaker from an owned Actor;
the server rejects unowned Actor IDs and retains the authenticated author.
Browser theme/layout and public/private roll acceptance remain open. Typecheck
and focused gateway, utility, catalog, chat and lint checks passed. No live
world was contacted.

### October 13, 2026 — C5 offline module checkpoint

The approved separate Shadowdark and Mörk Borg branches retain the parked HUD
branches intact. Shadowdark's simplified title uses viewport-scaled type without
word breaking. Source inspection established that Light's `Spell` description
links three distinct official `Basic` light-source templates; the shared
enricher had converted all three links into starting Gear. Spell-description
links no longer create inventory Items, while talent-grant links still do.
Shadowdark now declares existing `combatTracking.attributes` suggestions and
the documented module-api 1.3 minimum; saved GM preferences retain precedence.
An official Lizardfolk NPC source-shape fixture exposed an AC projection error:
prepared NPC AC now honors its explicit monster value instead of 10 + DEX.
Mörk Borg's mobile nav has an opaque SCVM-styled backdrop above Core's dock and
extra content clearance, and weapon/armor metadata wraps. Both module Actor
pages defer shared overlays to Core's persistent host. Module prepared and
presentation checks, the new spell-link fixture, and Core typecheck pass.
Rendered 390/820px review, fresh wizard, dock/keyboard checks and
native acceptance remain before C5 can be marked complete.

### October 13, 2026 — C6 integration inventory

Read-only branch comparison shows the parked ADR-0061 Core line also changed
the player layout, Combat Manager page and App Socket gateway. Each must be
reconciled with this branch's single media host, stat/UI changes and scoped
share listener when the user authorizes integration. Shadowdark and Mörk Borg
HUD branches both change `info.json` and README relative to their current main;
merge their SDK 3 compatibility metadata with these module fixes rather than
resetting either side. No branches were merged or HUD work copied here.

### October 13, 2026 — review and checkpoint, no code revisions

The user requested a review and checkpoint of the existing implementation,
with documentation revisions only. The following checks distinguish implemented
and offline-tested work from acceptance; this ADR remains open.

- [x] C0 incident logs/source reviewed; first home compilation and Actor HMR
  recorded. No evidence of another Core bootstrap/session replacement.
- [ ] C0 cold/warm dev and built-mode comparison; demonstrated correction or
  explicit acceptance of a supported development limitation.
- [x] C1 canonical catalog/default host correction and offline policy tests.
- [ ] C1 live install/update discovery with the default and custom policies.
- [x] C2 recipient-scoped delivery/store, persistent host and journal image
  implementation checkpoint; offline recipient-isolation checks pass.
- [ ] C2 review findings R1–R4 below and native/browser acceptance.
- [x] C3 speaker authorization and presentation changes reviewed; offline checks.
- [ ] C3 sheet/dashboard rolls, themes, background transitions and menu review.
- [x] C4 native source/consumer review and clarified operation-specific plan.
- [ ] C4 implementation, complete authorization matrix and native acceptance.
- [x] C5 Shadowdark/Mörk Borg corrections and existing module tests reviewed.
- [ ] C5 release compatibility R5, fresh wizard and responsive browser review.
- [x] C6 parked-branch overlap inventory and documentation checkpoint.
- [ ] C6 branch reconciliation, final user acceptance and closeout.

Review findings to resolve before acceptance:

| ID | Evidence and impact | Required follow-up |
| --- | --- | --- |
| R1 — image re-share | `SharedContentHost` resets `imageState` to loading for each new share, but reuses the same image element and `src`. Re-sharing an already-open identical URL need not fire another load event, leaving it hidden behind “Loading image”. | Tie media loading to the actual asset/share lifetime; test identical re-share while open, after dismissal, and rapid different-image replacement. Source finding; browser reproduction pending. |
| R2 — image/journal handoff | A new image replaces `activeShareKey` but leaves the previous shared journal open. Journal reads reject stale responses by entry ID only, so two shares of different pages of the same entry can race. | Keep one active shared presentation and its acknowledgement identity; guard asynchronous journal reads by request/share identity. Test journal→image→journal and rapid same-entry page shares. |
| R3 — dialog/dismissal lifecycle | Image dialog supports Escape but has no focus containment/restore; journal has no Escape handler. Dismissal writes a new `sessionStorage` key per share without pruning or handling storage failure. | Apply existing Core keyboard/focus conventions and a bounded, failure-tolerant scoped dismissal record; test keyboard-only close, route changes, re-share and storage denial. No new modal framework required. |
| R4 — snapshot ordering/coverage | Share ingestion attaches/detaches with each browser socket. A user's retained Foundry transport receives no snapshot updates while no app listener is attached. `FoundryContext` also replaces state with a late HTTP snapshot even if a newer realtime share arrived meanwhile. | Establish latest-share ordering across HTTP/socket delivery and bind receipt to the intended session lifetime, without global fan-out or adding share history. Test delayed HTTP, disconnected/reconnected browser, multiple tabs and retirement. The checkpoint does not promise offline replay. |
| R5 — companion module compatibility | Both modules remove their own SDK shared-media mount, but still admit older Core releases without the new layout host (Shadowdark ≥0.15.1; Mörk Borg ≥0.14.2). Such combinations lose sheet-page shared media. | Before release, retain the SDK compatibility mount or require the Core release containing the host. Record and validate the selected release minimum; do not publish these branches with the gap. |

An additional **pre-existing C4 review finding**, outside the new diff:
`ChatMessageStore` grants full GMs raw access to every non-roll whisper, and
`ChatService` uses that access to include ordinary whisper contents. Native
v14 `ChatMessage.visible` allows non-roll whispers only to author/recipients.
Ordinary document ownership is therefore not sufficient evidence for chat
presentation parity. The existing roll-content masking is a separate path.
Record this for a bounded privacy correction; do not broaden the same behavior
to Assistants while implementing C4. No live disclosure was tested or claimed.

Validation rerun at this checkpoint: full Core unit and client suites,
`npx tsc --noEmit`, lint, and Shadowdark prepared/presentation/enricher plus
Mörk Borg prepared/presentation tests all pass. Those suites do not render the
new media components or prove native permissions, so they do not close the
findings above. No code was revised in this review and no live service was
started, stopped or contacted. Checkpoint commits preserve the work for the
next implementation pass; they are not release/acceptance approval.

### October 13, 2026 — R1–R5 and C4 implementation follow-up

- [x] R1: each image receipt remounts only its loading-state/asset owner,
  including an identical cached URL. Old image callbacks belong to the retired
  instance; the dialog retains its focus lifetime across replacement.
- [x] R2: image/journal replacement clears the prior presentation. Journal
  reads and save refreshes use a request revision; a closed or superseded
  same-entry request cannot select an old page or restore the old dialog.
- [x] R3: image and journal dialogs share Core keyboard/focus handling, including
  Escape, Tab containment and focus restoration. Dismissal uses one bounded
  per-tab storage record; denied storage falls back to in-memory dismissal.
- [x] R4: `FoundryUserConnectionService` attaches `SharedContentIngress` once
  for the user-session lifetime and removes it on retirement. The Store keeps
  one latest receipt for that session/world even between browser connections.
  The gateway subscribes to scoped Store changes; multiple tabs do not install
  duplicate upstream receipt listeners. Stream/sequence ordering and a local
  receipt revision prevent delayed HTTP replies from replacing newer realtime
  delivery or retired state. No service-account receipt is fanned out.
- [x] C4: ActorStore/ActorService now resolve native Assistant world Actor
  operation capability; Combat/Folder Stores and manager UI/routes/projections
  admit Assistant. The shared ownership helper and other type-specific
  chat/journal/settings policies are unchanged. Copy/pack preflights use current
  release, User, Setting and pack data. Dispatches and durable preference
  writes recheck current authority, use caller transports and retain partial
  failure/retry reporting. Realtime Actor/Combat/Folder audiences follow the
  changed Store policies; preference invalidation includes current Assistants
  and stops after downgrade.
- [x] R5 media compatibility: Shadowdark/Mörk Borg retain their SDK media mounts
  for older compatible Core releases; the new Core component remains inert. Review
  additionally found Shadowdark's already-required module-api 1.3 was absent
  from its pinned Core 0.15.1 toolchain (module-api 1.2). The first released
  implementation is Core 0.16.0, verified against its tracked contract authority.
  The user approved **Core 0.17.0** for Shadowdark's minimum and CI/release pins;
  the future 0.18.0 HUD reconciliation is separate. Isolated released 0.16.0
  and 0.17.0 checks also exposed module-local Actor/roll typing errors hidden
  by the root `data/` exclusion, not an SDK version difference. Module-owned
  hook types, the existing random-gear table's array guard and concrete test
  assertions now respect the neutral SDK bags without widening Core's SDK or
  changing roll formulas. Mörk Borg stays at 0.14.2; its card resources likewise
  use module-owned types and reject non-scalar Silver values. Application,
  SDK/API and module release versions were not bumped.
- [ ] C2/C4/C5 native and user acceptance. These implementation checks do not
  substitute for v13/v14 caller-bound writes and browser recipient checks.
- [ ] C6 integration with parked HUD/participation branches remains separately
  authorized work. Follow-up changes on this branch and both companion branches
  remain uncommitted after the previously recorded checkpoint commits.

Offline regressions cover recipient isolation, independent session receipt,
duplicate/current receipt identity, delayed/empty/cross-stream HTTP replies,
retirement, bounded/denied storage, GM/Assistant/player/trusted/banned roles,
private Actors, hidden participants, pack restrictions, native version-specific
copy permissions, shared preferences, SDK Actor readers, ActorService,
invalidation audiences, role downgrade before writes and during a health batch,
and interrupted cleanup retry. Unrelated private chat/journal/Item/Setting
policies are asserted unchanged. The isolated browser fixture renders the actual
media components and verifies cached re-share, focus/Tab/Escape, image/journal
handoff, same-entry page races and closing before a late response. It connects
to no Core or Foundry service. Full validation results are recorded at the final
checkpoint below after the remaining checks finish.

The existing non-roll whisper presentation discrepancy has a **bounded follow-up
plan**, not an implementation in this pass: compare ordinary whisper visibility
for author, selected recipients, full GM, Assistant and unrelated player; separate
that content decision from raw document operation authority; correct ChatService
list/detail DTOs and non-roll delivery audiences together, preserving distinct
roll placeholders/result rules. Review SDK/raw-reader consequences before any
Store policy change. C4 does not extend the existing full-GM behavior to Assistants.

### October 13, 2026 — C0 isolated reproduction and mitigation trial

An actual copied Next/Shell checkout with copied local modules, a local mock
API/socket server, two isolated browsers and mocked local fonts reproduced the
incident without starting Core or contacting Foundry. Source files remained
unchanged throughout each run. After an authenticated Actor page settled:

| Mode / trigger | Existing Actor document | Result |
| --- | --- | --- |
| Next 16.3.8 `dev --webpack`, first cold homepage guest visit | `performance.timeOrigin` changed; three main-frame navigation notifications | Reproduced full development document reload, with Fast Refresh output; the Actor URL and mock session identity remained unchanged. |
| Same development run, repeated warm homepage visit | No navigation or time-origin change | Stable. |
| `build --webpack` / `next start`, first and repeated homepage guest visits | No navigation or time-origin change | Stable. |
| Fresh development run, plain homepage GET before the Actor browser opens | No navigation or time-origin change on first or repeated guest visit | Supported homepage-prewarm trial passed for the demonstrated cold-start sequence. |

This confirms cold-route compilation/HMR as the demonstrated trigger, rather
than login/session replacement. It does not prove all framework refresh behavior
or later entry-eviction behavior is solved. The user chose **keep C0 open for
deeper investigation**, not a startup prewarm. No startup, Next configuration
or lifecycle change was applied. Next investigation should capture the HMR
message and client bailout/module graph responsible for the cold compilation,
including later entry eviction, while preserving normal source-edit HMR and
production lifecycle behavior. C0 correction/acceptance remains open. The
failed initial fixture attempts involved mock font/status
setup and are not application regressions. Temporary fixture processes were
stopped; the user's existing services were untouched.

### October 13, 2026 — final offline verification and remaining acceptance

- [x] Full Core unit/client suites, typecheck and lint pass after the follow-up.
- [x] Both current local modules pass `module:check`, including typecheck,
  scoped CSS and logic/UI/server dry bundles.
- [x] The actual media-component browser fixture passes two consecutive runs
  after correcting return-focus loss on identical-image replacement: the
  dialog stays mounted while its asset/loading owner changes. Cached re-share,
  Tab/Escape/focus, denied storage, image/journal handoff, reversed same-entry
  responses and late-close checks pass without a Core/Foundry connection.
- [x] R5 target decision: user approved released Core 0.17.0; Shadowdark's
  manifest and validation/release workflows agree. Released-baseline checks
  are required in addition to the root check.
- [x] Archived Core 0.17.0 + Shadowdark checker, five module regressions and
  package build pass. Archived Core 0.14.2 + Mörk Borg checker, three regressions
  and package build pass. Both fixtures use isolated data and existing installed
  dependencies, not a fresh CI `npm ci`; no service or workflow was launched.
- [ ] C5 responsive and fresh wizard acceptance; no module was published.
- [ ] C0 deeper investigation; native C2/C4 checks remain paused pending fresh
  scoped approval. Do not equate offline tests with native/user acceptance.
- [ ] C6 parked-branch reconciliation and final user review. No staging, commit,
  branch mutation or remote operation occurred in this follow-up pass.

User/native acceptance checklist (run only on a user-approved environment):

1. Assistant and full GM: create/rename an encounter, link a private world
   Actor, copy two NPCs, edit HP, hide/defeat, begin/reset/roll initiative and
   delete/clean up. Shared stat choices update both managers; linked world
   Actors survive cleanup. Player/trusted users have no manager access. A
   role downgrade stops subsequent writes and preference invalidation.
2. Version-specific limits: native-denied v14 packs cannot be selected/read;
   v13 revoked `ACTOR_CREATE`/wildcard `FILES_BROWSE` fails before copies land.
   Do not expect a false v14 override to revoke mandatory Assistant/GM grants.
3. GM, two players and a guest: all-recipient versus selected-player images and
   journal pages appear only for authorized recipients. A share to the service
   account alone does not reach players. Nonrecipient HTTP snapshots expose
   no share. Unsupported force-only page visibility remains a stated limit.
4. Re-share an identical image while open and after dismissal; replace image
   with journal and back; rapidly share two pages of one journal. Test Tab,
   Escape and focus return, route navigation, tall/wide images and failed loads.
   Disconnect/reconnect a browser while its user transport is retained: only
   the latest receipt returns. Logout/new world must clear prior presentation;
   same-session tabs must not multiply upstream listeners.
5. Core: sheet chat/dice uses the owned Actor speaker, dashboard uses the user;
   author and public/private roll visibility stay correct. Verify participant
   labels/counts, stat-path labels, Tools return, light/dark and world/setup art.
   Official catalog discovery succeeds with defaults; explicit deny/empty
   allowlists stay authoritative.
6. Shadowdark: fresh Light-spell wizard has no three description-linked Gear
   additions, NPC AC/default stat suggestions are correct, GM overrides survive,
   and 390/820px titles fit. Mörk Borg: opaque mobile tabs, long weapon/armor
   wrapping and open/closed Core dock work without changing its sheet palette.

C0 is deliberately not an acceptance claim or startup mitigation; C6 remains
separately approved integration work. Keep this ADR open until the outstanding
acceptance and C0 disposition are actually resolved.

### October 13, 2026 — authorized checkpoints and C0 protocol diagnosis

The user authorized committing current work before a **no-application-code**
review. Core and both companion modules were checkpointed on their existing
`fix/observed-player-issues` branches. No branch switch, remote operation,
version bump or native Foundry test was performed. Later audit/documentation
revisions are separate from those implementation checkpoints.

- [x] R1–R4/C4/R5 source review against the implemented boundaries and tests.
  Core unit/client suites, typecheck, lint and ADR metadata pass again; the
  actual-component media browser fixture also passes. Existing module
  released-baseline validation remains applicable to their unchanged source.
- [x] C0 exact development reload trigger captured, including its client
  debugger stack, HMR messages, uninterrupted existing HMR connection and
  changed document time origin. This is diagnosis, **not a correction**.
- [ ] C0 supported correction or explicit acceptance of a documented
  development limitation. No prewarm, dependency/bundler change, Next patch,
  or SheetDelver lifecycle workaround is implemented.
- [ ] The six user/native acceptance checks above, including v13/v14 caller
  writes and recipient wire behavior, still need their recorded evidence.
- [ ] C6 parked-branch reconciliation still requires separate approval. No
  implicit merge or contract rollback follows from this checkpoint.

#### Exact mechanism and controls

Application manifest, lockfile and installed package all specify **Next
16.3.8**. The isolated copied app/modules ran against mock HTTP/Socket.IO only;
source files were unchanged, no user credentials/configuration were copied,
and no Core or Foundry service ran in the fixture.

1. The Actor browser receives initial HMR `sync` with compilation hash **A**.
2. The first homepage request causes on-demand compilation. The Actor receives
   `serverComponentChanges` and `built` with hash **B**, applies Fast Refresh
   successfully and reports its HMR latency. There are no compile errors.
3. When the new browser's **Next HMR** connection attaches,
   `server/dev/hot-middleware.js`, `WebpackHotMiddleware.onHMR`, calls
   `publish(sync)` rather than sending only to the joining client. Thus the
   existing, still-open connection receives another `sync`, now with **B**.
4. `client/dev/hot-reloader/app/web-socket.js:86–90` compares that hash with
   `mostRecentCompilationHash`, which this handler updates on `sync` but not
   on ordinary `built` messages. It still holds **A**. The debugger stops at
   `handleMessage` → `window.location.reload()` with these two different hashes;
   the browser records a reload navigation and a new `performance.timeOrigin`.
   The old HMR/application sockets close **after** this call, not before it.

This is not a SheetDelver `serverRestarting` announcement, user replacement,
world teardown, connection-count policy, or a React component error bailout.
It also explains the absence of Next's `client-full-reload` warning: this
hash-check path does not go through `performFullReload`.

An HTTP-only control compiled the cold homepage after the Actor was open:
Fast Refresh occurred, but document time origin stayed unchanged and the HMR
connection stayed open. A repeated warm HTTP request was also stable. Opening
a guest browser on that **already compiled** homepage afterward produced the
hash-check reload, with no additional compilation between the HTTP control
and its HMR connection. A read-only test of the installed Next middleware,
using fake compilers/clients,
independently confirms `sync(A) → built(B) → sync(B)` reaches the original
client when the second client attaches. Ordinary warm browser visits after
the reload are stable because the refreshed browser starts at hash B. Earlier
built-mode controls remain stable and do not contain development HMR.

The shared CSS/SDK/module update list records what Fast Refresh successfully
applied; its breadth does not establish a broken SheetDelver module boundary.
No such refactor is justified by this evidence. Later entry eviction or a
source edit could supply another compilation hash (an inference, not a tested
eviction claim); prewarming only the homepage cannot promise general protection.
The inspected [upstream client](https://github.com/vercel/next.js/blob/canary/packages/next/src/client/dev/hot-reloader/app/web-socket.ts)
and [middleware](https://github.com/vercel/next.js/blob/canary/packages/next/src/server/dev/hot-middleware.ts)
still show the relevant pattern at review time. No fixed released version was
established; do not claim a blind dependency upgrade resolves it.

#### C0 corrective action — scope initial HMR synchronization to its client

**Status: user approved continuation; version-pinned correction implemented and
offline-validated. User acceptance remains pending.**
The preceding review identified the cause but did not implement a mitigation.
Its former follow-up list omitted the actual change. This section supplies that
change; the subsequent implementation record documents its selected delivery.

The implementation record below supersedes that initial planning status: the
user subsequently authorized proceeding with this corrected action.

**Technical correction:** in Next's development
`WebpackHotMiddleware.onHMR(client, htmlRequestId)`, send the initial `SYNC`
envelope through the existing `publishToClient(client, envelope)` helper instead
of `publish(envelope)`. The joining connection must receive the current hash,
errors, warnings and development metadata. Other already-connected browsers
must receive no extra `SYNC` as a consequence of that connection joining.

Expected sequence after the correction:

| Recipient | Initial connection | Normal compilation | Second browser joins |
| --- | --- | --- | --- |
| Existing browser | `sync(A)` | `built(B)` and normal refresh events | No additional connection-specific `sync`; document remains loaded. |
| Joining browser | — | — | Receives its own `sync(B)` and initializes normally. |

Preserve broadcast delivery of ordinary compilation updates, errors and other
existing global HMR events. Keep the client reload/hash checks intact: a
connection that actually reconnects must still receive synchronization and
perform the framework's recovery when necessary. Updating client hash bookkeeping
or suppressing reloads is not required to remove the demonstrated cross-browser
trigger and would expand this correction's behavior.

**Delivery and temporary mitigation:**

1. Prefer a supported Next release containing this behavior (or an equivalent
   verified correction). Confirm its source change and pass the regression
   below before updating the pinned dependency and lockfile. No such release
   has yet been established by this audit.
2. The user approved proceeding with the corrected action. Selected delivery
   is a **tracked, version-pinned dependency patch limited to that one `onHMR`
   send site**, applied by the existing development startup manager. This is
   the bounded exception to the earlier framework-internals restriction.
   It must be reproducible after a clean install,
   verify the expected Next version and exact target, fail clearly on mismatch,
   and include a removal condition once a verified upstream fix is adopted.
   An untracked edit inside `node_modules` is not an implementation deliverable.
3. Until the correction is applied and validated, use an isolated built Shell
   (`next build --webpack` / `next start`, through the documented project
   workflow) for stable concurrent-browser acceptance. Existing built-mode
   controls support this operational mitigation. It does not change `npm run
   dev` behavior or mark its defect fixed. Homepage prewarming remains an
   unselected, incomplete mitigation because later compilation can change the
   hash again.

**Implementation tasks and completion evidence:**

- [x] Identify the exact correction site and required recipient behavior.
- [x] Select and apply the reviewed delivery mechanism. Record the framework
  version or tracked patch, installation behavior and rollback/removal steps.
- [x] Turn the existing middleware diagnostic into a regression: after
  `built(B)`, connecting another client sends `sync(B)` only to that client;
  later ordinary `built(C)` still reaches both. Cover initial sync with
  compilation errors/warnings and actual connection replacement as well.
- [x] Repeat isolated Actor-first and Dashboard-first browser checks: cold
  route compilation then another browser, HTTP-only compilation followed by a
  warm browser connection, repeated warm connects, and idle/entry eviction.
  Require unchanged existing-document time origin for new-client attachment.
- [x] Verify ordinary source-edit HMR, a genuine development-server restart
  and HMR reconnection still work. Repeat built-mode isolation and retain the
  existing intentional same-user/logout/admin-restart controls.
- [x] Update the developer guide, terse changelog, audit and handoff with the
  implemented mechanism and evidence.
- [ ] User acceptance for C0 and the remaining C1–C5 workflows.

SheetDelver session/world handlers, module contracts and the application socket
protocol need no changes for this correction. C0 remains open until the
implementation and acceptance boxes are satisfied, or the user explicitly
accepts the documented development limitation.

This review changes only documentation and ignored local diagnostic tooling.
It does not close the ADR or authorize publishing/merging the checkpoints.

### October 13, 2026 — C0 correction implemented; handoff for acceptance

After the user approved proceeding, the one-site version-pinned dependency
correction was selected. No fixed upstream release was established.
`patches/next-16.3.8-webpack-hmr-sync.json` records the original and corrected
checksums, target and exact replacement. `prepare-next-dev.ts` verifies the
installed version and file before writing, accepts an already-applied patch,
and can restore the original. It changes only the initial `onHMR` send to
`publishToClient(client, envelope)`.

The existing manager invokes preparation in its development path before either
Core or Next starts, including manager-initiated development restarts. Build,
production start and managed-config generation do not apply it. This approved
bounded correction supersedes the earlier no-framework-patch constraint only
for this artifact. There is no browser HMR filter, startup prewarm or client
reload suppression. Installation/removal commands and failure behavior are in
the [contributor guide](../CONTRIBUTING.md#next-development-synchronization-correction).
The application, SDK/API, module and Next dependency versions are unchanged.

Tracked `src/tests/unit/runtime/next-dev-hmr.test.ts` runs through the normal
unit suite. It executes the corrected vendor middleware with fake compiler/
client inputs; the unrelated compiler-classification import is stubbed to
avoid initializing Next server globals in the broader unit environment. It
verifies scoped initial synchronization, normal broadcasts to both clients,
error/warning metadata, actual client replacement, repeat preparation,
restoration and refusal of changed versions/contents. It operates on a
temporary file and asserts the real installed dependency remains untouched.

Isolated browser fixtures copy Next physically before applying the preparation
helper. The current app/module source, local mock HTTP/Socket.IO and local
fonts exercise the actual Shell. No root settings/credentials are copied; no
Core, native Foundry or hosted service is contacted. Results:

| Check | Automated result |
| --- | --- |
| Actor-first, first cold guest-home visit and warm repeats | Existing Actor document time origin unchanged. |
| Dashboard-first, cold Actor-route HTTP compilation, then warm guest-home HMR attachment | Existing Dashboard time origin unchanged throughout; joining client receives synchronization. |
| Real client-component edit and restoration | Edited Settings control appears through HMR; document time origin unchanged. |
| Actual HMR connection close/reconnect | Existing browser recovers; framework recovery/reload behavior remains enabled. |
| Three other routes, 35 seconds idle, new guest visit | Existing document time origin unchanged through subsequent compilation/attachment. |
| Owned Next development-server stop/restart on the same port | Existing browser reconnects and recovers its Actor; genuine restart can reload as expected. |
| Isolated Webpack build/production start, cold and warm guest visits | Build succeeds; existing document time origin unchanged, no dev HMR present. |

The idle case exercises the configured disposal window and subsequent route
compilation; it does not instrument every internal entry's disposal flag.
The framework recipient invariant also covers fresh compilation independently
of why the framework initiated it. Fresh-file preparation and repeated
preparation pass; a fresh network `npm ci` was not performed in this pass.
Full Core unit/client suites, typecheck and lint pass. Existing same-user,
logout, boundary and administrator-restart regressions remain passing.

**Ready for user verification; keep the ADR open.** On the user's chosen test
environment, restart SheetDelver in development mode to load the correction,
open an Actor in one authenticated browser, then visit the login page in a
fresh incognito browser before logging in. The first browser must keep its
page. Repeat with Dashboard open and after normal editing/idle periods.
Native v13/v14 media-recipient and Assistant-operation checks plus the six
acceptance cases recorded above remain for the user. Native testing is still
paused; it is not implied by this offline Shell fixture.
C6 parked-branch reconciliation remains separately authorized integration work.
No staging, commit, branch mutation or remote operation accompanied this fix.

### October 13, 2026 — mobile acceptance additions and temporary journal views

The user reported unreadable Shadowdark gear columns on phone/tablet and
Mörk Borg tabs above, rather than below, Core's Tools control. They approved
an **optional bottom-navigation SDK contract**, targeting SDK 2.3.0,
`ui-extension-api` 2.2.0 and Core 0.17.1. Only adopting modules raise their UI
minimum; unrelated modules keep their defaults. Core application version stays
0.17.0 until the separately authorized release workflow.

The module registers its own fixed bottom-bar element through
`useBottomNavigation(ref)` from the public React SDK. Core measures only a
connected, visible bar aligned with the viewport bottom; it reserves the
maximum height, not a sum, and moves its Tools, Chat, Players and player feedback
above it. Responsive hiding, unmount, module/world/user scope replacement and
terminal UI reset release reservations. Module appearance stays module-owned;
no private host DOM import, global mobile offset, portal API or server behavior
is introduced. Mörk Borg uses two visible tabs plus More with the active tab
leftmost. Shadowdark uses stacked readable gear rows below the desktop breakpoint
and a native modal HTML dialog above ancestor stacking contexts/HUDs. It adds
no SDK requirement.

**Publication gate:** Mörk Borg's new UI minimum is `>=2.2.0 <3.0.0`; local
development temporarily retains `coreVersion >=0.17.0` so the current development
host can load it. Released Core 0.17.0 has UI API 2.1.0 and is correctly rejected
by the named-contract requirement. Before publishing the module, after Core
0.17.1 is released, promote its application minimum to `>=0.17.1` and validate
against that tag. CI/release references target `v0.17.1` and cannot run remotely
until it exists. Do not publish these provisional metadata as a finished release
or pull the parked 0.18/SDK 3.x work into this branch.

#### J1 — native Show Players access, approved bounded correction

The user approved implementing this correction with its mechanics documented
here. This explicitly revises section 3's earlier unsupported force-only limit;
it does **not** relax ordinary journal permissions.

Read-only inspection of native Foundry v13.351/v14.367 establishes:

- `Journal.show(document, {force, users})` relays UUID and force to selected
  recipients. The native Show Players dialog can separately update saved
  ownership when the GM chooses that option; otherwise its final show uses
  `force: true` with no document mutation.
- The receiving client temporarily sets observer permission on the shown
  entry or page. A page opens in single-page mode; sharing it does not grant
  its siblings. For an entry, independently restricted pages remain subject
  to their own permissions/inheritance. Native close restores source ownership
  for a forced temporary view.
- Native enrichment excludes unrevealed `section.secret` blocks for non-owners;
  revealed sections remain visible. Temporary observer access is not ownership.
- The recipient event does not carry a verifiable sender ID. Treat the received
  event as Foundry's native presentation instruction, not evidence that Core
  independently authenticated a GM sender. Never accept a browser-supplied
  UUID/force/recipient list as equivalent authority.

See the [Journal API](https://foundryvtt.com/api/v13/classes/foundry.documents.collections.Journal.html)
and [journal guide](https://foundryvtt.com/article/journal/).
Before J1, SheetDelver received the instruction but hydrated through its ordinary
Observer-only detail route, explaining Access Denied for a private shared page.
J1's separate view projection corrects that path without weakening the ordinary
route.

**Mechanism and bounds:**

1. Preserve the boolean native force value in the existing recipient-scoped
   receipt. A protected open-view request supplies only its exact
   `streamId/sequence/shareId`; the server resolves entry/page/force from its
   latest receipt, never from browser document parameters. Require a current
   player session/world; reject service bearer, other sessions, changed streams,
   superseded shares and malformed identities.
2. Issue an opaque **read-only view lease**, scoped to that receipt and session.
   Reads use a dedicated JournalStore projection, not an unfiltered Store read
   or a service-account/native transport fallback. A forced page returns only
   that page plus its parent display name. A forced entry applies temporary
   Observer inheritance but does not bypass independently restricted pages.
   Non-forced shares retain ordinary entry/page visibility thresholds.
3. Whitelist display fields; omit source flags, ownership maps and statistics.
   Strip unrevealed Secret sections **on the server before transmission**, unless
   the requesting user already has source ownership of that page. Keep normal
   directory/detail/write routes unchanged; correcting any existing Secret
   exposure on those ordinary routes is a separately bounded follow-up.
4. The modal owns the lease. Closing, replacement, route unmount or logout
   attempts immediate disposal; late opens are also disposed rather than shown.
   A new native share or terminal session/world retirement invalidates all old
   leases server-side. Other open browsers have independent leases. No browser
   heartbeats or periodic journal polling are added.
5. As a failure bound, leases expire after **30 minutes without a read**;
   reads renew that idle interval. Store at most **16 simultaneous views per
   current receipt** and fail further opens clearly rather than evicting another
   browser. Prune expired leases on requests; do not add a rotation service or
   a permanent grant database. Failed close delivery therefore has bounded
   access lifetime. Already-delivered content cannot be recalled from a browser.
   An authenticated browser can open the latest retained receipt while its
   upstream session remains current, matching this ADR's existing catch-up
   policy; a closed lease itself is never reusable. This is not a persistent
   ownership grant or a promise of exact native browser-window internals.
6. Support current **world** JournalEntry/Page UUIDs only. Compendium journals,
   expanded native enrichment and module-specific page renderers remain outside
   this correction; do not fall back to privileged live fetches.

Acceptance must cover private selected page versus whole entry, unaffected
siblings/directory/ordinary reads, forced versus non-forced access, Secrets and
revealed sections in the network response, non-recipient/system rejection,
stale/closed/expired leases, independent browser leases, supersession/world/
session retirement, deleted pages, close during an in-flight open and read-only
UI. Native tests remain paused until separately authorized.

- [x] Optional footer contract and both module layout corrections implemented.
- [x] Actual-component/compiled-CSS offline checks: 390/820/1280px gear dialog,
  full labels, top-layer header, Add, Escape/focus/overflow restoration; actual
  SDKProvider with StrictMode, footer placement, two-tab/More selection/focus,
  world-scope replacement, responsive hiding, unmount and terminal reset.
- [x] J1 bounded view implementation and automated validation below.
- [x] User accepted J1 in the October 13 closeout; exhaustive generation-specific
  native checks are not claimed and agent-operated Foundry testing remains paused.
- [x] User accepted the mobile/footer corrections.
- [ ] Separate publication gate: Mörk Borg metadata promotion/released-tag validation.

#### Implementation follow-up for these additions

The footer registry and public SDK hook/context/testing facade are implemented.
Mörk Borg consumes only the public hook; its scope-specific idempotent disposer
prevents an old provider cleanup from removing a new world's registration.
Shadowdark's native modal dialog and readable mobile/tablet rows preserve item
creation and module-owned styling. Core/package/lock and module release versions
are unchanged; SDK/UI versions and Mörk Borg's named-contract minimum advance as
approved. The publication gate above remains.

J1 preserves native force and stores view leases inside SharedContentStore.
`SharedJournalService` and three protected `/api/shared-content/journal-view`
operations require the current player session and exact received identity.
System bearer and session/client mismatches are rejected. The dedicated
`JournalStore.projectSharedView` selects display fields, page visibility and
source-owned Secret access without mutating ownership, relaxing ordinary reads
or calling a Foundry transport. The client owns one modal lease with coalesced
reads; revisions reuse it and close/replacement/logout/unmount release it even
if its open finishes late. The shared presentation host sets its entry/page and
receipt identity together, avoiding a new live receipt being read against an
old displayed page. Failed coalesced requests now use settled cleanup handlers
rather than an unobserved rejected `finally` promise; retry is tested.

Tracked tests cover the footer registry's visibility/max-height/cleanup and
late observers; journal ingress/force, exact receipt, recipient/session/world
and real route gates, no-store, normal-read denial, no source mutation,
page/entry inheritance, forced/non-forced reads, Secrets/revealed/source-owner
distinctions, independent browser leases, close/supersession/idle renewal/expiry,
16-view bound, retirement and deleted pages. Client tests cover late opens,
out-of-order reads, close/replacement, revision refresh and failed open/close.
See `client/bottom-navigation.test.ts`, `documents/shared-journal-view.test.ts`,
`client/shared-journal-view.test.ts` and `client/coalesced-fetch.test.ts` under
`src/tests/unit/`.

Actual browser fixtures use current components with mocked HTTP/contexts and
in-memory server Stores, never production settings or native Foundry. The real
JournalProvider/SharedContentHost/JournalModal verifies a private page without
forbidden response bodies, sibling pagination or editing controls, lease close/
focus restore, identical re-share, non-forced denial and close-before-open.
Footer/gear checks use the real SDKProvider, StrictMode and compiled CSS. Core
unit/client suites, typecheck and lint, module checkers, eight module regressions
and explicit module-source typing pass. These are automated checks, not
user/native acceptance or validation against unpublished Core 0.17.1.

API/UI/architecture and public SDK/module-authoring guides, module README/
release gates, terse changelog and local reports/handoff are updated. This
implementation record preceded operator acceptance; the closeout above records
the subsequent confirmation and authorized checkpoint. Remote actions remain
with the user.

**Existing privacy follow-up:** ordinary authorized journal detail still returns
source HTML without owner-only Secret filtering. J1 does not broaden that path;
its shared DTOs filter before transmission. Before correcting ordinary reads,
inventory journal detail and SDK/UUID consumers, derive per-page ownership and
separate server display projections from owner raw/editor round-tripping.
Test Secret/revealed/nested sections and saves; do not accidentally persist
filtered owner source text or expand this work into private-whisper policy.

**User verification for this addendum:**

1. Shadowdark gear on phone/tablet: complete names/descriptions, labelled
   cost/slots, visible header/close above the combat HUD, Add/search and Escape.
2. Mörk Borg phone: bottom tabs, two plus More, active leftmost; switch all four
   sections, open Core Tools/Chat/Players, resize to desktop, navigate away and
   check light/dark without changing SCVM sheet colors.
3. Private journal with an inherited page, restricted sibling and unrevealed
   Secret: Show Players to one player **without changing ownership**. Only the
   selected page opens read-only; other players get nothing and neither sibling
   nor Secret body appears in the response. Close/re-share; compare entry/page,
   revealed Secret, image page and second browser. Normal private reads stay denied.

### October 22, 2026 — Next 16.4.2 security upgrade

Core 0.20.1 release validation exposed production advisories in Next 16.3.8
and sanitize-html 2.17.7. The repair pins Next and eslint-config-next to 16.4.2
and updates sanitize-html to ^2.18.1, locked at 2.18.1. The application release
version stays 0.20.1. The production audit gate remains enabled. See upstream
[Next image optimization advisory](https://github.com/advisories/GHSA-2464-fhr4-w9xw)
and [Server Actions advisory](https://github.com/advisories/GHSA-p3m5-59mp-jv5r).

The published 16.4.2 `dist/server/dev/hot-middleware.js` still broadcasts the
initial SYNC from `onHMR`. Retain the one-site correction; the current manifest
is `patches/next-16.4.2-webpack-hmr-sync.json`, replacing the historical 16.3.8
manifest. Both full-file hashes were recalculated from the exact npm artifact:

- Original: `c62af1c040758e369dbdefbf6df5782bfc77124c52ce7be7cd8885078731b2ca`.
- Corrected: `a63c95269e086c50988f86bf17af91da106b688ffab72aa12640cd72510f3e1a`.

No broader middleware rewrite or relaxed checksum/version guard is introduced.
The actual-vendor regression now supplies the new vulnerability-insight Promise
constructor argument. Compilation broadcasts, joining-client synchronization,
reconnection, restoration and mismatch refusal remain covered.

Matching Next lint tooling requires React Hooks 7.1. Four existing components
needed bounded compatibility corrections: AuditLogViewer initializes its clock
lazily; ModuleUpgradeStatus keeps its rendered return-focus target in state;
CombatHUDView and SharedDiceAnimation synchronize callback/scope refs in layout
effects. The initiative dialog renders based on its roll data, not the
callback-bearing props object. Authorization, layouts and roll behavior are
unchanged; these changes avoid publishing values from an uncommitted render.

The full audit also reports the existing development-only braces 3.0.3 chain
through eslint-config-next/fast-glob/micromatch (GHSA-vfj7-8cjw-p6xm). It is
unchanged from the previous lockfile and has no published patched braces version
at verification time. The npm suggestion to downgrade eslint-config-next to
14.2.35 is not a compatible repair for Next 16.4.2. Production audit results
exclude this tooling-only advisory; do not describe the complete dependency
graph as vulnerability-free.

Verification for this upgrade passed on Node 22.23.4 in a clean copied Core
workspace with an external CI data directory: `npm ci`, `npm run managed:generate`,
`npm audit --omit=dev --audit-level=high` (zero findings), `npm run lint`,
`npx tsc --noEmit`, `npm run test:unit`, `npm run test:client`,
`npm run test:integration`, `npm run ci:fixture` and `npm run build`. The
ADR metadata check also passed. The actual Next/Shell browser check used a
loopback mock API and copied modules: cold/warm guest joins preserved the
existing sheet document, a real client source edit hot-applied, an HMR reconnect
recovered, other route compilations plus idle did not cause a new-visitor reload,
and an owned development-server restart recovered. No live Foundry connection
or data write occurred. Hosted CI and release publication remain pending the
maintainer's push and `release:tag -- 0.20.1 --resume`.
