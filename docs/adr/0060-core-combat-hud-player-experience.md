# ADR-0060: Core Combat HUD Player Experience

**Status:** Accepted — implementation in progress; not yet operator-verified
**Date:** October 12, 2026
**Related:** ADR-0013, ADR-0027, ADR-0028, ADR-0038, ADR-0040, ADR-0049,
ADR-0053, ADR-0057, ADR-0058, ADR-0059

## Context

Core 0.17.0 has a shipped GM-only, tokenless Combat Manager and a separate
global Combat HUD. The HUD consumes `/api/combats`, backed by CombatStore,
the encounter read model and subject-specific projection. Combat/Actor/Scene
invalidations already refresh it; the shared player-world boundary owns
outages and terminal session/world transitions. These foundations stay.

The source review identified these correctness/integration gaps:

- Player rows omit hidden participants, but `hasHiddenCurrentCombatant`
  and the HUD's “Hidden combatant” label still disclose their existence and
  turn position. This violates the user's narrative-privacy requirement.
- Managed encounters advertise initiative to GMs in the HUD although its
  ordinary command route rejects all managed initiative calls. Managed HUD
  turn controls are already disabled; the player path is deliberately
  view-only under ADR-0049/0058.
- Generic initiative UI assumes Dexterity and exposes bonuses/visibility
  controls that are not consistently honored by its request. Module wrappers
  can recalculate formulas independently of the authoritative server resolver.
- Ordinary turn/initiative commands lack an observed-state precondition;
  one HUD's pending flag cannot prevent another GM/tab changing the target
  before submission. Current authorization is present, but staleness remains.
- A separate authorization edge occurs after ordinary rewind to round zero
  with `turn: 0`: the read model still resolves a current row, and projection
  and command guards allow its player owner to Begin. This contradicts the
  documented GM/assistant-only start policy and needs explicit started checks.
- Core theme tokens coexist with fixed dark/rose styling, small unlabeled
  controls, first-word names and no owner detail. A fixed high-layer HUD lacks
  shared clearance and can conflict with lower-layer dialogs; actual visual
  collisions still require rendered testing.

This is not native Foundry command parity. ADR-0028's implemented bounded
document-state progression, global active-encounter policy and source-backed
defeated semantics remain authoritative. The hidden-current disclosure from
ADR-0028 is explicitly revised by this proposal; its other boundaries remain.
Closed ADR-0049/0059 are not reopened.

## Decisions confirmed during design review

1. Use a compact **current turn / up next / my character** strip with an
   expandable roster, rather than an always-expanded carousel.
2. Preserve ordinary-encounter current-owner **End my turn**. This does not
   authorize player turn or initiative writes on SheetDelver-managed
   encounters; those remain deferred under ADR-0058.
3. Include a few read-only owned-Actor stats from the existing manager stat
   selection and a sheet shortcut. System-specific operations belong on the
   character sheet; no generic attack/spell action bar is requested.
4. Prefer retaining module HUD initiative presentation through the SDK,
   subject to the migration's scope. Do not silently replace a provided
   module surface. The detailed contract and version rollout below are
   proposed, not yet approved for implementation.
5. **Hidden means absent from the player's encounter view, not anonymized.**
   Hidden participants must not be represented by placeholders, counts or
   queue-position clues. GMs retain their identities and hidden indicators.
   This October 12 amendment replaces the draft's generic hidden-current
   placeholder and hidden-dependent “Up next: unavailable” design.

## Proposed implementation decision

### 1. One authorized tracker, with honest capabilities

Extend the whitelisted tracker projection, not the raw Store, with the
minimum presentation data needed:

| Data | Rule |
| --- | --- |
| Encounter kind and manager shortcut capability | Server validates the manager flag; only role-4 GMs get manager access. Use generic player labels/ordinals initially, not raw manager/scene names. |
| Owned-row and sheet-link capability | Independent of initiative capability; server checks ownership/read access. “Yours” means player ownership, not merely GM power. |
| Queue preview | GMs may see the actual next eligible row. Players consistently see **Next shown**, derived server-side from their visible ordered roster, never a hidden-dependent “Unavailable” slot. This is a visible-order preview, not a promise of the immediate next actual turn. |
| Owned stat chips | Bounded label/value/kind output only; no paths, edit descriptors, ownership maps, full `system` objects or manager DTO spread. |
| Initiative presentation | Formula/source and allowed actions from the same server resolver used by the manager; only for authorized ordinary-encounter rows. |
| Action observation | An explicit snapshot precondition for the target action; not an authorization token. |

Managed encounter HUD mutation capabilities must all be false. Add a GM-only
**Open Combat Manager** shortcut; implement/test selection by Combat ID if
deep-linking, rather than assuming the current manager already supports it.
Players/assistants never use manager endpoints. Ordinary GMs/assistants keep
existing start/next/previous controls; players only see their current-owner
End my turn and authorized initiative actions. Encounter selection stays local
and never activates a different Foundry Combat.

Both projection and commands must explicitly require a started, active
ordinary encounter for player End my turn; round zero is GM/assistant-only
even when a stored turn index resolves to an owned row.

Before Begin, managed encounters remain inactive and absent. Ordinary active
forming encounters retain the current own-rows-only player projection.
Completion/deletion/deactivation removes the HUD via the existing refresh
path. Hidden rows and their existence/position metadata stay out of player
projections; GM-visible hidden rows retain their
identity with a **Hidden from players** label. Defeated is a projected state,
not something the HUD derives from HP or system-specific effects.

#### Hidden-participant privacy amendment — October 12, 2026

The player projection must exclude hidden Combatants even when the player
owns the Actor. Do not send a hidden-current boolean, hidden Actor/Combatant
IDs, hidden counts, raw turn indexes, sequence gaps or a hidden reason in
capability/error/notification payloads. Retire the player-facing
`hasHiddenCurrentCombatant` distinction, not merely its text renderer.
Visible roster counts, encounter selector totals and queue previews must be
computed from the authorized visible view. Hidden-only encounters must not
create an empty HUD or an extra selectable encounter for a player.

For players, use a stable visible-only roster without a reserved current-turn
slot, mystery portrait, placeholder row, hidden-dependent round divider or
animation through omitted positions. Show **Next shown** consistently, even
when no hidden combatants exist; compute it from a visible reference row,
not the secret turn index. When the actual current combatant is not visible,
show the ordinary neutral encounter header without a current portrait,
queue preview or explanation specific to hidden activity. Use that same
presentation for other no-visible-current states. Do not falsely highlight
the last or next visible actor as current, grant End my turn, or skip hidden
turns in Foundry merely to keep the UI populated. Actual round/turn execution
remains unchanged and authoritative.

GM-authorized viewers retain full order, names, portraits and hidden tags.
Preserve existing assistant tracker-read policy; this does not grant manager
access. Hiding a previously visible row retires its HUD stats, pending dialog
and announcements; revealing it introduces a normal visible row. Do not create
player notices for hidden-only turns or changes, or send hidden-specific
socket hints/reasons. Review the projection, invalidation and observation
metadata together so a new counter or request precondition cannot undo
redaction. Existing tests which explicitly expect a hidden-current marker
describe old behavior and must change.

This is an encounter information-disclosure boundary, not a promise to erase
players' prior knowledge, revoke unrelated Actor-sheet permissions, conceal
real-world GM pauses or eliminate all network-timing inference. Those limits
do not justify explicit hidden indicators. Test player payloads and rendered/
accessible output, not just whether names are masked.

### 2. Share server orchestration, not GM endpoint authority

Add observed-state checks to ordinary HUD commands: turn requests identify
the observed round/current participant and relevant active/started state;
initiative identifies the row and observed initiative/formula context. Validate
against the latest authorized state before any chat roll or document write.
Coordinate Core-originated commands with an encounter guard, reusing/extracting
the manager's guard where appropriate without nested-lock deadlocks. Keep the
manager's internal command privilege unreachable from request bodies.

Reject stale observations with 409; refetch and require a deliberate new
action. Reject lost ownership/hidden/removed targets before side effects. Do
not queue actions across outages or blindly replay a roll after a timeout.
Preserve current-Combatant identity on initiative reordering using the existing
manager helper rather than creating another algorithm. This remains best-effort
Core serialization/preflight, not atomic compare-and-set with native Foundry
writes, exactly-once delivery or execution of native browser hooks.

### 3. Correct initiative through a bounded SDK presentation contract

Reuse `effectiveInitiativeFormula`: system adapter first, saved GM fallback
when absent, then the existing labeled Core fallback. Do not expand native
formula support, substitute module formulas differently, or hardcode abilities.
Core resolves and executes; the module presents. The HUD does not call the
manager UI or require any Foundry browser to be online.

Proposed typed inputs for `UIModuleManifest.rollModal`: open/close state,
combatant display label, server-resolved formula/source, automatic-roll and
advantage availability, manual-final-total availability and the effective
audience label. Proposed callback choices are **roll with an allowed mode**
or **manual final total**. No replacement formula, arbitrary bonus, recipient,
Actor path or transport comes from the modal. A finite numeric final total
supports fractional initiative; it is not a die face with a guessed modifier.
Use the existing roll/chat pipeline, clearly identifying manual input.

The shared SDK `RollDialog` should provide an initiative-specific mode using
this contract so modules can retain their theme without reimplementing rules.
Keep existing sheet-oriented modes/explicit theme props intact. Module
`rollModal` continues inside `SurfaceHost`; Core supplies the same-contract
fallback when the module declares none. Show a bounded loading/error state
with close/retry for module load failures, not an unhandled promise or a
silent bypass. Do not expose a visibility dropdown while the initiative
command retains its existing public/hidden-GM policy. Unsupported advantage
is absent, and manual input receives no advantage transformation.

**Compatibility checkpoint:** the current slot is typed only as an unknown
component, but it is a published extension and is used. Shadowdark currently
declares it; local Mörk Borg and D&D manifests do not. Shadowdark's wrapper
needs to forward Core initiative context instead of recomputing it. The
exported SDK `RollDialogProps` also disagrees with the injected component's
actual props; reconcile the touched contract and SDK mocks/tests together.
This is a recommended small migration, not a demonstrated patch estimate.

Changing required renderer inputs/results is a breaking UI contract change,
not justified as a private HUD cleanup. Before this checkpoint is implemented,
approve the canonical SDK/UI-extension versions and Core release sequence;
all three local modules currently require `ui-extension-api <3.0.0`, so a
major change affects their compatibility even without custom HUD rendering.
Coordinate separately authorized module branches/tests/minimum-host updates
and Core-before-module publication. Do not change compatibility metadata,
ignore a module override or weaken the installed-module gates by inference.
If this rollout is too large, explicitly defer the initiative-contract slice
and revise this ADR before shipping a smaller HUD pass; do not silently drop it.

### 4. Compact Core chrome and owned information

- The compact strip shows encounter selection, round, visible current
  portrait/full name and role-appropriate queue preview, plus an obvious
  **Show roster** control. Apply the neutral state above when no current
  participant is visible. Its
  owned-character area has a selector when the user owns multiple rows;
  selection is by Combatant ID, never a guessed primary character.
- Expanded roster shows every authorized row in server order: portrait,
  readable name, initiative (including zero), **Current**, **Yours** and
  **Defeated** labels as applicable. There is no player hidden-current
  placeholder or implied acted/upcoming split based on secret turn positions.
  Keep switching and collapse available in forming and started states.
- Reuse saved world/module stat selection; an intentional empty selection
  stays empty, otherwise existing module suggestions apply. Prefer selected
  roster stats/default health, with at most three chips in the compact area
  and remaining selected fields in expansion. These are read-only; no new
  settings store, HP guesses, automatic damage rules or condition controls.
- Authorize owned stat output separately from `canRollInitiative`, including
  managed view-only players. No stats for other players' Actors or NPCs merely
  because their roster row is visible. Resolve preferences once per projection
  request and reuse prepared Actor revisions rather than fetch per chip.
- First-pass stats cover owned world Actors for tokenless and linked-token
  rows. Unlinked-token synthetic stats remain unsupported; never display base
  Actor values as token-local values. Omit those chips with clear wording.
  An authorized base-Actor sheet shortcut must be labeled as such. Normal
  linked/tokenless sheet shortcuts open a new tab using existing navigation.
  Actorless rows remain valid roster entries without chips or a sheet action.
- Use Core `sd-ui-*` tokens and existing light/dark preference for the strip,
  panels and fallback UI. Keep world artwork and scoped module sheets/tools/
  overridden modal themes intact. No new hardcoded system palette.

Integrate occupancy and layers in the shared player shell, not per-page
padding fixes. Reserve compact-strip clearance; expansion must be dismissible
and scroll within the viewport. Test safe-area insets and 320px layouts, long
names, portrait load failure, large rosters and 200% zoom. Module fixed headers
may require a bounded shared inset contract; verify rather than assume outer
padding fixes them. Existing modal layering needs an explicit tested order:
page/HUD below modal, all below the world-unavailable boundary.

Use labeled keyboard controls, visible focus, `aria-expanded`/current-row
semantics, focus return and no hover-only essential actions. Aim for 44px
primary targets; verify smaller controls against WCAG target/spacing rules.
Use a polite, deduplicated current-turn announcement, not automatic sound,
focus stealing or repeated toasts. Respect reduced motion; don't remount or
animate the full roster on each invalidation. Keep all rows reachable, with
bounded scroll/image loading rather than a silent count cap.

### 5. Realtime, security and lifecycle

Keep `ActorCombatProvider`'s coalesced fetch/epoch guards and existing skinny
combat invalidations. Add authorized tracker invalidation for preference
changes; the existing preference event is GM-only and must not make players
call the GM config/discovery route. Test Actor changes, prepared-data
dependencies, permission loss, removal and module/world preference scope.
No HUD polling, second document store, raw socket payload authority or
browser-persisted Actor/stat history.

`PlayerWorldBoundary` remains the only world/session presentation owner.
Transient loss retains inert content, blocks pending dialog actions and
revalidates after recovery. Terminal close, logout and identity replacement
retire HUD state. Prevent late async results reopening or mutating an old
scope. Body portals must not escape the inert boundary; test this explicitly.
An initiative target removed, hidden or no longer authorized retires its
dialog; changed values require refresh rather than applying an old draft.
Strings render as text; image URLs use existing server resolution. A chip or
sheet-link capability is never authority to write. All endpoints reauthorize.

## Delivery checkpoints

- [x] **C0 — scope and contracts approved.** Review role matrix, compact
  hierarchy, owned-only stats, unlinked-token fallback, initiative prop/result
  types, SDK versioning and module release sequence with the user. Obtain
  module branch/edit authorization separately. Preserve this audit checkpoint.
- [ ] **C1 — projection and commands.** Fix managed capability mismatch, add
  minimal typed projection/observation fields, share turn/formula helpers and
  guards, verify no side effects on denied/stale commands. Cover ordinary vs
  managed, owner/non-owner/assistant/GM, pre-start (null and zero turn indexes),
  inactive, actorless/missing-Actor, hidden and deleted rows.
  Replace hidden-marker tests with privacy regressions: hidden rows before/
  between/after visible rows, several consecutive hidden turns, hidden owned
  Actors, all-hidden encounters, hide/reveal of the current row and GM full
  visibility. Assert no hidden metadata/counts/gaps, mystery-current state or
  hidden-dependent next slot in player JSON; unchanged visible order/count/
  preview when only hidden membership changes and the visible reference is
  unchanged. Verify inaccessible hidden targets remain indistinguishable
  from missing targets.
- [ ] **C2 — SDK initiative and migration.** Align shared component props,
  mocks and module override; migrate Shadowdark and check all module ranges.
  Test fallback and override with module formula, GM fallback, missing formula,
  numeric manual total, d20/non-d20, allowed advantage, privacy and load errors.
  No caller may bypass manager restrictions through the new callback/body.
- [x] **C3 — HUD and shell.** Build compact/expanded layouts, owned chips and
  sheet/manager shortcuts; wire preference invalidation. Review dark/light,
  mobile/desktop, keyboard, focus, reduced motion and all overlay states using
  fixture-driven browser rendering before live tests. Check module themes.
  Inspect accessible labels, focus order, tooltips, counters, notifications
  and transitions for hidden-participant existence/position disclosures.
- [ ] **C4 — integration and operator acceptance.** In an explicitly approved
  disposable world, exercise Begin/Next/Previous, initiative, hide/reveal,
  damage/stat changes, ownership change, completion/delete and concurrent
  users. Test ordinary and managed encounters, two GMs, current/non-current
  owners and assistant; disconnect/recovery, world close/start and replacement.
  Confirm no duplicate command/chat or stale old-scope action. Then request
  user acceptance. Record evidence, limitations and cleanup; no production
  probes or required native-browser dependency.
- [ ] **C5 — documentation/release review.** Update `docs/API.md` (DTO/action
  preconditions/audience), `docs/UI.md` (HUD behavior and role matrix),
  `docs/architecture.md` (projection/shell/invalidation),
  `docs/MODULE_MANIFEST.md`, `docs/MODULE_AUTHORING.md` and SDK exports/types/
  test fixtures (initiative contract/migration), and module-owned docs.
  Document the stricter hidden-participant policy and visible-only preview;
  cross-reference this successor decision where ADR-0028 describes its old
  hidden-current marker without rewriting the historical acceptance record.
  Review `docs/NOTIFICATIONS.md` only if shared notification behavior changes.
  Add terse delivered-feature changelog entries at implementation time;
  follow `docs/RELEASING.md`. Update handoff after checkpoints. Request scoped
  commit/release authority; close this ADR only after acceptance evidence.

At each implementation checkpoint run focused tests, `npx tsc --noEmit`,
`npm run lint` and `git diff --check`; run full unit/client and relevant
integration checks before acceptance. Inspect suite cleanup/data paths first
(the integration runner can delete retained `temp/integration-test-data`).
Use disposable data roots for builds/live tests; never root production config.
Checkpoint commits require the user's approval, not merely a checked box here.

## Deferred and design references

Not included: ADR-0058 requests/prompts and managed player initiative/End turn,
module quick cards/attack/spell/resource-edit contracts, condition automation,
scene controls/native command bridges, Journal history, grouping/spotlight,
timers, audible alerts and draggable layout presets. Do not revive them to
complete this HUD revision.

Design inputs are [Foundry's tracker](https://foundryvtt.com/article/combat/)
for familiar turn controls, [Carousel Combat Tracker](https://wiki.theripper93.com/free/combat-tracker-dock)
for portrait/owned-detail hierarchy, [Token Action HUD](https://github.com/Larkinabout/fvtt-token-action-hud-core)
for the distinction between generic navigation and system actions, and
[FFXIV's HUD guide](https://na.finalfantasyxiv.com/uiguide/know/know-hud/hud-layout.html)
for controllable density. Contrast/target review should use
[Xbox contrast guidance](https://learn.microsoft.com/en-us/xbox/accessibility/xbox-accessibility-guidelines/102)
and [WCAG target-size guidance](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html).
These are design references, not dependencies or evidence of native parity.

## Audit checkpoint evidence

Reviewed Core 0.17.0 source and local module manifests on October 12, 2026.
Existing `combat-hud-state.test.ts` and `combat-tracker-projection.test.ts`
passed offline. They establish current helper behavior, not complete service,
rendered accessibility or live concurrency coverage. A pure in-memory
round-zero/turn-zero player fixture separately reproduced the unexpected
`canAdvanceTurn: true`; no HTTP write or live reproduction was attempted.
No application/test code, SDK version, module or running service changed
during this design pass.
C0 was approved by the user on October 12, 2026. Implementation evidence is
recorded below; C1–C5 remain open until their full acceptance checks pass.

## Implementation follow-up — October 12, 2026

- Core tracker projection now omits hidden-current metadata and hidden-only
  player encounters, computes visible-order `nextShownCombatantId`, and
  prevents player Begin at round zero even when Foundry stores `turn: 0`.
  Managed HUD mutation capabilities are disabled; role-4 GMs receive a
  validated manager shortcut. Bounded owned stat chips and resolved initiative
  metadata are projected from prepared Actors with source authorization; the
  legacy full Actor payload is no longer sent on tracker rows. Unlinked scene
  Token base-Actor stats are omitted.
- The ordinary turn and initiative HTTP routes require an observed snapshot.
  Core command writes share an encounter guard with the manager; stale turns
  and initiative values/formulas fail before chat or document writes. The
  ordinary initiative route rejects arbitrary formulas and accepts a finite
  manual final total. This is still best-effort Core serialization, not an
  atomic Foundry transaction.
- The HUD now uses a compact strip and expandable authorized roster. Its
  shared initiative dialog presents Core-provided formula/source and returns
  only a roll mode or manual total; Shadowdark's override delegates to that
  component without recalculating the formula. SDK/UI contract 3.0.0 and
  local module branches target Core 0.18.0 for release. The Mörk Borg and D&D
  modules use the Core fallback. Module releases must follow the Core 0.18.0
  release.
- Offline Core unit, TypeScript and lint checks pass. The local module Core
  minimum was temporarily lowered to 0.17.0 for development against this
  checkout; the required UI-extension API 3.0.0 remains the actual compatibility
  discriminator. Before module publication, restore the Core minimum to
  0.18.0 after that Core release exists. Additional smoke coverage asserts that
  stale initiative produces no roll/write, and a fractional manual total uses
  the labeled chat path with the Core formula fallback. This offline checkpoint
  does not establish live-world or full operator acceptance.

### Operator visual review — October 12, 2026

The first live dashboard screenshot showed that the collapsed three-card HUD
occupied about 230px of vertical space and replaced Foundry's default Actor
portrait with a shield, unlike the dashboard Actor card. The client layout was
tightened into one desktop row, with controls inline, and available portrait
URLs (including the default Foundry image) are now rendered. TypeScript and
lint pass. A follow-up screenshot exposed the remaining centered, rounded
panel seam above the dashboard; the HUD surface now spans the viewport with
only its contents width-constrained, and the expanded roster aligns to that
full-width surface. The user visually accepted the revised desktop HUD on
October 12; the later isolated browser pass and operator review completed C3.
The same
screenshot showed no turn action because this was a SheetDelver-managed
encounter viewed as a player; that remains the intentional GM-command boundary
for this pass. The user reconfirmed that managed player turn actions require a
deliberate follow-up design rather than an ad-hoc permission change.

The user approved a development-only Core minimum of `>=0.17.0` for the three
local module manifests while this worktree still identifies itself as 0.17.0.
The `ui-extension-api >=3.0.0 <4.0.0` gate remains strict, so those modules do
not become compatible with the released Core 0.17.0, which exposes UI API 2.x.
Before publishing the modules, release Core 0.18.0 and restore their Core
minimum to `>=0.18.0`. CI/release workflow references continue to target the
future Core tag; no release or production compatibility is implied by local
development loading.
All three `module:check` runs subsequently passed their compatibility,
TypeScript, import-boundary, CSS, and dry-bundle checks with this development
minimum. Live module loading and full operator acceptance remain unverified.

After the full-width desktop refinement, `npm run test:unit`,
`npm run test:client`, `npx tsc --noEmit` and `npm run lint` passed. Desktop
visual acceptance is recorded above; broader C1–C5 acceptance remains open.

### C1–C3 offline acceptance preparation — October 12, 2026

Projection regressions now cover assistant visibility, actorless and
unavailable-Actor capabilities, and hide/reveal of the current row in addition
to existing hidden-position, hidden/missing-target and managed-command cases.
Initiative regressions cover Core/GM/module precedence, non-d20 advantage
suppression, a throwing module hook, manual-only presentation and invalid
manual-mode preflight without roll or write side effects.

An isolated browser fixture rendered the actual Core HUD and RollDialog plus
Shadowdark's module override with compiled scoped CSS, stubbed context/API
inputs and no Core/Foundry/network connection. It passed 320/375/1280px,
dark/light surfaces, expanded roster, 44px roster control, focus entry/return,
reverse-Tab/Escape, bounded manual dispatch, load-error presentation, dialog
retirement when an owned row disappears, reduced-motion operability and
overlay hit-testing. A light-mode contrast check found that the unlayered Core
panel surface suppressed Shadowdark's scoped black/white theme. The shared
initiative dialog now honors complete module header/body/button skin slots;
the isolated render confirms a black header with white title and white body
with dark text at 320px. The Shadowdark roll-dialog theme supplies explicit
header/body text colors. This fixture is a local development check, not a
substitute for two-user or native Foundry integration. Full Core unit/client,
TypeScript, lint and all three local module checks pass. C1–C3 remain open
until operator review; C4 remains a separate live pass.

### Owned current-turn cue and operator review — October 12, 2026

The user accepted C3's preceding HUD presentation and verified C1's
hidden-participant visibility in a live check. Their initiative check used the
GM Combat Manager because the player HUD offered no roll control. This is the
SheetDelver-managed player-command gap deliberately left outside C2's SDK
presentation migration, not a request to test Foundry's separate native UI.
C1 and C2 remain open for their remaining acceptance matrix; C3's prior scope
was accepted before the additional cue below.

The user also identified that an owned current turn lacked a clear visual cue.
The compact HUD now highlights only a projected current row with `isOwned` and
labels it **Your turn**; the expanded roster applies the same treatment. Use
Core light/dark accent tokens, a static outline/tint and text rather than
motion or a module theme. An unowned, hidden, or unavailable current row must
never receive the cue. This is presentation only: it grants no managed player
initiative or turn command. The user visually verified the cue as obvious when
their character is current.

### Checkpoint boundary — October 12, 2026

Foundry's own player combat controls are external to SheetDelver and are not
an operator acceptance target for this HUD pass. C2's versioned SDK dialog,
server-resolved formula, Core fallback and module migration are technical
presentation work; their offline fixtures and module checks do not supply a
player command in a managed encounter. Do not treat the unavailable managed
player initiative button as C2 acceptance or quietly expand its permissions.
Design player turn/initiative requests and authorization for SheetDelver-managed
combats explicitly under the ADR-0058 follow-up before implementation.

The current work can be checkpointed without closing ADR-0060. C1's remaining
role/command matrix, C2's end-to-end migration acceptance, C4's isolated-world
multi-user/lifecycle pass and C5's final documentation/release review remain.
The user has verified hidden-player visibility, C3 and the new own-turn cue.
