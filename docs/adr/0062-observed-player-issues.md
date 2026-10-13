# ADR-0062: Observed Player Issues and Cross-Browser Isolation

**Status:** Accepted — implementation in progress; user verification pending
**Date:** October 13, 2026
**Related:** ADR-0013, ADR-0038, ADR-0049, ADR-0053, ADR-0054, ADR-0057, ADR-0059

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
access and manager-only bypasses is needed. C4 remains unimplemented; this
review clarifies the required implementation, not an already-effective grant.

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
| C0 | Cross-browser development-refresh diagnosis and bounded correction | Trace confirms home-route compilation plus Actor HMR. Compare cold/warm routes with unchanged files, capture HMR and navigation, verify guest opens do not disrupt the first client after the correction, and compare built mode. Preserve same-user replacement/admin restart controls; review any framework-only limitation explicitly. |
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
Development HMR during the reported incident is verified; the exact invalidation
cause, navigation/remount mechanism, wizard Item provenance and native acceptance
remain open. The approved background/menu/shared-setting choices remain bounded
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
