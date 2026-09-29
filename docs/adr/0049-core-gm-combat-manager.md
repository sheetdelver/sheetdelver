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
   allowed in the manager.
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

The Combat Manager's basic stats are a presentation preference for the
current Foundry world and active system module, shared by all authorized
Gamemasters. They are not per-encounter tracker state, a historical Actor
snapshot, or a reason to write arbitrary Actor fields from the manager.

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
  are projected on the server
  from authorized prepared Actors, are read-only, and are omitted for Actors
  where unavailable. The existing configured Foundry tracker-resource quick
  edit remains separately source-backed and unchanged.
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

The September 28 stat-display follow-up has synthetic coverage for manifest
and path validation, saved-empty versus module-default selection, durable
world/module-scoped persistence, GM-only service access, and live linked-Actor
projection. The field-first follow-up discovers bounded choices across
prepared Actor types without requiring a selected combatant, while loading
that catalog only when the GM opens configuration. The full unit suite,
TypeScript, lint and Next production build
pass. Multi-GM browser refresh, world unload/restart persistence, and final
visual acceptance remain for GM testing; no hosted Foundry was touched.

After ADR-0053 landed, the manager page adopted Player Core palette surfaces,
controls, status accents and world-artwork scrim. TypeScript, lint and client
tests pass for this integration. Rendered light/dark GM review remains pending.
