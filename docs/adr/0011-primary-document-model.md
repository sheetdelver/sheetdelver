# ADR-0011: Primary Document Model — Per-Type Store + Repository via Shared Base

**Status:** Proposed — implementation across the phases listed in Exit Criteria below. Round 01 (`ActorStore`) is the reference implementation; this ADR generalizes its pattern.
**Date:** May 15, 2026
**Phase:** Primary Documents (Phases 1–7)
**Supersedes:** None. Builds on Round 01's actor lifecycle work.
**Related:** ADR-0010 (external module SDK and operational maturity)

---

## Context

Foundry exposes a uniform set of **primary document types** — Actor, ChatMessage, Combat, Folder, Item, JournalEntry, Macro, Playlist, RollTable, Cards, User, Scene, Setting, Adventure, FogExploration. At the wire level they all use the same socket dispatch (`modifyDocument`) with the same four actions (`get` / `create` / `update` / `delete`) and the same `parentUuid` convention for embedded children. The protocol is symmetric across types.

Sheet Delver's handling of these types is **not** symmetric. Round 01 built a coherent subsystem for `Actor`:

- `ActorStore` — hydrated cache, ownership-aware reads, bootstrap seeding, broadcast routing, change emission.
- `ActorRepository` — request-scoped write transport that dispatches to Foundry and mirrors results into the Store.
- `modifyDocument` listener that routes inbound events into the Store.
- `AppSocketGateway` fan-out with per-event ownership filtering.

Every other primary doc type sits in a different shape:

- **ChatMessage** is read fresh from Foundry on every request via `ChatService.getChatLog()`. Cached only in `gameDataCache` as a one-shot session snapshot.
- **Combat** is fetched fresh on every list/turn-advance call by `CombatService`, with per-request actor-data enrichment that re-normalizes each combatant on each request.
- **JournalEntry** has full CRUD routes but **no broadcast routing** — when a GM updates a journal, other connected users see stale data until they refresh.
- **Item** at the world level has no dedicated service or cache; embedded items live on actors only.
- **User** is tracked in two parallel structures (`userMap` and `gameDataCache.users`) updated from the same socket events.
- **RollTable** / **Macro** / **Playlist** / **Cards** have no per-type handling at all; they fall through to the generic `dispatchDocument` / `fetchByUuid` path.
- **Folder**, despite being a primary doc type, is read inline by `JournalService` for ancestry pruning and has no shared handling.

Inbound `modifyDocument` events are routed by a per-type `switch` in `CoreSocket` *and* a duplicate switch in `ClientSocket` — both emit per-type events (`combatUpdate`, `chatUpdate`, etc.). The duplication and asymmetry have grown out of necessity, not design.

This scatter creates several concrete problems:

- **No uniform read pattern.** Every type's caller has to know whether it gets a cache-first read (Actor) or hits Foundry every time (everything else).
- **No uniform event model.** Subscribers that want to react to "any primary doc changed" can't — each type has its own bespoke event name, and some types emit none.
- **Repeated bug surface.** The journal silent-mutation gap, the duplicated user cache, the dual broadcast emit points — these are all instances of the same missing abstraction.
- **Hostile to new doc types.** Adding `Combat` cache today means re-deriving the patterns Round 01 already established for `Actor`, manually, with no guarantee of consistency.

The choice is to either keep extending the ad-hoc per-type approach or to commit to a uniform model.

---

## Decision

Every in-scope Foundry primary doc type gets the same shape:

- A **`<Type>Store`** extending a shared `PrimaryDocumentStore<T>` base.
- A **`<Type>Repository`** extending a shared `PrimaryDocumentRepository<T>` base.
- A single **`modifyDocumentRouter`** as the inbound dispatch point — replacing the per-type switches in `CoreSocket` and the duplicate relay in `ClientSocket`.
- A registerable **`PrimaryDocumentCacheCoordinator`** — each Store registers itself; `SystemService.bootstrap()` awaits the coordinator instead of calling actor-specific methods.

The base layer encodes the uniform 80%; the per-type subclass encodes the policy 20%. The base provides:

- Map storage with clone-on-read.
- Seed / clear / isReady lifecycle.
- Ownership-filtered list/get (delegating to subclass-provided `resolveOwnership`).
- Upsert / patch / delete with deep-merge support and emit-only-on-observable-change semantics.
- Per-type change events (`<type>Changed`, `<type>ListInvalidated`) plus a cross-cutting generic `primaryDocumentChanged`.
- Lifecycle clear hooks tied to existing `CoreSocket` shutdown/reload/progress events.

The per-type subclass provides:

- `resolveOwnership(doc, subject) → ResolvedDocumentOwnershipLevel`. The policy hook.
- Embedded-child mutation handlers if the type has embedded docs (`applyEmbeddedItemChange` on Actor, `applyCombatantChange` on Combat, `applyPageChange` on Journal, etc.).
- Cross-store dependency subscriptions (e.g., `CombatStore` subscribes to `actorStore.actorListInvalidated`).
- Type-specific retention behavior — full hydration with bootstrap seed, or lazy population on first read.

The repository pattern is also unified. Every `<Type>Repository` is constructed per-request, binds to a request-scoped document transport so writes carry the requesting user's authenticated socket/session, dispatches via Foundry's `modifyDocument` channel, and mirrors the result back into the corresponding Store before returning to the caller.

**No type is excluded.** Even types Sheet Delver doesn't currently use (Macro, Playlist, Cards) and types whose data lives outside our scope (Scene, FogExploration, Adventure, Setting) get the shape — as full implementations for the ones we touch, as minimal subclasses or stubs for the ones we don't. Uniform shape is the point.

---

## Details

### Base / Subclass Split

Base (in `src/server/core/documents/primary/base/`):

- `PrimaryDocumentStore<T>` — abstract; subclasses must implement `resolveOwnership`. Provides all generic cache mechanics, event emission, and lifecycle hooks.
- `PrimaryDocumentRepository<T>` — abstract; subclasses add embedded-doc operations where the type has children.
- `PrimaryDocumentCacheCoordinator` — concrete; manages registered seeders and the bootstrap-seed gate.
- `modifyDocumentRouter` — concrete; routes inbound events to the right Store by `(type, parentUuid)`.

Per-type subsystems (in `src/server/core/documents/primary/<type>/`):

- `<Type>Store extends PrimaryDocumentStore<RawType>` — implements `resolveOwnership`, adds embedded handlers and cross-store subscriptions.
- `<Type>Repository extends PrimaryDocumentRepository<RawType>` — adds embedded-doc CRUD methods where applicable.

Subclasses are small — Actor (with embedded items and effects, cross-store-less ownership) is around 100 lines of policy code over the base. Trivial types like `MacroStore` end up under 30. The uniform shape is what each one looks like, not what it costs to write.

### Policy vs. Protocol

The protocol is uniform because Foundry's wire format is uniform:

- Every primary doc has `_id`, `_stats`, and goes through the same `modifyDocument` dispatch.
- Every embedded child uses `parentUuid` (e.g., `Actor.<id>` for an actor item; `Actor.<id>.Item.<id>` for an effect on an actor's item).
- Every `get` / `create` / `update` / `delete` payload follows the same shape per action.

Policy differs by type:

- **Ownership.** Actor / Item / RollTable / Macro / Playlist / Scene / JournalEntry use the standard `{ default, userId }` map. ChatMessage uses `whisper` + `blind` + `author`. Combat derives from combatants. User has none (users are subjects, not targets). Folder has none in v13 (confirmed across all six folder types in the audit dumps).
- **Embedded children.** Actor has Items + Effects. Combat has Combatants. Journal has Pages. RollTable has results with mutable `drawn` state. Playlist has sounds with playback state. Macro / ChatMessage / Folder / Cards / Macro / etc. have none.
- **Cross-store deps.** Combat depends on Actor for combatant visibility. Every Store depends on User for subject role resolution.
- **Retention.** Most types use full hydration with bootstrap seed. The rarely-touched types (Macro / Playlist / RollTable / Cards) use lazy hydration. The Sheet-Delver-unused types (Scene / FogExploration / Adventure / Setting) get stubs.

The split is what lets one base abstraction serve all of them.

### Cross-Cutting Behaviors

Three behaviors are universal across stores; they live in the base, not duplicated per type:

- **Emit only on observable change.** Applying the same diff twice produces exactly one `<type>Changed` event. No-op applies emit nothing. This is critical because Sheet Delver-initiated writes apply the diff twice: once when the Repository receives the Foundry result, and once when the broadcast arrives. Without observable-change-only emission, every write would fan out duplicate events.
- **Ownership-aware fan-out.** Per-event filtering against each Store's `canReadDocument` predicate. Subscribers register against specific Stores (per-type) and receive only events they're authorized to see. The filter is applied at fan-out time, not subscription time, so ownership changes take effect immediately.
- **List-invalidation as a separate event.** Ownership transitions emit `<type>ListInvalidated { targetUserIds? }`, not `<type>Changed`. The client adds or removes from its list rather than trying to patch a per-document view. Round 01 established this; the base lifts it for every type.

### Bootstrap and Lifecycle

`SystemService.bootstrap()` awaits a single `seedDocumentCache()` call instead of per-type seeding. Each Store registers a seeder during platform init; the coordinator runs them in dependency order (User and Folder before Journal/Combat because the latter consume the former). Seeding failure on a required Store blocks `world:ready` — the existing `ensureInitialized` middleware then returns 503 for protected routes until the cache is hot.

Cache clearing on world reload / shutdown / transition goes through the same coordinator. The lifecycle hooks already exist on `CoreSocket`; each Store registers a `clear(reason)` callback.

---

## Alternatives Considered

### Continue ad-hoc per-type implementations

The path of least resistance. ChatMessage gets its own `ChatStore` with whatever shape feels right at the time; Combat gets its own approach; etc. This is what the codebase already does.

Rejected because it reproduces the existing scatter at greater scale. Each new type would re-derive ownership filtering, broadcast routing, idempotency, and event emission from scratch — and inconsistencies between types would surface as bugs years later. Round 01 already built the canonical pattern for `Actor`; not generalizing it discards that work.

### Single generic store, fully config-driven

A single concrete `PrimaryDocumentStore` parameterized at runtime by injected callbacks for ownership resolution, embedded handlers, etc. No per-type subclasses.

Rejected for two reasons:

1. **TypeScript loses its grip.** Embedded children are typed Foundry shapes — `RawCombatant`, `RawJournalEntryPage`, `RawActiveEffect`. A config-driven generic erases these types or pushes them into untyped `Record<string, unknown>` parameters. Compile-time enforcement of the shape per type is one of the safety nets we're paying the abstraction tax for.
2. **Policy is not easily expressible as data.** Combat visibility ("subject can see at least one non-hidden combatant via ActorStore") is code, not config. Wrapping it in a callback config gets you back to the per-type subclass shape but with worse ergonomics.

The base/subclass split keeps the type safety and lets policy be code where it needs to be.

### Store only the types we actually use

Build Stores for Actor / ChatMessage / Combat / Journal / Item / User. Skip Macro / Playlist / RollTable / Cards / Scene / FogExploration / Adventure / Setting entirely.

Rejected because of API asymmetry. Module authors and platform contributors would have to remember "we have Stores for these types but not those, so look up the SDK pattern" — and the answer differs over time as types get added. The minimal-stub cost is low (a `MacroStore` against the base is under 30 lines); the cognitive cost of "is this a Storage type or a fallthrough type" is high.

The uniformity guarantee — "every primary doc has a Store, period" — is the architecturally honest choice. It also future-proofs against features that might surface a currently-unused type later.

### Bounded retention per type (e.g., a cap on ChatMessage cache)

Earlier drafts considered a "bounded retention" tier — ChatMessage would cap at 100 messages so memory wouldn't grow unbounded.

Rejected because mixing display constraints into the data model is a leaky abstraction. The Store should be a faithful local mirror of what Foundry has; consumers (routes / UI) apply display limits. ChatMessage's `config.app.chatHistory` setting governs how many messages a route or UI shows, not how many the platform holds. The Store mirrors Foundry's chat log; `ChatService.getChatLog(limit)` slices to the configured display limit at the service boundary.

This matches the `ActorStore` pattern — it mirrors all world actors regardless of how many a given user can see; consumers filter by ownership at read time.

---

## Consequences

### Positive

- **Uniform read pattern.** Every reader uses `store.list({ subject, minOwnership })` or `store.get(id, { subject, minOwnership })` regardless of which doc type they want. No special-casing per type.
- **Uniform realtime model.** Every Store emits the same shape of change/invalidation events; cross-cutting subscribers (audit log, telemetry, debug overlay, future SDK helpers) listen with no per-type wiring.
- **Drift prevention.** The base enforces idempotency, observable-change-only emission, ownership-aware fan-out, and per-type listener registration. New stores get these for free; old stores can't drift away from them.
- **Type safety.** `<Type>Store<RawType>` and `<Type>Repository<RawType>` preserve the Foundry document shape per type; embedded handlers are typed against the right embedded shape.
- **Compile-time enforcement of policy decisions.** `resolveOwnership` is `abstract` on the base; the compiler flags any subclass that forgets to implement it.
- **Scattered patterns consolidate.** `userMap` + `gameDataCache.users` → `UserStore`. Dual broadcast emit points → single `modifyDocumentRouter`. Inline journal folder pruning → `FolderStore` consumed by `JournalStore`. Authorization helpers per service → `Store.canReadDocument`. Each migration phase closes one or more of these silos as a side effect.

### Tradeoffs

- **More files per type.** Three files per subsystem (Store, Repository, document-events) plus optional test files. For minimal types (Macro, Playlist, Cards, stubs) this is mostly boilerplate. The cost is real but bounded.
- **A learning curve for the abstraction.** Future contributors need to understand the base/subclass split and where policy lives versus protocol. This ADR (and the related event/ownership ADRs to follow) is the mitigation; subclasses themselves should be small enough to read alongside the base for orientation.
- **One additional dispatch layer in the hot path.** Reads go through `Store.get` instead of a direct cache map lookup. This is microseconds — not measurable in normal use — but worth noting.
- **Cross-store dependencies must be declared.** `CombatStore` needs `ActorStore` for combatant visibility; `JournalStore` consumes `FolderStore` for folder-organized list views. These dependencies need explicit wiring at module-init time. The plan documents which Stores depend on which.

---

## Per-Type Policy Matrix

Captured here for durability (not in working planning docs). Subclass implementations encode each row.

| Type | Ownership policy | Embedded children | Cross-store deps | Retention |
|---|---|---|---|---|
| Actor | `ownership` map (standard) | `Item`, `ActiveEffect` | `UserStore` (subject role) | Full + bootstrap seed |
| ChatMessage | `whisper[]` + `blind` + `author` (no ownership map) | none | `UserStore` | Full + bootstrap seed |
| User | None — users are subjects, not targets | none | none | Full + bootstrap seed |
| Folder | None — confirmed absent in Foundry v13 across all six folder types | none | none | Full + bootstrap seed |
| JournalEntry | `ownership` map at entry level AND per-page | `JournalEntryPage` (each has own ownership map) | `FolderStore` (organizational list views only) | Full + bootstrap seed |
| Combat | None on the Combat doc — derived from combatants (`hidden` flag + actor visibility) | `Combatant` | `ActorStore` (combatant visibility), `UserStore` | Full + bootstrap seed |
| Item (world) | `ownership` map (standard) | `ActiveEffect` | `UserStore` | Full + bootstrap seed |
| RollTable | `ownership` map (standard) | `RollTableResult` (with mutable `drawn` state) | `UserStore` | Lazy |
| Macro | `ownership` map (standard) + `author` attribution | none | `UserStore` | Lazy |
| Playlist | `ownership` map (standard) | `PlaylistSound` (with mutable playback state) | `UserStore` | Lazy |
| Cards | `ownership` map (standard) | `Card` (stub handler) | `UserStore` | Lazy |
| Scene, FogExploration, Adventure, Setting | Per-type — varies | Per-type | Per-type | Stub (uniform shape, not actively wired) |

The "policy 20%" lives in subclass `resolveOwnership` and embedded-mutation handlers. The "protocol 80%" — cache map, seed/clear, list/get, upsert/patch/delete, event emission, lifecycle hooks — lives in the base.

## Related Decisions

This ADR captures the *model*. Two further decisions are planned as their own ADRs:

- **ADR-0012 (planned): Realtime event emission and per-type subscription.** The uniform event shape (`<type>Changed`, `<type>ListInvalidated`, cross-cutting `primaryDocumentChanged`), the per-type listener registration model, and the rules for when each event fires.
- **ADR-0013 (planned): Document ownership and visibility model.** `DocumentOwnershipLevel` enum (`-1 INHERIT`, `0 NONE`, `1 LIMITED`, `2 OBSERVER`, `3 OWNER`), `DOCUMENT_VISIBILITY` predicates (`LIST_VISIBLE`, `CARD_VISIBLE`, `DETAIL_VISIBLE`, `WRITEABLE`), `INHERIT`-resolution semantics, the policy-per-type matrix.

Per-phase implementation work and post-phase audit results are tracked in the project's working planning area separately from this ADR.

---

## Validation

The model is validated phase by phase. Each phase must:

- Pass `npx tsc --noEmit` clean. Per-type subclasses must implement the abstract `resolveOwnership`; `tsc` flags any that forget.
- Pass `npm run test:unit` including the prior-phase regression tests. Round 01 `ActorStore` coverage stays green after the Phase-1 base lift.
- Include unit tests against the base abstraction using a mock document type — these are the contract tests that every concrete Store must respect.
- Include per-type unit tests covering CRUD, embedded children where applicable, ownership filtering, idempotency, and event emission.
- Include a vertical smoke test that wires a real Store + Repository + router against a fake socket and confirms end-to-end behavior — catches wire-up regressions that unit tests miss.

The end-state validation is structural:

- A reader can trace `GET /api/<type>` end-to-end in a handful of lines per type, all following the same pattern.
- `grep`-ing for `getActor(`, `getCombats(`, `getJournals(` etc. on the socket layer returns no live callers outside the Store/Repository implementation files.
- Adding a hypothetical new primary doc type (say, the day Foundry adds one) is mechanically a single subsystem extension against the base, not a re-derivation of patterns from scratch.

---

## Exit Criteria

This ADR is fulfilled when every Foundry primary doc type covered by the alignment plan has its `<Type>Store` + `<Type>Repository` implementation against the shared base — including stubs for the types Sheet Delver doesn't currently use.

- [ ] Phase 1: Base abstractions + `ChatMessageStore` + `ChatMessageRepository`. `ActorStore` / `ActorRepository` lifted onto the base.
- [ ] Phase 2: `UserStore` + `UserRepository`. `userMap` / `gameDataCache.users` consolidate.
- [ ] Phase 3: `FolderStore` + `FolderRepository`.
- [ ] Phase 4: `JournalStore` + `JournalRepository` with two-level ownership.
- [ ] Phase 5: `CombatStore` + `CombatRepository` with cross-store visibility.
- [ ] Phase 6: `ItemStore` + `ItemRepository` (world-level).
- [ ] Phase 7: `RollTableStore` / `MacroStore` / `PlaylistStore` / `CardsStore` (lazy) + `SceneStore` / `FogExplorationStore` / `AdventureStore` / `SettingStore` (stubs).
- [ ] `modifyDocumentRouter` replaces per-type switches in `CoreSocket` and removes the duplicate relay in `ClientSocket`.
- [ ] `PrimaryDocumentCacheCoordinator` replaces the hardcoded actor-only seeding path in `SystemService.bootstrap()`.
- [ ] Each phase's exit criteria verified before proceeding to the next.
- [ ] Status flipped to **Accepted** when Phase 7 ships green.
