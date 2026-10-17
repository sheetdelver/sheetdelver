# UI Documentation

Sheet Delver's UI is a Next.js and React shell over the Core Service. The
browser does not talk to Foundry directly; it reads and mutates through the
Sheet Delver API, receives Socket.io invalidation events, and renders
system-specific surfaces through the module SDK.

---

## Application Shell

The first screen is the usable player/admin experience, not a marketing page.
The main browser shell owns:

- Authentication and connection state.
- World readiness/status display.
- Actor selection and actor-page routing.
- Journals and shared content.
- Global chat, dice UI, and combat overlays.
- Module UI mounting, error boundaries, style scoping, and SDK context injection.

Reusable host components remain host-owned. Module UI consumes them through
`useSDKComponents()` from `@sheet-delver/sdk/react`; module code must not import
host component files directly.

The player layout also owns the world/session boundary for home, Actor, and
module-tool routes. A module page mounts only after Core confirms readiness;
an already mounted page is made inert during a temporary same-world outage and
is retired on confirmed closure, world replacement, or session loss. Module
pages should not poll global status, implement their own world-ready screen, or
redirect on world lifecycle. They still own local resource loading, errors,
and module-specific styling. A temporary Actor read failure is not proof that
the Actor was deleted; only a confirmed 404 should show that state.

**Unreleased service-account role block (ADR-0064):** Core's configured Foundry account
must be full Gamemaster. A lower/unknown role or active demotion makes the world
unavailable through this shared boundary, without exposing account details to
players. The admin backend shows the configured account's observed/required role
and directs the administrator to change it in Foundry and retry. Keep admin login,
status and recovery usable; no module-specific error modal or native user lockout.
This enforcement is not shipped Core 0.18.1 behavior. See
[configuration recovery](CONFIGURATION.md#service-account-role-and-recovery).

**Native world settings (SDK 3.3.0 / UI API 3.2.0, unreleased):** module UI can
read declared, authorized settings with `useWorldSetting(key)` from
`@sheet-delver/sdk/react`. It returns `{ result, revision }`; distinguish stored,
registered-default and unavailable results. `useModuleSettings` remains a separate
browser-preference API. Filtered `world:contextChanged` events invalidate context
without broadcasting setting values. The host hook retires stale requests across
world/session/module changes; modules must also refresh or reject dialogs/actions
opened under obsolete rule inputs, using `X-SheetDelver-Context-Revision` where
appropriate. See the [world context contract](MODULE_MIGRATIONS.md#rule-inputs)
and [compatibility requirements](MODULE_MIGRATIONS.md#compatibility-and-adoption).

The persistent layout mounts one shared-content host outside page-filtered
panels. Image shares use a viewport-bounded dialog; journal shares open the
authorized entry/page in `JournalModal`. Dismissal is scoped to user, world and
share identity across route changes. SDK `SharedContentModal` remains a
compatibility delegate, not a second overlay. Images and shared journals replace
each other, and journal replies are guarded by request/share identity. Each new
image receipt owns its loading state, including cached identical URLs. Both
dialogs contain keyboard focus, close on Escape and restore the prior control.
Only one dismissal record is kept per tab; storage denial still permits closing.
Image captions from native shares render as bounded, scrollable plain text
within that same dialog. Markup in a caption stays inert. Owner journal edits
retain raw source on unchanged saves and preserve nested Foundry Secret wrappers
when editing rich text; non-owner display responses are filtered by Core.
Native journal shares use a separate read-only view lease, not the ordinary
journal detail cache. The server resolves the exact entry/page and force value
from this recipient's latest receipt; a page-only share has no sibling navigation.
Unrevealed owner-only Secret sections are filtered before transmission. Close,
replacement and unmount dispose the modal's lease; late opens are disposed too.
New shares and session/world retirement invalidate old leases. Failed close
delivery is bounded by 30-minute idle expiry, without polling. Ordinary journal
browsing/ownership/editing are unchanged. See ADR-0062 J1 and
[shared-view endpoints](API.md#temporary-shared-journal-views).
Actor-page chat/dice may use the
currently owned Actor as speaker; the server verifies Actor ownership while
the authenticated user remains the message author.

---

## State Model

Module sheets may opt into SDK 2.3.0 / UI API 2.2.0 bottom-navigation clearance.
Core measures only registered visible viewport-bottom bars and offsets its
Tools, Chat, Players and player feedback above them. Hidden/unmounted/retired
bars release their reservation; other pages keep the default positioning.
This does not theme module tabs, reposition every mobile page or add a portal
API. Full-screen dialogs/drawers retain their existing overlay layout.

The UI state is split into focused providers and hooks:

| Area | Responsibility |
|---|---|
| Auth/status | Login, current user, world status, connection readiness. |
| Documents | Host-owned document cache. Generic `useDocument()` reads endpoint-defined document DTOs; `useActorSheet()` reads the authorization-bounded prepared Actor projection. |
| Journals | Journal/folder browsing, pagination, and shared journal content. |
| Chat | Chat message cache, dice tray state, and message submission. |
| Combat | Combat tracker projections (`CombatTrackerDto`), realtime refresh, and combat HUD state. |
| Module SDK | `SDKProvider`, injected SDK context, module event bus, and host component context. |

Module UI should prefer SDK hooks over direct REST calls when a hook exists. The
host cache deduplicates reads, refreshes on realtime invalidation, and keeps
permission checks centralized in server routes. Actor invalidations are emitted
only after Core publishes the replacement prepared revision, so card and sheet
refreshes cannot observe the older source revision.

---

## Module UI Loading

The browser resolves a module UI manifest with `getUIModule(systemId)`.

1. `GET /api/registry/sources` returns the active source for each module id.
2. Local dev source (`"local"`) loads through the generated
   `.managed/module-ui-registry.ts`, which contains explicit imports for modules
   under `<DATA_DIR>/local/modules`.
3. Managed artifact source (`"managed"`) loads through `GET /api/modules/:id/ui`.
   The server serves the compiled ESM artifact from `<DATA_DIR>/modules` and
   rewrites bare SDK/React imports to host-provided browser globals.
4. If a module cannot be resolved or throws during import/evaluation, the host
   falls back to the generic actor page/sheet and records the failure for
   lifecycle/admin visibility.

Managed artifacts are intentionally not bundled into the Next build. A stale or
broken installed artifact can fail at runtime without breaking `next dev` or
`next build`.

---

## Module Surface Hosting

Every dynamic module surface is mounted inside `SurfaceHost`.

`SurfaceHost` provides:

- A module-scoped root class, `.sdk-module--<id>`, for CSS isolation.
- Loading and error boundaries.
- Injection of SDK context and host component context.
- Best-effort runtime failure reporting when a module surface cannot render.

Module UI should use:

```tsx
import {
    useSDK,
    useSDKComponents,
    useActorSheet,
    useDocument,
    useDocumentMutation,
} from '@sheet-delver/sdk/react';
```

Use `useSDK().logger` instead of `console.*`, `useSDK().assetUrl()` for module
static assets, and `useSDK().resolveImageUrl()` for Foundry-relative image paths.

---

## Realtime Events

Raw Socket.io events are host implementation details. The app listens to
document-specific socket events from `AppSocketGateway`, then maps them into the
module-facing SDK signal bus.

Important raw event families:

| Event family | Purpose |
|---|---|
| `systemStatus` | Connection, world, auth, and readiness status. |
| `<type>Changed` | One document changed, e.g. actor, item, combat, journal, chat message, roll table, macro, playlist, or cards. |
| `<type>ListInvalidated` | A document list should be refreshed. |
| `sharedContentUpdate` | Image or journal share delivered only through this session's authorized Foundry transport. |
| `moduleSourceChanged` / `moduleStateChanged` / `moduleRegistryChanged` | Module source/lifecycle changes that require UI manifest cache invalidation. |

Module UI receives the stable SDK signals instead:

| SDK signal | Payload |
|---|---|
| `document:changed` | `{ type, id, action }` |
| `document:listInvalidated` | `{ type, reason }` |
| `content:shared` | `{ kind, data }` |
| `connection:changed` | `{ connected, worldId }` |
| `world:ready` / `world:teardown` | `{ worldId }` |
| `module:initialized` / `module:disposed` | `{ moduleId }` |

Since SDK 2.1.0 / `ui-extension-api` 2.1.0, `connection:changed`
reports each status snapshot, including a temporary link loss. `world:teardown`
means a confirmed setup/close or replacement of the authenticated world, not
a same-world transport blip; `world:ready` announces the next established
world after startup or replacement. A public-room status cannot prove a world
identity change. Modules should refresh on document signals and readiness,
without disposing world state merely because `connected` briefly became false.

---

## Combat Tracker (ADR-0028, ADR-0060)

ADR-0063 refinements: Actor/tool navigation uses normal flow below the HUD;
modules do not reserve a guessed HUD height. My character defaults to the
visible owned current turn, then an actionable owned initiative target, then
the first visible owned row. A manual choice resets with turn/encounter or
authority context. It never changes the encounter turn.

The initiative cue counts eligible owned unrolled participants independently
of the stats selector: zero hides it, one opens the registered module roller,
and multiple open a Core chooser. Individual rolls retain the module dialog.
Roll all confirms a fixed set of targets, refreshes eligibility before each
existing single-target command and uses each server default formula. It reports
applied/skipped/failed/unknown/unattempted outcomes and stops on failure or
uncertainty. It never automatically retries. Closing/session/world retirement
stops undispatched rolls; an in-flight request may complete. End my turn stays
tied to the current server-authorized row. No open-sheet detection is used.

`GET /api/combats` returns typed `CombatTrackerDto` projections built from the
backend encounter read model — never raw Combat/Combatant/Actor documents.

- Rows arrive server-ordered (Foundry initiative order); the current turn is
  identified by `currentCombatantId` / per-row `isCurrent`, never a positional
  index. Display identity follows Foundry's combatant → token → actor
  fallback, so unlinked NPC tokens show their token name/art; defeated state
  covers the tracker flag, linked-actor dead status, and unlinked-token
  (ActorDelta) dead status.
- Hidden combatants are absent from player projections, including hidden owned
  Actors. No placeholder, hidden-current flag, count, queue gap or hidden-only
  encounter reveals their presence. GMs see the full roster with a **Hidden
  from players** label. A current row not visible to the player produces a
  neutral current-turn area and no queue preview.
- Action capabilities (`canAdvanceTurn`, `canRewindTurn`, per-row
  `canRollInitiative`) are server-computed; the HUD renders them without
  reconstructing ownership.
- The compact HUD shows current turn, **Next shown** (visible-order preview),
  and an owned-character selector with up to three read-only selected stats.
  When the visible current combatant is owned by the player, **Your turn** gets
  a Core-themed accent highlight in the strip and expanded roster; other or
  unavailable current combatants do not get that cue.
  Its expandable roster contains all authorized rows, full names, portraits,
  initiative, current/owned/defeated labels and GM-only hidden labels. Linked
  or tokenless owned world Actors may show selected stats; unlinked scene
  Tokens show no base-Actor stats. The sheet shortcut opens a new tab.
- Active forming encounters remain visible only when a viewer has projected
  rows. During an open managed initiative phase, an inactive pre-Begin encounter
  exposes only the player's own visible rows. Eligible owners can roll their
  unrolled initiative and, after Begin, End my turn when enabled. GM/Assistant
  users get an Open Combat Manager shortcut and use manager controls. Ordinary
  encounters retain GM/Assistant navigation and current-owner End my turn.
  Player Begin is denied even if Foundry stores round-zero `turn: 0`.
- Initiative presentation receives a server-resolved formula: explicit GM
  override, module formula or Core fallback, in that order. The manager's
  override Save validates all current managed participants
  before persistence and shows field-level errors while preserving the draft.
  Clearing and saving restores module-first behavior. **Input Manually** means
  a final total, not an unmodified die; future Actor changes are checked again.
  **Insert attribute** lazily opens the existing field catalog filtered to safe
  numeric leaves, with search and cursor/selected-text insertion. Insertion
  changes only the draft, preserves keyboard focus and does not imply validation
  success for every participant. Advanced custom stat fields must have a label,
  safe path and matching current Actor value type before entering the draft;
  inline errors explain disabled controls or rejected checks, and late checks
  cannot add a changed/retired draft. GM configuration has no fixed stat-count
  cap; the compact HUD's existing three-stat presentation remains independent.
  The dialog offers only allowed roll modes or a manual final total. Core executes the action;
  modules may theme the dialog through the versioned SDK slot.
  A changed phase, score, formula, Actor association or lost row capability
  retires an open initiative dialog; the player chooses a fresh action.
  The shared initiative renderer reuses the SDK sheet roller's frame/theme,
  without appending Core chrome over a module skin. Module overrides may reuse
  their own sheet modal's presentation, but not its formula/recipient editors
  or raw-die arithmetic. Formula and audience remain server-owned.
- `combatChanged`, `combatListInvalidated` and
  `combatTrackerPreferencesChanged` are skinny invalidations — the client
  refetches its authorized projection; payloads never carry document data.

### Managed-HUD refinements (ADR-0061 N1–N3; operator-accepted baseline)

The October 14 operator review accepts the existing formulas, module rollers,
privacy/layout, turn controls and recovery. A compact **Roll
initiative** cue for eligible owned characters even with the roster collapsed,
with a chooser for multiple characters is now available. Pending own initiative is separate
from the player turn roster: unrolled/cleared rows stay at the bottom of the
GM list and are skipped by managed turn navigation until scored. Late NPCs
default hidden and remain so after scoring until the GM reveals them. Hidden
or other-owner pending counts never appear in the cue. Clearing the current
row's score pauses with **Awaiting initiative** until GM Next or a GM-restored
score; player rolls alone do not resume it. No owner End my turn while paused.

The manager reuses one Add/Edit stat editor for Text, Value / Max, Number
and Textarea, with editable labels, detail-grid column/row spans and a bounded
scrollable multiline text viewport. Narrow layouts clamp/stack spans; text
is read-only, not a new Actor-text write capability. Plain is the old-record
default; explicit HTML uses Core's sanitized rich-detail boundary. Existing
configuration Save persists the shared world/module settings. Apply changes
updates an existing draft selection without duplicating/reordering it; Cancel
discards that editor draft. Supported spans are 1–3 columns/1–6 rows, with
1–12 visible textarea rows; these bound the grid/viewport, not the stat count.
Textarea stays detail-only. A row-level Defeated/Restore toggle reuses the
existing participant-detail action and changes only the explicit Combatant
flag, not Actor dead effects. Awaiting initiative is shown in the manager;
navigation is disabled when no scored eligible rows exist. These additions
are implemented and offline verified. The user accepts queue/cue, pause, stat
editor/layout and row/detail Defeated reconciliation; explicit Skip is new scope in
[ADR-0061](adr/0061-managed-combat-player-participation.md#operator-acceptance-and-late-entrystat-addendum--october-14-2026).

**Implemented and operator-accepted refinements (ADR-0061 N4–N6):** the
thin strip groups Current / Next shown / My character, with owned portrait,
stats, sheet and explicitly targeted initiative controls together. One own-character
selector includes unrolled targets. ADR-0063 refines its default to the current
owned turn, then pending initiative, then the first owned participant; manual
selection lasts for that turn/context. The independent Roll initiative cue opens
one eligible participant's module dialog or a chooser for multiple participants.
Your turn, privacy, portraits and narrow reading order remain. The stat editor offers plain or sanitized HTML textarea
in the existing scrollable detail viewport. Rich text stays read-only/detail-only,
without raw HTML or Foundry interactive enrichment. Matching module defaults
are available through SDK3.2.0/module-api1.4.0, for Core0.18.0 adoption.

Separate Defeated and Skip controls are available in participant details/quick rows.
The per-encounter **Skip defeated enemies automatically** checkbox defaults off;
when enabled, marking an NPC defeated checks the same persisted Skip flag.
Manual Unskip while still defeated must persist. NPC Restore clears Skip;
player defeat never automatically skips, but explicit GM player Skip is allowed.
No separate derived automatic-exclusion layer. Disabling the encounter setting
does not clear existing flags. Assignment affects only new SheetDelver NPC
Defeated actions, not existing rows or external Foundry events. A current-row
Skip pauses until GM navigation or eligible Unskip/NPC Restore; failure after
pause requires explicit recovery. The manager distinguishes that pause from
Awaiting initiative and disables navigation when all rows are unrolled/skipped.
Actor dead effects remain separate. Row/detail controls and configuration are
offline verified and user-accepted for HUD/rich-detail/Skip behavior. Module
default declarations retain automated evidence; generation/publication
limitations are recorded in the ADR.

| Viewer | Ordinary HUD actions | Managed HUD actions |
| --- | --- | --- |
| Player | Roll initiative for eligible owned rows; End my turn only when the visible owned row is current in an active, started Combat | Own unrolled initiative during an open phase; End my turn when enabled for the current visible owned row after Begin |
| Assistant GM | Begin/Next/Previous and eligible initiative | Open Combat Manager; manager controls respect native document permissions |
| Role-4 GM | Begin/Next/Previous and eligible initiative | Open Combat Manager; no player-owner HUD lane |

The assistant and GM receive the full roster, including hidden rows; players
receive only visible rows. HUD buttons follow these projected capabilities,
but Core reauthorizes every command and checks the observed state before a
write. A stale ordinary command refetches on `409` rather than replaying the
old action. Managed owner commands follow ADR-0061's phase and observed-state
guards, never the privileged manager path. Native/HTTP checks pass on
Foundry13.351/Shadowdark4.0.6 and14.367/D&D5e6.0.2; user acceptance is recorded
in the completed ADR. This does not certify all system browser hooks. The
broader private directed-roll workflow stays deferred in ADR-0058.

Module components should treat realtime as invalidation. Refetch through SDK
hooks or host APIs instead of applying socket payloads as authoritative document
diffs.

---

## Styling

The host ships the global Tailwind reset and design tokens. Module styles compose
under the `SurfaceHost` root:

- Local dev modules can use Tailwind classes directly; the host build scans
  `<DATA_DIR>/local/modules`.
- Managed artifacts ship compiled scoped Tailwind output when the module has
  `src/styles/tailwind.css`.
- Static module stylesheets live under the module `assets/` directory and load
  through the module asset route.

Module CSS must scope selectors under `.sdk-module--<id>` unless the checker
explicitly allows the construct, such as `@font-face` or `@keyframes`.

### Maintenance-only presentation (unreleased correction)

Normal Core/Next workers stop during reviewed world maintenance. Core serves a
small dependency-free status/admin shell at the application port; it does not
load module assets or player providers. Its public panel contains no world,
target or recovery detail. Authenticated administrators see complete plans,
bounded reasons/progress, the mandatory backup-warning acknowledgement and a
keyboard-accessible stop confirmation. Browser light/dark preferences and narrow
viewports remain supported without mounting a module theme.

Old player pages retain the shared nondismissible, inert maintenance boundary.
Reconnects get public maintenance status only, never restored user transports.
After verified activation, an observed new runtime token requests a reload;
old assets cannot adopt the new mutation token. See [runtime lifecycle and
operator flow](MAINTENANCE_RUNTIME.md) and [API payloads](API.md#module-world-context-and-maintenance-apis-unreleased).

---

## Dice Presentation and Player Settings

The player shell owns one shared 3D dice presentation provider. It consumes
live chat create hints paired with authorized chat DTOs, not raw Foundry data.
Tray, actor-sheet, SDK, and Foundry-originated rolls use this same path when
they contain supported evaluated dice terms. Modules must not add their own
renderer or animation socket subscription.

The bottom-menu Settings dialog lives in `components/Settings/`. Its Chat &
Rolls tab contains browser-local chat toast and dice preferences; General and
Themes are reserved disabled tabs. Dice components stay in `components/Dice/`.
Chat toasts reuse NotificationSystem with a title, plain-text body, configurable
duration, and one replaceable message above the bottom menu. A broader
notification-system redesign is deferred.

See [3D Dice Presentation](dice-presentation.md) and
[ADR-0039](adr/0039-client-dice-presentation.md) for supported terms, privacy,
resource cleanup, and architecture boundaries.
