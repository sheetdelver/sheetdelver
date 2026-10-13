# ADR-0061: Managed Combat Player Participation

**Status:** Accepted — implementation underway; native/live acceptance pending
**Date:** October 13, 2026
**Related:** ADR-0013, ADR-0028, ADR-0038, ADR-0049, ADR-0057, ADR-0058,
ADR-0060

## Context and completed baseline

ADR-0060 is complete and user-accepted. It delivered the compact Core HUD,
authorized visibility and owned stats, ordinary-Combat command preconditions,
and SDK 3.0.0/UI API 3.0.0 initiative presentation. Managed encounters remain
view-only in that HUD by design; their manager commands require role-4 GM.
This ADR proposes the next slice, not unfinished work in ADR-0060.

The review found reusable foundations and two concrete correctness gaps:

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

Managed Combats remain inactive until Begin. The current list can include
owned forming rows, but the HUD filters on `active`; pre-start participation
needs explicit presentation, not early activation. Manager status `active`
means provisioned/editable and is distinct from Foundry's `active` bit.

Local Foundry v14 permission-source review indicates a feasible headless path:
player Combat updates permit round/turn but not parent flags/activation;
Combatant initiative uses Actor-derived OWNER permission, with Actor lookup
by `actorId` on the server. This is not yet live verification of managed
tokenless player writes. No online GM browser, GM impersonation or unsupported
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

## Proposed decision

### 1. Persist a small participation policy on the Combat

Extend the validated `flags.world.sheetDelverCombat` policy with an optional
player-actions block: initiative open/closed, an opaque phase generation and
whether owner End my turn is enabled. No second store or browser persistence.
The role-4 GM writes policy under the existing encounter guard. Player
responses write initiative/round/turn only, never GM-authored policy flags.

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
keep `/api/combat-manager` role-4-only. Distinguish ordinary HUD, managed owner
and GM-manager authorization internally, then call a shared executor once
under the encounter guard. A request body cannot select the privileged path.

| Caller/state | Managed initiative | Managed turn control |
| --- | --- | --- |
| Player/trusted player, owns visible world Actor | Own null score while phase open; automatic or manual final total | End current owned turn if enabled, active and started |
| Non-owner, hidden/missing/actorless row | No action; hidden and missing targets indistinguishable | No action |
| Assistant | Existing authorized tracker reads only | No manager privilege added |
| Role-4 GM | Existing manager roll/manual/bulk/reset controls; Open/Close phase | Existing manager Begin/Next/Previous; policy switch |
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
unchanged, including module-provided advantage/disadvantage. Proposed typed
choice: allow omitted `advantageMode` to mean preserve; keep explicit `normal`
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
consumers and SDK mocks together. Review the optional-mode contract's version
impact and release baseline before coding; no new version is assigned here.
If module edits are needed, obtain their branch/edit authority separately.

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

- [ ] **P0 — approve policy and prove the write boundary.** Review the phase
  lifecycle, public-vs-directed roll distinction, label treatment and SDK
  choice. Agree branch/release sequencing separately. In an approved isolated
  v13/v14 world, prove owner tokenless initiative and turn writes with no GM
  browser online, no service-account substitution and no parent flag writes.
  A failure blocks enabling player capabilities, not a reason to elevate.
- [ ] **P1 — shared correctness and authorization.** Correct default formula
  execution and player turn responses; add validated durable policy and one
  guarded action path. Test absent/malformed flags, module/GM/Core formulas,
  module keep-highest/lowest preservation, non-d20, fractional/manual input,
  duplicate owners/tabs, GM concurrent updates, score clear and phase reopen.
  Test hide/remove/ownership loss, cleanup, policy disable and session/world
  replacement at asynchronous boundaries. Denied/stale preflight has no side
  effects; later/unknown failure never claims success or rerolls automatically.
- [ ] **P2 — manager and player UI.** Add Open/Close, GM roll progress and End
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
