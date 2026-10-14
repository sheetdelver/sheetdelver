# ADR-0061: Managed Combat Player Participation

**Status:** Accepted — N1/N2 and N3 flag control operator-accepted; N4–N6 proposed refinements and generation/release gates open
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

Original scope kept module-first selection and GM-fallback reference substitution;
the approved October 14 formula addendum below supersedes precedence with an
explicit GM override first. Module expressions still remain unchanged;
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
| P2 manager/player UI | Baseline and N1/N2 operator-accepted; N3 Defeated/Restore matches details | N4 compact grouping, N5 rich content/module suggestions and N6 explicit Skip proposal below |
| P3 integration/operator | v14 native/multi-role evidence and automated race checks; user accepts baseline and the latest queue/pause/stat checks | New N4–N6 acceptance after implementation; v13 remains deferred to the final pass; no new explicit shared-owner/manual-total operator result was supplied |
| P4 docs/release | Contracts, module-owned notes, feature-snapshot changelog and handoff updated; approved local checkpoints saved; new Core work uncommitted | Core-first release, module minima/unused versions, released-host CI/package checks and final closeout |

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

### Operator checklist presented before the latest acceptance

The October 14 acceptance/addendum at the end of this ADR supersedes the
pending operator items below where explicitly accepted; retain this list as
the test definition, not a request to repeat completed checks.

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

## Formula correction addendum — October 14, 2026 (approved; completion below)

At the presentation checkpoint, the user reported Shadowdark initiative displaying only `1d20`, expected the
appropriate Actor initiative modifier, and requests **Input Manually** instead
of Manual total. At that point the module hook computed only a DEX-based formula;
the GM setting was still a lower-priority fallback. These are
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

## Formula correction follow-up — October 14, 2026

The user-authorized local hardening/presentation checkpoint was committed first
on the existing Core and three module branches, with this addendum recorded as
pending. The following changes are implemented afterward, still uncommitted
and awaiting operator acceptance. No branch/version/remote operation or live
service contact accompanies this correction.

- Shared resolution is now **explicit GM override → module formula → Core
  `1d20`**. An override bypasses the module hook; clearing restores module-first
  selection. Invalid/missing GM references disable automatic rolling rather
  than falling back. Module expressions are not rewritten by the GM resolver.
  The stored `initiativeFormula` and legacy `initiative-fallback` URL remain;
  their new override semantics are explicit in API/UI/module-authoring docs.
- Saving first validates the restricted additive dice/number/reference grammar
  and the same bounded server parser used for execution, without evaluating
  dice or consuming RNG. It resolves every distinct authorized Actor in active
  managed encounters, including hidden/scored participants, not a sample or
  unrelated world scan. No participants means a referenced formula cannot be
  certified. A missing/non-numeric/path/limit error leaves the previous file
  unchanged. Caller role/user/world/runtime/transport is rechecked after the
  system dependency; no await separates final participant checks and storage.
  This is a current cache snapshot, not a promise that future Actors or native
  mutations cannot invalidate it; execution retains the current-value guards.
- Manager wording is override, with a field-level accessible validation error
  and retained invalid draft. Saving/clearing refreshes the current preview.
  Core/Shadowdark, Mörk and D&D HUD adapters say **Input Manually**, still meaning
  a final total. Mörk's sheet-only Auto/Manual wording/raw-die math is unchanged.
- Shadowdark's module prepares initiative from effect-applied Player DEX score
  (native −4…4 modifier), explicit NPC DEX modifier, initiative bonus and signed
  advantage. Its hook consumes that prepared value rather than stale serialized
  Player `.mod`, and handles modern zero/disadvantage plus legacy advantage
  arrays. `derived.initiative.value`/`advantage` are module-owned prepared fields;
  no source Actor write or Core system-name logic is introduced. Native 4.0.6
  source (`_ActorBaseSD`, Player/NPC models) establishes these rules, not
  `system.attributes.init.value`. That sample path is usable only if actual
  Actors provide it. Existing supported numeric effect handling is reused;
  arbitrary native hooks/effect parity are not certified.

Core unit/client/integration/type/lint checks pass. Unit regressions prove
precedence/clear, unresolved override fail-closed, unchanged module references,
zero/fractional attributes, bounded parsing without RNG, all-encounter hidden/
scored validation, no-evidence and invalid-input persistence protection,
Assistant access, and role/session/world/transport changes during awaits.
Shadowdark tests cover Player/NPC modifiers, bonuses, enabled/disabled numeric
effects, legacy/modern advantage, zero/negative bounds and source immutability.
All ten module tests, explicit three-module source typing and three isolated
check/packages pass. The actual-component offline browser fixture checks
**Input Manually** and preserves native sheet callbacks, plus manager invalid
draft/error, valid save and clear. No native permissions are inferred from it.

Operator checks for this correction:

1. With no override, inspect a Shadowdark Actor with known DEX/initiative bonus:
   displayed formula, chat and applied score agree, including an NPC and any
   applicable advantage/disadvantage. HUD uses the existing themed frame.
2. Save a deliberate override (`1d20+2`, or a verified numeric path such as
   Shadowdark `1d20+@derived.initiative.value`): manager/HUD use GM source even
   when a module provides its own formula. Clear/save restores module source.
3. Try an invalid expression or missing path: inline error, draft retained and
   old preference unchanged. Later Actor/reference changes disable automatic
   rolling rather than selecting another source. Confirm **Input Manually**
   still applies zero/fraction final totals without additional modifiers.

The prior v13 evidence/support decision, broader operator acceptance and
Core-first publication gates remain open. No new release/minimum was selected.

## Operator refinement addendum — October 14, 2026 (implemented; subsequently user-accepted below)

The user reports that Shadowdark still omits a zero initiative modifier and
requests explicit `1d20+0`, plus a searchable numeric attribute picker to insert
safe `@system`/`@derived` paths into the manager's formula draft. The zero branch
is corrected with zero/advantage/disadvantage regressions. The
picker reuses the existing bounded stat catalog, now retaining resource numeric
leaves as well as aggregate display fields. It inserts a reference at the
cursor/selection without saving or evaluating; existing server validation
remains authoritative. Choosing an attribute does not invent system dice rules;
the GM authors the dice expression. Only observed numeric leaves are offered,
not resource objects or text. Discovery is lazy, with current loading/search
state, and insertion restores focus while respecting selected text.

The user also requests validation of manually added custom stat paths, rejecting
unsafe, absent or mismatched fields before adding them. A read-only manager
`POST /api/combat-manager/stat-preferences/validate-path` now checks current
user/world/runtime scope, source-authorized prepared Actors and selected value
type; it returns only path/kind/observed types, never Actor IDs/values. Exact
lookup is not limited by catalog sampling. Zero/negative values and supported
resources/text are accepted; unsafe/missing/mismatched paths reject before
adding. UI explains missing label/path, retains invalid input with inline
errors, and ignores late responses after edits/configuration/world retirement.
Adding enters only a local stat draft; Save remains the persistence action.

Investigation found an existing eight-selected-stat cap in both UI
and shared validation, distinct from Foundry permissions or Actor counts.
ADR-0049 describes bounded display fields but does not document why eight was
chosen. The authoring reference also documented eight, but without a rationale.
The user explicitly approved its removal: **GM display selections have no fixed
field-count cap**. If a future count limit is necessary, document its evidence
and obtain a product decision rather than silently imposing it. Module metadata
still permits at most 16 suggestions; field-shape/key/path/label/type/editability
validation, catalog discovery bounds, normal HTTP limits and the existing
256000-byte preference-file limit are separate safeguards. The compact HUD's
three-stat presentation remains unchanged. GM parsing/persistence no longer
inherits the metadata ceiling or truncates defaults at eight. Unique generated
keys remain valid for longer lists. The byte guard now rejects an oversized
write with 413 before replacing the file, avoiding a file that its own reader
would subsequently reject. No new arbitrary count replaces eight.

Core unit/client/integration/type/lint pass. Tests verify 32-field persistence/reload,
independent 16-suggestion metadata bounds, oversized-file preservation, exact
custom lookup outside catalog samples, GM/Assistant authorization, HTTP error
status/whitelisted responses, and retired role/session/world/transport during
reads. Rule tests cover explicit normal/advantage/disadvantage `+0`. The offline
actual-component browser proves lazy numeric discovery, safe leaf filtering,
search/cursor replacement/focus, narrow/dark/light controls, custom path/type
rejection, a ninth/tenth stat plus Save, and stale custom-response suppression.
All ten module tests, explicit source typing and three isolated check/packages
pass. Dark/light screenshots were inspected after Core palette transitions
settled. These use isolated data/mocked API, not new Foundry integration or operator
acceptance. Existing broader native/v13/publication gates stay open.

Operator checks: confirm zero is visible in Shadowdark's manager preview/HUD;
type `1d20`, use **Insert attribute** to choose a real numeric path, then Save;
check manual custom fields with valid/missing/wrong-kind paths and add/save/reload
more than eight selections. This addendum is not ADR closeout, a version bump
or authorization to commit/push. Existing checkpoint and subsequent uncommitted
work are preserved.

## Operator acceptance and late-entry/stat addendum — October 14, 2026

**Documentation-only checkpoint.** The user visually accepts the refinements
and reports checklist **1 (formula/settings), 3 (module rollers), 5 (privacy/
layout), and 6 (persistence/recovery)** verified. Existing turn controls in
item 4 are accepted, except the late/cleared initiative discovery and queue
gap below. Item 2 confirms Close retires the modal; the user questions zero/
fractional totals rather than reporting a new manual/shared-owner test.
Do not turn that question into acceptance or a new positive-integer rule.
These are operator reports, not a new agent-run integration pass. Earlier
v14/native/offline evidence remains valid within its recorded scope.

### N0 — numeric initiative evidence (review complete)

Foundry itself permits zero and fractional initiative. Read-only inspection of
local v13/v14 `common/documents/combatant.mjs` finds `initiative` declared as
`NumberField({required: true})` without integer, positive, min or step overrides.
Both versions' `common/data/fields.mjs` default to `integer: false`,
`positive: false`, unset min/max/step and nullable numbers; validation accepts
finite numbers. Therefore **null means unrolled; zero and finite fractions mean
scored**, including negative finite results. Do not round, use truthiness or
impose a system-agnostic positive-only restriction. A system's dice/rules may
produce a narrower set, but that is not Foundry's document-field constraint.

Official references: [v14 Combatant data](https://foundryvtt.com/api/interfaces/foundry.documents.types.CombatantData.html),
[v13 BaseCombatant schema](https://foundryvtt.com/api/v13/classes/foundry.documents.BaseCombatant.html#defineSchema),
and [NumberField options](https://foundryvtt.com/api/classes/foundry.data.fields.NumberField.html).
Public docs identify the numeric field/options; the local schema/defaults
establish the absence of those restrictions. The earlier v14 HTTP pass already
accepted manual zero/fraction writes. No Foundry service was contacted in this
review, and schema inspection does **not** close the v13 owner-write gate.

### N1 — discoverable owner initiative and a separate pending queue (implemented; operator-accepted)

The user reports that a late-added or cleared owned character at the end of the
roster offers Roll only after expanding the entire list. Add a compact bar cue
while the phase is open: one eligible character offers **Roll initiative**;
multiple eligible characters offer an accessible owned-character chooser.
It must work with the roster collapsed and when the caller has only pending
owned rows. No automatic modal, timer, polling, repeated notification or roll
replay. Each choice uses the existing server capability, observed phase and
module/Core dialog. Hidden/non-owned rows and other players' pending counts
never enter this cue; Close, scoring, hide/remove, ownership/session/world
changes retire it and any stale dialog under the existing boundary.

For **SheetDelver-managed** encounters, distinguish the GM participant list
from the executable queue and player turn roster:

- An unrolled addition or cleared score stays in the GM list, **after all
  scored participants**, visibly awaiting initiative. Preserve deterministic
  ordering within that pending section; do not delete the Actor/Combatant.
- Pending rows are absent from the player's turn roster/current/next preview.
  Only an eligible owner's separate initiative cue may expose their own
  pending character. Once scored, the row joins initiative order, subject to
  normal hidden/ownership projection. This applies before Begin as well as
  to late arrivals after Begin; pre-Begin redaction still remains own-only.
- Late NPC additions default to **hidden on the created Combatant**, classified
  by the existing native-style non-GM ownership test, not system Actor-type
  strings. Scoring does not reveal them: the GM explicitly uses Reveal.
  This default is for late additions to a started encounter, not a migration
  or blanket visibility change to existing/unstarted participants.
- Begin, Next, Previous, owner End my turn, turn repair and next previews use
  the same managed eligibility rule: **finite initiative required**, plus the
  existing defeated-skip policy. Hidden scored NPCs still have real GM turns;
  hiding is not a global queue-exclusion rule.
- Map the selected eligible Combatant back to its **full native order index**
  for caller-bound writes. Do not filter the shared raw/prepared order and
  then write the filtered index to Foundry. Retain ordinary/native Combat
  behavior; implement the managed policy once in shared server orchestration.
- Adding/scoring a different participant preserves the current Actor identity;
  it does not steal a turn or automatically begin combat. A newly scored row
  joins its score position and becomes reachable through subsequent navigation.
  If no eligible rows remain, show **Awaiting initiative** and disable turn
  advancement rather than cycling pending rows or incrementing rounds.

**User-confirmed clearing policy:** clearing the *current* character's score
removes it from executable/player turn state and **pauses with Awaiting
initiative until the GM acts**. No implicit turn/round advancement or owner
End my turn while paused. The GM can choose Next (skipping pending rows) or
set a score; neither an owner roll nor scoring an unrelated pending row silently
releases the pause. Preserve enough native/validated Combat state to keep it across
refresh/restart and resume deterministic navigation, not a browser-only latch.
Test current/all-score clear, subsequent scoring and round-wrap behavior;
pending regrouping alone must not increment a round. This supersedes the old
promise that reset never changes executable current-turn state.

No second pending ledger or permanent placeholder is required: derive pending
from current initiative and policy. Audit roster selection, manager controls,
HUD-only-pending encounter retention, role-filtered DTOs, all queue consumers
and score/reset/remove synchronization before editing shared helpers.

### N2 — one stat editor and configurable detail layout (implemented; operator-accepted; N5 extension proposed)

Provide **Text**, **Value / Max** (existing resource representation), **Number**
and **Textarea** choices in a reusable Add/Edit attribute editor. Textarea
displays an Actor string as multiline **plain text**, preserves newlines and
wraps long content; never treat arbitrary Actor text as HTML. Retain exact
safe-path/type validation. Textarea is a display option, not authorization to
edit Actor text: numeric/source-resource editing and health constraints remain.

Allow each selected stat's label and presentation to be edited in place or
through the same shared Core editor. Keep its stable key/order, roster/health/
editable choices where still valid, and revalidate incompatible kind/path
changes. Editing an existing selection must replace it, not append a duplicate.
Keep persistence in the existing shared world/module preferences under data/
config, with the current configuration Save action; editor apply/cancel changes
the draft and is clearly distinguished from saving the configuration.

Configure **column span and row span** in the participant detail grid, including
textarea's visible text rows/height. Content beyond that viewport scrolls
vertically inside the field with keyboard-accessible focus, not by stretching
the entire page. Use explicit supported grid dimensions and responsive span
clamping/stacking on narrow screens; do not invent another selected-stat cap.
Missing layout metadata uses the current layout. Preserve the compact HUD's
three-stat limit and concise roster pills; multiline content belongs in detail,
not an expanded HUD/pill. Decide concrete metadata names/ranges at implementation
and document their purpose; no arbitrary large/unvalidated CSS spans.

Add optional GM-selection presentation metadata without silently changing
`info.json`/SDK module suggestion kinds. Existing module declarations stay
number/text/resource. If module-authored textarea/layout hints are later needed,
review/version that contract separately. Existing byte/HTTP/security safeguards
remain; ensure absent/new metadata round-trips and cannot bypass write guards.

### N3 — roster Defeated toggle (implemented; flag control operator-accepted; N6 Skip extension proposed)

Add an accessible **Defeated / Restore** toggle beside Hide/Roll/Clear on each
manager Actor row. Reuse the existing caller-bound Combatant `defeated` update,
which already exists in participant details and the manager API; no new Actor
HP/dead-condition automation or player write lane. Use pressed state, pending/
disabled feedback, refresh reconciliation and the existing native GM/Assistant
permissions. Keep detail/row/HUD state consistent and test the configured
skip-defeated behavior. An Actor-derived dead status may still make effective
defeated true after clearing the explicit Combatant flag; do not pretend the
toggle removes native effects or expand into system condition management.

### Next checkpoints and acceptance

- [x] **N0:** record operator acceptance and numeric schema evidence; preserve
  existing source changes. This pass changes documentation only.
- [x] **N1 implemented and offline verified:** compact own-pending cue and shared managed queue
  policy, including the confirmed current-score-clear pause. Test late Player/NPC,
  NPC hidden default, clear/re-score/reveal, multiple owned pending characters,
  collapsed HUD, last/all eligible removal, round wrap and native-index mapping.
  Assert no hidden IDs/counts/ordinal leaks or automatic modal/roll replay.
- [x] **N2 implemented and offline verified:** shared Add/Edit stat presentation and persistent
  textarea/layout metadata; test all four kinds, type rejection, edit/cancel,
  stable order/keys, reload/two-GM synchronization, scrolling/keyboard and
  narrow/desktop light/dark. Preserve read-only text and existing health guards.
- [x] **N3 implemented and offline verified:** expose the row Defeated toggle; verify detail/row reconciliation,
  native failure/stale handling and skip-defeated interactions with pending rows.
- [x] Re-run affected Core/module checks; current evidence is recorded below.
- [x] User accepts N1/N2 and N3 row/detail Defeated/Restore reconciliation in
  the October 14 follow-up below. Explicit per-participant Skip is new scope,
  not an already-implemented or accepted N3 capability.

ADR-0061 remains open. The v13 native-write/support decision and Core0.18.0-first
module publication gates remain unchanged. No new SDK version, release number,
branch, commit or live-test permission is implied. General reminders, directed
roll requests, ledger/history, action bars and native bridges remain deferred;
only this bounded owned-initiative reminder is brought into scope.

## N1–N3 implementation follow-up — October 14, 2026

The user authorized a local checkpoint of the accepted formula/stat/module work
**before** continuing. Core and all three module checkpoints were committed;
no push, branch change, version/tag/release or subsequent commit occurred.
The user explicitly defers **v13 verification to the final pass**; it remains
a gate, not waived or claimed complete. The following new Core work is
implemented and uncommitted. The subsequent operator follow-up below records
acceptance and new proposed refinements; this section preserves its original
implementation/evidence scope.

### Shared queue, durable pause and compact cue

- `CombatTurnQueue` centralizes managed finite-score/defeated eligibility and
  maps Next/Previous to native full-order indexes. Ordinary Combats/read-model
  order remain unchanged. No eligible scored rows means 409/no turn or round
  write; manager navigation is disabled. Hidden scored NPCs retain real turns.
- Late linked NPCs use existing non-GM ownership classification; late private
  pack copies also start hidden. Both await initiative at the end of the GM
  list and require explicit Reveal after scoring. No migration/Actor visibility
  change. Players see only scored visible turn rows plus a separately enriched
  `initiativeCandidates` collection for their own visible pending targets while
  the phase is open. GM/Assistant HUDs retain their full roster; previews skip
  pending/appropriately defeated rows. A pending-only owner encounter remains
  selectable; hidden-only/non-owner pending encounters do not gain a slot.
- The compact bar offers Roll initiative independently of the expanded roster,
  with a chooser for multiple eligible owned characters. It reuses the current
  module/Core modal and observed phase. Candidates take part in stale Actor/
  score/phase retirement; no polling, auto-modal or action replay was introduced.
  Multiline stat detail is excluded from owned HUD chips.
- Clearing/resetting the started current score first persists `turn: null` and
  a validated `turnPause: { combatantId, initiative }` anchor containing its
  previous ordering position. This survives cache rebuild/refresh/restart and
  hides current identity/owner End-turn without exposing a player pause marker
  for hidden Actors. Unrelated scores and owner rolls cannot resume it. GM
  Next/Previous resumes by the saved position; explicit GM manual/single/batch
  restoration of the anchored score can resume it. A successful restoration
  clears the flag with **null**, not omission (native flags merge objects).
- Pause-before-clear is deliberately fail-safe, not atomic: if the score write
  fails, the old score can remain while the encounter stays paused. Refresh and
  recover through explicit GM action. A failed/uncertain roll never resumes
  through the automatic-success path. Post-score owner identity/scope checks
  still run when there is no current row to repair.

### Stat editing/layout and Defeated rows

- `CombatStatAttributeEditor` is the single Add/Edit form. Apply changes replaces
  the existing key in the configuration draft, preserving order and compatible
  roster/editable/health choices; Cancel discards the editor draft. Existing
  configuration Save persists, not Apply. Incompatible kind/path changes clear
  writable/health placement, exact path/type validation is reused, and stale
  checks cannot add changed/retired fields. Draft controls are gated during
  verification. Save/reset now pin caller/world/runtime through system reads;
  invalid selected metadata yields 400 without replacement.
- Core GM kinds are number/text/resource/**textarea**. Long/multiline Actor
  strings are discoverable; textarea also accepts an existing empty string.
  Projection preserves plain text/newlines instead of short-text truncation.
  A read-only native textarea provides keyboard scrolling; no rich HTML, text
  writes, roster pill or default-health capability. Module suggestion kinds
  remain number/text/resource, with no SDK/API/minimum bump.
- Optional `layout: { columnSpan, rowSpan, textRows }` persists with the shared
  world/module selection. Supported integers are **1–3 columns**, **1–6 grid
  rows**, **1–12 visible text rows**. Columns follow the actual three-column
  detail grid; row/viewport bounds prevent pathological page-sized spans.
  These are documented presentation safeguards, not a stat-count limit.
  Absent metadata retains one cell/four text rows; narrow screens stack spans.
- Roster Defeated/Restore reuses native-authorized Combatant PATCH. The DTO
  separates explicit `defeatedFlag` from effective defeated state: clearing a
  flag does not remove an Actor's dead effect. Row/details update from refreshed
  server state, with existing busy/error handling and no HP/condition automation.

### Automated evidence and remaining operator checks

Core full unit/client/integration, TypeScript and lint pass; all ten module
tests, explicit three-module source typing, three compatibility checks and
isolated package builds pass. Package fixture sources were compared to the
current module checkpoints. Unit regressions cover pending-only/redacted reads,
late NPC classification, native index mapping, zero eligibility, cache-rebuild
pause persistence, owner/unrelated-score non-resume, safe failed clear,
round wrap and defeated skipping. Existing concurrency/identity/partial-result
tests remain green. Stat tests cover old/new record round-trips, module-kind
isolation, malformed layouts, string/type validation, plain-text preservation
and scope retirement during save/reset.

The retained offline browser fixture renders actual components/CSS at
320/375/1280 in both themes. It checks the collapsed multiple-owner chooser,
pending-only phase, existing module dialogs/keyboard/stale/ordinary controls,
eleven-field Add/Edit/Save without duplicates, multiline scrolling/responsive
spans and Defeated/Restore. Narrow dark/desktop light detail screenshots were
inspected. Browser API projections are mocked; this is **not** new native
Foundry acceptance. No application/Foundry service was started or contacted.

For operator acceptance, verify only these additions:

1. In a started encounter, add one/two player-owned characters and a linked/
   copied NPC. Pending rows sort last and Next/End turn skips them. The NPC
   starts hidden, remains hidden after scoring, and appears only after Reveal.
   Owners can roll through the compact bar with the roster collapsed; a score
   inserts the character into order without stealing the current turn.
2. Clear a non-current score, then the current score. The former waits pending;
   the latter pauses. Refresh/restart while paused, roll as owner or score an
   unrelated row: it must stay paused. GM Next resumes from the prior position
   without a spurious round increment, or GM restoring the anchored score
   resumes that character. Clear all: no navigation until an eligible score.
3. Add/edit Text, Value/Max, Number and Textarea fields. Change labels/spans/text
   viewport, Apply/Cancel and Save/reload; other GMs see saved settings. Long text
   scrolls and does not become writable or a HUD/pill. Check narrow/desktop and
   both themes, type errors, existing health flags and no selection count cap.
4. Toggle row Defeated/Restore and compare participant details. Check configured
   skip-defeated navigation; Actor dead effects remain independent of the flag.
5. After refinement acceptance, finish the v13 native-write/support gate and
   separately approved Core-first publication/minimum/version checks.

ADR stays open. Documentation/audit/single queue/handoff and terse feature
snapshot are updated; accepted baseline checks need not be repeated by default.

## Operator confirmations and proposed N4–N6 refinements — October 14, 2026

**Documentation-only follow-up; no new implementation or automated/live run.**
The user confirms checklist 1 (pending/late queue and compact Roll cue), 2
(pause until GM acts), and 3 (stat editor/layout). Checklist 4 confirms that
Defeated/Restore matches participant details, but reports defeated NPCs are
not skipped. That does not establish the world's tracker-setting value.
Source review confirms current managed navigation uses the world-wide
`core.combatTrackerConfig.skipDefeated` setting, default off; there is **no
per-participant Skip control** yet. The screenshot also shows insufficient
separation between current, next, own-character stats and the own Roll action.

### N4 — compact, distinct HUD regions

Keep the thin, full-width strip; do not return to tall cards. Separate **Current
turn**, **Next shown** and **My character** into clear, labeled regions using
theme tokens, restrained dividers/background contrast and spacing. Emphasize
the current identity and retain the accepted **Your turn** treatment; next is
secondary. Player wording remains *Next shown*, not a promise about hidden
queue positions. Round/encounter context and roster/GM controls remain distinct.

Group owned-character stats, sheet shortcut and initiative action together,
making the Roll target explicit without the current detached duplicate name.
Multiple owned/pending characters must still have an unambiguous accessible
target selector; the displayed stats and Roll action must not silently target
different Actors. Preserve collapsed pending discovery and existing capabilities.
On narrow screens, wrap these groups in the same reading/focus order, not one
undifferentiated line. Retain portraits, touch targets and both themes without
adding polling, prompts, private counters or module-specific action bars.

### N5 — sanitized rich detail and declared module defaults

Current textarea preserves **plain text**; HTML rendering and module-authored
textarea/layout defaults are **not implemented**. Propose an explicit textarea
format choice, `contentFormat: "plain" | "html"`, default plain for absent/old
records. HTML mode displays sanitized rich content in the same bounded,
keyboard-scrollable detail viewport. Plain mode preserves literal angle brackets
and newlines; do not guess format with a regex or treat every string as HTML.
Neither format authorizes Actor text writes, roster pills or HUD rich content.

Reuse `src/shared/security/safeHtml.ts` (`sanitizeRichHtml`) and Core's sole
`SafeHtmlContent` rendering boundary, not a second sanitizer or unreviewed raw
HTML insertion. Authorize the Actor/current scope first; sanitize the selected
HTML before DTO delivery, then cross the client sanitizer boundary before
rendering (JSON strings are not branded `SafeHtml`). Non-GM projections must
exclude unrevealed secret sections **before transmission**, if such a detail
projection is ever provided. Retain existing URL/tag/image allowlists and safe
relative Foundry URL resolution. Static formatting is not a Foundry enrichment
runtime: no hook execution, dice/document-action delegation, embedded documents,
new permission grants, scripts, inline event handlers or arbitrary CSS. Scope
rich styles to the detail viewport; test tables/images/long content and safe
empty/failure rendering so Actor markup cannot disturb surrounding controls.

Extend `ModuleCombatStatAttribute`/`info.json` `combatTracking.attributes` with
optional **textarea**, the same validated `layout` defaults/ranges, and textarea
`contentFormat`. Number/text/resource, `actorTypes` and `showInRoster` continue
unchanged; textarea remains detail-only. Module defaults seed an unconfigured
selection or an explicit **Reset to module suggestions**; they do not overwrite
saved GM choices. Module and GM metadata must share validation, defaults and
round-trip tests rather than diverging parsers. Missing/wrong-type Actor paths
retain current validation/omission behavior; suggestions are not permissions.

Illustrative **proposed, not currently supported** module descriptor (the actual
Actor string path must be verified for that module):

```json
{
  "key": "description", "label": "Description", "path": "system.description",
  "kind": "textarea", "contentFormat": "html",
  "layout": { "columnSpan": 3, "rowSpan": 2, "textRows": 6 }
}
```

Before implementing/publishing the manifest extension, record the appropriate
SDK/module-api contract revision and required Core host. Current module-api
1.3.0 does not promise these new descriptors. Preserve old modules and the
Core0.18.0-first release plan; no version bump, compatibility promotion or module
publication is authorized by this documentation pass. Inventory all suggestion,
reset, persistence, discovery, projection and packaging consumers first.

### N6 — explicit Skip, separate from Defeated/Hidden

**User-confirmed policy:** add **Skip** beside **Defeated** in participant details
and as an accessible quick row toggle. One persisted per-Combatant Skip boolean
controls managed turn exclusion; it is not an Actor condition or a separate
derived automatic-skip layer. The GM/authorized Assistant may explicitly Skip
any participant, including a player-owned character. Defeat alone must never
automatically Skip a player-owned character.

Add a per-encounter GM configuration checkbox **Skip defeated enemies
automatically**, **off by default** for new/old encounters. When enabled,
marking an NPC defeated also sets that same Skip flag. The GM can uncheck Skip
in the row or details while leaving the NPC defeated; reads, refetches and
refreshes must not re-check it. **Restore clears Skip for that NPC**, as confirmed
by the user. This is an explicit NPC Restore action, not an automatic change to
player/manual skips or Actor dead effects. Classify NPCs through the existing
non-manager ownership rule, not system Actor-type names. Changing Hidden or
initiative does not change manual Skip.

Implement this through validated manager Combat/Combatant flags and the existing
operation-specific, caller-bound writes. Defeated+Skip must use one authorized
Combatant update where possible. No read-side writes, GM impersonation, shared
ownership-helper expansion or player flag-write lane. Turning the configuration
off stops automatic assignment; it does not silently erase existing Skip flags.
Before implementation, settle and document whether enabling it also offers an
explicit apply-to-existing-defeated action and how external Foundry dead/defeated
changes enter this bounded write workflow. Do not invent a service-account
observer or continually reapply Skip after the GM opts out.

All managed consumers must share **finite initiative and not Skip** eligibility:
Begin, Next, Previous, owner End my turn, turn repair, previews and manager
navigation availability. A scored skipped row stays visible in the authorized
roster with its score/flags and can be Unskipped; unlike unrolled rows it is not
removed from the player roster by this rule. Hidden privacy remains independent.
Map eligible identities to full native indexes and retain no-eligible 409/no
round advancement. Propose pausing, not silently advancing, if the current row
becomes skipped; explicit GM Next/Unskip/Restore resolves it. Test this transition
alongside the accepted initiative-clear pause before exposing the new controls.

For managed encounters, these explicit flags replace the world-wide defeated
setting as the queue-exclusion authority; otherwise a player or manually
unskipped defeated NPC could still be excluded against the new policy. Ordinary
Combats retain their current Foundry-setting behavior. Old managed records default
to no Skip and automatic assignment off; no migration/read-side flag synthesis.

### Proposed implementation checkpoints / acceptance

- [x] Record N1/N2 and flag-only N3 operator acceptance and the Skip decisions.
- [ ] **N4:** group compact HUD regions and own target/action; test 320/375/1280,
  both themes, keyboard/focus, multiple owners, pending-only and hidden rows.
- [ ] **N5:** agree the additive SDK/module-api revision, implement validated
  format/layout suggestions and sanitized detail; test old/default records,
  Reset versus saved choices, wrong-type paths, secret/XSS/unsafe URL fixtures,
  overflow, and all affected module typing/compatibility/packages.
- [ ] **N6:** settle external/bulk assignment edges, implement one durable Skip
  flag plus default-off encounter setting and row/detail controls. Test explicit
  player Skip, NPC automatic assignment/manual opt-out/Restore, setting changes,
  current/all skipped, zero/fraction scores, round wrap, native indexes,
  concurrent GMs, failures, restart and ordinary-Combat non-regression.
- [ ] Re-run documented Core/module offline checks and obtain acceptance only
  for these new additions; do not repeat accepted baseline tests by default.
- [ ] Finish deferred v13 owner-write/support decision and separately approved
  Core-first release/module promotion before ADR closeout.

These are proposals for the next implementation pass, not completed behavior.
Existing uncommitted N1–N3 work remains preserved. No code, changelog feature
claims, stage/commit, branch, version, remote or live-service changes in this pass.

### Checkpoint and continuation approval — October 14

The user authorizes a local checkpoint of the accepted N1–N3 implementation
and N4–N6 planning, followed by N4–N6 implementation on the existing branch.
They separately approve the additive **SDK 3.2.0 / module-api 1.4.0** metadata
contract, with **Core 0.18.0** required for modules adopting it. UI/roll API
versions and application/module release versions do not change for this
approval. Existing modules remain compatible; publication/minimum promotion,
new commits after this checkpoint and live tests still require scoped approval.
