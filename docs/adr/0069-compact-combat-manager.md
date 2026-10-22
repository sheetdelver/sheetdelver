# ADR-0069: Combat manager and HUD usability, settings and initiative

**Status:** Completed — selected scope closed 2026-10-22; publication pending
**Date:** 2026-10-22
**Owners:** Core combat services and UI

## Context and scope

After accepting ADR-0068's reference viewers and two-row participant controls,
the user requested that encounter content appear without scrolling past creation,
configuration and participation panels. They also requested automatic owner
initiative for participants added after combat begins. This is a new follow-up;
ADR-0061's completed acceptance is retained as historical evidence. The policy
below supersedes its requirement to manually reopen initiative during combat.

## Decisions

- The header contains the encounter selector, **New encounter** and **Encounter
  settings**. Creation opens a modal containing name, retention and automatic
  defeated-NPC skipping. The existing creation endpoint and validation remain.
  Successful creation selects the new encounter; rejected creation retains the
  draft and displays the error inside the modal.
- Settings separates **This encounter** (player participation, owner End my
  turn, automatic defeated-NPC skipping) from **All encounters in this world**
  (stat display and initiative formula). Moving controls does not change their
  persistence scope or introduce global defaults. World preferences still use
  their existing Save/reset actions; encounter switches apply immediately.
- Player participation, including its progress count, belongs in settings.
  Open/Close player initiative is available only at round zero. Once a managed
  encounter has started and is active in Foundry, owners may roll visible,
  unrolled participants automatically, including late additions. Clearing a
  score also makes that row eligible. Zero is already rolled. Players still
  cannot reroll, clear, start combat, reveal hidden rows or author manager flags.
- The server enforces this policy, not just the hidden toggle. Requests to set
  `initiativeOpen` after start return409; changing `endTurnEnabled` still works.
  An inactive started encounter, completion, cleanup or deletion admits no owner
  initiative. Existing legacy flags need no migration or write on reads.
- One `playerInitiativeGeneration` helper determines the effective window for
  tracker projections and write revalidation. Active windows prefix the stored
  opaque generation with `active:` so pre-start observations cannot cross Begin,
  including externally observed starts. Core Begin/rewind also rotate the stored
  generation, even if the pre-start switch was already closed. The HTTP bound
  accommodates the existing128-character stored generation plus the7-character
  prefix. Clients must treat the result as opaque.
- Existing world/session, OWNER, hidden-row, Actor association, formula, score,
  encounter serialization and partial-write checks remain. Late initiative
  joins the existing queue without stealing the current turn. No rollback or
  native browser-hook equivalence is newly promised.
- `CombatManagerDialog` composes `RollDialogFrame` and `useModalFocus`, portals
  outside page layout, contains keyboard focus, closes with Escape and restores
  the opener. Busy requests prevent dismissal. Modals retire on world changes;
  opening settings adds no server writes. Existing native-runtime limitations
  move into encounter settings instead of occupying main-page space.
  Keyboard handling remains active if a saved/removed control leaves focus on
  the document body; the shared top-dialog guard still handles nested dialogs.

## Implementation and acceptance

| ID | Implementation | Required observable result |
| --- | --- | --- |
| CM69-01 | `src/client/ui/pages/CombatManagerPage.tsx`, `CombatManagerDialog.tsx` | Creation/settings are header dialogs; participant content appears near the top; all settings retain their scope |
| CM69-02 | `src/server/services/combats/combatManagerFlag.ts`, `CombatService.ts`, `CombatManagerService.ts` | Pre-start opt-in, active automatic owner eligibility, inactive denial, stale/duplicate rejection and preserved current turn |
| CM69-03 | `src/tests/unit/combat/combat-manager.test.ts` | Late world-Actor additions, score zero, ownership/visibility/completion/rewind changes during reads and legacy flags are covered alongside existing races |
| CM69-04 | `src/tests/acceptance/combat-manager-settings.browser.mjs` | Actual manager and production CSS at360/820/1440px; saved participation/settings, realtime Begin, rejected save/create, duplicate name, keyboard focus and world retirement |

The browser harness controls API/context responses and never connects to Foundry.
It does not establish fresh native or operator acceptance. Run with external
`PLAYWRIGHT_MODULE` and `CHROME` paths; screenshots go to
`COMBAT_UI_OUTPUT` (default `/tmp/combat-manager-settings`). Core's maintained
unit/client/integration suites, explicit TypeScript, lint and whitespace checks
remain the verification gates. No application or SDK versions change in this pass.
The user accepted this pass and authorized a local checkpoint on2026-10-22.
No remote operation or release is authorized.

Verification: maintained Core unit/client/integration suites, targeted combat and
public owner-route regressions, explicit Core typing, changed-file lint and
whitespace checks passed. The mounted manager acceptance above passed at all
three widths, and its screenshots were inspected. The existing reference-viewer
browser suite also passed all14 request transitions after the shared focus fix.
The full integration runner completed successfully, including existing migration
and lifecycle regressions. The user accepted the settings/participation cleanup and selected further
roster, picker and roll-dialog polish. Tests use
controlled sources and do not establish new native parity. No task services
remain running; the operator instance and Foundry data were untouched.

## Follow-up: roster, reference actions and initiative choices

The accepted settings/late-initiative pass is checkpoint `7f5d4c37`. The user
then selected this additional polish on the same branch:

- **CM69-05:** Roster portraits fill the identity area height. Reference links
  move out of rows into the selected participant heading as prominent buttons;
  this avoids a reference-only extra line. Actor picker thumbnails use the
  existing authorized choice image, with a fallback on missing/broken assets.
  Its scrollable list expands to the desktop column height and remains bounded
  in the stacked mobile layout. The Basic stats heading sits outside grid cells.
- **CM69-06:** Remove participant moves beside the selected detail action and
  retains the existing confirmation and removal semantics. Open Actor sheet is
  shown for native `Player`, `character` or `pc` types (case-insensitive). Player
  ownership does not turn an NPC into a PC. Other types offer View reference
  only when the module provider and readable original source are available.
  Unknown types do not receive an assumed character-sheet link. Ownership-based
  `isNpc` still controls batch NPC rules; it is not repurposed for UI routing.
- **CM69-07:** Single-row Roll/Reroll opens the shared Core initiative dialog,
  offering a manual final total and supported normal/advantage/disadvantage
  choices. Normal explicitly selects one leading d20; advantage/disadvantage
  replace that leading die mode while preserving the resolved bonus. These
  modes are absent for formulas that cannot support them. Unavailable formulas
  still permit manual totals. The separate detail advantage buttons are removed.
  Batch rolls and the player HUD retain their existing default-formula behavior.
- **CM69-08:** Manager projections expose native `actorType` and the resolved
  `initiativeRoll.formula`. Single-roll requests include the observed formula
  and score; the existing authoritative roll service rejects stale values before
  rolling. Manual totals use the existing expected-score update. The modal
  retires on participant/Actor, score, formula, visibility, encounter or caller/
  world changes. It closes before dispatch to prevent duplicate submissions.
  There is no arbitrary client formula override and no new SDK contract.

Verification extends `combat-manager-settings.browser.mjs` with actual page
controls, production CSS, PC vs owned-NPC actions, reference/removal placement,
expanded picker and row portraits, all four initiative choices, stale score/
formula retirement and manual-only fallback. `combat-manager.test.ts` exercises
all three modes through the real manager HTTP handler, resolved Actor bonuses,
new projection fields and malformed/stale observation rejection without rolls.
The user authorized closeout on2026-10-22. Isolated checks are not native acceptance.

Follow-up verification passed: maintained unit and client suites, focused combat
service/HTTP tests, explicit Core TypeScript, changed-application lint and
whitespace. Mounted manager acceptance passes360/820/1440 layouts and the new
flows above; desktop roster, mobile viewport and initiative dialog screenshots
were visually inspected. Integration suites passed at the preceding checkpoint;
they were not rerun for this bounded follow-up. No live Foundry writes or
operator-service changes occurred. New polish remains uncommitted; the user subsequently authorized documentation closeout.

## Final amendment and closeout — 2026-10-22

This amendment records the complete selected manager/HUD change, including the
later user corrections. It supersedes earlier pending-review wording and
ADR-0068's historical placement of reference links under every roster row.

| Requirement | Final behavior and completion |
| --- | --- |
| CM69-01 | New encounter and Encounter settings beside the selector; shared accessible dialogs; participation, stat/formula and skip settings moved off the main page |
| CM69-02–03 | Automatic late-owner initiative during active started encounters, guarded by the same server eligibility/generation checks; no manual reopening after Begin |
| CM69-04 | Actual manager/settings/create behavior, error handling, keyboard focus and retirement checked at360/820/1440px |
| CM69-05 | Full-height identity portraits, thumbnail Actor picker using the available desktop height, two-row controls, whole stat pills, no per-row source subtext or reference-only line; compact Basic stats heading |
| CM69-06 | Reference button and confirmed Remove participant in the selected detail header; sheet links only for native Player/character/pc types, optional reference otherwise |
| CM69-07–08 | One single-row initiative dialog: manual total or supported normal/advantage/disadvantage; resolved settings formula and observed score/formula validation; duplicate footer roll buttons removed |
| CM69-09 | Combat HUD Sheet/Base sheet uses current-tab Next Link navigation in `CombatHUDView.tsx`; the unrelated manager detail link retains its existing behavior |

The prior accepted settings/late-initiative checkpoint is `7f5d4c37`.
The user requested the HUD navigation correction, then explicitly authorized Core
ADR/document closeout. This is the closeout decision, not a claim of a new live
native test or user-verification result for every final control. Final manager
polish passed maintained unit/client suites, explicit typing, changed-file lint,
HTTP/service regression checks and mounted production-CSS acceptance with visually
reviewed desktop/mobile/dialog captures. The subsequent one-link HUD edit passed
component lint and whitespace checks. Full integration passed at the preceding
checkpoint; it was not repeated for that narrow UI/route follow-up.

No remaining implementation item in this selected Core scope. Publication and
committing the final working tree are separate operations. Core0.20.0 is the
recommended next feature release; release:tag owns package/lock updates. This UI
amendment does not introduce another SDK version beyond the unreleased SDK3.5.0,
module-api1.7.0 and UI-extension-api3.3.0 package/reference additions. DW-08 live
cards/actions and future Item-consuming product surfaces remain deferred.
