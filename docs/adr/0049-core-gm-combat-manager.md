# ADR-0049: Core GM Combat Manager

**Status:** Accepted — first release verified; October 2026 addendum pending
**Date:** September 24, 2026
**Related:** ADR-0011, ADR-0012, ADR-0013, ADR-0028, ADR-0038, ADR-0048, ADR-0058

## Context

The existing CombatHUD is a compact, audience-filtered tracker, not a GM
encounter-building surface. Core already mirrors Foundry Combat, Combatant,
Actor, Folder, Setting and Scene source documents, and its Combat repository can
write Combat and embedded Combatant documents over the requesting user's
Foundry connection. The dashboard's module tools demonstrate a card-to-page
interaction, but a universal combat utility belongs to Core rather than any
system module. World Actor lists used by player dashboards intentionally omit
NPCs and are not a GM participant picker. Compendium Actors are separate pack
documents; pack IDs are not world Actor IDs.

Isolated Foundry v13/Daggerheart and v14/Shadowdark tests established that a
`scene: null` Combat with Actor-ID Combatants and null Token/Scene IDs can be
created, persisted across restart and advanced without Tokens. Two copies of
one v14 pack Actor acquired distinct world Actor IDs and independent HP. The
pack UUID remained provenance, not Combatant identity. A scene-null Combat is
also Foundry's ordinary global encounter, so scene nullity alone is not an
ownership marker. Those tests did not prove every system hook, resource path,
permission edge or cleanup failure mode.

Foundry's native Combat start/turn/round methods and pre-command hooks run in
its browser client. Core's user-bound document writes persist round/turn and
produce document events, but cannot invoke native pre-command hooks or promise
system-overridden start state, world-time or ActiveEffect behavior. Core's
primary Store is a source mirror, not a Foundry browser runtime (ADR-0038).
ADR-0028's existing SheetDelver-managed progression is therefore a deliberately
bounded first-version command contract, not native-method parity.

## Decision

1. Core adds a dedicated GM Tools card and `/tools/combat` page, separate from
   the player CombatHUD and `/admin`. First-version manager list, search, detail
   and every mutation route require a role-4 Gamemaster. Hiding a card is not an
   authorization check; assistants and players receive 403 from manager APIs.
   Existing player CombatHUD routes and audience rules remain unchanged.
2. The manager handles only SheetDelver-marked, `scene: null` Combats. Its
   versioned `flags.world.sheetDelverCombat` object holds a validated label,
   `mode: "tokenless"`, retention choice, lifecycle status, Folder ID, owned
   copy IDs and completion metadata. Unmarked global and scene-linked Combats
   are never adopted or mutated by manager routes. No second encounter store
   exists; CombatStore mirrors the Foundry Combat document. Creation leaves
   Foundry's `active` bit false: both tested Foundry server generations
   deactivate other active Combats when one is created or updated active. The
   manager's `status: "active"` means editable/runnable inside SheetDelver,
   independently of Foundry's global active bit. Before Begin, the page reads
   the current GM-visible Combat list. It asks for confirmation only when
   another Combat is active, warning that activation deactivates that Combat
   (including a scene encounter); with none active, Begin proceeds directly.
   The manager's first round/turn update sets Foundry `active: true`.
   Rewinding to round zero clears it again.
3. Creation makes a dedicated world Actor Folder for the encounter. A world
   Actor selected from the ActorStore is **linked by its canonical Actor ID**,
   whether PC, NPC or another system-specific type. Selecting directly from
   an Actor compendium makes a new world Actor copy in that Folder. Every copy
   has its own Actor ID; its original pack UUID is provenance, not the
   Combatant `actorId`. The source of a selection determines link versus copy;
   there is no world-Actor Copy action or PC/NPC-type heuristic. Linked Actors
   remain authoritative for ongoing story/game state.
4. The manager projects only bounded, GM-authorized fields: encounter label,
   status, round/turn, ordered roster, participant source, initiative, hidden,
   defeated and a validated configured resource when available. Browser code
   calls authenticated Core APIs; only server services access Stores and
   dispatch Foundry writes. Ordinary Actor editing remains on the Actor sheet.
   The shared GM stat-display preference below is the manager's only
   stat-selection authority (an earlier interim Actor-card block strip was
   removed); module CSS and arbitrary card fields do not cross the manager
   DTO.
   A resource quick edit is permitted only when the configured path resolves to
   a persisted, writable Actor source field; prepared-only or ambiguous values
   are read-only or omitted. No Shadowdark, D&D or other system-name branch is
   allowed in the manager. The request includes the observed Actor ID, resolved
   source path and numeric value; the service rejects a stale observation with
   409 before dispatching an absolute write. This protects against already-
   mirrored GM/Foundry edits and changed Combatant/resource identities, but is
   not atomic with external Foundry writes between preflight and dispatch.
   A dirty GM draft retains its original observation through realtime refresh
   and refetches on conflict. This operation is **Set tracked resource**, not
   generic damage/healing or `Actor.modifyTokenAttribute` parity.
5. Start/Next/Previous use ADR-0028's current document-state progression,
   including its skip-defeated policy. The UI states that this does not
   guarantee native Foundry pre-command hooks, system overrides, world-time or
   effect parity. Native client-command integration is deferred investigation,
   not a browser dependency for normal manager operation. Managed turns use
   separate GM-only routes under the encounter mutation guard; the older
   CombatHUD turn routes remain available for unmarked Combats only. Adding a
   participant or changing initiative mid-round preserves the current
   Combatant identity despite row reordering. Roll All and Roll NPCs mirror
   Foundry's unrolled-only selection; NPC means a Combatant whose world Actor
   has no non-GM OWNER, independent of Actor type. A GM-only batch reuses
   Core's user-bound initiative roll path and preserves current-turn identity
   after reordering. Hidden initiative chat rolls are GM-only. The universal
   CombatHUD is omitted on the manager page while other pages keep it. The
   legacy single-roll route cannot bypass manager initiative controls.
6. `Keep for history` is unchecked by default at creation. Completion requires
   an explicit GM confirmation. With retention, the Combat, Folder and
   compendium-derived copies remain, marked completed and read-only in the
   manager. Without retention, cleanup may delete only the marked Combat, its
   verified encounter-owned copies and its verified Folder. It never deletes
   a preexisting world Actor, even if linked as an enemy. Unexpected Folder
   contents, nested Folders, external Combat/Scene Token references or
   mismatched ownership halt cleanup safely. A partial failure
   leaves recoverable lifecycle metadata and supports a guarded retry; the
   Combat is deleted last. Merely reaching the final turn never completes an
   encounter.
7. Retained history reflects current values of linked world Actors; it does
   not reconstruct their past HP or status. Compendium-derived copies retain
   encounter-specific state. Bounded Actor snapshots, action/change logs,
   notes/counters, reopening/replay, assistants and scene-linked management
   are deferred. If later added, tracker-only historical data belongs on the
   same Combat flag, not a parallel database.

### Follow-up decision: shared GM stat display

The Combat Manager's basic stat selection is a shared preference for the
current Foundry world and active system module, shared by all authorized
Gamemasters. It is not per-encounter tracker state or a historical Actor
snapshot. The selected Editable flag below authorizes only bounded Actor
source-field writes, not arbitrary fields.

- A system module may provide optional combat-stat suggestions in its
  `info.json`: stable key, short label, safe prepared-Actor attribute path,
  bounded display kind, and optional Actor types. Core validates and bounds
  this metadata. Existing modules without suggestions remain compatible; no
  system-specific paths are hardcoded in Core.
- The manager offers GM configuration to add, remove, reorder and relabel
  suggested or custom safe attributes. Its ordinary picker discovers bounded
  numeric, text and resource fields from available prepared Actor shapes in
  the current world, across Actor types, so GMs need not know JSON paths.
  Module suggestions supplement that list; manual paths are advanced-only.
  Discovered scalar labels include parent context (for example, `Armor · Mod`)
  and colliding labels use more of the path; no system-specific stat names are
  hardcoded. Each selected stat has an optional roster-placement checkbox.
  Checked stats render compact read-only pills beside combatant names in the
  configured order; unchecked stats appear only in the detail panel.
  This is observed Actor data, not a promise that Foundry's generic document
  schema describes every system-specific field or future Actor type. Values
  are projected on the server from authorized prepared Actors and omitted
  where unavailable. A GM may mark a selected `system.*` number or resource
  Editable. Core exposes an edit control only if the source Actor has a finite
  number at that path and the prepared display value matches it. Derived and
  text fields remain read-only; module suggestions do not grant edit access.
  The server rechecks the saved GM selection, Actor identity, path and latest
  source value under the encounter guard before user-bound Actor dispatch.
  Stale observations return 409. This is best-effort Core Store preflight,
  not an atomic Foundry compare-and-set. World Actors are edited in place;
  compendium copies are edited independently. Retained completed encounters
  cannot be edited. The existing configured Foundry tracker-resource quick
  edit remains separately source-backed. Stat, tracked-resource and initiative
  number edits commit on blur or Enter without a per-field Save button;
  configuration changes still require Save.
- A GM can mark exactly one editable selected field as Default health. The
  roster then offers a right-aligned Damage action for each participant with
  a writable source value. Its Core-themed modal shows current health and
  source max when present, allows a direct current-value edit, and applies a
  positive amount as Heal (`current + amount`) or Damage (`current - amount`).
  This is simple arithmetic through the same guarded stat endpoint, without
  automatic clamping or system-specific damage/healing rules. Actors without
  that field keep a disabled action. This health choice lives in the shared
  world/module GM preference, not the Combat flag.
- Core persists the shared selection in a versioned, atomically written file
  under the configured data directory's durable `config/` area, keyed by
  world ID and module ID. It is not stored in browser localStorage, the
  cache-backed module DataStore, or an encounter's Combat flag. It survives
  world unload, process restart, and cache rebuild. GM-only APIs enforce the
  same role-4 boundary as the manager.
- An existing saved selection takes precedence, including an intentionally
  empty selection. If no saved selection exists, module suggestions apply;
  without either, no extra stats appear until a GM configures them. Reset
  removes the saved selection and restores module suggestions. Other GM
  views refresh after changes. Retained encounters continue to show live
  linked-Actor values under the current preference, not historical snapshots.

Verification for this follow-up must cover manifest/path validation, GM-only
access, fallback and intentional empty selection, world/module isolation,
restart and cache-deletion persistence in a disposable data directory,
missing/derived Actor values, and multi-GM refresh. The interim card-block
checkpoint is not final acceptance of this follow-up.

### Repeated enemies and initiative controls

**Status:** Implemented. Bounded repeated enemies, Add participant sorting and
individual initiative controls extend the GM-only, tokenless manager without
claiming system-specific combat mechanics. They are motivated by the
quantity and distinct-instance controls in
[Heart of Daggers](https://heartofdaggers.com/support-articles/getting-started-encounters/),
duplicate labels in [D&D Beyond Maps](https://dndbeyond-support.wizards.com/hc/en-us/articles/46385529638164-Combat-Encounters-on-Maps),
and Foundry's individual roll, reroll, clear and reset controls in its
[Combat Encounters guide](https://foundryvtt.com/article/combat/).

The Add participant picker defaults to **Name ascending**. A small ordered
sort-key control lets the GM choose up to three additional Actor
stat fields observed in the current world-Actor source or selected Actor
pack, set ascending/descending per key, and remove a key. The first chosen
stat is the primary sort; subsequent stats and then Name/Actor ID break ties.
Name has its own ascending/descending control, defaults to ascending, and is
primary when no stat is chosen. The dropdown is discovered from Actor
source data, **not** the GM's selected combat-stat display preferences and
not a hard-coded Level/CR/HP list. It offers only bounded, comparable source
values (numeric or short text; a resource's numeric value/max may be labeled
separately), with contextual labels so bare `value` or `max` is ambiguous
nowhere. Missing values sort last in either direction. Clear restores Name
ascending and clears the search text without changing the source/pack.
Sorting and searching run on the complete GM-authorized candidate set; the
picker's former 40-row truncation is removed, so every matching Actor remains
selectable in the scrollable list. The pack stat catalog uses GM-bound
Foundry index projections, with no source documents sent to the browser; a
field that cannot be read reliably is omitted rather than sorted partially.
The server validates requested sort paths against the current discovered
catalog.

1. The compendium Actor picker has a bounded quantity input (1–20). The
   limit is persistent helper text beside the input, not only a hover
   tooltip, so it remains visible on touch and keyboard layouts.
   The limit applies per Add request, not as a cap on encounter size. Each
   requested instance follows the existing copy path: a distinct
   world Actor ID in the encounter Folder, the original pack UUID as
   provenance, a recorded owned-copy ID in the Combat flag, and one
   Combatant. Each instance has independent HP and other Actor state. World
   Actors remain linked one at a time; quantity never creates repeated
   Combatants pointing at the same world Actor. The server rejects a
   duplicate world-Actor link within one encounter rather than imply an
   independent instance. An already-linked world Actor stays visible in
   search with Add disabled and an `Already added` cue; the server's
   duplicate guard remains authoritative if another GM adds it concurrently.
2. Repeated instances get stable, unique Combatant **display names** such as
   `Ooze #1`, `Ooze #2`, without renaming the source pack document or copied
   Actor. The suffix is allocated from a counter on the same Combat flag and is
   never silently reassigned after a removal. Names are Combatant names; the
   copied Actor is never renamed. Quantity groups only the **add action**;
   the running initiative order shows each independent Combatant at its own
   position. Grouping is a separate open design item (addendum A5).
3. Each row has compact Roll/Reroll and Clear initiative actions, and Reset
   all sits beside Roll All/Roll NPCs. The server reuses the GM-bound,
   adapter-formula initiative path through dedicated manager routes and the
   encounter lock, not the older CombatHUD endpoints. Reroll replaces only
   that Combatant's score; Clear sets only that score to null; Reset all
   clears every score in one request. Current Combatant identity survives
   reordering, hidden Combatant rolls are whispered to GMs, and Reset all is
   confirmed only when at least one score exists. All controls are
   unavailable on completed encounters; no native pre-command hook parity
   is implied.
4. Bulk creation is not atomic. Each copy keeps the marker and compensation
   guarantees. If instance N fails, the error reports how many earlier
   instances succeeded and the roster refreshes; the request is not
   replayed automatically. Cleanup deletes only verified encounter-owned
   copies. Invalid quantities are rejected before any write.

Encounter notes, timed reminders, action history, Actor-condition mutation,
temporary-HP rules and player-facing controls are **not** included in this
slice. They need separate decisions about Combat-flag state, Actor source
authority and system rules. Daggerheart spotlight/Fear mechanics are likewise
outside this initiative-oriented follow-up; no system-name branch is added
to Core.

### Addendum: player initiative, history removal and roster ergonomics

**Status:** Accepted for implementation (October 2026). A1–A4 and A6–A8 must
be implemented and verified before this ADR is marked Completed. A5 is an
open design item and is not a completion gate. This addendum revises the
slice above only where stated: A1 adds one player-facing control; every
other player control remains out of scope.

**A1. Players roll their own visible characters' initiative.** The first release
made the CombatHUD view-only for managed encounters: its initiative route
refuses every caller without the manager command flag, and the HUD projects
`canRollInitiative` only for a GM. That differs from Foundry's own tracker
and common online trackers, where a player rolls for their own character.

- **Universal prompt.** When individual initiative is requested and a player
  owns one or more visible, unrolled Combatants in a managed encounter, Core
  shows one prompt listing only those characters on any player page. Each
  character may use the resolved module/GM formula or enter a final total.
  A custom formula selected for particular actors by the GM uses the reusable
  Core directed-roll flow in ADR-0058; the current module `rollModal` and
  Core `RollDialog` cannot be assumed to honor an external formula unchanged.
  The modal can be dismissed ("Later") and reopened from a player-visible
  pending control. It closes when no eligible unrolled row remains or the
  encounter leaves `active`.
- **When it appears.** A managed encounter keeps Foundry's `active` bit false
  until Begin, so the existing pre-combat banner (`active && !started`) never
  shows it to players. The prompt is therefore driven by a narrow
  player-scoped projection of managed encounters in `active` status
  (including before Begin) that contains only the encounter label and the
  caller's own **non-hidden** unrolled rows, so players can pre-roll without
  the manager activating the Foundry Combat. Showing the full roster to
  players before Begin is not part of this change. Multiple encounters keep
  their rows and dismiss/reopen state distinct by Combat and Combatant ID.
- **Authorization.** A non-GM user may set initiative for a Combatant only
  when the encounter is `active`, the Combatant is non-hidden and unrolled,
  and the user has OWNER permission on its world Actor. Ownership and hidden
  state are rechecked on the server; client flags are presentation only.
  Compendium copies are created with `default: 0` ownership, so they are
  never player-rollable unless a GM grants ownership.
- **Input bounds.** For player requests the server accepts only the formula
  resolved by A8 or supplied in a valid GM-directed request, or a bounded
  numeric final total. Arbitrary dice expressions and extra modifiers from
  players are rejected. A manual entry is trust-based, as at a physical
  table, and its private chat card is marked as manually entered.
- **Execution.** Both paths run under the encounter lock through the same
  user-bound roll path and server-selected chat audience, preserving current-
  Combatant identity after reordering. Hidden Combatants stay GM-controlled;
  their GM rolls remain whispered rather than leaking through a player prompt.
- **GM visibility control.** Foundry already supplies `Combatant.hidden`,
  which the manager can edit and the player projection redacts. Add a
  discoverable per-row toggle in the manager, not another flag; verify an
  immediate player prompt/HUD refresh when it changes.
- **Still GM-only.** Reroll, Clear, Reset all, batch rolls, turn controls and
  every other mutation. A player cannot roll for a Combatant they do not own
  or replace an existing score; those requests return 403 or 409. Turn
  advancement by players ("End turn") is not included and needs its own
  decision.
- **Interplay with A7.** The Begin confirmation distinguishes player-owned
  unrolled characters from NPCs, so the GM can wait for players, roll NPCs
  and begin, roll all and begin, or begin anyway.

**A2. Round ledger and Journal history.** This supersedes first-release
decisions 6–7 for newly completed encounters. The GM revised the retained-
Combat design: a kept encounter should leave a readable, round-by-round
Journal record, not indefinitely retain its Combat, copied enemies and Actor
Folder. The encounter recipe should permit a new encounter to be built from
current sources; it is not a promise to restore old live Actor documents.

- During play, keep an ordered, bounded ledger associated with the marked
  Combat. Record round/turn transitions, initiative formula and total (or a
  manual-total marker), and changes to the GM-selected displayed fields with
  participant name, field label, previous value and new value. Unchanged
  fields do not generate entries. Rewinding appends a transition rather than
  rewriting earlier history. Each event has stable order and enough identity
  to distinguish repeated actors. Manager writes have explicit command
  context; Actor changes received from Foundry may be marked as observed
  changes, not attributed to a manager command. A connection gap cannot
  reconstruct every intermediate outside edit: compare with the last stored
  observation on recovery and label any difference as a gap, not a precise
  action sequence. Avoid bootstrap emissions and event feedback loops.
- When Keep for history is checked, completion first writes a GM-only
  Journal with readable round/turn pages and a versioned, server-validated
  recipe (world Actor IDs and pack source UUIDs, not temporary copy IDs),
  plus a bounded final snapshot of selected display fields. The request-
  scoped Journal repository and Store are the only document path. Once the
  archive is verified, reuse the existing ownership and external-reference
  cleanup checks to remove owned pack copies, Folder and Combat. Failure to
  archive leaves the live documents intact; interrupted cleanup retries
  against the same marked Journal, never creating a second archive. Linked
  world Actors are never deleted.
- Manager history lists marked Journals separately from active Combats. Open
  History opens the Journal; Create from history previews each recipe source
  and warns if a world Actor or compendium entry is missing or changed before
  creating a new encounter. It does not silently omit an unavailable source.
  Existing retained completed Combats need an explicit GM-triggered archive
  migration, not a silent background deletion. Deleting a Journal follows
  normal GM Journal permissions and removes that historical record.
- The active encounter list puts active/provisioning/cleaning Combats first,
  and never auto-selects history while an unfinished Combat exists. An
  unchecked Keep for history choice retains the existing verified cleanup
  behavior and creates no Journal.

**A3. Edit drafts survive realtime refresh.** The manual initiative input is
reset whenever the selected participant's projection refreshes, so any
Combat or Actor event (including another GM's change) discards a value being
typed. That is a race between local editing and realtime projection.

- Every editable number on the page (initiative, tracked resource, selected
  stats, and the health modal's current value) keeps a dirty draft with its
  original observation until commit or cancel. A refresh updates only
  untouched fields; changing the selected participant or encounter discards
  the draft.
- Manual initiative edits gain the same expected-value precondition as stat
  and resource edits: the request carries the observed initiative and the
  server returns 409 if it changed. On 409 the page shows the newer value and
  keeps the GM's draft for an explicit retry. This is a Core Store freshness
  check, not an atomic Foundry compare-and-set.

**A4. Damage or heal several participants at once.** For area effects, a GM
can select multiple participants and apply one positive amount as Damage
(`current − amount`) or Heal (`current + amount`) to each.

- Only rows whose Default health stat is editable can be selected; others
  show a disabled checkbox. The batch is relative only; direct value setting
  stays per participant.
- One request carries each target's observed Actor ID, path and value. The
  server takes the encounter lock once and applies each write through the
  same guarded stat path in roster order, with each target's own stale check.
  A stale or failed target stops the batch and reports "Applied N of M",
  then the roster refreshes; nothing is replayed automatically.
- Arithmetic matches the single-target modal: no clamping, resistances or
  other system rules. The batch size is bounded (for example, 100), and
  completed encounters reject it.

**A5. Grouped repeated enemies (open design item).** Quantity currently
creates independent copies with independent initiative; nothing groups them.
Shared group initiative, as in several online trackers, needs a group
concept first: identity and storage, how a grouped row shows the active turn,
whether removing or defeating one member affects the group, and how grouping
interacts with A4. Foundry v13 and v14 define a native `CombatantGroup`
embedded document; evaluate its persistence and tokenless behavior in
disposable worlds before inventing a Combat-flag group. Side initiative
(one roll decides whether the party or the enemies act first, as in Mörk
Borg's core rules, where per-character initiative is an optional rule) is a
grouping question of the same kind and belongs here, not in A8. Until then,
quantity remains "add N independent copies".

**A6. Rename an unstarted encounter.** A GM can change the label of an active
encounter only while it is at round 0. The server validates the label as at
creation (1–100 characters), updates the Combat flag and the encounter
Folder's name after verifying the Folder's ownership marker, and rejects the
change once the encounter has begun or completed.

**A7. Roster ergonomics.**

- **Begin with unrolled participants.** If any participant has no initiative,
  Begin opens one Core modal that counts unrolled player characters and NPCs
  separately and offers "Roll NPCs and begin", "Roll all and begin", "Begin
  anyway" and Cancel (Cancel is how the GM waits for players to roll through
  A1). Roll-and-begin choices apply only when every targeted Actor has a
  resolved formula; otherwise the GM can request a custom roll, enter values
  manually or begin anyway. It merges with the existing other-active-Combat
  warning so the GM sees one confirmation, not two.
- **Concurrent GM changes.** The encounter lock still fails fast, but a busy
  rejection carries a stable error code (not a message match). The page shows
  it as a brief notice and refreshes instead of a red error.
- **Stat-preference refresh.** Replace the page's 15-second preference poll
  with a server event emitted to Gamemaster sockets when a preference is
  saved or reset. The event carries no preference data; the page refetches
  through the GM-only route, and also refetches on window focus and socket
  reconnect.

**A8. Initiative formula source without hardcoding systems.** Systems do not
share one initiative die (Mörk Borg's module uses `1d6` plus Agility,
Shadowdark and D&D 5e have their own formulas), and Core must not name
systems. Core already asks the module: the SDK adapter's
`getInitiativeFormula(actor)` hook feeds every initiative roll, manager rolls
included, and all three local modules implement it. The gap is the fallback:
the SDK base adapter silently returns `1d20` when a module does not override
it, which is wrong for non-d20 systems.

- **Resolution order.** (1) The module adapter's individual-initiative
  formula, which stays the authority whenever a module provides one
  (ADR-0038: modules own system rules). (2) Otherwise, a GM-configured
  initiative formula stored in the same shared world/module preference as
  the combat-stat selection, with the same GM-only access, durability and
  refresh rules. (3) Otherwise, no automatic formula or automatic player
  roll prompt: the GM may enter initiative directly or select one or more
  eligible Combatants, choose a bounded custom formula and send a private
  directed roll request through ADR-0058. The silent `1d20` default is
  removed. A module formula need not imply that its system always uses
  individual initiative; the GM can choose whether this encounter requests
  individual player rolls. Side/group initiative remains A5.
- **GM-configured formula.** Limited to dice terms, numbers and `+`/`−`, with
  optional `@` attribute references that pass the same safe-path validation
  as selected stats and resolve against the prepared Actor. A reference that
  does not resolve for an Actor makes that Actor's formula unavailable
  (manual entry) rather than rolling with a missing term. The configuration
  shows a preview against the selected participant.
- **Foundry system `initiative` field.** Not used as an authority. In
  captured world data, Shadowdark's value is
  `@initiativeFormula + @initiativeBonus`, whose terms are produced by the
  system's browser code (`getRollData()`), which Core does not run; D&D 5e
  does not set the field and defines its formula in code. It may at most be
  offered as a suggestion for the GM field when every reference resolves
  against prepared Actor data.
- **Advantage modes.** Core's advantage/disadvantage rewrite applies only to
  a leading `1d20` (or its existing keep-high/low form). Offer those choices
  only when the resolved formula and system rule permit them; a GM-selected
  custom request does not gain d20 advantage merely from its die shape.
- **Projection.** Initiative DTOs (manager rows and the A1 player
  projection) state whether a native formula is available and whether
  advantage applies, without sending formula internals beyond what the
  dialog displays.
- **Contract impact.** Making the SDK base adapter return "no formula"
  instead of `1d20` changes a published SDK default. Review it through
  `src/shared/sdk/contractVersions.ts`, update module-authoring and SDK
  documentation, and keep existing module overrides working unchanged.

**Verification for this addendum:** the universal player prompt with one and
several owned visible characters, native and final-total manual entry,
no-formula GM-directed requests through ADR-0058, dismiss/reopen, and
pre-Begin visibility limited to the player's own non-hidden rows; owner-only,
unrolled-only player rolls, rejected arbitrary formulas, and their 403/409
refusals; hidden-roll audience and per-row GM toggle; round/turn ledger,
observed-field diffs, GM-only Journal archive, retry-safe cleanup, legacy
retained-Combat migration, recipe preview and listing order; draft retention
through refresh and the initiative 409 path; multi-target damage/heal with
partial failure and
stale targets; rename gating at round 0 and Folder marker checks; Begin with
unrolled participants; busy-lock notice; and preference refresh across two GM
accounts without polling; formula resolution order (module formula,
GM-configured fallback, none), safe-path rejection, unresolved references
falling back to manual entry, advantage shown only for d20 formulas, and
existing module overrides unchanged after the SDK default changes. Use isolated
data and disposable Foundry worlds only.

## Implementation and verification requirements

- All manager reads and writes recheck GM role and marked tokenless status on
  the server. Copy/Folder ownership markers must agree with the Combat flag
  before deletion. User-bound transport remains Foundry's final permission
  authority; mutations fail closed on missing source documents or mismatches.
- The compendium picker uses bounded user-authorized pack-index/document
  requests, never raw pack documents in browser responses. World search uses
  ActorStore, not player actor-list endpoints. IDs and paths are validated.
- The GM page responds to permitted Combat and Actor invalidation events and
  refetches projections. Source stores, prepared Actor models and authorized
  DTOs remain separate. No direct Foundry socket in client components. Native
  browser alert/confirm/prompt dialogs are not used; Core's shared modal handles
  destructive and conditional confirmations. The tool card uses its dashboard
  context, while the dedicated manager page and modal use the Player Core
  dark/light palette rather than module theme overrides. The page retains
  only the active world background with the palette scrim, falling back to
  Core's canvas when absent; a system module's fallback artwork is not used.
- Tests cover GM/assistant/player access, marked versus unmarked/scene-linked
  Combats, world NPC links versus independent pack copies, identity/provenance,
  completed-history write rejection, safe cleanup and partial-failure retry,
  plus source-backed resource validation. Isolated v13/v14 integration tests
  are desirable for transport/Foundry behavior; production-connected worlds
  are not test targets.

## Consequences

The first version is a usable, system-neutral encounter manager backed by real
Foundry documents, with a clear limitation around native browser combat
semantics. Its retained-Combat history shows current linked-Actor values; A2
replaces that first-release limitation with a bounded Journal ledger and final
selected-field snapshot for newly archived encounters. The
versioned Combat flag and copy markers make retention and cleanup auditable
without conflating SheetDelver encounters with all scene-null Foundry combats.
The prepared defeated flag combines the Combatant flag with direct, enabled
raw `dead` ActiveEffects on the linked Actor or token ActorDelta. This narrow
source-document fallback ignores disabled effects, but does not promise native
`actor.statuses` parity for suppressed/transferred effects or systems that
reconfigure `CONFIG.specialStatusEffects.DEFEATED`. The Actor sheet remains the
route for broader Actor-state changes; a native-client bridge is separate
future investigation.

## Verification

**Verified for the first release** (everything above the October 2026
addendum):

- **Synthetic Core tests** cover GM-only access and assistant/player 403s,
  marker scoping against unmarked and scene-linked Combats, world links
  versus pack copies and their provenance, source-backed resource and stat
  edits with stale-identity/path/value 409s (no Actor write dispatched),
  disabled versus enabled `dead` effects, turn gating, retained history,
  safe cleanup with partial-failure retry, stat-preference validation,
  saved-empty versus module-default selection and world/module isolation,
  picker sort discovery/priority/missing values, quantity limits, numbering
  after removal and partial-failure cleanup, individual roll/reroll/clear,
  Reset all and current-turn preservation. The full unit suite, TypeScript,
  lint and production build pass.
- **Isolated Foundry v14.367 (Shadowdark), service level:** create an
  inactive Combat and Folder, link a world Actor, copy a pack Actor with a
  new world ID, activate on Begin, deactivate on rewind to round zero, and
  clean up or retain on completion; three numbered copies (`Aboleth #1`–`#3`)
  persisted with distinct Actor IDs; individual initiative reroll, clear,
  reset and current-turn preservation.
- **Isolated v14, rendered GM page:** individual Roll persisted after the fix
  that reads the evaluated Roll attached to the chat document (numeric
  content remains a fallback); a brief transport interruption showed Core's
  shared reconnect boundary (ADR-0057) and kept the selected encounter.
- **Pack-read ingress:** opening a 244-entry Actor pack previously inflated
  the world ActorStore from 7 to 251 Actors; with the scope fixes it stays
  at 7, with focused regression tests.
- **Operator reports:** the manager flow, stat display, health action and
  initiative controls work in manual use and across two GM accounts with
  shared stat preferences; after restarting the same Foundry world and
  logging in again, the Combat and selected stats remained.
- **Appearance:** the page uses the Player Core palette, controls and
  world-artwork scrim under ADR-0053's unified theming, so dark/light
  behavior follows Core's verified palette; no separate theme acceptance is
  required.
- **Separate incident:** a reported unbegun-Combat deletion came from the
  installed Shadowdark Crawl Helper module (a Foundry `Combat/delete` from the
  main GM's own session; disabling the module stopped it). SheetDelver needs
  no workaround; manager completion requests and Combat delete ingress are
  logged for future comparison.

**Not verified, by design or as optional follow-up:**

- Live Foundry v13 runs (optional, not a release gate).
- Native Foundry combat-command hooks, system-overridden start state,
  world-time and effect timing.
- Atomic compare-and-set against external Foundry writes; the 409 checks are
  Core Store freshness checks only.
- Assistant-GM access, scene/token-linked encounters, and every deferred item
  listed in decision 7 and the repeated-enemies section.
- The October 2026 addendum (A1–A8), which has its own verification list and
  gates completion of this ADR (except A5).
