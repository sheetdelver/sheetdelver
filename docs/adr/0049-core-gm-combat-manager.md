# ADR-0049: Core GM Combat Manager

**Status:** Accepted — manager and stat preferences implemented; GM acceptance pending
**Date:** September 24, 2026
**Related:** ADR-0011, ADR-0012, ADR-0013, ADR-0028, ADR-0038, ADR-0048

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
   A bounded, read-only Actor-card block strip was added as an interim
   follow-up. The shared GM stat-display preference below replaces card
   blocks as the manager's eventual stat-selection authority; module CSS and
   arbitrary card fields do not cross the manager DTO.
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
   including its skip-defeated policy. The UI will state that this does not
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

### Repeated enemies and proposed initiative controls

**Status:** Bounded repeated enemies and Add participant sorting are implemented
on the branch. Individual initiative controls remain proposed. This extends the existing GM-only,
tokenless manager without claiming system-specific combat mechanics. It is
motivated by the quantity and distinct-instance controls in
[Heart of Daggers](https://heartofdaggers.com/support-articles/getting-started-encounters/),
duplicate labels in [D&D Beyond Maps](https://dndbeyond-support.wizards.com/hc/en-us/articles/46385529638164-Combat-Encounters-on-Maps),
and Foundry's individual roll, reroll, clear and reset controls in its
[Combat Encounters guide](https://foundryvtt.com/article/combat/).

The Add participant picker also defaults to **Name ascending**. Add a small
ordered sort-key control: the GM may choose up to three additional Actor
stat fields observed in the current world-Actor source or selected Actor
pack, set ascending/descending per key, and remove a key. The first chosen
stat is the primary sort; subsequent stats and then Name/Actor ID break ties.
Name has its own ascending/descending control, defaults to ascending, and is
primary when no stat is chosen. The dropdown is discovered from Actor
source data, **not** the GM's selected combat-stat display preferences and
not a hard-coded Level/CR/HP list. Offer only bounded, comparable source
values (numeric or short text; a resource's numeric value/max may be labeled
separately), with contextual labels so bare `value` or `max` is ambiguous
nowhere. Missing values sort last in either direction. Clear restores Name
ascending and clears the search text without changing the source/pack.
Sorting and searching run on the complete GM-authorized candidate set; the
picker's former 40-row truncation is removed, so every matching Actor remains
selectable in the scrollable list. A pack stat catalog/read must use GM-bound Foundry
index projections, with no source documents sent to the browser. Verify
`system`/nested index-field behavior and payload size in disposable v13/v14
worlds before accepting pack sorting; if a field cannot be read reliably,
omit it rather than silently sorting partial data. The server validates
requested sort paths against the current discovered catalog.

1. The compendium Actor picker gains a bounded quantity input (proposed range
   1–20). Show that limit as persistent helper text beside the input, not
   only a hover tooltip, so it remains visible on touch and keyboard layouts.
   The limit applies per Add request, not as a cap on encounter size. Each
   requested instance follows the existing copy path: a distinct
   world Actor ID in the encounter Folder, the original pack UUID as
   provenance, a recorded owned-copy ID in the Combat flag, and one
   Combatant. Each instance has independent HP and other Actor state. World
   Actors remain linked one at a time; quantity must never create repeated
   Combatants pointing at the same world Actor. The server should reject a
   duplicate world-Actor link within one encounter rather than imply an
   independent instance. Keep an already-linked world Actor visible in search
   but gray out and disable Add with an `Already added` cue; the server's
   duplicate guard remains authoritative if another GM adds it concurrently.
2. Repeated instances get stable, unique Combatant **display names** such as
   `Ooze #1`, `Ooze #2`, without renaming the source pack document or copied
   Actor. The suffix is allocated from a counter on the same Combat flag and is
   never silently reassigned after a removal. Verify that tokenless Combatant
   names persist and project correctly on supported Foundry v13/v14 versions;
   do not substitute Actor renames if either version behaves differently.
   Quantity groups the **add action**; the running initiative order still
   shows each independent Combatant at its own position. A collapsible roster
   group is not part of this slice because it could hide the active turn.
3. Add compact per-row Roll/Reroll and Clear initiative actions, plus a
   Reset all control near Roll All/Roll NPCs. The server reuses the current
   GM-bound, adapter-formula initiative path through dedicated manager routes
   and the encounter lock, not the older unrestricted CombatHUD endpoints. Reroll
   replaces only that Combatant's score; Clear sets only that score to null;
   Reset all clears every score. Preserve the current Combatant identity
   when sorting changes, use the existing hidden-roll audience rule, and
   confirm Reset all only when at least one score exists. All controls are
   unavailable on completed encounters; no native pre-command hook parity
   is implied.
4. Bulk creation is not described as atomic. Keep the existing marker and
   compensation guarantees for each copy. If instance N fails, report how
   many earlier instances succeeded, refresh the roster, and do not
   automatically replay the full request. The GM can decide whether to add
   the remainder. Cleanup must still delete only verified encounter-owned
   copies. Bound request size and reject invalid quantities before any write.
5. Verification must cover role/encounter guards; quantity limits; distinct
   Actor IDs and independent source values; pack provenance; stable
   Combatant labels without Actor renames; the visible quantity-limit hint;
   disabled already-added world choices and duplicate-link rejection;
   Name-default ordering, stat-field discovery, multi-key/direction/clear
   behavior, missing-value placement and sorting before the row limit;
   partial-failure and cleanup behavior; individual roll/reroll/clear and
   Reset all; active-turn preservation; hidden-roll visibility; and rendered
   GM use. Check the Combatant display-name persistence in disposable v13
   and v14 worlds before treating this slice as complete. No hosted world
   or normal-use Foundry browser dependency is introduced.

Encounter notes, timed reminders, action history, Actor-condition mutation,
temporary-HP rules and player-facing controls are **not** included in this
slice. They need separate decisions about Combat-flag state, Actor source
authority and system rules. Daggerheart spotlight/Fear mechanics are likewise
outside this initiative-oriented follow-up; no system-name branch is added
to Core.

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
semantics. Linked world Actors can change after completion; that is an
intentional history limitation, not an accidental snapshot promise. The
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

Core synthetic tests cover GM-only access, marker scoping, world links and pack
copies, resource validation, turn gating, retained history and safe cleanup
failure/retry. In an isolated Foundry v14.367 Shadowdark world, the actual
server manager service over a GM-bound socket created an inactive Combat and
Actor Folder, linked an existing world Actor, copied a pack Actor with a new
world ID, activated the Combat on Begin, deactivated it on rewind to round
zero, and removed only owned copies/Folder on ordinary completion. Retained
completion preserved its Combat and copy with a completed flag; those test-
created documents were then removed. The pre-existing active probe Combat was
restored after testing. Unit tests, TypeScript, lint and production build pass.
The GM reports that the manager UI and flow work well in manual testing. A v13
service-level run remains unverified; neither that report nor the isolated v14
service test represents native Foundry command-hook parity.

The later bounded data-hardening slice adds synthetic stale-value, Actor
identity and tracker-path conflict tests: no Actor write is dispatched on 409.
Disabled `dead` effects no longer mark prepared rows defeated; reenabling the
same embedded effect rebuilds the row. These tests do not prove an atomic
external-write guard, configurable native status behavior or a client bridge.

The September 28 stat-display follow-up has synthetic coverage for manifest
and path validation, saved-empty versus module-default selection, durable
world/module-scoped persistence, GM-only service access, and live linked-Actor
projection. The field-first follow-up discovers bounded choices across
prepared Actor types without requiring a selected combatant, while loading
that catalog only when the GM opens configuration. The full unit suite,
TypeScript, lint and Next production build
pass. Multi-GM browser refresh, world unload/restart persistence, and final
visual acceptance remain for GM testing; no hosted Foundry was touched.

The October 1 stat-management slice adds the GM-owned Editable selection flag
for source-backed numeric/resource fields. Focused tests cover preference
persistence, module-suggestion isolation, GM-only writes, linked world Actors
versus encounter copies, stale identity/path/value rejection, configuration
revocation and completed-encounter rejection. TypeScript and focused lint pass;
multi-GM preference and world-restart acceptance remain pending. The user chose
bounded headless tokenless management; native client hooks, scene-linked
encounters and token positioning remain Foundry-side rather than this tool's
release gate.
The subsequent health-action follow-up adds the one-field preference invariant,
resource-max projection and a Core modal for direct, heal and damage arithmetic.
Focused preference/manager tests and TypeScript/lint pass; rendered GM
acceptance was subsequently reported for this flow. Multi-GM preference and
world-restart checks remain pending.

The Add participant sort follow-up adds source-stat field discovery, GM-bound
pack index projection, priority/direction controls and a Name A–Z reset.
Synthetic manager tests cover default ordering, multi-key priority, missing
values, invalid paths and the complete sorted result set; TypeScript,
focused lint and client unit tests pass. During GM testing, the former 40-row
picker cap was found to hide choices; it was removed rather than paginated.
A simultaneous ActorStore count jump after a pack read exposed a pack-scope
ingress failure: a null response `operation.pack` could override the initiating
pack, unsolicited read broadcasts could enter world Stores, and the initiating
repository mirrored pack results as world Actors. The normalizer now preserves
initiating pack scope, broadcast reads are ignored for primary Stores, and the
repository skips pack mirroring. Focused regression tests cover all paths.
The observed Combat deletion was a separate Foundry-module incident. A second
operator reproduction, creating the encounter as one GM and then logging into
Foundry as the main GM, produced a Foundry `Combat/delete` broadcast with the
main GM user ID as sender. No manager Complete request appears in that trace;
Core's service account used a different user ID. The evidence identifies the
Foundry user session. The GM subsequently confirmed that disabling the
installed Shadowdark Crawl Helper stopped the deletion; no SheetDelver
Combat-deletion workaround is required.
Future Combat delete ingress logs include response origin, user ID when
provided, and document IDs without source content; the manager also logs
explicit completion requests. In a disposable v14 world, an unbegun,
scene-null SheetDelver Combat with one copied pack Actor survived a fresh
native GM browser login, including a sort-then-login variation. Opening the
244-entry pack previously inflated the world Actor cache from 7 to 251; with
the repository guard it remained at 7. This confirms the cache fix but is
independent of the Crawl Helper deletion. A second disposable
v14 run with two distinct GM accounts, one world link and one pack copy also
survived the main GM's native login. The disposable Combats, copies and extra
GM were cleaned up; the prior test Combat was unchanged. No hosted world
mutation was attempted. Disposable v13 pack projection and rendered GM
acceptance remain pending. Individual initiative controls in the proposed
next slice are not yet built.

The quantity follow-up now bounds a compendium Add to 1–20 independent copies,
persists each copied Actor ID and a monotonic display-name counter on the
Combat flag, and creates separately named Combatants. The name filter is
visibly placed beneath the sort controls and updates on a short debounce.
Already-linked world Actors stay visible but disabled, with a server duplicate
guard. Partial failure reports the completed count and leaves every created
copy marked for cleanup. Focused tests cover limits, uniqueness, numbering
after removal, partial failure and cleanup. Disposable v14 confirmed three
persisted names (`Aboleth #1` through `#3`), three distinct Actor copies and
successful cleanup. Disposable v13 and rendered GM checks remain pending.

After ADR-0053 landed, the manager page adopted Player Core palette surfaces,
controls, status accents and world-artwork scrim. TypeScript, lint and client
tests pass for this integration. Rendered light/dark GM review remains pending.
