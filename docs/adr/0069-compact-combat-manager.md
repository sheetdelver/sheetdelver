# ADR-0069: Compact combat manager and automatic late initiative

**Status:** Implemented — isolated acceptance and operator review passed; follow-up polish pending
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
