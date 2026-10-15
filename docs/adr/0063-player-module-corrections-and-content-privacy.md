# ADR-0063: Player and Module Corrections and Content Privacy

**Status:** Completed — user-authorized closeout on offline evidence; native/operator A1–A7 not performed
**Date:** October 15, 2026
**Related:** ADR-0013, ADR-0038, ADR-0049, ADR-0057, ADR-0060, ADR-0061, ADR-0062

## Closeout — October 15, 2026

After independent verification of R1–R3, the user requested closing this ADR
and its documentation, archiving the audit, preparing Core **0.18.1** and the
changed modules' next patch versions, and committing the work. The user also
authorized module pushes/merges and retained Core push/merge responsibility.
Shadowdark is prepared at **0.9.4** and Mörk Borg at **0.8.3**; D&D5e remains
**0.4.1**.

C0–C6 implementation and offline verification are complete; C1 includes the
corrective R1–R3 regressions described below. C7 was already user-confirmed.
C8 closes by this explicit user decision on the recorded offline evidence.
The A1–A7 native/operator checklist was **not performed** in this pass. It is
retained for future operator validation, not marked passed or carried as a
closeout blocker. This decision supersedes earlier requirements to keep the
ADR/audit open pending those checks; it does not establish live Foundry parity.

Core unit/client/integration, root TypeScript/lint, explicit module typing,
module tests/checkers and isolated packaging passed. The Shadowdark correction
also passed 448 isolated browser surface cases plus provider dialog defaults.
Tracked regression/component tests are reproducible in module CI; the broader
browser harness remains local evidence. No confirmed R1–R3 blocker remains.

Public API/SDK versions, module Core minima and workflow pins remain unchanged;
both modules retain the released Core **v0.18.0** toolchain. New-version isolated
packaging passed, and both module PRs passed their pinned released-host contract,
regression and packaging checks before squash merge:

| Module | Version | Merge / released-host CI |
| --- | --- | --- |
| Shadowdark | 0.9.4 | [PR #12](https://github.com/sheetdelver/sd-shadowdark/pull/12), merge `09b2633`; [validation passed](https://github.com/sheetdelver/sd-shadowdark/actions/runs/38754517571). |
| Mörk Borg | 0.8.3 | [PR #9](https://github.com/sheetdelver/sd-morkborg/pull/9), merge `8cde351`; [validation passed](https://github.com/sheetdelver/sd-morkborg/actions/runs/38754531466). |

Both module source branches were deleted locally and remotely; local main
matches each remote merge commit. Core 0.18.1 release notes, package/lock alignment
and ADR metadata checks passed. Core stays on `fix/player-module-corrections`
for the user's push/merge. Version preparation and merges do not constitute
tagged publication; no tags were created or pushed. No live services, production
data or existing Actor/Item records were changed during verification/closeout.

The root and affected module correction audits move to their local `completed/`
directories. The deferred-work ledger retains DW-01–DW-12 and their decisions;
ordinary journal Secret and non-roll whisper corrections are completed here.
Earlier planning, review and pending-release statements below are dated history,
superseded by this closeout and the corrective implementation record.

## Context and scope

Core0.18.0 and the compatible Shadowdark0.9.3, Mörk Borg0.8.2 and experimental
D&D5e0.4.1 modules are released. ADR-0061 and ADR-0062 remain Completed. A later
operator retest reports the earlier overlay, journal-image, dismissal, mobile
tabs, speaker, Assistant access, catalog access and managed participation fixes
working. This successor addresses newly observed gaps and two explicitly
carried privacy findings; it does not reopen those accepted implementations.

New observations are wrong Shadowdark weapon display/choice handling, Actor
navigation covered by the HUD, unintuitive owned-character selection, Mörk HP
spacing on phones and missing shared-image captions. External catalog wording
was also reported and is now user-confirmed resolved (C7).
The initial planning pass corroborated these paths from source only. The
implementation record below supersedes that baseline and separates offline
verification from unperformed native/operator checks. The independent review
identified mastery assembly, damage-effect ordering and inventory presentation
gaps; the later C1 corrective record resolves all three.

The reproduction used Shadowdark4.0.6, Mörk6.0.1 and D&D6.0.2 on Foundryv14.
Available local native references instead declare Shadowdark4.1.0, Mörk6.0.0
and D&D6.0.2; installed Shadowdark4.0.6 source was also inspected. Differences
must be recorded in fixtures. A newer reference is not automatic authorization
for a system-version migration or evidence of compatibility with all builds.

## Confirmed user decisions

- Keep exactly one active audit/follow-up report. Archive completed or superseded
  reports with dispositions; carry real gaps and explicit deferrals forward.
- The user approved the bounded implementation on October 15 and separately
  approved `fix/player-module-corrections` branches in Core, Shadowdark and
  Mörk Borg. Git commits/remotes and live services need separate authority.
- For initiative, count **eligible owned participants in the selected encounter**:
  one opens its existing module roller directly; more than one opens a chooser
  with individual or all actions. Do not depend on which Actor sheet is open.
  Zero eligible participants means no Roll action. The user corrected the initial
  proposal to avoid a redundant one-character chooser.
- Use supplied local system source for subsequent rule investigation. Keep
  module READMEs concise; module contributor details belong in docs/.
- Target patch/point releases within the current release lines, not a new minor
  release. Exact versions, version edits and publication still need separate
  approval; this direction does not waive contract/compatibility review.

## Approved corrections

### 1. Shadowdark attack semantics and unresolved talent choices

`src/logic/rules.ts:calculateAttacks` in the module reads `damage.melee/ranged`
and falls back to d4, adds STR to melee damage, and tests property UUID strings
for “finesse”/“thrown”. `ShadowdarkActorContext` and `ShadowdarkAdapter` duplicate
parts of those assumptions. The native4.0.6 Weapon schema uses
`damage.oneHanded/twoHanded` and resolves properties by identity. Handedness
**does exist** as `1h`/`2h`; native preparation fills absent/blank values using
two-handed properties or the available dice. A raw blank is not proof of1h.

Implement a bounded module-owned normalization shared by prepared attack rows,
sheet dialog defaults and server formula resolution. Inventory paper/standard
sheets, Abilities, inventory/item detail and attack execution first. Use declared
hydrated property data and stable identities rather than English-name matching
inside UUIDs. Resolve handedness and applicable damage/attack bonuses from the
verified system schema, preserving explicit supported bonuses/effects and
separate NPC rules. No unconditional STR damage, fabricated d4 for an unresolved
weapon, duplicate modifier application, cached source mutation or Core system hack.

Reproduce longsword/staff, finesse/thrown/ranged and versatile cases with the
same Actor/Item fixtures; compare display, dialog and executed formula. Pin
native rules for each asserted supported version. If4.1's effect/roll schema
requires wider migration, report that separately before expanding this fix.

The reported generated Weapon Mastery retains `REPLACEME` in effect keys.
Current talent handlers replace a matching **value**, while native effects also
substitute selected weapon slugs in **keys**. Trace generator, importer and
level-up selection inputs before assigning a single cause. Resolve supported
choice-bearing templates in the creation path after a validated choice, preserve
formula values, and prevent creation with unresolved required choice keys.
Use existing module selection components; reselect/cancel must be safe. No
background rewrite/deletion of existing Actors or shared compendium templates.

### 2. Coordinate Actor navigation with the HUD

The shared HUD is sticky at top0/z140; Shadowdark/Mörk Actor pages and Core's
GenericActorPage use fixed top0/z50 navigation. The overlap is a layout conflict,
not a session, authorization or combat-state problem.

Prefer putting Actor navigation into normal page flow below the existing Core
HUD, with matching removal of obsolete fixed-header padding. Inventory Core
generic/helper-generated sheets, all three modules and tool headers before
editing; only affected surfaces should change. Do not fix it by reversing
z-index or hard-coding the HUD height. If a permanently pinned module header is
required, first review a measured Core/SDK inset contract and its adoption
minimums; no private module DOM inspection. Existing footer registration,
world overlays, initiative dialogs and shared-media precedence remain intact.

### 3. Owned selection and multiple-character initiative

Current `CombatHUDView` falls back from a retained ownedId to first pending then
first owned; it does not consider the current turn. Approved automatic default:
current visible owned turn, otherwise first actionable owned initiative target,
otherwise first visible owned participant. A manual selection persists within
the current encounter/turn, but resets when that context or authority changes.
Do not move focus or affect the actual current turn. No open-sheet detection.

The initiative action is based on eligible rows, independent of the selected
stats card. Eligibility stays server-owned: selected encounter, caller-owned,
visible, pending initiative, open phase, current session/world and existing
policy. Hidden/other-owner rows and unrelated world Actors never enter the chooser.
Use the existing authorized projection, including forming/pre-Begin candidates.

- One eligible row opens the registered typed module initiative modal, using
  the Core fallback only where the existing SDK contract permits it.
- Multiple eligible rows open a Core-themed chooser listing only those rows.
  Individual Roll uses that row's existing module dialog; do not create a
  second competing system roller or stack two active focus traps.
- **Roll all** uses each listed participant's current server-resolved
  default formula, preserving GM override > module > Core and module advantage.
  Make that behavior explicit in the chooser. Manual totals and explicit mode
  choices stay on individual dialogs. No aggregate formula, guessed modifier,
  shared roll result, extra success chat or service-account writer.
- Reuse the guarded initiative operation; prefer a bounded sequential runner
  over a new privileged batch executor. Snapshot the confirmed target IDs,
  show per-target progress/outcomes and refresh eligibility before dispatch.
  Removed/rolled/ineligible targets are skipped explicitly; never add a newly
  arrived Actor to an already confirmed batch. A stale server refusal must not
  trigger a new roll under refreshed observations without another user action.
- On known failure or ambiguous outcome, stop remaining dispatch and show which
  results applied, failed/unknown, were skipped or remain unattempted. No automatic
  replay. Retiring/closing the chooser cancels only undispatched work; an already
  sent request may complete and must be reconciled from server state.
- Concurrent co-owners, phase closure, Actor reassignment, logout/world changes
  and hidden rows retain ADR-0061's server checks. A browser runner cannot grant
  authority or keep working after its owning view/session has retired.

After the last eligible score succeeds, remove the Roll cue. Existing End my
turn remains tied to the current authorized combatant, never the stats selector
or a chooser selection. This is a new bounded multi-character action, not the
deferred directed-roll request queue from ADR-0058.

### 4. Correct Mörk Borg mobile HP grouping

`MorkBorgSheet:StatBlock` places two fixed-width numeric inputs and a slash in
a narrow card. Size the current/max group within its available width and center
it while retaining multi-digit readability, focus, labels and touch targets.
Preserve resource update/clamping behavior and styling. Check HP alongside
Omens/Powers/Silver and the bottom navigation; no generic resource redesign.

### 5. Preserve shared-image captions

Foundry v14 `ImagePopout.shareImage` includes caption. Core's SocketBase relays
it, but `SharedContentIngress` selects URL/title only, and SharedContentHost
does not render a caption. Preserve an optional bounded string in the existing
recipient-scoped store, HTTP/realtime payloads and public SDK type where exposed.
Render it as plain text in an accessible caption region inside the same dialog.
Long captions wrap/scroll without losing the image title or close control.
Missing captions retain today's layout; reject/ignore non-string input safely.

Keep receipt identity/order, identical-image re-sharing, one presentation owner,
focus/keyboard dismissal and terminal teardown. A caption never grants journal
access; do not hydrate a private document to fill a missing caption. Test unsafe
markup as inert text, delayed HTTP/realtime replacement and distinct recipients.
Inspect v13's payload before asserting matching native behavior. If the typed
SDK surface grows, follow contract-version review rather than casually changing
every module minimum; existing consumers must tolerate the absent field.

### 6. External catalog wording — resolved

On October 15, the user confirmed that the catalog's `catalog.json` was updated
from “Sheet Delver” to “SheetDelver” and “Mork Borg” to “Mörk Borg”. C7 is resolved
on that supplied confirmation. The earlier cached wording is historical evidence,
not a remaining defect. No independent remote/schema validation is claimed here.

No catalog implementation or publication task remains in this ADR. Do not edit
runtime caches, immutable release archives, module IDs or compatibility metadata
to repeat this correction. The separate catalog access fix remains completed
under ADR-0062.

### 7. Carry two bounded privacy corrections explicitly

ADR-0062 did not fix these existing paths. They are approved independent slices
in this ADR, with consumer inventory before any common policy change:

1. **Ordinary journal Secret projection.** JournalService filters visible pages
   but returns their source HTML. Temporary J1 share views already filter
   unrevealed Secrets. Inventory normal detail/list, SDK document/UUID paths,
   editor and update consumers. Derive current entry/page ownership, distinguish
   read-only display from owner-authorized raw editing, and filter before
   transmission. Preserve source in Stores and on edit/save; never save a
   redacted body over an owner's original. Test revealed/unrevealed/nested
   Secrets, inherited/explicit page ownership and session/role changes. Reuse
   existing safe HTML projection helpers where appropriate.
2. **Non-roll private whisper visibility.** ChatMessageStore grants full-GM
   ownership before checking whisper recipients. ADR-0062's native-source review
   records ordinary whispers as author/recipient-visible, unlike roll result
   presentation. Recheck version-specific native rules and all chat list/detail,
   SDK/UUID, realtime audience, toast and notification consumers. Correct this
   document-specific policy consistently; preserve public roll placeholders,
   blind/self/GM-roll handling and Assistant boundaries. No global OWNER helper
   change or new source-account fallback. Test author, recipient, unrelated
   player/Assistant/GM and transport agreement without disclosing private bodies.

These need explicit acceptance; moving their previous report to completed/
does not close them. Neither is fixed by the new caption or initiative work.

## Checkpoints and acceptance gates

Checkpoint progress is recorded below; user acceptance remains open except C7,
resolved by user confirmation. A planning/source finding is not a passing test. Update this
record, the single local audit and handoff at
each checkpoint; module details stay in their own docs/test evidence.

| Gate | Deliverable | Required evidence |
| --- | --- | --- |
| C0 | Scope/version/consumer baseline | Approved ADR/branches; record exact native versions and reference mismatch; reproduce new defects in isolated fixtures; inventory roll, header and privacy consumers. |
| C1 | Shadowdark attack + mastery corrections | Versioned Player/NPC, 1h/2h/versatile, finesse/thrown, signed bonuses, display/dialog/executed formula; selection/cancel/no-choice cases, new generator/import/level-up paths and unchanged cached templates/existing Actors. |
| C2 | HUD/navigation and owned initiative flow | Generic/three-module sheets; one/many/zero eligible; manual selection/turn reset; individual native modal; all-roll concurrency, stale/partial/unknown/close, hidden/phase/session retirement; no duplicate chat or retargeting. |
| C3 | Mörk HP layout |320/390/820/1440, short/multi-digit current/max, keyboard editing, footer/tools/HUD, no changed resource semantics. |
| C4 | Shared captions | Native payload versions, HTTP/socket recipient/order agreement, no private journal fetch, unsafe/empty/long caption, re-share and modal focus/viewport checks. |
| C5 | Ordinary Secret projection | Inventory + display/raw separation review before patch; page/role matrix, SDK/UUID responses and lossless owner saves; J1 regressions. |
| C6 | Ordinary whisper visibility | Versioned native matrix; list/detail/SDK/realtime/notifications agree, existing roll placeholders and result privacy unchanged. |
| C7 | Catalog labels — resolved | User confirmed `catalog.json` spelling corrections on October 15; no independent remote/schema check claimed. No further implementation or publishing task. |
| C8 | Documentation, user acceptance, readiness | Affected offline suites, explicit module typing/packages, scoped live and operator checklist; truthful compatibility minima and released-host checks; user accepts before closeout, separately approved Git/release work. |

Implement dependency-independent slices separately; privacy policy changes must
not be hidden inside cosmetic diffs. Prefer C5/C6 early after their inventories.
Patch/point releases are the user-selected direction; no exact release number,
SDK bump or wider system-version support is chosen here.
If new Core functionality becomes a module requirement, validate the actual
released host minimum before publishing modules. The completed catalog wording
correction does not require a module release.

## Validation and documentation

Extend existing Core tests, particularly combat HUD state/rendering, managed
participation, shared-content store/realtime, shared-journal/journal store and
chat-message presentation/audience tests. Run the applicable full checks:

```sh
npm run test:unit
npm run test:client
npm run test:integration
npx tsc --noEmit
npm run lint
git diff --check
```

Integration covers module lifecycle, not native Foundry permission proof.
Use module-owned test commands in each AGENTS.md (moved from docs/DEVELOPMENT.md),
explicit module
source typing (root tsc excludes them), module:check and isolated package output.
Inspect retained browser tooling before reuse; do not add it to runtime dependencies.

For C2–C4 use rendered current components at320/390/820/1440, light/dark, keyboard,
safe area, HUD expanded/collapsed, shared media and footer/world overlays. After
fresh approval, compare relevant native source/formulas and caller-bound rolls
in the approved local Foundry world. Do not start services from root production
settings or reuse prior live permission as ongoing authority.

Update docs/UI.md for layout/chooser/captions; docs/API.md and architecture.md
for any payload/privacy changes; SDK/manifest/module-authoring guidance only
when its contracts change. Module rules/limits/tests belong in module docs/.
Changelogs describe shipped outcomes tersely; don't add implementation promises
to release notes during planning. Keep tracked decisions self-contained without
depending on ignored audit files.

Operator acceptance: correct Shadowdark weapon values and required new mastery
selection; unobstructed Actor navigation; one-character direct roller and
multi-character individual/all flow with accurate outcomes; centered mobile HP;
captions visible to intended recipients; Secrets and non-roll whispers absent
from unauthorized responses while owner editing and ordinary rolls still work.
Catalog wording acceptance is already recorded separately in C7.

## Explicit exclusions and review points

- Known experimental D&D derived values (including newly noted level5 dashboard
  proficiency) remain recorded, not fixed or silently promoted. Preserve its
  parked native preparation-runtime experiment/research/stash.
- No automatic cleanup/migration of old Light spell Items or unresolved mastery
  templates; no runtime art replacement for marketing permissions.
- Directed requests, Journal history/rebuild, grouped/alternative initiative,
  quick cards/action bars, conditions/system damage automation and native-client
  bridges remain deferred. No world/session architecture rewrite.
- The Next16.3.8 development correction remains conditional maintenance under
  ADR-0062, not unfinished work or a promised upgrade in this release.
- The user approved the combined scope and default-formula/failure behavior for
  Roll all. Keep version support evidence-bounded rather than copying4.1 schema
  into a4.0.6 fix. A requirement to keep
  headers pinned needs a separate layout-contract decision.

## Planning record — October 15, 2026

Reconciled four old root audits against ADR-0049/0057/0059/0060/0061/0062.
Archived them with explicit completion/supersession/deferred dispositions and
carried unresolved findings into one successor audit. Read the October15
operator notes and inspected current Core/module/native source. Only documentation
changed; implementation, automated behavior validation and user acceptance for
this ADR remain pending.

ADR metadata and documentation diff/link checks pass. These checks establish
document integrity only; remaining behavior checkpoints stay open for approval.

### User addendum — October 15, 2026

Recorded the user's completed catalog spelling correction in C7 and the
patch/point-release direction. This closes only the catalog wording item; it
does not claim other implementation, testing, release or acceptance work complete.

## Implementation record — October 15, 2026

### C0 — Verified baseline and consumer inventory

Core `535be84`/0.18.0, Shadowdark `d7ae5a0`/0.9.3 and Mörk Borg
`979e406`/0.8.2 now have the approved `fix/player-module-corrections` branches.
Existing planning edits were preserved. D&D remains clean on main `97726a1`/
0.4.1; its sheet uses the host page rather than another fixed navigation bar.
Reference/version differences above were confirmed. No services were contacted.

| Slice | Consumers inventoried / boundary |
| --- | --- |
| Shadowdark rules | `logic/rules.ts`, Actor context, server adapter, paper/standard Abilities and inventory; talent handlers/enricher plus generator/import/level-up creation. Normalize module rules without changing cached source. |
| Layout/HUD | Core `GenericActorPage`, Shadowdark/Mörk Actor and generator/import headers, D&D host page; HUD selection, module modal loading and existing initiative HTTP actions. |
| Shared media | User-socket `SharedContentIngress`, session/world Store, HTTP/realtime contracts, client ingestion and the single `SharedContentHost`. Local v13 and v14 ImagePopout both send captions. |
| Journals | Ordinary JournalService, SDK get/list/UUID in `moduleDocumentServices`, embedded page UUIDs, JournalModal/editor and caller-bound page writes; temporary SharedJournalService remains separate. |
| Chat | ChatMessageStore ownership/audiences, ChatService projection, scoped SDK/UUID reads and realtime invalidation-driven previews. Native v13/v14 ordinary whispers both restrict visibility to author/recipients, including GMs. Roll content rules differ by generation and remain outside this non-roll correction. |

Implementation authorization and branch gates are satisfied. Focused regression
fixtures and behavioral checks will be recorded with their correction checkpoints;
this inventory alone is not runtime verification or user acceptance.

### First correction checkpoint — implementation and focused offline checks

- C1: module-owned weapon normalization now feeds display/dialog/server attack
  bonuses; native damage/handedness and exact property identities replace legacy
  guesses. Deterministic numeric selectors support mastery arithmetic without
  evaluating JavaScript. Disabled/suppressed/unselected situational effects are
  excluded. Unsupported effect values carry warnings; full native hook parity
  and a 4.1 migration remain outside scope. Fixed class/ancestry mastery now uses
  the existing choice UI; generator/import/advancement reject unresolved required
  keys before new writes. Versioned 4.0.6 weapon/choice and prepared tests pass.
- C2: affected Core/Shadowdark/Mörk headers now use normal flow. HUD selection
  follows owned current turn with context-bounded manual selection. Zero/one/many
  initiative behavior and serial Roll all use existing caller-bound commands;
  no new batch privilege/transport. Focused sequencing tests cover reassignment,
  ownership/hide/score/phase changes, cancellation, partial/unknown failures and
  no appended arrivals or automatic replay. Responsive/operator checks pending.
- C3: Mörk current/max groups now share card width with readable labels; update
  semantics are unchanged. Module checker passes; rendered checks pending.
- C4: native v13/v14 caption payloads confirmed from local source. Optional
  plain text is carried through existing extensible share metadata (4096-character
  ingress bound), without new required SDK methods/fields or module minima.
  Recipient/retirement/re-share and invalid/long caption unit tests pass;
  rendered focus/viewport checks pending.
- C5: one ordinary JournalStore detail projection feeds HTTP/SDK/embedded page
  UUIDs. Page owners retain raw source; other readers receive Secret-filtered HTML
  with alternate Markdown removed. UI editing follows effective page ownership.
  Rich-editor Secret nodes preserve confidentiality wrappers; unchanged saves
  retain exact original source. Service/SDK/page/role/deletion/source-preservation
  fixtures pass, as do existing J1 temporary-share regressions. Actual editor
  round-trip/render checks remain pending.
- C6: non-roll whispers now exclude unrelated GMs before the existing GM raw-roll
  shortcut. The Store predicate also scopes realtime audiences. Service/SDK/read
  and targeted-hint tests pass; blind/self/GM-roll regressions remain passing.
  Source-confirmed native matrix is not fresh live acceptance.

Core unit/client suites and root typing passed at this checkpoint. Both affected
module checkers passed. Full module/source typing, packaging, lint/integration,
rendered regressions and operator/native acceptance remain C8 work. No versions,
compatibility requirements, commits or remote actions changed.

### C8 — Final offline verification and acceptance handoff

The first checkpoint's pending automated checks are now complete. No live
Foundry/Core/dev service was contacted, started or stopped. Root settings were
not used for testing. No staging, commits, version/compatibility edits or remote
operations occurred. The following statuses describe implementation and
automation, **not user acceptance**:

| Gate | Implementation / automated disposition |
| --- | --- |
| C0 | Complete: versioned sources, consumer inventory and focused fixtures. D&D remains unchanged; exact reference differences remain recorded above. |
| C1 | Reopened by independent review: existing native4.0.6 fixtures pass, but R1–R3 below identify missing mastery-assembly combinations, damage-effect ordering and inventory presentation coverage. |
| C2 | Complete: one/many/zero actions, serial defaults, co-owner scoring, mutable Actor reassignment, stale eligibility, cancellation and known/unknown outcomes tested. Actual HUD/manager/module-dialog browser fixtures exercise direct/chooser flows and keyboard behavior. Headers use flow rather than measured/guessed HUD offsets. |
| C3 | Complete: actual Mörk sheet renders four-digit current/max at320/390/820/1440 in both themes. HP spans the phone row; keyboard editing and existing clamping pass. |
| C4 | Complete: recipient/order/re-share regressions and actual dialog caption checks pass at all four widths/themes. Markup stays inert; long text is bounded/scrollable. Media Escape closes only the top presentation and restores chooser focus. |
| C5 | Complete: HTTP/SDK/root and page UUID projections, page-role/retired-user matrix, unchanged raw Store source and real editor round trips pass. Unchanged editor saves return exact source; supported edits retain nested Secret wrappers. This does not promise lossless editing of every arbitrary native rich-text extension. J1 remains separately scoped and read-only. |
| C6 | Complete: author/recipient/unrelated player/Assistant/GM service/SDK/UUID matrix and targeted realtime hints pass. Existing public/blind/self/GM-roll regressions remain passing. Native v13/v14 source review is not fresh live permission evidence. |
| C7 | Resolved earlier by user confirmation; no code or catalog work. |
| C8 | Existing offline checks pass; R1–R3 correction/regression evidence, native/operator acceptance, closeout and separately approved Git/releases remain pending. |

Commands passed: the Core unit, client and integration suites, root TypeScript,
lint and ADR metadata checks; all six documented Shadowdark tests (including
`weapon-rules`), all three Mörk tests, both module checkers, explicit source
typing for all three modules and isolated Shadowdark/Mörk packaging. D&D's
unchanged prepared/presentation regressions also pass. Root typing alone was
not treated as module validation. Package artifacts are local verification
outputs at existing versions, not new releases.

Retained isolated browser fixtures use actual components with mocked data and
blocked live network. They cover320/390/820/1440 light/dark chooser, shared
caption and module/header/HP layouts, module initiative presentation, keyboard/
focus, cancellation, footer/Tools and existing HUD/manager regressions. A
separate shared-media/chooser check verifies top-layer dismissal. Header
clearance is additionally hit-tested below variable-height in-flow HUD chrome;
it does not depend on a fixed production HUD height. Actual native dice/chat,
permission changes and user-operated world transitions still need acceptance.

#### Operator checklist — retained, not performed

The closeout decision above supersedes the original requirement to complete this
checklist before closing. These unchecked items are not passing live evidence.
If agent-operated live testing is later requested, obtain scoped approval for
the instance, accounts and mutations.

- [ ] **A1 — Shadowdark attacks/mastery:** compare longsword/staff,1h/2h,
  finesse/thrown/ranged, explicit bonus and NPC examples across summary, module
  dialog and executed chat formula. Generate/import/advance a new mastery
  character: valid selection required, selected effect keys resolved, formula
  values retained; cancel/reselect safely. Existing Actors/templates unchanged.
- [ ] **A2 — Navigation/selection:** with collapsed and expanded HUD, reach
  Core generic/D&D and Shadowdark/Mörk sheet/tool navigation on phone/tablet/
  desktop; footer/Tools remain usable. My character follows the owned current
  turn; manual selection resets on turn/encounter/authority change.
- [ ] **A3 — Initiative:** zero hides Roll, one opens the existing module
  roller, multiple opens chooser. Try individual/manual and Roll all with
  different server defaults/GM overrides. Scores remove pending cues; late
  arrivals are not appended to a running batch. Co-owner scoring, hide/remove,
  phase close or logout must prevent stale writes. Close cancels undispatched
  rolls; failure/unknown stops without replay. End my turn still targets only
  the authorized current row, never the selected stats Actor.
- [ ] **A4 — Mörk HP:** current/max remain centered/readable on phone/tablet,
  including multi-digit values; editing, clamping, keyboard and footer work.
- [ ] **A5 — Captions:** show an image to selected/all players with absent,
  long and markup-looking captions; only intended recipients see inert text.
  Re-share the identical image; verify replacement, close/Escape and focus,
  including above initiative dialogs.
- [ ] **A6 — Journal privacy:** compare observer, explicit page owner,
  inherited owner, Assistant and GM. Unrevealed/nested Secrets must be absent
  from unauthorized ordinary HTTP/SDK/UUID responses; revealed content remains.
  Owners can edit without losing confidentiality wrappers. Private forced-page
  J1 views remain read-only, page-bounded and temporary; session changes retire
  access rather than expose prior raw content.
- [ ] **A7 — Whispers:** send non-roll whispers as/to player, Assistant and
  GM; unrelated users (including GM) receive neither body nor targeted preview.
  Confirm public rolls, blind/self/GM roll visibility and placeholders unchanged.

No breaking SDK surface was required: caption uses existing extensible metadata,
page ownership is an already-transmitted field, and navigation/chooser reuse
existing public APIs. Application/module/API versions, workflow host pins and
minimum Core requirements are unchanged. After acceptance, choose unused patch
versions with separate approval and validate affected modules against their
declared released Core0.18.0 toolchain before publication. Do not close the ADR
or treat generated packages as published releases.

## Independent implementation review addendum — October 15, 2026

Reviewed the current uncommitted Core/Shadowdark/Mörk implementation against
this ADR, its passdown, and the installed Shadowdark 4.0.6 source. The existing
automated suites still pass. That establishes their covered behavior, not full
C1 completion. The following findings are within the already accepted scope;
they are not deferred native-hook parity or a request to revive parked work.
This review records corrections; it does not implement them.

### R1 — Preserve mastery choices through final assembly (high priority)

In Shadowdark `src/server/api/level-up-engine.ts`, `assembleFinalItems` now
resolves mastery choices only after its generic UUID/name deduplication. The
previous mastery-handler output is excluded from this path, so it no longer
provides a separately resolved Item when generic filtering removes a template.
Two isolated calls reproduce the gap:

- A level-one Fighter with fixed Weapon Mastery and the same template UUID in
  `rolledTalents`, with a valid Longsword selection, returns only the Class Item
  and **zero mastery Items**. The name-based baggage check treats both copies
  as rolled and discards both. The unresolved-key guard cannot detect an Item
  that has already disappeared.
- Two rolled copies of the mastery template with Longsword and Dagger choices
  produce only **Weapon Mastery (Longsword)**. UUID deduplication runs before
  the two choices can become distinct Items; the second selection is ignored.

Reconcile fixed/rolled overlap without dropping the required talent, retain
each independently required selection, and verify that every required choice
is consumed exactly once before writes. Add assembly regressions for these
combinations, armor mastery, and generator/advancement consumers; preserve the
passing importer choice-deduplication cases and source-template immutability.
The existing fixture tests fixed-only and rolled-only assembly separately;
its multiple-selection assertions exercise the importer helper, not assembly.

### R2 — Apply native damage-effect ordering (medium priority)

Shadowdark `src/logic/weapon-rules.ts` groups attack-bonus effects by mode but
applies damage effects in source order. For base `d8` with numeric MULTIPLY 2
followed by ADD 3, `prepareWeaponAttack` returns `(d8)*2+3`. Reversing those
same two changes returns `(d8+3)*2`. Native 4.0.6
`ActorBaseSD._getActiveEffectKeys` groups ADD, then MULTIPLY, then OVERRIDE;
both orders therefore require `(d8+3)*2` (ignoring whitespace).

Use that same ordering for the supported damage subset, with permutation
tests including OVERRIDE and changes spread across effects/Items. This is a
defect in explicitly supported numeric modes, not unsupported dynamic native
hooks. The review reproduced helper outputs and checked the native source;
it did not execute a live native damage roll.

### R3 — Finish the inventoried weapon display consumers (medium priority)

Shadowdark `src/ui/InventoryComponents.tsx` still independently detects
properties using substring/hard-coded-ID checks and fabricates `d4`/`d6`
when native damage fields are missing. For a Weapon with no damage, the
corrected attack summary reports **Damage unavailable**, while the inventory
detail reports **d4**. For a raw weapon with only `twoHanded: d10` and no
property hint, the helper derives two-handed/d10 while inventory reports d4.

Finish the item-detail consumer inventory promised by C0/C1. Reuse the native
property/handedness/damage interpretation, distinguish base item damage from
Actor-adjusted damage where appropriate, and remove invented fallback dice.
Cover absent damage, inferred two-handed, versatile and exact property identity
in actual inventory rendering as well as attack-summary fixtures. This finding
is a source-confirmed remaining consumer gap, not a claimed live reproduction.

### Verification and remaining evidence

Fresh review runs passed Core unit tests (which include the client suite),
integration, root TypeScript, lint, all six Shadowdark tests, all three Mörk
tests, D&D prepared/presentation regressions, both affected module checkers and
explicit source typing for all three modules. The three retained isolated
browser harnesses also passed against current components, with mocked services
and blocked application network. No new Core, Next or Foundry service was
started or contacted. Packaging was not rerun in this review; the earlier
packaging record remains historical evidence.

No additional confirmed defect was found in the reviewed C2–C6 changes. This
is bounded review evidence, not live permission/dice/chat acceptance. The
isolated browser harnesses and their Playwright installation are local ignored
tooling, so a clean checkout/CI cannot reproduce that evidence from the tracked
unit suite alone. For durable regression coverage, retain focused component
checks in tracked development/test tooling or document a reproducible optional
setup; no application/backend runtime dependency or required Foundry browser
is implied.

C1 remains open for R1–R3, followed by focused regressions and A1 acceptance.
All A1–A7 operator/native acceptance boxes remain open, along with the declared
released-host check before module publication. No application code, version,
compatibility minimum, Git state or remote was changed by this review. Existing
uncommitted work and unrelated research remain preserved.

## C1 corrective implementation — October 15, 2026

The user explicitly authorized R1–R3 application corrections and tracked
regressions on the existing branches. This follow-up supersedes the independent
review's open implementation findings, not A1–A7 acceptance. **R1–R3 are resolved
in implementation and offline verification.** No live native/operator acceptance,
version/compatibility changes or Git/remote operations are claimed.

### R1 — Grant provenance and exact choice accounting

Final assembly now records fixed-source grants separately from each rolled
occurrence. Resolution precedes generic deduplication. Two references within one
fixed class/ancestry grant are aliases; class versus ancestry and fixed versus
rolled grants are independent even with the same template UUID. UUID/name
deduplication cannot erase mastery before selection. UI requirement counting uses
the same distinction.

A fixed mastery plus a genuinely rolled mastery requires **two** choices; an
old one-choice request is rejected before Actor/Item writes rather than silently
discarding a grant or returning no mastery. Two rolled templates likewise retain
both selections. Assembly verifies exact selected/required cardinality and
consumes each choice once. Resolved custom templates retain their typed identity
through generator enrichment; importer source-plus-choice deduplication remains.
No new persistence flags, template repair or existing Actor rewrite is introduced.

Tracked regressions cover weapon and armor fixed/rolled overlap, repeated rolls,
fixed-reference aliases, independent class/ancestry grants, missing/extra choices,
generator enrichment, importer duplicates, immutable source templates and
cancel/reselect. A fake caller-bound finalize transport records **zero Actor or
Item writes** on rejected choices and unchanged existing Actor data.

### R2 — Native supported numeric damage ordering

Native4.0.6 `_ActorBaseSD._getActiveEffectKeys` aggregates ADD, then MULTIPLY,
then OVERRIDE, with the last override winning. The module now follows that
ordering across Actor and Item effects. d8 +3 ×2 therefore yields
`(d8+3)*2` in either source order. Tests include one effect, multiple effects,
multiple Items, all ADD/MULTIPLY/OVERRIDE permutations, combined additions and
multipliers, and zero/last-wins overrides. Unsupported native hooks are not
claimed implemented.

### R3 — Authoritative damage and completed consumer inventory

Read the pinned4.0.6 `items/WeaponSD`, `items/NpcAttackSD`, `PlayerSD`,
`NpcSD` and `_ActorBaseSD` source. Shared `prepareWeaponBase` reads only the
selected native Player damage field. Blank handedness derives from exact
Two-Handed property identity or missing1h/present2h data. No cross-hand borrowing,
Player `damage.value` fallback, invented d4/d6 or implicit ability damage.
Missing data reports **Damage unavailable** with the exact source field;
unresolved property UUIDs retain hydration diagnostics.

| Consumer | Corrected authority / boundary |
| --- | --- |
| Normalization and attack summaries | Source damage fields are preserved; exact declared property names feed the shared helper and both attack lists. |
| Standard inventory `ItemRow` | Shared selected base damage and Actor-adjusted damage, explicitly labelled separately; no UUID substring/hard-coded property or die fallback. |
| Paper inventory `ItemModal` | Same shared base/adjusted values and diagnostics, including2h-only source Items. |
| Standard `AbilitiesTab` and paper attack box | Prepared adjusted damage and warnings from `calculateAttacks`; no independent damage calculation. |
| Actor dialog defaults and server `getRollData` | Shared helper for ability/item/talent components and selected hand/type. Existing item command executes attack only; no automatic damage chain was added. |
| Native `NPC Attack` | Separate `damage.value`, ranges and item attack/damage bonuses; Player ability/mastery/global weapon effects do not bleed into it. |
| Dormant `item-properties` helper | Inventory found no callers. Removed its name/ID-specific weapon damage/property rewrites; unrelated description-link repairs remain. |

The cross-consumer fixture also exposed prepared-effect loss/double counting:
the sheet's flattened effect display is not Actor-only source data. Weapon
preparation now retains an Actor-only effect snapshot separately, then reads
Item effects once. Actor effects survive normalization and transferred effects
are not applied again from the flattened display.

Fourteen shared versioned fixtures cover missing damage, legacy wrong-field
data,2h-only d10 with blank handedness/no hint, explicit hands, versatile,
exact/unresolved property identities, missing selected hand, finesse, supported
bonuses/effects, transferred effects once and distinct NPC fields. The same
fixtures test source preservation, normalization, helper/summary agreement,
server formulas and actual inventory/modal/Abilities/paper rendering. The
isolated browser matrix additionally tests actual Actor-provider dialog defaults.

### Corrective verification and remaining gates

The new tracked `src/tests/weapon-rules.test.ts` regressions were run against
the pre-fix behavior: R1 lost Dagger, R2 returned `(d8)*2+3`, and actual R3
inventory rendering omitted Damage unavailable. The independent-review probe
remains historical evidence, not corrected-behavior coverage. These tracked
tests now pass, including both documented assembly combinations and downstream
generator/importer checks. No browser package was added to runtime dependencies.

Fresh passes: all six Shadowdark tests, Core unit/client/integration, root
TypeScript/lint, explicit three-module source typing, Shadowdark module checker
and isolated package. Actual inventory/modal/Abilities/paper/provider rendering
passes all fourteen fixtures at320/390/820/1440 light/dark (448 surface cases),
with all application network blocked and no services started. The tracked
React render assertions run in the existing module test/CI step; local browser
tooling is additional evidence, not a claimed clean-checkout browser install.
Direct React rendering emits existing untransformed styled-jsx attribute
warnings; no rendering exception or browser page error remains.

No confirmed R1–R3 defect or unresolved native source-value decision remains.
Genuinely missing Item data remains unavailable with diagnostics, not fabricated.
**A1–A7 were not performed**, including live damage/formula comparison and native
permissions; this is not4.1 migration or universal native-hook parity. The
subsequent user-authorized closeout above records their disposition, patch
versions and Git scope. Tagged publication remains separate from this closeout.
