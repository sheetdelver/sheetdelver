# ADR-0061: Managed Combat Player Participation

**Status:** Accepted — hardening verified; final acceptance and release gates pending
**Date:** October 13, 2026
**Related:** ADR-0013, ADR-0028, ADR-0038, ADR-0049, ADR-0057, ADR-0058,
ADR-0060, ADR-0062

## Context and completed baseline

ADR-0060 is complete and user-accepted. It delivered the compact Core HUD,
authorized visibility and owned stats, ordinary-Combat command preconditions,
and SDK 3.0.0/UI API 3.0.0 initiative presentation. Managed encounters remain
view-only in that baseline HUD by design; manager commands originally required
role-4 GM. ADR-0062 subsequently enabled native Assistant management, retained
by the October 14 integration amendment below.
This ADR proposes the next slice, not unfinished work in ADR-0060.

The original October 13 review found reusable foundations and two concrete
correctness gaps. These baseline findings are historical; formula preservation
and response redaction are now implemented. See the current checkpoint status
and resumption review below for remaining work.

- `CombatService` and `CombatTrackerProjection` already resolve ownership,
  formula context and visible order; `EncounterCommandGuard` serializes
  Core-originated commands. Merely enabling buttons or setting the internal
  `managerCommand` boolean for players would bypass the intended boundary.
- `effectiveInitiativeFormula` selects module formula, then saved GM fallback,
  then Core `1d20`. The typed `rollModal` presents Core context; it does not
  execute rules. Shadowdark registers an override, while local Mörk Borg and
  D&D 5e use the shared fallback. No new general-purpose roller is needed.
- The shared dialog's default Roll sends `advantageMode: normal`, which the
  server uses to replace leading `2d20kh1`/`2d20kl1` with `1d20`. Shadowdark's
  module can supply keep-highest initiative itself. Default execution can
  therefore differ from the displayed module formula.
- Turn-command success still contains a raw `turn` index even though tracker
  DTOs omit positional metadata. The ordinary player route forwards it.
  Correct the response before extending the same path to managed players.

Managed Combats remain inactive until Begin. The baseline HUD filtered on
`active`; this implementation now also selects owned forming rows during an
open player initiative phase without activating the Combat. Manager status `active`
means provisioned/editable and is distinct from Foundry's `active` bit.

Local Foundry v14 permission-source review indicates a feasible headless path:
player Combat updates permit round/turn but not parent flags/activation;
Combatant initiative uses Actor-derived OWNER permission, with Actor lookup
by `actorId` on the server. The October 14 live checkpoint verifies tokenless
owner writes on v14.367; v13 remains unverified. No online GM browser, GM impersonation or unsupported
Foundry server extension is proposed. Core's API policy remains stricter than
Foundry's base rules; it cannot govern writes made outside SheetDelver.

## Decisions confirmed with the user

1. Start with a GM-controlled **Open player initiative** phase. Owners may
   roll their own visible, unrolled characters, including before Begin.
   Individual directed roll requests are not a prerequisite.
2. Enable owning-player **End my turn** by default, with a per-encounter
   GM switch to disable it.
3. Retain module initiative presentation through the SDK. System-specific
   actions remain on character sheets; the HUD manages turn information and
   initiative. Hidden participants remain absent, not anonymized.

The user authorized implementation on October 13. Release and closeout remain
subject to the acceptance gates below.

## Accepted decision

### 1. Persist a small participation policy on the Combat

Extend the validated `flags.world.sheetDelverCombat` policy with an optional
player-actions block: initiative open/closed, an opaque phase generation and
whether owner End my turn is enabled. No second store or browser persistence.
The GM or native-authorized Assistant writes policy under the existing encounter
guard. Player responses write initiative/round/turn only, never manager-authored
policy flags. In this ADR's current policy, “GM controls” includes native
Assistant manager capability from ADR-0062, not SheetDelver administration.

- Valid existing managed encounters with absent new settings default to
  initiative **closed**, owner End my turn **enabled**. Reads do not migrate
  or write documents. Unknown/malformed policy fails closed for player writes;
  it must not downgrade a marked managed Combat to ordinary permissive policy.
- Open applies only to a valid, editable, tokenless managed encounter with
  no cleanup/deletion marker. It may be unstarted or active and started.
  A deactivated started encounter is not an actionable initiative prompt.
- Open and Close rotate the phase generation. Begin closes the phase in the
  GM's state update; rewind to round zero closes it too. A GM can deliberately
  reopen during combat for late arrivals. Completion/deletion/cleanup disable
  all player actions. An open phase survives same-world restart until closed;
  there is no timeout or repeating modal nag.
- A visible owned row with null initiative is eligible. Zero is a rolled
  score. Multiple owners see the same opportunity; the first valid applied
  score wins. Players cannot reroll, clear or reset. A GM clearing a score
  while the phase is open deliberately makes it eligible again.
- Manager progress is derived from current eligible rows/scores, not stored
  responses. Only the GM sees overall progress. Player counters, if used,
  concern that player's visible owned rows only.

### 2. Add owner actions without exposing manager authority

Reuse the existing authenticated Combat API and underlying orchestration;
keep `/api/combat-manager` GM/Assistant-only under ADR-0062's document policies.
Distinguish ordinary HUD, managed owner and manager authorization internally,
then call a shared executor once under the encounter guard. A request body
cannot select the privileged path.

| Caller/state | Managed initiative | Managed turn control |
| --- | --- | --- |
| Player/trusted player, owns visible world Actor | Own null score while phase open; automatic or manual final total | End current owned turn if enabled, active and started |
| Non-owner, hidden/missing/actorless row | No action; hidden and missing targets indistinguishable | No action |
| Assistant or full GM | Existing manager roll/manual/bulk/reset controls; Open/Close phase, subject to native document permissions | Existing manager Begin/Next/Previous; policy switch |
| Provisioning, cleanup, completed, deleted or unavailable world/session | No action | No action |

End my turn advances exactly one step using the existing server order and
skip-defeated behavior. It never starts, activates, rewinds, skips directly
to an ID or ends an encounter. A hidden current Actor's owner gains no action.
The GM switch is rechecked on submission, not merely reflected in button
visibility. Ordinary-Combat role policy remains unchanged.

Use the authenticated caller's Foundry connection. If native permissions
reject a write, report failure; do not retry as the service GM. Verify native
acceptance before publishing the capability. This is bounded document-state
progression, not native pre-command hooks, time advancement, condition expiry,
scene/token actions, or system turn automation.

### 3. Preserve resolved formulas and the existing SDK boundary

Default **Roll initiative** must execute the displayed server-resolved formula
unchanged, including module-provided advantage/disadvantage. The implemented
typed choice allows omitted `advantageMode` to mean preserve; keep explicit `normal`
as an override rather than silently redefining it. Show the expression an
explicit supported override will execute. Manual input remains a finite
**final total**, including fractional tie-breakers, and has no die modifier.

Keep module-first selection and current GM-fallback reference substitution;
do not interpret new `@` references in module formulas. Unavailable module
formula/prepared data must not silently become an incorrect system roll.
Keep the existing manual/unavailable behavior and label the Core fallback.
Leading-d20 override support stays bounded; it does not imply a universal
initiative-rules API. Non-d20 formulas do not get d20 mode controls.

Continue `SurfaceHost` + typed `rollModal` + shared `RollDialog`. Modules
may theme/present the resolved context, but cannot replace expressions,
bonuses, recipients, transports or authorization. Update callback producers,
consumers and SDK mocks together. The implementation advances SDK/UI API to
3.1.0; module 3.x ranges admit it. The approved Core 0.18.0 publication sequence
remains a separate gate, not a release created by this ADR. Any further module
edits or branch changes require the appropriate scoped authorization.

Keep ordinary visible initiative's existing public chat policy for this
self-service phase; hidden GM rolls remain GM-visible. Do not add an audience
picker. ADR-0058's **private directed requests** are a different, deferred
flow. This distinction should be confirmed in the ADR review.

### 4. Extend the shared HUD projection, not lifecycle ownership

Project an explicit participation state through the authorized Combat DTO.
Before Begin, expose only this caller's visible owned rows, formula context
and phase observation. Do not expose the manager DTO, raw flags, recipient
lists, NPCs, other owners' progress or private encounter/scene labels.
Players with no eligible/owned visible rows receive no extra encounter entry.

Show a small **Initiative open** section in the existing HUD, including when
the managed Combat is inactive. Keep scored own rows visibly resolved while
the phase remains open; Roll is absent on them. Do not steal focus or pop a
modal automatically. A player chooses a row to open its existing module/Core
dialog. Multiple encounters remain separately selectable without activating
one in Foundry; starting combat changes to the normal compact turn display.

For active managed turns, use the existing **Your turn** cue and explicit
**End my turn** button only when authorized. Keep read-only owned chips,
sheet shortcut, Core light/dark theme, responsive clearance and accessible
focus/labels. The shared world/session boundary disables retained UI during
transient loss and retires terminal scope. No page-specific polling, reconnect
logic, local action queue or auto-resubmission.

### 5. Guard effects and all player-visible responses

Require current observations at the HTTP boundary: turn state for End my
turn; phase generation plus current score and resolved formula for initiative.
Under the shared guard, re-read authorization and relevant current state
after asynchronous reads and immediately before each write/roll. Capture and
recheck world/session identity so late work cannot apply in a replacement
world. Re-resolve live turn identity when preserving it after a score change.
Busy/stale actions return 409 and require a deliberate refresh/new action.

This is best-effort preflight, not a Foundry transaction or native compare-
and-set. The process-local guard does not lock external Foundry clients or
other Core processes; equal snapshots cannot prove no intervening native
change. Do not promise exactly-once execution. Once chat was created, a later
score-write failure must report **rolled, not applied** where known. On an
ambiguous timeout, report an unknown outcome and refetch; never silently
reroll. GM recovery can use the known chat total/manual entry. Do not accept
arbitrary chat IDs as proof of an authorized initiative response.

Player command success returns a minimal acknowledgment (or a separately
authorized projection), never the internal raw `turn` index. Audit ordinary
and managed responses, errors, observation fields and realtime hints together.
Do not add hidden-row IDs, counts, generation counters tied to hidden-only
changes, queue gaps or hidden-specific failure reasons.

Generated manager copy labels (`Name #N`) also deserve a projection check:
their counters include hidden/removed copies. Preserve stable GM labels but
avoid exposing generated ordinal gaps to players. Use explicit provenance
to distinguish generated labels from authored names; do not regex-strip
arbitrary names or mutate world Actors. Confirm the bounded label treatment
at P0; a general alias/art editor is not required for this slice.

## Other tracker features considered

The recommendation is to finish participation before expanding density or
system mechanics. These comparisons do not create implementation obligations.

| Feature/reference | Disposition |
| --- | --- |
| [Foundry](https://foundryvtt.com/article/combat/) owner pre-start initiative/End Turn | Adopt the bounded managed equivalents above; GM bulk rolls, hidden/defeated and resource controls already exist |
| [D&D Beyond Maps](https://dndbeyond-support.wizards.com/hc/en-us/articles/46385529638164-Combat-Encounters-on-Maps) late arrivals and privacy-aware duplicate labels | Reopen initiative for late entrants; audit generated-label privacy. Keep SheetDelver's neutral hidden-current display |
| [Carousel](https://wiki.theripper93.com/free/combat-tracker-dock) resource detail and event rows | Owned chips already exist; optional reminders later, with actorless-system capability review |
| [PF2e tracker](https://pf2etracker.app/) hazards, combat log and encounter import/export | Consider Journal history/rebuild and reminders separately; no generic PF2 rules or automatic undo |
| [Token Action HUD](https://github.com/Larkinabout/fvtt-token-action-hud-core) system action integration | Attacks/spells remain on sheets, not a new Core action bar |

Defer: ADR-0058's standalone Request Roll tool and durable targeted queue;
Journal ledger/rebuild; full alias/art editor; condition badges/automation;
grouped/party initiative; delay/ready and system-specific tie resolution;
PF2 skill-choice initiative, Daggerheart spotlight and other non-scalar
ordering models; timers/audio/layout presets; native browser bridges.
One numeric Actor formula is not a complete system combat contract. Do not
merge Actor resources when merely grouping entries visually.

## Implementation checkpoints and acceptance

### Current status — October 14 hardening and live checkpoint

The unchecked parent checkpoints below combine implementation and acceptance;
they do not mean the UI and transport still need to be built. Source review at
the reconciled HUD checkpoint plus the hardening/native follow-up confirms this disposition:

| Checkpoint | Implemented / verified evidence | Remaining gate |
| --- | --- | --- |
| P0 policy/native boundary | Approved local Foundry 14.367 / D&D 5e 6.0.2: native owner tokenless score and turn writes accepted with no full-GM client online; caller-bound SheetDelver actions also pass | v13 evidence or an explicit supported-generation decision; v14 is not v13 proof |
| P1 correctness/authorization | R1/R2 and retired-user guard implemented; extended controlled-await, concurrent-owner, partial/unknown-result and route regressions pass; full Core/module offline validation passes | Automated verification complete for the bounded matrix; operator acceptance remains P3 |
| P2 manager/player UI | Actual HUD/dialog rendered at 320/375/1280 in both themes; focus/keyboard/stale/loading/error/selection checks pass. Subsequent visual correction reuses shared Shadowdark and native Mörk/D&D roller frames | Fresh operator visual acceptance; live D&D interaction evidence predates this presentation correction |
| P3 integration/operator | v14 native proof; GM/Assistant/owner/shared-owner/non-owner HTTP checks and D&D player browser actions pass; failure/lifecycle races injected offline | Live other-system formula/dialog checks, restart/transient/terminal lifecycle acceptance, generated-copy inspection and user sign-off |
| P4 docs/release | Contracts, module-owned verification notes, feature-snapshot changelog and local handoff updated; no versions or Git writes | Core-first release, module minima/unused versions, released-host CI/package checks and final closeout |

- [x] Approved participation design and baseline Core/module implementation are
  preserved on the existing branches; no new tracker or generic roll tool is needed.
- [x] Main integration preserves SDK/UI 3.1, Assistant manager capability,
  mobile footer and shared-media fixes. No pending C6 branch reconciliation.
- [x] Resolve the bounded R1/R2 findings below and extend focused offline coverage;
  the implementation follow-up records validation and remaining acceptance.
- [ ] Complete the native and operator acceptance gates; do not reuse the
  completed ADR-0060 ordinary-Combat pass as managed-owner evidence.

- [ ] **P0 — approve policy and prove the write boundary.** Review the phase
  lifecycle, public-vs-directed roll distinction, label treatment and SDK
  choice. Agree branch/release sequencing separately. In an approved isolated
  v13/v14 world, prove owner tokenless initiative and turn writes with no GM
  browser online, no service-account substitution and no parent flag writes.
  A failure blocks enabling player capabilities, not a reason to elevate.
- [x] **P1 — shared correctness and authorization (implemented and automated).** Correct default formula
  execution and player turn responses; add validated durable policy and one
  guarded action path. Test absent/malformed flags, module/GM/Core formulas,
  module keep-highest/lowest preservation, non-d20, fractional/manual input,
  duplicate owners/tabs, GM concurrent updates, score clear and phase reopen.
  Test hide/remove/ownership loss, cleanup, policy disable and session/world
  replacement at asynchronous boundaries. Denied/stale preflight has no side
  effects; later/unknown failure never claims success or rerolls automatically.
- [x] **P2 — manager and player UI (rendered verification; operator acceptance in P3).** Add Open/Close, GM roll progress and End
  my turn setting; expose only projected own-row initiative before Begin and
  owner controls when started. Preserve module dialog/fallback and sheet
  theming. Verify light/dark, narrow/desktop, keyboard, dialog stale/loading
  errors, multi-encounter selection and no repeated prompts/polling.
- [ ] **P3 — integration and operator review.** Exercise GM, assistant,
  owner/non-owner and shared owners through HTTP/browser; automatic/manual
  rolls, public chat, pre-Begin inactive state, Begin/Close/reopen/late joins,
  GM clear, turn ending/disable, hidden and generated-copy privacy. Inject
  roll-success/write-failure and timeout; confirm truthful recovery. Test
  restart persistence, transient recovery, terminal world/session replacement
  and no replay. Compare actual module formula, dialog and executed formula
  for all three current modules. Record versions, evidence limits and cleanup.
- [ ] **P4 — documentation and release review.** Update API DTO/action/error
  contracts, UI role/lifecycle table, architecture orchestration and SDK/module
  authoring guides/exports/mocks as affected. Update module-owned docs only
  in their repositories. Retain ADR-0058 as Deferred with the narrow successor
  note. Add terse delivered-feature changelog entries, update handoff, request
  checkpoint/commit permission, then let the user handle PR/release unless
  separately authorized. Close after recorded acceptance, not proposal approval.

Run focused service/route/projection/client/SDK tests at each checkpoint,
`npx tsc --noEmit`, `npm run lint`, and `git diff --check`. Before acceptance,
run full `npm run test:unit`, `npm run test:client`, affected module compatibility
checks and approved isolated integration tests. Inspect test data/cleanup and
process ownership first; root configuration is production-connected unless
proven otherwise. No live startup is authorized by this document alone.

## Audit evidence and remaining uncertainty

October 12–13 source/primary-reference review and existing offline tests passed:
`combat-tracker-projection`, `combat-hud-state`, `initiative-roll-dialog`,
`combat-route-preflight`, and `actor-combat-smoke`. The smoke's known missing-
registry diagnostics accompany its passing mocked no-adapter cases. These
checks establish the baseline, not acceptance of proposed player commands or
the newly identified button/response gaps. No code or new tests changed.

## Implementation follow-up — October 13, 2026

Core now persists optional participation policy and a rotating phase generation
on the managed Combat; absent settings default closed initiative and enabled
owner End my turn. Marked-but-malformed Combats fail closed. The manager has a
GM-only policy endpoint, Open/Close and End-turn controls, and derived visible
player-score progress. Begin and rewind to round zero close an open phase in
the same Combat update. Player actions use ordinary authenticated Combat routes
under the encounter guard, never the manager command flag or service GM socket.

The HUD projects own visible pre-Begin rows only, shows an opt-in initiative
button, and uses the same SDK modal after Begin when the GM reopens. Score zero
is rolled; the first applied score wins. The owner End my turn capability is
rechecked on submission. Shared initiative-mode logic preserves a module's
displayed expression when the default Roll omits a mode; explicit d20 modes
remain overrides. This additive choice raises SDK/UI API to 3.1.0; current
module `>=3.0.0 <4.0.0` ranges remain compatible, and Shadowdark's wrapper
delegates to the injected Core dialog. Generated copy labels now carry explicit
Combatant provenance, allowing player-only ordinal suppression without changing
the GM label or an authored rename. Turn HTTP acknowledgments omit raw indexes;
partial/unknown roll outcomes require manual refresh, not automatic retry.
After a score write, turn-index preservation checks the live parent turn,
current policy/ownership and world scope before a second write; a concurrent
turn change returns an uncertain-sync result rather than restoring an old turn.

Focused manager/HUD/dialog/route/SDK tests, full unit and client suites,
`npx tsc --noEmit`, `npm run lint`, and `git diff --check` pass offline.
Covered cases include absent policy, pre-Begin projection, phase rotation,
Begin closure, duplicate-score rejection, hide/ownership loss, world replacement
during an async read, owner turn disable, generated-name privacy and synthetic
post-chat score-write failure. These mocked checks do **not** establish native
Foundry player permission acceptance, browser layout/accessibility, or a
multi-role HTTP/socket session pass.

The previously approved disposable v14 fixture was started only on
`/tmp/sd-combat-foundry-v14.wwm6H3/foundry.sock`. It reported “software license
requires signature”; `/api/status` stayed inactive, so the native player-write
script could not run. The fixture was stopped; the separate port-30000 instance
was untouched. P0 native owner initiative/turn writes without a GM browser,
and P2/P3 live UI/permission checks remain **open**. Do not mark this ADR
verified or release player capabilities based on offline tests alone. The
user has been asked to restore a valid isolated fixture or identify another.
The user is currently using Foundry; no instance should be started, stopped or
probed for this acceptance run until they explicitly say it is available.

Checkpoint: implementation and offline verification are preserved on the
Combat HUD branch while native acceptance waits. A separate branch will
investigate the unrelated cross-browser reload report; this ADR remains open.

ADR-0060's Core-first release/module-minimum sequence remains separate.

## Main reconciliation — October 14, 2026

The user authorized merging each repository's current `main` into its existing
HUD branch, without publishing those branches. Core includes released 0.17.1 /
ADR-0062; all three module branches include their released fixes and historical
changelogs. SDK/UI 3.1 retains the additive footer reservation and shared-media
fixes, not a rollback to UI 2.x. No new application/module version was chosen.

The October 13 role-4-only policy description above is historical. Current
manager authorization follows ADR-0062: native-authorized Assistants can set
participation policy and use manager initiative/Begin/Next/Previous; their HUD
gets the manager shortcut, not the player-owner lane. Players retain the
bounded visible-owner phase/turn rules. Manager preference invalidations reach
GM/Assistant sockets; all authorized HUD clients receive the separate skinny
tracker invalidation. Chat, journal, compendium and administration boundaries
are not replaced with a blanket role override.

Validation: Core unit/client/integration suites, type-checking and lint pass;
all ten module regressions and explicit three-module source typing pass.
Regression coverage combines Assistant policy/Begin/rewind/caller-bound
initiative with the existing managed-owner checks. These are offline checks,
not native player-write or operator acceptance. P0/P2/P3 remain open and
agent-operated Foundry testing remains paused pending fresh approval.

Module CI/release workflow pins retain the already-planned future Core 0.18.0
target. Development UI 3.x ranges stay in place; Shadowdark/D&D retain their
temporary Core >=0.17.0 minimum and Mörk retains >=0.17.1 for footer support.
Before publishing, promote minima to the released 0.18.0 host and select unused
module release versions; Mörk's existing branch version 0.8.1 has since shipped
on main. No tag, release or remote operation is part of this reconciliation.

## Resumption review — October 14, 2026 (documentation only)

Reviewed the current services, routes, projections, HUD/dialogs, module
manifests/formula hooks and regression sources against the handoff. Retained
merge-validation logs confirm Core unit/client/type/lint, offline integration,
ten module tests, explicit module typing and three package checks passed.
No tests were rerun in this documentation pass. The integration runner tests
module lifecycle dependencies, **not** native Foundry player permissions.
ADR-0060 remains Completed; its historical role-4/view-only descriptions do
not override ADR-0062 or this successor. ADR-0058 and other deferred features
remain deferred.

### R1 — pin Combatant-to-Actor identity through initiative work

`CombatService.rollInitiativeCore` resolves source/prepared data and formula
using the captured Combatant, while `checkManagedOwner` checks the latest
row's ownership/score/phase. It does not require that latest row's `actorId`
still equals the Actor used for the pending roll. A native/external change
can rebind the row to another Actor owned by the same player during an await;
the existing checks need not reject that identity change. This is a
source-confirmed missing check and inferred failure path, not a live incident
or a reproduced test result.

Correction: bind the action to its original Actor identity and require that
association before rolling, before score application and before subsequent
turn synchronization. Reject a changed association before effects; if chat
already exists, return the appropriate partial/unknown result without retrying
the roll. Add paused-await regressions for swaps to both another owned Actor
and an unowned Actor, including a swap during the chat operation. Do not
expand this into an Actor mutation or global ownership-helper redesign.

### R2 — revalidate the tracker read after asynchronous lookups

`CombatService.listCombats` captures the access subject and readable Combats
before awaiting preferences, system and adapter lookup. Projection then uses
that earlier role and Combat flag snapshot. `UserStore.createAccessSubject`
captures a role value; it is not a live reference. A GM/Assistant demotion
during a lookup can therefore leave this response on the former privileged
projection, and phase/world changes can leave stale participation metadata.
This read-side ordering predates the merge; it is not a claim that the merge
introduced an observed disclosure.

Correction: retain the request's user/world/runtime scope, reject a retired
scope, and re-resolve current subject plus subject-filtered Combat data after
the awaited dependencies and before projection. Use current flags and Actor
authorization; no unfiltered reads or new Store. Test a role downgrade,
removed user, world replacement, phase close and row hide/removal during a
controlled await. Assert that no old-role hidden rows or old-phase controls
escape. This is the bounded read side of the same P1 privacy contract.

### Remaining verification order

1. Add R1/R2 regressions/corrections and finish P1's targeted offline matrix:
   simultaneous shared-owner submissions (not just sequential retries), busy
   guard/no duplicate chat, hide/remove/policy/session loss during awaits,
   chat timeout versus known post-chat failure, and public success payloads
   with no raw turn index. Keep each result's evidence type explicit.
2. After fresh scoped approval and a valid isolated fixture, run P0's native
   owner-write proof. The retained v14 probe tests raw caller-bound score/turn
   acceptance only; it does not exercise SheetDelver HTTP/UI or all v13 rules.
   The previous license-signature blocker has not been rechecked this round.
3. Run P2/P3 on the integrated code: GM/Assistant controls; player own-only
   inactive pre-Begin initiative; auto/manual totals (including zero and
   fractions); Begin/Close/reopen/late joins/GM clear; current-owner turn/end
   disable; hidden/generated-name privacy; concurrent owners; failure recovery;
   restart persistence and terminal/transient session/world behavior without
   replay. Verify Shadowdark's keep-highest formula/themed wrapper and Mörk
   Borg/D&D Core fallbacks through displayed, submitted and evaluated values.
   Test the new controls with footer/media/world overlays, keyboard and mobile
   layouts. This does not certify every system's native initiative mechanics.
4. Record user acceptance and finalize P4. Core 0.18.0 must exist before
   publishing dependent modules; promote minima and choose an unused Mörk
   version, then run released-host CI/package checks. Current future-tag
   workflow pins are a publication dependency, not a local coding blocker.

No application/test/module code, version, branch, commit, remote or live service
was changed by this review. R1/R2 are follow-up implementation tasks, not fixes
already made. No additional product decision is required to retain the
approved first slice; any native permission failure or supported-generation
restriction must be brought back for review rather than bypassed.

## Hardening checkpoint — October 14, 2026

R1 is implemented in `CombatService`: managed initiative captures its original
Actor ID, checks the live Combatant association after each asynchronous read,
before rolling/scoring and before turn repair. A changed target before chat
returns a stale error; after chat it reports `ROLL_NOT_APPLIED`, or
`TURN_SYNC_UNKNOWN` if scoring already occurred. It does not reroll or borrow
another user's transport.

R2 now captures request user/world/runtime identity, validates it after awaited
preferences/system/adapter reads, then resolves current role and readable
Combats for a synchronous projection using current flags/Actor access. The
HTTP route preserves `401` for retired callers and `503` for unavailable or
replaced world/transport scope. A paused-await regression also reproduced a
deleted user retaining access through an explicit Actor ownership entry; the
combat service's private subject resolver now rejects removed/banned users.
No shared ownership helper or SDK contract version changed. The API guide's
remaining role-4-only manager descriptions were aligned with ADR-0062.

The extended isolated browser fixture reproduced a stale open dialog after
Actor reassignment with the same formula. The HUD now also compares the
projected Actor association when retiring the dialog; this closes the pending
view instead of inviting a submission for a replacement Actor. This is part
of R1 and uses the existing DTO fields, with no new SDK contract.

Focused tests extend the existing Combat Manager suite and mock repositories:
owned/unowned Actor swaps during source lookup, chat and score acknowledgement;
GM/Assistant downgrade, deletion/ban, world/caller/transport replacement,
phase close and row removal during reads; concurrent shared-owner roll/turn
requests; no duplicate chat/write; policy/ownership/visibility loss; zero and
fractional totals; explicit d20 modes; known post-chat failure versus unknown
timeout; minimal public turn acknowledgements and correct read error statuses.
The focused matrix passes. Broader Core/module/browser validation and native
acceptance are recorded in the next checkpoint; they are not inferred from
this focused pass. No commit or release was made.

## Verification follow-up — October 14, 2026

All Core unit/client suites, type-checking, lint and the offline integration
suite pass on the hardened source. The integration suite is module-lifecycle
coverage, not native owner permission proof. Ten module tests, explicit
three-module source typing and isolated check/package runs for Shadowdark,
Mörk Borg and D&D pass. Root TypeScript alone excludes module sources.
No module source/API/version/minimum changed during this hardening.

An isolated rendered fixture uses the actual HUD, Core initiative dialog,
Shadowdark wrapper and current Core CSS. It verifies light/dark at
320/375/1280px, keyboard/focus, phase/Actor replacement retirement,
loading/errors, multiple encounter selection without activation, zero scores,
disabled owner controls and no automatic replay. Default submissions preserve
Shadowdark `2d20kh1+3`, Mörk `1d6+2` and D&D `1d20+2`; non-d20 formulas do not
gain d20 overrides. These are injected contexts, not native system data.
Screenshots were visually inspected; module sheet themes remain unchanged.

The user explicitly authorized their existing local Foundry at port30000.
The old disposable license-signature block and earlier live-test pause are
superseded **for this scoped run only**. Foundry **14.367**, D&D 5e **6.0.2**
was tested through a temporary loopback-only SheetDelver copy on32000/32001,
with separate config/data and uniquely marked users, Actors and Combats.
No hosted world, original application config or existing Actor/user permission
was changed. Native score and round/turn writes used an ordinary owner socket
after disconnecting the setup GM; native active-user data confirmed no existing
full-GM client online. The headless service account was not substituted for
the player. This proves this generation's document acceptance, not native
browser hook/system combat automation.

Live HTTP verification covers GM/Assistant creation/policy/Begin/turn controls,
inactive own-only phase visibility, non-owner manager denial, hidden-row
omission, automatic module initiative, manual zero/fraction, shared-owner stale
rejection, Close/reopen generation rejection, GM score clear, Begin closure,
owner End my turn and disabling it. A real mobile player browser then exercised
pre-Begin automatic/manual-zero submission with the displayed D&D formula,
phase-close retirement of an open dialog, Your turn indication, hidden roster,
End my turn and policy disable. No page errors occurred. Fixture-only issues
were corrected: missing imported-world setup cache, and relying on native
create-result ordering rather than finding users by name. Neither prompted an
application lifecycle or permission workaround.

Cleanup verified removal of marked users/Actors/Combats/chat/folders and restored
the previous active Combat where applicable. Only the owned temporary
SheetDelver manager/children were stopped; local Foundry and the existing
31000/31001 stack remain running. The temporary credential file was removed.
No staging, commit, branch operation, remote write, tag or release occurred.

### Operator acceptance still required

1. With GM/Assistant plus two owners, open an inactive managed encounter's
   initiative. Only each owner's visible unrolled rows offer Roll; a non-owner
   gets no action. Try automatic and manual `0`/fraction totals. Shared owners
   cannot replace the first score; Close/reopen invalidates an old dialog.
2. Check Shadowdark's module-supplied keep-highest formula/theme, Mörk's d6
   fallback and D&D's d20 fallback: displayed formula, chat result and applied
   score agree. Explicit supported d20 overrides remain deliberate choices.
   These system switches were **not** performed on the supplied running world.
3. Begin closes initiative; advancing to an owned visible row highlights Your
   turn and offers End my turn. A non-owner/hidden row does not. Disable it,
   clear an initiative and reopen for a late arrival; inspect hidden copied
   enemies for absent rows/generated ordinals. Check narrow/desktop themes,
   sheet/footer/media overlay interaction and keyboard focus.
4. When convenient, restart the same world: Combat policy persists, a fresh
   login may be necessary. A brief same-world connection loss blocks then
   refreshes; world replacement/logout retires pending actions. Never replay
   a possibly successful roll. No world shutdown/restart was done in this run.

Before closing or shipping, resolve the v13 native-write evidence gate (or
explicitly decide a supported-generation restriction) and record operator
acceptance. Publishing still requires Core0.18.0 first, subsequent module
minimum promotion/released-host validation and an unused Mörk version.
All broader directed-roll/history/action-bar/native-bridge ideas stay deferred.

## Presentation correction — October 14, 2026

The user rejected the new initiative layout against the existing Shadowdark
sheet roller. Although the wrapper passed the module's `rollDialog` theme,
Core's initiative renderer appended rounded chrome, a Core-colored inset and
an unrelated wrapping action layout. Earlier color/contract checks did not
establish visual equivalence with the existing roller; operator acceptance
must not be inferred from them. The user also authorized equivalent native
presentation adapters for Mörk Borg and D&D, plus module docs/changelogs.

- Core `RollDialogFrame` extracts the existing SDK sheet roller's frame,
  header, X close control, body/footer and theme defaults. Sheet and bounded
  initiative modes reuse it. Theme classes own their surfaces without appended
  Core shape/color overrides; narrow option rows stack to avoid text clipping.
  Existing sheet inputs, callbacks and roll preferences are retained.
- Shadowdark's existing typed wrapper still calls injected SDK `RollDialog`
  with the same sheet theme. No module-private Core import or new roller.
- Mörk Borg registers its typed initiative adapter. It reuses the sheet
  roller's extracted native frame and Auto/Manual control, with the existing
  dark/pink styling. The formerly unregistered legacy initiative wrapper's
  Actor-formula calculation, local audience preference and raw-die conversion
  are not used. Sheet rules/raw-die behavior remain separate and unchanged.
- D&D registers a typed adapter sharing its sheet `RollModalFrame`, native
  `BaseModal`, field rows and roll buttons. Native dialog centering/scrolling
  is explicit against global CSS resets; close/unmount releases the dialog.
  Scoped narrow styles stack the HUD options without changing sheet rules.

All adapters consume `InitiativeRollModalProps`, display the supplied formula
and audience read-only, and return only a permitted roll choice or finite
manual **final total**. Zero/fractions do not invoke sheet modifier math.
No Actor/bonus/recipient editor, API/transport change, new SDK surface, version
bump or compatibility-minimum change is introduced. Modules with no override
continue using the shared Core renderer. Core's phase/ownership/identity
guards and execution remain authoritative.

Core unit/client/type/lint, all module tests and explicit module source typing
pass; all three isolated check/package runs pass. Actual module adapters and
scoped CSS are rendered at320/375/1280 in both Core appearances, including
default formula preservation, zero/fraction submissions and Escape behavior.
The same rendered fixture checks preserved sheet callbacks: Shadowdark ability
bonus/advantage selection, Mörk raw die (not final total), and D&D situational
bonus/native roll mode. Each module's stale phase retires its dialog without
submitting. These are offline checks, not new native integration evidence.
Fresh visual acceptance is still required. The earlier live D&D action/native
permission pass remains its own evidence; no Foundry/Core/dev service was
contacted or restarted for this presentation correction. No Git writes or
release operations were made; the broader v13/operator/publication gates stay
open.

## Next correction addendum — October 14, 2026 (approved, not yet implemented)

The user reports Shadowdark initiative displaying only `1d20`, expects the
appropriate Actor initiative modifier, and requests **Input Manually** instead
of Manual total. The existing module hook computes only a DEX-based formula;
the GM setting is still implemented as a lower-priority fallback. These are
separate from the completed presentation correction above.

The user confirmed the new precedence: **explicit GM override → module
formula → Core fallback**. No saved override means module-first; clearing it
restores that behavior. This supersedes ADR-0049's module-first GM-fallback
semantics for the shared world/module initiative preference. Preserve module
formula execution when no override exists; do not reinterpret module `@`
expressions through the GM-reference resolver. Rename the manager wording to
override; retain the existing preference field/endpoint unless a public route
migration is explicitly required and approved.

Before persistence, validate syntax, bounded roll grammar and numeric safe
references for current authorized managed participants; return actionable
inline errors without saving an invalid draft. Checking current Actors cannot
guarantee future participants/values, so revalidate at execution. An unresolved
explicit override must fail closed, not silently use module/Core instead.
Attribute-dependent formulas with no suitable current participants need an
explicit no-evidence error, not a misleading validation success. Validation
must not roll dice, create chat or borrow a service-account transport.

Investigate Shadowdark against native4.0.6 source/prepared data, including
player/NPC DEX handling, initiative bonuses and advantage. The installed native
4.0.6 `_ActorBaseSD._modifyRollData` derives initiative from DEX plus
`system.roll.initiative.bonus` and advantage; it does not establish the user's
`system.attributes.init.value` example as a native field. Verify field
availability rather than inventing a path or claiming source/browser parity.
Any module rule correction belongs in Shadowdark, not Core system-name logic.

Checkpoint first, as requested. Then implement these bounded corrections,
regress precedence/clear/invalid/missing-reference/participant-change cases,
update API/UI/module documentation, terse changelogs and handoff. No versions
or release operations are authorized. The current hardening/presentation
checkpoint must not be described as already implementing this addendum.
