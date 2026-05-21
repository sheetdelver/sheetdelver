# ADR-0011: Primary Document Model — Per-Type Store + Repository via Shared Base

**Status:** Accepted — Phases 1-7 shipped. Phase 8 tracks a post-acceptance boundary-enforcement amendment. Round 01 (`ActorStore`) was the reference implementation; this ADR generalized its pattern across every primary document type.
**Date:** May 15, 2026 (Accepted: May 17, 2026)
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
- Type-specific retention behavior — full hydration with bootstrap seed for every actively-modeled type. (Earlier drafts proposed a lazy-population tier for rarely-touched types; that distinction was dropped after audit confirmed `game.data` already ships every primary doc type at bootstrap, so the per-type cost is paid regardless. Stub types remain unwired.)

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

- `<Type>Store extends PrimaryDocumentStore<DocumentShape>` — implements `resolveOwnership`, adds embedded handlers and cross-store subscriptions.
- `<Type>Repository extends PrimaryDocumentRepository<DocumentShape>` — adds embedded-doc CRUD methods where applicable.

Subclasses are small — Actor (with embedded items and effects, cross-store-less ownership) is around 100 lines of policy code over the base. Trivial types like `MacroStore` end up under 30. The uniform shape is what each one looks like, not what it costs to write.

### Policy vs. Protocol

The protocol is uniform because Foundry's wire format is uniform:

- Every primary doc has `_id`, `_stats`, and goes through the same `modifyDocument` dispatch.
- Every embedded child uses `parentUuid` (e.g., `Actor.<id>` for an actor item; `Actor.<id>.Item.<id>` for an effect on an actor's item).
- Every `get` / `create` / `update` / `delete` payload follows the same shape per action.

Policy differs by type:

- **Ownership.** Actor / Item / RollTable / Macro / Playlist / Scene / JournalEntry use the standard `{ default, userId }` map. ChatMessage uses `whisper` + `blind` + `author`. Combat derives from combatants. User has none (users are subjects, not targets). Folder uses Foundry's `permission` map for the Folder document/tree entry itself; when the map or a key is omitted, the effective permission is `NONE`. Folder ownership does not dynamically govern contained primary documents in Foundry v13; folder-level ownership operations bulk-copy values onto those documents instead.
- **Embedded children.** Actor has Items + Effects. Combat has Combatants. Journal has Pages. RollTable has results with mutable `drawn` state. Playlist has sounds with playback state. Cards has embedded `Card` records with face/drawn/display state. Macro / ChatMessage / Folder / User have none.
- **Cross-store deps.** Combat depends on Actor for combatant visibility. Every Store depends on User for subject role resolution.
- **Retention.** Every actively-modeled type uses full hydration with bootstrap seed — `game.data` already ships them all at world bootstrap, so there's no saving from a lazy tier. The Sheet-Delver-unused types (Scene / FogExploration / Adventure / Setting) get stubs (classes exist for type-union completeness; not registered with the coordinator or router).

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

1. **TypeScript loses its grip.** Embedded children are typed Foundry shapes — `CombatantDocument`, `JournalEntryPageDocument`, `ActiveEffectDocument`. A config-driven generic erases these types or pushes them into untyped `Record<string, unknown>` parameters. Compile-time enforcement of the shape per type is one of the safety nets we're paying the abstraction tax for.
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
- **Type safety.** `<Type>Store<DocumentShape>` and `<Type>Repository<DocumentShape>` preserve the Foundry document shape per type; embedded handlers are typed against the right embedded shape.
- **Compile-time enforcement of policy decisions.** `resolveOwnership` is `abstract` on the base; the compiler flags any subclass that forgets to implement it.
- **Scattered patterns consolidate.** `userMap` + `gameDataCache.users` → `UserStore`. Dual broadcast emit points → single `modifyDocumentRouter`. Inline folder pruning → `FolderStore` consumed by folder-aware Stores through each document's `folder` id. Authorization helpers per service → `Store.canReadDocument`. Each migration phase closes one or more of these silos as a side effect.

### Tradeoffs

- **More files per type.** Three files per subsystem (Store, Repository, document-events) plus optional test files. For minimal types (Macro, Playlist, Cards, stubs) this is mostly boilerplate. The cost is real but bounded.
- **A learning curve for the abstraction.** Future contributors need to understand the base/subclass split and where policy lives versus protocol. This ADR (and the related event/ownership ADRs to follow) is the mitigation; subclasses themselves should be small enough to read alongside the base for orientation.
- **One additional dispatch layer in the hot path.** Reads go through `Store.get` instead of a direct cache map lookup. This is microseconds — not measurable in normal use — but worth noting.
- **Cross-store dependencies must be declared.** `CombatStore` needs `ActorStore` for combatant visibility; folder-aware Stores consume `FolderStore` for folder-organized list views by joining from their own `folder` field, not for document ownership inheritance. These dependencies need explicit wiring at module-init time. The plan documents which Stores depend on which.

---

## Per-Type Policy Matrix

Captured here for durability (not in working planning docs). Subclass implementations encode each row.

| Type | Ownership policy | Embedded children | Cross-store deps | Retention |
|---|---|---|---|---|
| Actor | `ownership` map (standard) | `Item`, `ActiveEffect` | `UserStore` (subject role) | Full + bootstrap seed |
| ChatMessage | `whisper[]` + `blind` + `author` (no ownership map) | none | `UserStore` | Full + bootstrap seed |
| User | None — users are subjects, not targets | none | none | Full + bootstrap seed |
| Folder | `permission` map; omitted map/key means effective `NONE` | none | none | Full + bootstrap seed |
| JournalEntry | `ownership` map at entry level AND per-page | `JournalEntryPage` (each has own ownership map) | `FolderStore` (folder tree projection only) | Full + bootstrap seed |
| Combat | None on the Combat doc — derived from combatants (`hidden` flag + actor visibility) | `Combatant` | `ActorStore` (combatant visibility), `UserStore` | Full + bootstrap seed |
| Item (world) | `ownership` map (standard) | `ActiveEffect` | `UserStore` | Full + bootstrap seed |
| RollTable | `ownership` map (standard) | `RollTableResult` (with mutable `drawn` state) | `UserStore` | Full + bootstrap seed |
| Macro | `ownership` map (standard) | none | `UserStore` | Full + bootstrap seed |
| Playlist | `ownership` map (standard) | `PlaylistSound` (with mutable playback state) | `UserStore` | Full + bootstrap seed |
| Cards | `ownership` map (standard) | `Card` (in-place `cards[]` handler) | `UserStore` | Full + bootstrap seed |
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

**Phase 1 verification addendum (May 15, 2026):**

- `npx tsc --noEmit` passed.
- `npm run test:unit` passed when rerun outside the sandbox; the sandboxed run failed before tests started because `tsx` could not open its IPC pipe.
- Structural Phase 1 pieces are present: base Store/Repository abstractions, `modifyDocumentRouter`, cache coordinator, `ChatMessageStore` / `ChatMessageRepository`, and `ActorStore` / `ActorRepository` lifted onto the base.
- [x] Fix blind-message visibility ordering in `ChatMessageStore.resolveOwnership`: `blind: true` must restrict visibility to author + GMs before whisper recipients are considered.
- [x] Align browser realtime listeners with the new server events. Server-side Phase 1 emits `chatMessageChanged` / `chatMessageListInvalidated`; `ChatContext` listens only for those events. The legacy `chatUpdate` listener and payload contracts were removed after ADR-0011 Phase 7 closure so new consumers cannot accidentally depend on the retired event.
- [x] Complete chat write-path migration onto `ChatMessageRepository`: `ChatService.sendChatMessage()` no longer uses `client.sendMessage()` for writes, and slash-roll output is created through request-scoped `ChatMessage` document dispatch after local roll evaluation.
- [x] Preserve the route-facing chat DTO projection when reads come from `ChatMessageStore`. Store-backed reads now project raw messages into enriched fields such as `user`, `isRoll`, `rollTotal`, and `rollFormula`.

**Phase 1 addendum 2: remove socket-owned chat writes**

Phase 1 still has a legacy socket-owned `sendMessage` surface on `CoreSocket` and `ClientSocket`. That surface should be removed now that `ChatMessageRepository` exists. Primary document writes must flow through the primary-document repository framework; raw `modifyDocument` dispatch should remain behind `PrimaryDocumentRepository` / `DocumentTransport`, not at service, module facade, or socket helper call sites.

This addendum is about the internal server route client (`RouteFoundryClient`, built by `src/server/shared/utils/createRouteFoundryClient.ts`), not the public module SDK API. The public SDK can keep `sendMessage(data, options?)`; its implementation should delegate to the internal repository-backed helper.

- [x] Add a repository-backed internal route-client chat helper, e.g. `createChatMessage(data)`, implemented by `createRouteFoundryClient()` with `ChatMessageRepository.send(data)`.
  Files: `src/server/shared/types/documents.ts`, `src/server/shared/types/requestContext.ts` if needed, `src/server/shared/utils/createRouteFoundryClient.ts`, `src/server/core/documents/primary/chat-messages/ChatMessageRepository.ts` if the repository surface needs a small adjustment, `src/server/core/documents/primary/chat-messages/chatMessagePayload.ts`.
- [x] Update `ChatService.sendChatMessage()` to call the repository-backed helper for both plain chat and slash-roll chat output. It should not call `client.sendMessage()` and should not issue raw `dispatchDocument('ChatMessage', ...)` itself.
  Files: `src/server/services/chat/ChatService.ts`, `src/tests/unit/services/chat-service.test.ts`.
- [x] Keep the public module SDK `sendMessage(data, options?)` facade for compatibility, but reimplement `createModuleFoundryClient().sendMessage` through the repository-backed route-client helper.
  Files: `src/server/shared/utils/createModuleFoundryClient.ts`, `src/shared/sdk/contracts.ts` only if docs/comments need clarification, `src/tests/unit/sdk/sdk-integrity.test.ts`.
- [x] Replace `CoreSocket.roll()` fallback chat creation and `CoreSocket.useItem()` chat creation with repository-backed chat creation, or move those flows behind route/module service helpers that already use `ChatMessageRepository`.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts` plus any route/service wrapper introduced for the replacement.
- [x] Remove `CoreSocket.sendMessage()` and `ClientSocket.sendMessage()` after all callers are migrated.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts`, `src/server/core/foundry/sockets/ClientSocket.ts`.
- [x] Remove `sendMessage` from internal socket/client interfaces and route-client type requirements; update unit mocks and socket probes accordingly.
  Files: `src/server/core/foundry/interfaces.ts`, `src/server/shared/types/documents.ts`, `src/server/shared/types/requestContext.ts` if touched, `src/tests/unit/**/*.test.ts`.
- [x] Update `src/tests/socket/05-write-operations.test.ts` to verify chat writes through the repository-backed path rather than `client.sendMessage()`.

Closure verification (May 15, 2026): `rg "sendMessage\b|\.sendMessage\(" src/server src/tests src/shared -g "*.ts"` now finds only the public SDK contract/facade and SDK integrity mock. `npx tsc --noEmit` passed. `npm run test:unit` passed when rerun outside the sandbox; the sandboxed run failed before tests started because `tsx` could not open its IPC pipe.

**Phase 1 addendum 3: coalesce client refreshes from semantic event bursts**

Phase 1 Store events can correctly emit both a document-level change and a list-level invalidation for a single create. That is useful semantic information: one event says the document changed, the other says a user's visible list may have changed. The issue found after Phase 1 was in the browser reaction layer, where each event path independently refetched the same resource.

Observed symptom: a chat send or actor update could produce duplicate or triplicate requests such as repeated `GET /api/chat` or repeated `GET /api/actors/:id`. For chat, the sender could refresh after `POST /api/chat/send`, then refresh again on `chatMessageChanged`, then refresh again on `chatMessageListInvalidated`. For actor detail pages, bursty `actorUpdate` delivery could stack duplicate detail fetches for the same actor.

The fix preserves the primary-document event contract and coalesces the client refresh behavior:

- [x] `ChatContext` now debounces chat refresh requests and reuses an in-flight `/api/chat` request, so a burst of send-success + realtime events produces one fetch.
  Files: `src/client/ui/context/ChatContext.tsx`.
- [x] `GenericActorPage` now debounces actor-detail refresh requests and reuses an in-flight `/api/actors/:id` request for the same actor.
  Files: `src/client/ui/pages/GenericActorPage.tsx`.
- [x] Verification passed: `npx tsc --noEmit`, `npm run test:unit`, and `git diff --check`.

**Phase 2 staging: UserStore + UserRepository**

ADR-0011 Phase 2 promotes Foundry `User` documents into the primary-document framework. The goal is to make user documents and role lookups a Store-backed source of truth rather than maintaining the current split between `CoreSocket.userMap` and `gameDataCache.users`.

Scope:

- [x] Add `UserStore` and `UserRepository` under `src/server/core/documents/primary/users/`.
  Files: `src/server/core/documents/primary/users/UserStore.ts`, `src/server/core/documents/primary/users/UserRepository.ts`, optional `userDocumentEvents.ts`.
- [x] Register `UserStore` with `PrimaryDocumentCacheCoordinator` and `modifyDocumentRouter`; seed from Foundry's `User` documents at bootstrap.
  Files: `src/server/core/documents/primary/PrimaryDocumentCacheCoordinator.ts`, `src/server/core/documents/primary/base/PrimaryDocumentStore.ts` if `PrimaryDocumentType` needs the `User` path verified.
- [x] Move user create/update/delete broadcast application into `UserStore` and remove `userMap` / `gameDataCache.users` as primary mutation targets.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts`, `src/server/core/foundry/sockets/ClientSocket.ts` if user relay behavior changes.
- [x] Route subject-role lookups through `UserStore` so Actor/ChatMessage and future Stores construct `DocumentAccessSubject` from one user source.
  Files: `src/server/shared/utils/createRouteFoundryClient.ts`, `src/server/services/chat/ChatService.ts`, `src/server/realtime/AppSocketGateway.ts`, `src/server/core/system/SystemService.ts`.
- [x] Decide and document where active-user presence belongs. `users` are primary documents; `activeUsers` is presence state and may remain outside the Store or become a separate Store-owned presence projection.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts`, `src/server/core/system/SystemService.ts`, status payload builders if touched.
- [x] Split user document changes from broad system-status refreshes where practical. `UserStore` should emit user-document events; status broadcasts should remain for connection/world-status changes.
  Files: `src/server/core/system/SystemService.ts`, `src/server/realtime/AppSocketGateway.ts`.
- [x] Add Phase 2 tests covering UserStore ownership policy, bootstrap seed, modifyDocument routing, role lookup, and removal of `userMap` / `gameDataCache.users` as sources of truth.
  Files: `src/tests/unit/documents/user-store.test.ts`, `src/tests/unit/run.ts`, plus focused updates to route-client/realtime tests.

Non-goals for Phase 2:

- `sceneDataCache` and non-document world metadata remain on `CoreSocket`; broader world-state consolidation is outside this phase.
- Full ADR-0012 wire-event rename remains outside this phase unless needed for user events.
- User documents have no embedded children and no ownership map; visibility policy is the ADR-0013 user policy: authenticated users can observe the roster, GMs are owners.

Exit for Phase 2: `UserStore` / `UserRepository` exist, user document mutations route through the primary-document framework, role/subject lookup reads from `UserStore`, duplicate user state is no longer authoritative, and `npx tsc --noEmit` plus `npm run test:unit` pass.

**Phase 2 verification addendum (May 15, 2026):**

- `npx tsc --noEmit` passed.
- `npm run test:unit` passed when rerun outside the sandbox; the sandboxed run failed before tests started because `tsx` could not open its IPC pipe.
- Structural Phase 2 pieces are present: `UserStore`, `UserRepository`, `UserDocument`, coordinator registration, modifyDocument router registration, `userChanged` / `userListInvalidated` bridge events, user presence separated from User document fields, and unit coverage in `user-store.test.ts`.
- User document mutation flow now routes through `modifyDocumentRouter` into `UserStore`. The old `userMap` field is gone; `userPresence` holds only runtime active-state.

**Phase 2 addendum 1: remove socket-owned user reads**

Phase 2 introduced `UserStore`, but several call sites still ask the socket/client layer for users through `getUser()` or `getUsers()`. Those methods now mostly delegate to `UserStore`, but they keep user-document reads conceptually owned by the socket surface. As with the Phase 1 `sendMessage` cleanup, primary document reads should move to Store/repository utilities and route-client helpers, leaving sockets as transport/presence infrastructure rather than document read APIs.

- [x] Add Store-backed user read helpers for the common projections:
  - role lookup for `DocumentAccessSubject` construction,
  - full roster with composed presence,
  - GM-recipient lookup for roll-mode/chat helpers,
  - sanitized status-user projection if that remains server-side.
  Files: `src/server/core/documents/primary/users/UserStore.ts`, `src/server/core/documents/primary/users/UserPresence.ts`, `src/server/shared/types/users.ts`.
- [x] Replace subject-role lookups that still call `systemService.getSystemClient().getUser(...)`.
  Files: `src/server/shared/utils/createRouteFoundryClient.ts`, `src/server/realtime/AppSocketGateway.ts`, `src/server/services/chat/ChatService.ts`, `src/server/core/foundry/sockets/CoreSocket.ts`.
- [x] Replace GM/roster lookups that still call `client.getUsers()` or `systemService.getSystemClient().getUsers()`.
  Files: `src/server/services/chat/ChatService.ts`, `src/server/shared/utils/createModuleFoundryClient.ts`, `src/server/shared/utils/createRouteFoundryClient.ts`, `src/server/core/documents/primary/chat-messages/chatMessagePayload.ts`, `src/server/core/foundry/sockets/CoreSocket.ts`, `src/server/services/combats/CombatService.ts`, `src/server/services/journals/JournalService.ts`, `src/server/app/registerRoutes.ts`.
- [x] Replace fallback chat author/user decoration that still calls `systemService.getSystemClient().getUser(...)`.
  Files: `src/server/core/foundry/sockets/ClientSocket.ts`.
- [x] Move status payload user data off `gameData.users` and onto the Store-backed roster plus composed presence state.
  Files: `src/server/services/status/StatusService.ts`, `src/server/core/foundry/sockets/CoreSocket.ts`, `src/server/shared/types/foundry.ts`.
- [x] Remove or deprecate `CoreSocket.getUser()` / `CoreSocket.getUsers()` and `ClientSocket.getUsers()` once all callers are migrated.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts`, `src/server/core/foundry/sockets/ClientSocket.ts`, `src/server/core/foundry/interfaces.ts`.
- [x] Remove `getUsers` from internal route-client/service type requirements once user reads no longer flow through the socket/client surface.
  Files: `src/server/shared/types/documents.ts`, `src/server/shared/types/utility.ts`, `src/server/shared/types/foundry.ts`, affected unit mocks.
- [x] Update socket probes or legacy tests that still exercise `client.getUsers()` so they verify the new Store-backed route/helper path instead.
  Files: `src/tests/socket/04-users-compendia.test.ts`, `src/tests/socket/07-user-status.test.ts`, `src/tests/unit/**/*.test.ts`.
- [x] Verify the cleanup with `rg "\.getUser\(|\.getUsers\(|getUser\(|getUsers\(" src/server -g "*.ts"`, `npx tsc --noEmit`, and `npm run test:unit`.

Closure verification (May 16, 2026): Store-backed user helpers now own role lookup, presence-composed rosters, and GM recipient lookup. `UserPresence` owns runtime `active` state outside User documents. Exact cleanup grep finds no `getUser()` / `getUsers()` call sites under `src/server` or `src`. `npx tsc --noEmit` passed. `npm run test:unit` passed when rerun outside the sandbox; the sandboxed run failed before tests started because `tsx` could not open its IPC pipe.

**Phase 3 staging: FolderStore + FolderRepository**

ADR-0011 Phase 3 promotes Foundry `Folder` documents into the primary-document framework. `FolderStore` models the folder tree itself, not the primary documents that happen to be nested under it. Its core helpers should be generic over folder ids and ancestry; Foundry's Folder `type` is metadata for optional filtering, not a reason for FolderStore to understand Actor, JournalEntry, Item, or any other document payload. JournalService is the first existing call site to migrate because it currently owns inline folder ancestry pruning, not because Journals are the only folder-aware document type.

Foundry Folder schema assumptions for this phase: core fields include `_id`, `name`, `type`, `parent`, `sort`, `color`, `flags`, optional `children`, optional `private`, optional `img`, and optional `permission`. `permission` is a map keyed by user id or role id when explicit permissions are set; if Foundry omits the map or a key because nothing is explicitly set, `FolderStore` should normalize that absence to effective `NONE`. `type` identifies the contained collection (`Actor`, `Item`, `JournalEntry`, `Scene`, `RollTable`, `Card`, `Playlist`, `Macro`, `Compendium`, etc.) but does not make FolderStore responsible for validating contained document schemas. Folder permissions apply to Folder documents/tree entries only; Foundry v13 folder "Configure Ownership" behavior bulk-applies copied ownership values to contained documents instead of creating live inheritance. Current Sheet Delver DTOs may still expose a `folder` parent alias; Phase 3 should normalize that to `parent` at the Store/type boundary.

Observed v13 sample-payload note: folderable primary documents carry their own `folder` id and join to the Folder collection from the document side. In the reviewed sample, `actors`, `items`, `journal`, `tables`, `macros`, `playlists`, and `scenes` all expose a `folder` field, with non-null examples for all except playlists in that sample. FolderStore therefore owns folder docs/tree/type metadata only; it must not maintain child document collections or store nested primary document payloads.

Scope:

- [x] Add `FolderStore` and `FolderRepository` under `src/server/core/documents/primary/folders/`, plus a FolderDocument type that reflects Foundry's Folder schema and normalizes legacy/local parent aliases.
  Files: `src/server/core/documents/primary/folders/FolderStore.ts`, `src/server/core/documents/primary/folders/FolderRepository.ts`, `src/server/shared/types/documents.ts` or `src/server/shared/types/folders.ts`.
- [x] Register `FolderStore` with `PrimaryDocumentCacheCoordinator` and `modifyDocumentRouter`; seed from Foundry's `Folder` documents at bootstrap.
  Files: `src/server/core/documents/primary/PrimaryDocumentCacheCoordinator.ts`.
- [x] Model Folder read helpers around the folder tree itself: list folders, optionally filter by Folder `type`, lookup by id, traverse ancestors/descendants using `parent`, resolve permission/visibility with omitted maps/keys defaulting to `NONE`, and return the folder ids required to display a visible tree. These helpers should not inspect or depend on the document type nested under the folder.
  Files: `src/server/core/documents/primary/folders/FolderStore.ts`, `src/server/services/journals/JournalService.ts`.
- [x] Implement Folder permission resolution. Direct folder `permission` wins; omitted map/key normalizes to effective `NONE`. Only an explicit inherited permission value, if present in the Foundry payload/version, walks `parent` ancestry with a cycle guard and fail-closed behavior for missing parents.
  Files: `src/server/core/documents/primary/folders/FolderStore.ts`, `src/tests/unit/documents/folder-store.test.ts`.
- [x] Move JournalService's inline folder ancestry pruning to `FolderStore` helpers while keeping `JournalEntry` reads/writes on the existing path until Phase 4.
  Files: `src/server/services/journals/JournalService.ts`, `src/tests/unit/documents/journal-smoke.test.ts`.
- [x] Route Folder create/update/delete through `FolderRepository` for existing Journal route flows where `type === 'Folder'`; leave `JournalEntry` mutation responsibility unchanged until Phase 4.
  Files: `src/server/services/journals/JournalService.ts`, `src/server/shared/utils/createRouteFoundryClient.ts`, `src/server/shared/types/documents.ts`.
- [x] Remove socket/client-owned Folder reads once callers are migrated.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts`, `src/server/core/foundry/sockets/ClientSocket.ts`, `src/server/shared/utils/createRouteFoundryClient.ts`, `src/server/shared/types/documents.ts`, `src/tests/unit/**/*.test.ts`.
- [x] Update socket probes or legacy tests that still exercise `client.getFolders()` so they verify the Store-backed Folder path instead.
  Files: `src/tests/deprecated/socket-legacy/06-journals.test.ts`, `src/tests/unit/documents/journal-smoke.test.ts`.
- [x] Add Phase 3 tests covering seed/clear, schema normalization, type filtering, permission resolution, default-`NONE` normalization, explicit inheritance if present, tree mutation, router application, repository writes, JournalService folder pruning, and removal of socket-owned Folder reads.
  Files: `src/tests/unit/documents/folder-store.test.ts`, `src/tests/unit/routing/modify-document-router.test.ts`, `src/tests/unit/documents/journal-smoke.test.ts`, `src/tests/unit/run.ts`.

Non-goals for Phase 3:

- `JournalStore` and JournalEntry folder-aware visibility stay in Phase 4. Phase 3 creates the general Store-backed folder tree and removes Folder reads/writes from socket-owned surfaces.
- Actor, Item, RollTable, Scene, Macro, Playlist, and other folder-aware Stores do not need to consume `FolderStore` in this phase unless a narrow call-site cleanup requires it, even though observed payloads already expose `folder` ids. The helpers should remain document-payload agnostic so later phases can join those document stores to the same Folder infrastructure.
- Folder embedded children are out of scope; Folder is treated as a primary document with parent-folder ancestry, not as an embedded-document owner.
- Full ADR-0012 wire-event rename remains out of scope. Folder events should use the primary-document bridge shape, but browser-facing event naming can remain compatibility-oriented unless the implementation naturally adds `folderChanged` / `folderListInvalidated`.

Exit for Phase 3: `FolderStore` / `FolderRepository` exist, Folder document mutations route through the primary-document framework, JournalService folder pruning reads from `FolderStore`, socket/client-owned Folder reads are removed from server call sites, and `npx tsc --noEmit` plus `npm run test:unit` pass.

**Phase 3 verification addendum (May 16, 2026):**

- `npx tsc --noEmit` passed.
- `npm run test:unit` passed when rerun outside the sandbox; the sandboxed run failed before tests started because `tsx` could not open its IPC pipe.
- Exact cleanup grep found no `getFolders` call sites under `src/server` or `src/tests`.
- Structural Phase 3 pieces are present: `FolderStore`, `FolderRepository`, `FolderDocument` schema expansion, coordinator seeding, modifyDocument router registration, `folderChanged` / `folderListInvalidated` bridge events, JournalService folder pruning through `FolderStore`, and Folder create/update/delete through `FolderRepository`.

**Phase 2/3 audit addendum (May 16, 2026): User/Folder realtime fan-out closure**

Audit of the Phase 2 and Phase 3 work surfaced one shared gap and a few smaller observations. At audit time, the User/Folder Store-to-systemClient bridges existed but no browser consumer subscribed to the new wire events, so they were decorative until downstream fan-out was added. The addendum below closes that gap for authenticated clients. User presence transitions now reach dashboards through the system-owned status refresh path: `CoreSocket` updates `userPresence`, `SystemService` emits a single status-refresh signal, and `SystemStatusBroadcaster` sends the fresh `systemStatus` payload. User document mutations also request that status refresh so roster-derived UI stays current without a `ClientSocket` `modifyDocument` relay.

- [x] Wire `userChanged` / `userListInvalidated` fan-out in `AppSocketGateway` alongside the existing `chatMessageChanged` subscription, with per-socket subject resolution and `targetUserIds` filtering for invalidations.
  Files: `src/server/realtime/AppSocketGateway.ts`, `src/tests/unit/sockets/app-socket-gateway.test.ts` (system-handler count assertion now 7).
- [x] Wire `folderChanged` / `folderListInvalidated` fan-out in `AppSocketGateway`. Folder reads have no per-user ownership map today, so the gate is world-broadcast to authenticated sockets pending Phase 4 / future folder visibility policy; `targetUserIds` is still honored if a future emit populates it.
  Files: `src/server/realtime/AppSocketGateway.ts`, `src/tests/unit/sockets/app-socket-gateway.test.ts`.
- [x] Move dashboard roster freshness off `ClientSocket`: `ClientSocket` no longer listens for Foundry `User` `modifyDocument` or presence events, `CoreSocket` updates `userPresence` and emits one system-owned status-refresh signal on active-state changes, and `UserStore` document changes request the same full status refresh.
  Files: `src/server/core/foundry/sockets/ClientSocket.ts`, `src/server/core/foundry/sockets/CoreSocket.ts`, `src/server/core/system/SystemService.ts`, `src/server/realtime/SystemStatusBroadcaster.ts`, `src/tests/unit/sockets/realtime-broadcaster.test.ts`.
- [x] Add a client-side subscriber for `userChanged` / `userListInvalidated` so user roster/role/color changes refresh without waiting for a `systemStatus` broadcast. Implemented as an in-flight-coalesced `/api/status` refetch that updates the `users` slice only.
  Files: `src/client/ui/context/FoundryContext.tsx`.
- [x] Add a client-side subscriber for `folderChanged` / `folderListInvalidated` so folder rename/move/permission updates refresh the journal/folder view without manual reload. Implemented with the same in-flight-coalesce + 75 ms debounce shape used by `ChatContext`.
  Files: `src/client/ui/context/JournalProvider.tsx`.
- [x] Confirm `documentListInvalidated` ownership-change diffs on `UserStore` populate `targetUserIds` where applicable. Result: User docs carry no `ownership` field, so the base `diffOwnershipAndEmitInvalidation` and `usersWithEffectiveVisibility` always produce `undefined` for User events; `userListInvalidated` is always broadcast-wide. Documented on the `UserStore` class header.
  Files: `src/server/core/documents/primary/users/UserStore.ts`.

Closure verification (May 16, 2026): `npx tsc --noEmit` passed. `npm run test:unit` passed (`unit test suite passed`), with the updated `app-socket-gateway.test.ts` assertion against 7 system handlers / 5 foundry handlers reflecting the new user + folder bridge wiring.

Secondary audit notes (no action required for Phase 2/3, but worth recording for Phase 4 and beyond):

- `FolderStore.canReadDocument()` permission resolution (direct id, role id, default, `INHERIT` with cycle guard, missing-parent fail-closed) is implemented and covered by `folder-store.test.ts`, but no production primary-document read path should use it to gate contained document visibility. `JournalService.listJournals()` derives "visible folders" from the ancestry of visible JournalEntries, not from `folderStore.canReadDocument()`. That matches Foundry v13 behavior: JournalEntry visibility is journal/page ownership only, and Folder permissions govern the Folder document/tree entry rather than dynamically inheriting onto contained documents.
- `UserStore.seed()` runs twice on connect: once from `CoreSocket` on socket-`connect` using the `gameData.users` snapshot (so role lookups work before bootstrap), and again from `PrimaryDocumentCacheCoordinator.seedAll()` during `SystemService.bootstrap()` using `dispatchDocumentSocket('User', 'get', ...)`. Both apply the same emit-only-on-observable-change rule, so the second seed is idempotent in practice. Practical purpose of the early seed: it runs before `emit('connect')` in `CoreSocket`, so the first `systemStatus` broadcast (driven by `world:connected` on `SystemService`) already carries the user roster instead of an empty list. Removing the early seed would put browsers in a brief "empty player dropdown" state until `world:ready` fires. The cleaner split is described in the deferred-refactor note below — it is not a "fix one of the two seed sites" change.

**Deferred refactor — split CoreSocket connect handler responsibilities (no work in this pass)**

CoreSocket's `socket.on('connect', ...)` handler currently mixes several concerns:

- Transport: post-connect handshake, `getWorldStatus()`, soft-reset to `setup` state when the world isn't active.
- Raw world-data fetch + cache: `getWorldData()` / `fetchSceneData()` plus the resulting `gameDataCache` / `sceneDataCache` fields.
- Presence init: `userPresence.setActiveUsers(gameData.activeUsers)` (genuinely wire state — belongs here).
- Document Store seeding: the early `userStore.seed(...)` from the `gameData.users` snapshot.
- Identity: setting `this.userId = gameData.userId` (the service-account id).
- Adapter loading: `loadSystemAdapter(systemId)`.

Of those, only transport, raw cache, and presence init are clearly CoreSocket's job. Store seeding and adapter loading are orchestration concerns that `SystemService.bootstrap()` already owns later in the cycle. The clean split is roughly:

- **CoreSocket** keeps transport, raw `gameDataCache` / `sceneDataCache`, `userPresence` initialization from `gameData.activeUsers`, and emits a richer "ready with snapshot" signal (e.g. `connect` carrying or making available the already-cached `gameData` / `sceneData`).
- **SystemService** consumes that signal in `handleConnect` and orchestrates: eager `UserStore` seed from the snapshot (replacing the in-socket seed), `loadSystemAdapter` for the resolved system id, then the existing `bootstrap()` for compendium / discovery / coordinator seedAll / adapter init.

With that split, the "double seed" becomes two seeds both owned by `SystemService` (eager + authoritative), both idempotent, both at the orchestration layer — which is the layering ADR-0011 implies. It also lets the lifecycle clears (currently `userStore.clear(...)`, `actorStore.clear(...)` peppered through CoreSocket transport branches) collapse into `clearDocumentCache(reason)` on the SystemService side.

This is deferred because:

- It touches transport, lifecycle, and bootstrap simultaneously — risk surface is broader than the Phase 2/3 audit scope.
- It interacts with the still-pending Phase 5+ Stores (`CombatStore`, `ItemStore`) which will add more "seed me eagerly?" decisions and should be designed against the new layering, not the current one.
- It changes the ordering of operations around `emit('world:connected')` in subtle ways (eager seed before vs. after) and needs explicit test coverage for the connect-state transitions.

Tracked here so it isn't lost; planning happens in a later pass.
- ~~`FolderDocument.folder` (legacy DTO alias) is live, not vestigial.~~ **Resolved May 16, 2026 (Phase 4 follow-up):** the alias was dropped. `JournalFolderDto.folder` is now `JournalFolderDto.parent`; `FolderDocument.folder` is removed; `FolderStore` / `FolderRepository` no longer normalize a `folder` field on input; `journalApi.createJournalFolder` posts `{ parent }`; `JournalBrowser` reads `f.parent`. `JournalEntryDto.folder` was *not* renamed — Foundry's actual `JournalEntry` document field is `folder`, so that DTO field is not an alias.

**Phase 4 staging: JournalStore + JournalRepository**

ADR-0011 Phase 4 promotes Foundry `JournalEntry` documents into the primary-document framework. `JournalStore` owns the hydrated JournalEntry cache, entry-level visibility, embedded `JournalEntryPage` visibility, page mutation application, and folder-aware list projection by joining `journal.folder` to `FolderStore`. `JournalService` remains the route-facing orchestration layer for DTO projection and compatibility routes, but it should read from `JournalStore` and write through `JournalRepository` rather than fetching or mutating JournalEntry documents directly through the socket.

Foundry Journal assumptions for this phase: observed v13 JournalEntry payloads use a standard `ownership` map at the entry level, carry an optional `folder` id, and embed `pages`. Folder membership is read from `journal.folder` and joined against `FolderStore` for tree projection; `FolderStore` should not hold JournalEntry payloads or maintain a child-document collection. Each `JournalEntryPage` has its own `_id`, `name`, `type`, content payload fields such as `text`, `image`, `video`, `src`, optional `ownership`, `flags`, and `_stats`. Page visibility is two-level: the caller must be able to read the entry, then the page's own ownership is applied. An explicit page `INHERIT` should resolve to the entry's effective ownership; omitted page ownership should fail closed unless Foundry's actual payload semantics prove a different default during implementation.

Shared-content note: Foundry GM sharing is currently integrated through `SocketBase.setupSharedContentListeners()` (`shareImage` and `showEntry`), `UtilityService.getSharedContent()`, `/shared-content`, and realtime `sharedContentUpdate`. The exact Foundry semantics still need verification: sharing a journal page may be a live reference, a copied/snapshotted presentation payload, or a temporary GM presentation grant. Phase 4 should not create a second JournalEntry read path for shared journal content. If shared journal content is hydrated in this phase, resolve it through `JournalService` / `JournalStore` using the requesting user's subject and the shared UUID/id as input; if Foundry actually sends copied content, preserve it as a shared-content snapshot instead of refetching. A richer GM-share handler is likely needed later, and that policy should live in shared-content handling rather than weakening normal JournalStore ownership.

Scope:

- [x] Add `JournalStore` and `JournalRepository` under `src/server/core/documents/primary/journals/`, plus JournalEntryDocument/JournalEntryPageDocument types that reflect entry ownership, folder id, and embedded page ownership/content fields.
  Files: `src/server/core/documents/primary/journals/JournalStore.ts`, `src/server/core/documents/primary/journals/JournalRepository.ts`, `src/server/shared/types/documents.ts`.
- [x] Register `JournalStore` with `PrimaryDocumentCacheCoordinator` and `modifyDocumentRouter`; seed from Foundry's `JournalEntry` documents at bootstrap after `FolderStore` is ready.
  Files: `src/server/core/documents/primary/PrimaryDocumentCacheCoordinator.ts`.
- [x] Implement JournalEntry visibility in `JournalStore.resolveOwnership()` using the standard entry `ownership` map and `UserStore` subject roles; keep folder access lookups isolated to folder-organized list projection. Folder permissions do not gate JournalEntry visibility in Foundry v13; any future folder-level "Configure Ownership" feature should bulk-copy ownership to affected JournalEntry documents through repositories rather than joining reads through `FolderStore.canReadDocument`.
  Files: `src/server/core/documents/primary/journals/JournalStore.ts`, `src/tests/unit/documents/journal-store.test.ts`.
- [x] Implement embedded `JournalEntryPage` handling: apply create/update/delete events with `parentUuid: JournalEntry.<id>`, expose `canReadPage(entryId, pageId, subject)`, and filter pages for route DTOs via `visiblePages(entryId, subject)`.
  Files: `src/server/core/documents/primary/journals/JournalStore.ts`, `src/tests/unit/documents/journal-store.test.ts`, `src/tests/unit/routing/modify-document-router.test.ts`.
- [x] Move `JournalService.listJournals()` and `getJournalById()` reads to `JournalStore`; the service stays the route-facing DTO/projection layer and continues to use `FolderStore` for visible folder ancestry. Detail fetch now applies entry-level + page-level filtering before projecting the DTO.
  Files: `src/server/services/journals/JournalService.ts`, `src/tests/unit/documents/journal-smoke.test.ts`.
- [x] Route JournalEntry create/update/delete through `JournalRepository`; preserve the existing `type === 'Folder'` branch through `FolderRepository`. `JournalEntry` and `JournalEntryPage` types now dispatch through `JournalRepository` inside `createRouteFoundryClient`.
  Files: `src/server/services/journals/JournalService.ts`, `src/server/shared/utils/createRouteFoundryClient.ts`, `src/server/shared/types/documents.ts`.
- [x] Investigate Foundry `showEntry` / journal-page sharing semantics. Result: `showEntry` carries a UUID reference only (`SocketBase.setupSharedContentListeners` stores `{ id, uuid }`); the browser hydrates the entry through `/api/journals/:id`, which now runs through `JournalStore.get(id, { subject, DETAIL_VISIBLE })`. No separate hydration path is needed — shared journal content inherits the same ownership policy as direct journal reads. The GM "force-show" override remains a future custom shared-content policy concern and is intentionally out of scope.
  Files: `src/server/core/foundry/sockets/SocketBase.ts` (no change), `src/server/services/journals/JournalService.ts`.
- [x] Remove socket/client-owned JournalEntry reads once callers are migrated. `CoreSocket.getJournals` and `ClientSocket.getJournals` are gone; the `JournalClientLike` route-client type no longer requires `getJournals` or `dispatchDocumentSocket`.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts`, `src/server/core/foundry/sockets/ClientSocket.ts`, `src/server/shared/utils/createRouteFoundryClient.ts`, `src/server/shared/types/documents.ts`, `src/tests/deprecated/socket-legacy/06-journals.test.ts`, `src/tests/unit/actors/actor-store.test.ts`, `src/tests/unit/services/auth-status-smoke.test.ts`.
- [x] Add Phase 4 tests covering seed/clear, clone-on-read, entry ownership, page ownership, page `INHERIT`, folder-aware list projection, detail authorization, embedded page mutation routing, and repository writes.
  Files: `src/tests/unit/documents/journal-store.test.ts`, `src/tests/unit/documents/journal-smoke.test.ts`, `src/tests/unit/routing/modify-document-router.test.ts`, `src/tests/unit/run.ts`.

Non-goals for Phase 4:

- Do not implement the full GM shared-content grant model unless it is necessary to keep existing behavior working. Track it as a later custom shared-content handler if normal Journal visibility and "GM deliberately showed this" need different policy.
- Do not migrate client/UI or public SDK journal helpers unless a server type change forces a compile update.
- Do not retrofit Actor, Item, RollTable, Scene, Macro, Playlist, or other folder-aware documents to consume `FolderStore` yet; their later phases should use the same document-side `folder` join pattern.
- Do not make Journal folder operations separate routes in this phase; existing folder operations can continue to flow through the journal route surface until a broader folder API is designed.

Exit for Phase 4: `JournalStore` / `JournalRepository` exist, JournalEntry and JournalEntryPage mutations route through the primary-document framework, JournalService reads from `JournalStore`, JournalEntry writes use `JournalRepository`, shared-content journal access is documented or routed through JournalService without bypassing Store visibility, socket/client-owned JournalEntry reads are removed from server call sites, and `npx tsc --noEmit` plus `npm run test:unit` pass.

**Phase 4 verification addendum (May 16, 2026):**

- `npx tsc --noEmit` passed.
- `npm run test:unit` passed (`unit test suite passed`). New `journal-store.test.ts` covers seed/clone-on-read, entry ownership, page ownership (with omitted-page fail-closed), page `INHERIT` resolution, `listByFolderIds` with and without subject, embedded page mutation routing, and repository-write mirroring. `modify-document-router.test.ts` adds `JournalEntryPage` embedded-routing coverage. `journal-smoke.test.ts` now seeds `journalStore` instead of mocking `client.getJournals`, exercises hidden-detail 404 via Store-backed visibility, and asserts both Folder and JournalEntry create routes dispatch through their respective Repositories.
- `app-socket-gateway.test.ts` system-handler count updated to 9 (5 foundry + 9 system bridges), adding `journalChanged` / `journalListInvalidated`.
- Structural Phase 4 pieces are present: `JournalStore`, `JournalRepository`, `JournalEntryDocument` + `JournalEntryPageDocument` schema expansion, coordinator seeding after Folder, modifyDocument router registration with embedded handler for `JournalEntryPage`, `journalChanged` / `journalListInvalidated` bridge events with gateway fan-out, `JournalService.listJournals()` + `getJournalById()` reading from `JournalStore` with page-level visibility filtering, and JournalEntry/JournalEntryPage writes through `JournalRepository`.
- Shared-content `showEntry` reference path keeps the existing `SocketBase` listener; client-side hydration goes through `/api/journals/:id` which now enforces `JournalStore.get` ownership at `DETAIL_VISIBLE`. No bypass path was introduced.
- Client: `JournalProvider` subscribes to `journalChanged` / `journalListInvalidated` and refetches via the existing in-flight-coalesced + 75 ms debounced path.

**Phase 5 staging: CombatStore + CombatRepository (embedded Combatant)**

ADR-0011 Phase 5 promotes Foundry `Combat` documents into the primary-document framework with embedded `Combatant` handling. `CombatStore` owns the hydrated combat cache, combat-level visibility (cross-referenced against `ActorStore`), embedded combatant mutation application, and the list-invalidation surface that fires when actor visibility crossings affect which combats a subject can see. `CombatRepository` owns combat-level and combatant-level writes. `CombatService` keeps the route-facing orchestration role: list/turn/initiative projections, GM/active-combatant authorization, and DTO enrichment with normalized actor payloads. Phase 5 also retires the legacy `combatUpdate` bespoke wire event (currently emitted from both `CoreSocket` and `ClientSocket`) and replaces it with the standard `combatChanged` / `combatListInvalidated` bridge pattern, matching the post-Phase 1 wire surface used by `chatMessageChanged`, `userChanged`, `folderChanged`, and `journalChanged`.

Foundry Combat assumptions for this phase: the observed v13 dump shows Combat documents carry `_id`, `active`, `type`, `system`, `scene` (nullable), `groups`, `combatants[]`, `round`, `turn`, `sort`, `flags`, `_stats`. **Combat documents do not carry an `ownership` map.** Visibility is derived: GMs are owners of every combat; non-GM subjects observe a combat if it contains at least one non-hidden combatant whose `actorId` resolves to an actor they can read at `LIST_VISIBLE`. The `CombatDocument` / `CombatantDocument` types in `src/server/shared/types/documents.ts` are currently bare and will need to expand (combat: `active`, `scene`, `type`, `sort`, `flags`, `system`, `groups`; combatant: `tokenId`, `sceneId`, `hidden`, `defeated`, `group`, `type`, `system`, `flags`, `name`, `img`). Combatants have a `hidden: true` flag that filters them from non-GM views of the combat (combatant payloads should be pruned in the route DTO projection for non-GMs).

Cross-store visibility: `CombatStore.resolveOwnership` reads `actorStore.canReadActor` for each non-hidden combatant. Because the answer changes when actor ownership maps shift, `CombatStore` exposes a `bindActorVisibilityBridge(actorStore)` method that subscribes to `actorStore.documentListInvalidated` and translates each event into a `combatListInvalidated` emit for combats containing the affected actor, preserving the original `targetUserIds`. The coordinator calls `combatStore.bindActorVisibilityBridge(actorStore)` once, in the same place the existing Store registrations happen — so a developer reading `PrimaryDocumentCacheCoordinator.ts` sees the cross-store wiring in one greppable line, and a developer reading `CombatStore.ts` sees the dependency declared explicitly as a method on the Store. This is the first cross-store dependency in the framework and the pattern Phase 6+ Stores follow. The seed order in `PrimaryDocumentCacheCoordinator` must register `CombatStore` after `ActorStore` so the first `seedAll` pass has actors available for the visibility computation triggered by combatant arrivals.

Wire-event rename (committed): `combatUpdate` is currently a bespoke "fat" event emitted from per-type `modifyDocument` switches in both `CoreSocket` (line ~470) and `ClientSocket` (line ~380), with a SDK contract (`RealtimeCombatUpdatePayload` in `src/shared/sdk/contracts.ts` and `src/shared/contracts/realtime.ts`) shaped as `{ _id, active, round, turn, combatants[], sceneId }`. The only browser consumer (`FoundryContext.handleCombatUpdate`) already ignores the payload and just refetches; the SDK shape has no in-tree module consumers. Phase 5 removes both emit sites and replaces them with skinny `combatChanged { combatId, action }` and `combatListInvalidated { reason, combatId?, targetUserIds? }` events bridged from `CombatStore` through `SystemService`. The SDK contract type is replaced (not aliased) — `RealtimeCombatUpdatePayload` becomes `RealtimeCombatChangedPayload` + `RealtimeCombatListInvalidatedPayload`. This matches Phase 1's treatment of `chatUpdate → chatMessageChanged` and the post-Phase 1 surface used by `userChanged`, `folderChanged`, and `journalChanged`.

Scope:

- [x] Add `CombatStore` and `CombatRepository` under `src/server/core/documents/primary/combats/`, plus expand `CombatDocument` / `CombatantDocument` shapes to reflect the observed v13 fields.
  Files: `src/server/core/documents/primary/combats/CombatStore.ts`, `src/server/core/documents/primary/combats/CombatRepository.ts`, `src/server/shared/types/documents.ts`.
- [x] Register `CombatStore` with `PrimaryDocumentCacheCoordinator` after `ActorStore`; register direct-type and `Combat`-parent embedded handlers on `modifyDocumentRouter`.
  Files: `src/server/core/documents/primary/PrimaryDocumentCacheCoordinator.ts`.
- [x] Implement combat visibility in `CombatStore.resolveOwnership()`: GM → OWNER; non-GM → OBSERVER iff `combat.combatants` contains a non-hidden entry whose `actorId` resolves to an actor the subject can read at `LIST_VISIBLE` via `actorStore.canReadActor`. Missing actors fail closed; combats with zero readable combatants resolve to NONE for non-GMs; a Store without an ActorStore binding also fails closed for non-GMs.
  Files: `src/server/core/documents/primary/combats/CombatStore.ts`, `src/tests/unit/combat/combat-store.test.ts`.
- [x] Implement embedded `Combatant` handling: apply create/update/delete events with `parentUuid: Combat.<combatId>`, mutate the parent combat's `combatants[]` array, and emit `combatChanged` (update) on the parent so newly-added readable combatants are observable to fan-out subscribers.
  Files: `src/server/core/documents/primary/combats/CombatStore.ts`, `src/tests/unit/combat/combat-store.test.ts`, `src/tests/unit/routing/modify-document-router.test.ts`.
- [x] Wire the cross-store subscription as a Store-owned method: `CombatStore.bindActorVisibilityBridge(actorStore: ActorStore)` subscribes to `actorStore.documentListInvalidated` and emits `combatListInvalidated` for combats containing the affected actor (preserving `targetUserIds`). The coordinator calls this once alongside the existing Store/router registrations. Translation logic (`findCombatsContainingActor`) stays on `CombatStore` next to `resolveOwnership`.
  Files: `src/server/core/documents/primary/combats/CombatStore.ts`, `src/server/core/documents/primary/PrimaryDocumentCacheCoordinator.ts`, `src/tests/unit/combat/combat-store.test.ts`.
- [x] Move `CombatService.listCombats()`, `advanceTurn()`, `previousTurn()`, and `rollInitiative()` reads onto `CombatStore`. Service-level enrichment (actor DTO normalization through `deps.normalizeActors`) stays at the service boundary; `ensureReady` gates each entry point.
  Files: `src/server/services/combats/CombatService.ts`, `src/tests/unit/actors/actor-combat-smoke.test.ts`.
- [x] Route combat and combatant writes through `CombatRepository`. `advanceTurn` / `previousTurn` use `combatRepository.update(combatId, { round, turn })`; `rollInitiative` uses `combatRepository.updateCombatant(combatId, combatantId, { initiative })`. `createRouteFoundryClient.dispatchDocument('Combat'|'Combatant', ...)` routes through `CombatRepository`.
  Files: `src/server/services/combats/CombatService.ts`, `src/server/shared/utils/createRouteFoundryClient.ts`, `src/server/shared/types/documents.ts`, `src/tests/unit/actors/actor-combat-smoke.test.ts`.
- [x] Bridge `CombatStore` events through `SystemService` as `combatChanged` / `combatListInvalidated`; remove the bespoke `combatUpdate` emit on `CoreSocket.modifyDocument` listener and the duplicate `combatUpdate` emit from the former `ClientSocket` document listener. `AppSocketGateway` now subscribes to the system-client events with `combatStore.canReadDocument` per-socket on `combatChanged` and `targetUserIds` filtering on invalidations.
  Files: `src/server/core/system/SystemService.ts`, `src/server/core/foundry/sockets/CoreSocket.ts`, `src/server/core/foundry/sockets/ClientSocket.ts`, `src/server/realtime/AppSocketGateway.ts`, `src/tests/unit/sockets/app-socket-gateway.test.ts` (system-handler count goes 9 → 11; foundry-handler count goes 5 → 4).
- [x] Replace the SDK / shared realtime `RealtimeCombatUpdatePayload` with `RealtimeCombatChangedPayload` and `RealtimeCombatListInvalidatedPayload`; update the browser subscriber `FoundryContext.tsx` to listen on the new event names with refetch.
  Files: `src/shared/sdk/contracts.ts`, `src/shared/contracts/realtime.ts`, `src/client/ui/context/FoundryContext.tsx`.
- [x] Remove socket/client-owned Combat reads. `CoreSocket.getCombats`, `ClientSocket.getCombats`, the route-client `getCombats` surface, and `RouteFoundryClient.dispatchDocumentSocket` (now dead because no client type requires it) are gone; `CombatClientLike` requires `dispatchDocument` + `getActor` only.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts`, `src/server/core/foundry/sockets/ClientSocket.ts`, `src/server/shared/utils/createRouteFoundryClient.ts`, `src/server/shared/types/documents.ts` (`CombatClientLike`), `src/tests/unit/actors/actor-store.test.ts`, `src/tests/unit/services/auth-status-smoke.test.ts`, `src/tests/deprecated/socket-legacy/06-combats.test.ts`.
- [x] Filter `hidden: true` combatants from non-GM DTO projections in `CombatService.listCombats`. GMs see hidden combatants; players see them pruned. Service-side projection step, not a Store-side filter.
  Files: `src/server/services/combats/CombatService.ts`.
- [x] Add Phase 5 tests covering seed/clear, GM-vs-non-GM visibility against `ActorStore`, missing-actor fail-closed, unbound-Store fail-closed, hidden-combatant exclusion, embedded combatant mutation routing, repository writes, and cross-store invalidation propagation. Updated `actor-combat-smoke.test.ts` to seed `combatStore` and capture `dispatchDocument` calls.
  Files: `src/tests/unit/combat/combat-store.test.ts`, `src/tests/unit/actors/actor-combat-smoke.test.ts`, `src/tests/unit/routing/modify-document-router.test.ts`, `src/tests/unit/sockets/app-socket-gateway.test.ts`, `src/tests/unit/run.ts`.
- [x] Verify cleanup with `rg "\.getCombats\(|getCombats\(|combatUpdate" src/server src/client src/shared -g "*.ts" -g "*.tsx"`, `npx tsc --noEmit`, and `npm run test:unit`.

Non-goals for Phase 5:

- Do not retrofit `SceneStore` for combat.scene visibility. Scenes are a Phase 7 stub; Phase 5 treats `combat.scene` as a passthrough field and does not gate combat visibility on scene visibility.
- Do not redesign the GM-share / shared-content path. Combat is not shared via `showEntry`; no overlap with the Phase 4 shared-content guardrails.
- Do not migrate the CoreSocket connect handler split (the deferred Phase 2/3 audit item). Phase 5 may register `CombatStore` for early seeding alongside the existing pattern; the orchestration refactor is still its own pass and Phase 5 explicitly does not block on it.
- Do not introduce a `CombatantStore` as a separate primary doc type. Combatants are embedded children of Combat (per ADR-0011's primary-vs-embedded model), routed via `parentUuid: Combat.<id>` exactly like Items under Actor.
- Do not migrate the Scene / Group / system-specific fields (e.g. `shadowdark-crawl-helper.crawl` typed combats). Store-level handling is generic; system-specific projection stays in adapter or service code.

Exit for Phase 5: `CombatStore` / `CombatRepository` exist, Combat and Combatant mutations route through the primary-document framework, `CombatService` reads from `CombatStore` and writes via `CombatRepository`, `actorListInvalidated` propagates to `combatListInvalidated` for affected users, the legacy `combatUpdate` wire event is removed from both `CoreSocket` and `ClientSocket` and replaced with `combatChanged` / `combatListInvalidated`, socket/client-owned Combat reads are removed from server call sites, `hidden` combatants are filtered for non-GMs at the DTO boundary, and `npx tsc --noEmit` plus `npm run test:unit` pass.

**Phase 5 verification addendum (May 16, 2026):**

- `npx tsc --noEmit` passed.
- `npm run test:unit` passed (`unit test suite passed`).
- New `combat-store.test.ts` covers seed/clear, ownership cross-reference against ActorStore, missing-actor fail-closed, unbound-Store fail-closed, hidden-combatant exclusion from non-GM views, embedded `Combatant` mutation routing (create/update/delete/idempotent), `bindActorVisibilityBridge` propagation (target combat scoped + `targetUserIds` preserved + unrelated actors not propagating), and `CombatRepository` write mirroring (`create`, `createCombatant`, `updateCombatant`).
- `modify-document-router.test.ts` adds a `Combatant`-under-Combat embedded-routing case alongside the existing Actor/JournalEntryPage coverage.
- `actor-combat-smoke.test.ts` was rewritten: each combat case now seeds `combatStore` and captures `dispatchDocument` calls instead of mocking `client.getCombats` and `dispatchDocumentSocket`; all turn-control and authorization paths still verified.
- `app-socket-gateway.test.ts` system-handler count updated to 11 / 4 reflecting `combatChanged` + `combatListInvalidated` moving onto the system bridge.
- Legacy `06-combats` socket test now seeds `combatStore` from `core.dispatchDocumentSocket('Combat', 'get', ...)` instead of calling `client.getCombats()`.
- Structural Phase 5 pieces are present: `CombatStore`, `CombatRepository`, expanded `CombatDocument` / `CombatantDocument` types, coordinator seeding after ActorStore, modifyDocument router registration with embedded `Combatant` handler, `bindActorVisibilityBridge` wired in coordinator, `combatChanged` / `combatListInvalidated` bridge events with gateway fan-out + ownership filtering, `CombatService.listCombats / advanceTurn / previousTurn / rollInitiative` reading from `CombatStore` and writing through `CombatRepository`, hidden-combatant filtering in non-GM DTO projections, and removal of socket-owned Combat reads.
- Wire-event cleanup: `combatUpdate` is gone from `CoreSocket`, `ClientSocket`, the SDK contracts (`RealtimeCombatUpdatePayload` → `RealtimeCombatChangedPayload` + `RealtimeCombatListInvalidatedPayload`), and the browser subscriber (`FoundryContext` listens on `combatChanged` / `combatListInvalidated`). Exact cleanup grep finds only documentation comments under `src/server`, `src/client`, `src/shared`.
- Incidental cleanup: `RouteFoundryClient.dispatchDocumentSocket` was removed because no route-client consumer required it anymore after Phase 5; the type narrowed correspondingly. The Phase 5 audit found this dead surface while migrating CombatService off it.

**Phase 5 audit/fix addendum 1 (May 16, 2026): combatant visibility invalidation + browser refetch coalescing**

Follow-up audit found two implementation gaps and one documentation staleness note after Phase 5 landed:

- [x] Fix stale combat lists when an embedded `Combatant` mutation removes a user's combat visibility. `CombatStore.applyEmbeddedChange()` previously emitted only `combatChanged` on parent updates. Because `AppSocketGateway` gates `combatChanged` against post-change visibility, a user who lost access could miss the event and keep a stale combat in the browser. `CombatStore` now compares the non-hidden combatant actor-id source set before/after embedded `Combatant` changes and emits `combatListInvalidated { reason: "combatant-visibility-changed", combatId }` when that source set changes.
  Files: `src/server/core/documents/primary/combats/CombatStore.ts`, `src/tests/unit/combat/combat-store.test.ts`.
- [x] Coalesce browser combat refetches from paired `combatChanged` + `combatListInvalidated` events. `FoundryContext` now debounces realtime combat refreshes, and `ActorCombatContext.fetchCombats()` reuses an in-flight `/api/combats` request so bursts collapse to one fetch.
  Files: `src/client/ui/context/FoundryContext.tsx`, `src/client/ui/context/ActorCombatContext.tsx`.
- [x] Treat the Phase 5 staging paragraphs that say `CombatDocument` is "currently bare" and `combatUpdate` is "currently" emitted as pre-implementation historical text. The verification addendum and this audit/fix addendum supersede that language; the source now has expanded combat types and no live `combatUpdate` emitters.
  Files: `docs/adr/0011-primary-document-model.md`.
- [x] Verify the fix with `npx tsc --noEmit`, `npm run test:unit`, and `git diff --check`.

**Phase 5 audit/fix addendum 2 (May 17, 2026): combat tracker exposes enemy combatant name/img + URL resolution**

In-game testing surfaced a tracker bug: a player who can see a combat (because they own one combatant's actor) saw enemy combatants render as "Unknown" with no image. Root cause: `CombatService.listCombats` enriches combatants by calling `client.getActor(id)`, which routes through `ActorStore.getActor` with `LIST_VISIBLE` filtering. Enemy NPCs typically have `ownership: { default: 0 }` (NONE), so the route-client read returns null and the projected combatant ends up with `actor: null`. This contradicts Foundry's tracker semantic, where non-hidden combatants in a visible combat are shown by their displayed name/image regardless of whether the player owns the underlying actor doc. Hiding sensitive actor fields elsewhere is correct; hiding the tracker label is not.

- [x] Project a stripped `{ _id, name, img }` actor for non-readable combatants in a visible combat. `CombatService.listCombats` now collects two parallel maps — `readableActors` (full data, flows through `deps.normalizeActors`) and `strippedActors` (name + img only, taken from `client.getActorRaw` after the ownership-filtered read returns null). The merged display map runs through the existing combatant projection so the tracker has a name even when the player can't read the actor doc. Sensitive fields (`system`, `items`, `ownership`, etc.) stay stripped.
  Files: `src/server/services/combats/CombatService.ts`, `src/tests/unit/actors/actor-combat-smoke.test.ts`.
- [x] Resolve the stripped `img` against the Foundry URL prefix via `client.resolveUrl(raw.img)`. The readable path picks this up through `deps.normalizeActors` (the system adapter handles asset URL prefixing); the stripped path bypasses the adapter, so the resolution happens inline to avoid 404s on raw relative Foundry paths in the browser.
  Files: `src/server/services/combats/CombatService.ts`.
- [x] Verify with `npx tsc --noEmit` and `npm run test:unit`. New `actor-combat-smoke` case asserts that a player who owns one combatant's actor sees the enemy combatant's name + resolved img on the tracker DTO while `system` and `ownership` stay absent.

**Phase 6 staging: ItemStore + ItemRepository (world-level)**

ADR-0011 Phase 6 promotes Foundry world `Item` documents into the primary-document framework. `ItemStore` owns the hydrated world-Item cache, standard-ownership-map visibility, and (where applicable) `ActiveEffect` embedded child handling for world Items. `ItemRepository` owns world-Item create/update/delete + embedded effect ops. The phase makes the embedded-vs-world Item distinction explicit at the type level: `ActorRepository.createItem` (embedded items via `parentUuid: Actor.<id>`) and `ItemRepository.create` (world items, no parent) coexist as clearly separate surfaces. The world Item set is typically small; full hydration with bootstrap seed matches the Actor / Journal / Combat pattern.

Foundry world Item assumptions for this phase: observed v13 sample world Items carry `_id`, `name`, `type`, `img`, `folder`, `system`, `effects`, `sort`, `ownership` (standard map), `flags`, `_stats`. The standard `ownership` map (`{ default, userId: level }`) drives visibility — same shape as Actor and JournalEntry, so `getEffectiveOwnership` from `ownership.ts` works directly inside `ItemStore.resolveOwnership`. The `ItemDocument` shape in `src/server/shared/types/actors.ts` is currently bare-bones (`_id`, `name`, `type`, `system`, `effects`) because it was only ever exercised as an embedded-on-Actor type; Phase 6 expands it to cover world-Item fields. The shape stays shared between embedded and world contexts — it's the same Foundry document type with or without a parent — but the expanded fields are no-op on embedded items and load-bearing on world items.

Router priority decision (committed): Phase 6 must change `modifyDocumentRouter.route` priority so `parentUuid` is consulted **before** direct-type lookup when a matching embedded handler is registered. Today the router runs direct-type first, which means once `register(itemStore)` lands, embedded `Item` events with `parentUuid: Actor.<id>` would route to `ItemStore` instead of `ActorStore` — silently breaking Phase 1's actor-owned item handling. The corrected order: if `parentUuid` is present and points to a registered embedded handler, route to the embedded handler; otherwise direct-type. World Item events have no `parentUuid` so they still hit `ItemStore` correctly. This is a one-method change in the base router but it must land in Phase 6 before `ItemStore` registers; the existing `modify-document-router.test.ts` needs an explicit "Item under Actor stays with ActorStore even after ItemStore registers directly" case.

Embedded `ActiveEffect` on world Items: world Items can carry `effects[]` just like actor-owned items. If Foundry's `modifyDocument` for an `ActiveEffect` ever arrives with `parentUuid: Item.<id>.ActiveEffect.<id>` (i.e. parent type starts with `Item`, not `Actor`), `ItemStore` must handle it. Phase 6 registers `ItemStore` as the embedded handler for parent type `Item` and implements `applyEmbeddedChange('ActiveEffect', ...)` mirroring the Actor pattern. This stays scoped to effects on world Items; embedded effects on actor-owned items continue to flow through ActorStore's existing path with `parentUuid: Actor.<id>.Item.<id>.ActiveEffect.<id>` (parent type `Actor`).

Cross-store / consumer notes: ItemStore has no cross-store visibility dependency (item visibility is self-contained in `item.ownership`, no Combat-style actor join). The public Module SDK surface `getWorldItems` (`src/server/shared/utils/createModuleFoundryClient.ts:124`) currently calls `client.dispatchDocument('Item', 'get', ...)` directly; Phase 6 reroutes the implementation to read from `ItemStore.list({ subject, minOwnership: LIST_VISIBLE })`. The SDK signature stays the same, so modules don't change. At the time of Phase 6, the socket-owned UUID path also needed the `Item.<id>` branch to read from `ItemStore` like the existing Actor branch; ADR-0016 later moved that UUID routing out of sockets and into `DocumentResolver`. No Sheet Delver browser route or React context consumes world items today; the wire-event bridge + gateway fan-out are wired for symmetry and future module/SDK consumers, but no client-side subscriber is added in this phase (matches the "no consumer; gateway is decorative until subscribed" pattern documented in the Phase 2/3 audit addendum).

Scope:

- [x] Add `ItemStore` and `ItemRepository` under `src/server/core/documents/primary/items/`. Expand `ItemDocument` in `src/server/shared/types/actors.ts` to include world-Item fields (`folder`, `img`, `sort`, `ownership`, `flags`, `_stats`); the type stays shared between embedded and world contexts.
  Files: `src/server/core/documents/primary/items/ItemStore.ts`, `src/server/core/documents/primary/items/ItemRepository.ts`, `src/server/shared/types/actors.ts`.
- [x] Fix `modifyDocumentRouter.route` priority: `parentUuid` present routes embedded-or-drop (no fall-through to direct-type, which would let synthetic-token `Item` events on `ActorDelta` leak into `ItemStore`). World events with no `parentUuid` go to direct-type lookup. Added a regression test that `Item` events under `Actor.<id>` route to `ActorStore` even after `ItemStore` registers directly, AND that `Item` events with `parentUuid: ActorDelta.<id>...` still drop silently rather than leaking to `ItemStore`.
  Files: `src/server/core/documents/primary/base/modifyDocumentRouter.ts`, `src/tests/unit/routing/modify-document-router.test.ts`.
- [x] Register `ItemStore` with `PrimaryDocumentCacheCoordinator` (after `FolderStore`). Register direct-type binding on `modifyDocumentRouter` and the `Item`-parent embedded handler for `ActiveEffect` on world Items.
  Files: `src/server/core/documents/primary/PrimaryDocumentCacheCoordinator.ts`.
- [x] Implement world-Item visibility in `ItemStore.resolveOwnership()` using `getEffectiveOwnership(item.ownership, subject)`.
  Files: `src/server/core/documents/primary/items/ItemStore.ts`, `src/tests/unit/documents/item-store.test.ts`.
- [x] Implement embedded `ActiveEffect` mutation handling for world Items via `parentUuid: Item.<id>`. Mirrors the Actor-effect pattern; emits `itemChanged` (update) on the parent.
  Files: `src/server/core/documents/primary/items/ItemStore.ts`, `src/tests/unit/documents/item-store.test.ts`, `src/tests/unit/routing/modify-document-router.test.ts`.
- [x] Add `ItemStore.listByFolderIds(folderIds, options?)` mirroring `JournalStore.listByFolderIds`. Not consumed in Phase 6; parity for future folder-organized item views.
  Files: `src/server/core/documents/primary/items/ItemStore.ts`, `src/tests/unit/documents/item-store.test.ts`.
- [x] Migrate `createModuleFoundryClient.getWorldItems` to read from `ItemStore.list({ subject, minOwnership: LIST_VISIBLE })` with optional `type` filtering preserved. SDK signature unchanged. Store-readiness guard throws `PrimaryDocumentCacheNotReadyError` pre-bootstrap.
  Files: `src/server/shared/utils/createModuleFoundryClient.ts`.
- [x] Reroute the then-existing `CoreSocket.fetchByUuid` `Item.<id>` branch through `ItemStore.get(id)` with the Actor pattern's Store-ready guard. ADR-0016 later removed the socket method and preserved this Store-backed behavior in `DocumentResolver`.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts`.
- [x] Route world Item create/update/delete through `ItemRepository` in `createRouteFoundryClient.dispatchDocument`. Parent-aware priority: `parent.type === 'Actor'` → `ActorRepository`; `parent.type === 'Item'` → `ItemRepository`; bare `type === 'Item'` → `ItemRepository`. Embedded `ActiveEffect` events under either parent route to the right Repository via the `parent.type` check. Inline-documented in the dispatch helper.
  Files: `src/server/shared/utils/createRouteFoundryClient.ts`, `src/tests/unit/documents/item-store.test.ts`.
- [x] Bridge `ItemStore` events through `SystemService` as `itemChanged` / `itemListInvalidated`. `AppSocketGateway` fan-out applies per-socket `itemStore.canReadDocument` on `itemChanged` and honors `targetUserIds` on invalidations. System-handler count goes 11 → 13.
  Files: `src/server/core/system/SystemService.ts`, `src/server/realtime/AppSocketGateway.ts`, `src/tests/unit/sockets/app-socket-gateway.test.ts`.
- [x] Define skinny SDK + shared realtime contracts `RealtimeItemChangedPayload` and `RealtimeItemListInvalidatedPayload`. No client-side subscriber added (no in-tree consumer); the gateway emits for future module-SDK consumers, matching the pre-subscription pattern from the Phase 2/3 audit.
  Files: `src/shared/contracts/realtime.ts`, `src/shared/sdk/contracts.ts`.
- [x] Add Phase 6 tests covering seed/clear, clone-on-read, ownership policy (default + per-user, GM short-circuit), `listByFolderIds`, embedded `ActiveEffect` routing, repository writes, and the router-priority regression case.
  Files: `src/tests/unit/documents/item-store.test.ts`, `src/tests/unit/routing/modify-document-router.test.ts`, `src/tests/unit/run.ts`.
- [x] Verify with `npx tsc --noEmit` and `npm run test:unit`.

Non-goals for Phase 6:

- Do not introduce a `/api/items` Express route. No Sheet Delver UI consumes world items today; module access happens via the SDK. If routes are needed later they layer on top of `ItemStore` cleanly.
- Do not change the SDK `getWorldItems` signature. Module callers must not break — only the underlying read path changes.
- Do not migrate Compendium-Item lookups. Compendium cache stays on its existing path; Phase 6 is world-Items only.
- Do not retrofit the embedded-on-Actor Item path. Actor-owned items keep flowing through `ActorStore.applyEmbeddedChange('Item', ...)` from Phase 1.
- Do not migrate the deferred CoreSocket connect-handler split (still its own pass).
- Do not implement Item folder permission gating in Phase 6. Foundry v13 world Item visibility is item-ownership-only; folder-level ownership tools bulk-copy ownership onto Items rather than creating a live FolderStore read dependency.
- Do not add browser-side `ItemContext` or refetch coalescing. There's no consumer; the wire-event bridge is decorative until a real subscriber lands.

Exit for Phase 6: `ItemStore` / `ItemRepository` exist; world-Item mutations route through the primary-document framework; embedded `Item` events on Actors keep routing to `ActorStore` via the router-priority fix; `getWorldItems` reads from `ItemStore`; the then-existing Item UUID branch is Store-backed; `itemChanged` / `itemListInvalidated` bridges fire through `SystemService` and fan out through `AppSocketGateway`; `ItemDocument` covers the world-Item field set; and `npx tsc --noEmit` plus `npm run test:unit` pass.

**Phase 6 verification addendum (May 17, 2026):**

- `npx tsc --noEmit` passed.
- `npm run test:unit` passed (`unit test suite passed`).
- Router priority decision tightened during implementation: `parentUuid` present is **embedded-or-drop** (no fall-through to direct-type) so a synthetic-token `Item` event with `parentUuid: ActorDelta.<id>.Item.<id>` cannot leak into `ItemStore` as if it were a world Item with the wrong id. The Phase 6 staging language ("direct-type fallback when parent type has no handler") is superseded by this stricter rule; the `modifyDocumentRouter` doc comment and the regression test in `modify-document-router.test.ts` reflect the final behavior.
- Dispatch routing in `createRouteFoundryClient` reorganized around `parent.type`: `parent.type === 'Actor'` → `ActorRepository`, `parent.type === 'Item'` → `ItemRepository` (covers `ActiveEffect` under either parent), bare `type === 'Item'` → `ItemRepository`. Inline comment in the helper documents the priority.
- New `item-store.test.ts` covers seed/clone-on-read, ownership policy (default + per-user + GM short-circuit), `listByFolderIds` (privileged + subject-filtered + root-only), embedded `ActiveEffect` routing (create/update/idempotent/delete + unknown-type drops), and repository write mirroring (`create` / `createEffect` / `update`).
- `modify-document-router.test.ts` adds `runEmbeddedTakesPriorityOverDirectType`: `Item` under `Actor` stays on `ActorStore` even with `ItemStore` registered for direct `Item`; world `Item` (no parentUuid) reaches `ItemStore`; `Item` with `parentUuid: ActorDelta.<id>...` drops silently rather than leaking.
- `app-socket-gateway.test.ts` system-handler count updated to 13 (added `itemChanged` + `itemListInvalidated`); foundry-handler count remains 4.
- Structural Phase 6 pieces are present: `ItemStore`, `ItemRepository`, expanded `ItemDocument`, coordinator seeding after FolderStore, modifyDocument router registration with embedded `Item` handler for `ActiveEffect`, `itemChanged` / `itemListInvalidated` bridge events with gateway fan-out, `getWorldItems` Store-backed read, Item UUID Store-backed read behavior later carried forward by `DocumentResolver`, route-client dispatch priority for parent-aware routing.

**Phase 6 audit/fix addendum 1 (May 17, 2026): route-client nested actor-item effects + tracked-doc wording**

Follow-up audit found two small alignment gaps after Phase 6 landed:

- [x] Route-client dispatch now treats dotted parent types by their root document type. `parent.type === "Actor.<actorId>.Item"` now routes through `ActorRepository`, so module SDK actor-owned item effect helpers keep repository-backed immediate cache mirroring instead of falling through to raw socket dispatch. `parent.type === "Item"` still routes world-Item effects through `ItemRepository`, and bare `type === "Item"` still routes world Item writes through `ItemRepository`.
  Files: `src/server/shared/utils/createRouteFoundryClient.ts`, `src/tests/unit/actors/actor-store.test.ts`.
- [x] `modifyDocumentRouter` comments now match the implementation's final rule: `parentUuid` present is embedded-or-drop, with no direct-type fall-through.
  Files: `src/server/core/documents/primary/base/modifyDocumentRouter.ts`.
- [x] ADR wording no longer references untracked temp dump paths. The observed folderable-document and world-Item field notes are written inline.
  Files: `docs/adr/0011-primary-document-model.md`.
- [x] Verify the tracked ADR contains no untracked dump-file references, then run `npx tsc --noEmit`, `npm run test:unit`, and `git diff --check`.

**Phase 7 staging: Remaining full-hydration types + stubs**

ADR-0011 Phase 7 is the type-uniformity closure: every Foundry primary doc type covered by the alignment plan ends up with a `<Type>Store` + (where applicable) `<Type>Repository` implementation against the shared base. Phase 7 lands two groups — full-hydration Stores for the remaining primary types (RollTable, Macro, Playlist, Cards), and stub Stores for the Sheet-Delver-unused types (Scene, FogExploration, Adventure, Setting). After Phase 7 the ADR's exit checklist clears and the status flips from "Proposed" to "Accepted." Phase 7 also tightens four cross-cutting closure items: (a) confirming `modifyDocumentRouter` is the sole inbound dispatch path, (b) confirming `PrimaryDocumentCacheCoordinator` is the sole bootstrap-seed path, (c) renaming the legacy `actorUpdate` wire event to `actorChanged` so every primary doc type uses uniform `<type>Changed` / `<type>ListInvalidated` event names, and (d) extending the `fetchByUuid` world-doc Store short-circuit to the new full-hydration types — so the ADR can ship green.

Lazy-retention dropped: earlier drafts proposed a `LazyPrimaryDocumentStore<T>` subclass for RollTable / Macro / Playlist / Cards on the grounds that they're "rarely touched." That distinction doesn't survive audit — Foundry's `game.data` already ships every primary doc type in full at world bootstrap, so the per-type wire + parse cost is paid regardless. Modeling these four differently from Actor / Item / Journal / Combat introduces an asymmetry without a real saving. Phase 7 makes them all full-hydration like every other Store; the earlier-rejected "bounded retention" tier (ADR Alternatives Considered) also stays rejected. The data-source optimization (seed-from-`gameData` instead of per-type `dispatchDocumentSocket` round trips) is real but out of scope here — it intersects with the deferred CoreSocket connect-handler split and lands after primary-document alignment is complete.

Stub model: stub Stores are near-empty subclasses against `PrimaryDocumentStore<T>` with `documentType` set and a minimal `resolveOwnership` matching the policy matrix: Scene keeps the standard ownership-map policy, FogExploration is a per-user placeholder, and Adventure / Setting fail closed for non-GMs until their semantics are designed. They are **not** registered with `PrimaryDocumentCacheCoordinator` or `modifyDocumentRouter` — the classes exist so the `PrimaryDocumentType` union is complete and a future phase can wire them up with a single line each, but Phase 7 does not exercise their CRUD or events. The point is shape uniformity, not feature work. The four stub types are chosen on the basis of "no in-tree consumer yet" rather than "rarely used": Scene visibility, FogExploration per-user state, Adventure import/export, and Setting key-value semantics each warrant a deliberate design pass when Sheet Delver actually needs them.

Schema notes per the policy matrix in this ADR (no external file references):

- **RollTable** — standard `ownership` map; embedded `RollTableResult` array with mutable `drawn: boolean` state. The embedded handler maintains the result array in place; `drawn` updates flow through as normal embedded `update` events. The SDK's `drawTable` simulator is left as-is — Foundry doesn't expose draw over the modify-document socket so the application performs its own draw, and the simulator's table-fetch leg already goes through `client.fetchByUuid`. After Phase 7 that fetch benefited from the world-doc Store short-circuit for any RollTable that lives in the world's table sidebar; ADR-0016 later moved that branch from `CoreSocket` into `DocumentResolver`. Compendium-only RollTables (not dragged into the sidebar) are not in the Store; ADR-0015 supersedes the original ADR-0011 follow-up note with Pathway B shard lookup and parsed pack-document fallback prep.
- **Macro** — standard `ownership` map. Observed Macro docs carry `name`, `type` (sample: `script`), `_id`, `author` (creator user-id), `img`, `scope` (sample: `global`), `command`, `folder`, `sort`, `ownership`, `flags`, and `_stats` (`coreVersion`, `systemId`, `systemVersion`, created/modified metadata, and `lastModifiedBy`). The `author` field is attribution metadata for projection — it is **not** part of ownership resolution; access is gated through the `ownership` map exactly like every other standard-map type. No embedded children. Macros are admin/GM authoring; player exposure is rare.
- **Playlist** — standard `ownership` map; embedded `PlaylistSound` with `playing` / `pausedTime` / `repeat` playback state. Same in-place-array embedded pattern as RollTable.
- **Cards** — standard `ownership` map. Observed Cards primary docs use `type: "deck" | "hand" | "pile"`, carry `cards[]`, `displayCount`, `folder`, dimensions/rotation where applicable, and standard `flags` / `_stats` / `system`. Embedded `Card` records carry `_id`, `name`, `faces[]` (`name` / `img` / `text`), `face`, `drawn`, `type`, `suit`, `value`, `origin`, `back`, dimensions/rotation, `sort`, `flags`, `system`, and `_stats`. Phase 7 ships an in-place array handler that accepts `Card` create/update/delete events and preserves those fields without modeling game-specific card semantics (Sheet Delver doesn't currently use cards). Cross-Cards-doc transfers (Foundry `Cards#pass` deck→hand→pile) arrive as paired update/delete events across two parent docs; each leg is handled independently by its parent's in-place array handler, so both deck and hand caches stay coherent on change. Phase 7 does not model a transfer as a single coordinated operation — the paired per-parent events are sufficient for cache consistency, and a future round can add a transfer-aware affordance if Sheet Delver ever uses cards.
- **Scene** / **FogExploration** / **Adventure** / **Setting** — stubs only. Scene uses the standard ownership-map policy if/when wired, but is not registered in Phase 7 because canvas/scene visibility needs its own design pass. FogExploration is per-user state (one doc per user), while Adventure import/export and Setting key-value semantics remain GM/admin-tier placeholders. Phase 7 captures the classes; no wiring.

- [X] Add `RollTableStore` + `RollTableRepository` plus a `RollTableDocument` / `RollTableResultDocument` type pair. Implement the embedded `RollTableResult` handler maintaining the `results[]` array with mutable `drawn` state. Full-hydration Store with bootstrap seed via `PrimaryDocumentCacheCoordinator`.
  Files: `src/server/core/documents/primary/roll-tables/RollTableStore.ts`, `src/server/core/documents/primary/roll-tables/RollTableRepository.ts`, `src/server/shared/types/documents.ts`, `src/tests/unit/documents/roll-table-store.test.ts`.
- [X] Add `MacroStore` + `MacroRepository` plus a `MacroDocument` type. No embedded children; `MacroDocument` includes `author` for projection/attribution, but `MacroStore.resolveOwnership` ignores `author` and resolves access from the standard `ownership` map only. Full-hydration with bootstrap seed. `listByAuthor` helper added for projection convenience (subject-filtered so `author` cannot grant read access on its own).
  Files: `src/server/core/documents/primary/macros/MacroStore.ts`, `src/server/core/documents/primary/macros/MacroRepository.ts`, `src/server/shared/types/documents.ts`, `src/tests/unit/documents/macro-store.test.ts`.
- [X] Add `PlaylistStore` + `PlaylistRepository` plus `PlaylistDocument` / `PlaylistSoundDocument` types. Embedded `PlaylistSound` handler maintains the `sounds[]` array with playback state. Full-hydration with bootstrap seed.
  Files: `src/server/core/documents/primary/playlists/PlaylistStore.ts`, `src/server/core/documents/primary/playlists/PlaylistRepository.ts`, `src/server/shared/types/documents.ts`, `src/tests/unit/documents/playlist-store.test.ts`.
- [X] Add `CardsStore` + `CardsRepository` plus `CardsDocument` / `CardDocument` types. Embedded `Card` handler maintains the `cards[]` array for create/update/delete while preserving Foundry card fields (`faces[]`, `face`, `drawn`, `suit`, `value`, `origin`, `back`, dimensions, rotation, sort, flags, system, `_stats`) without adding game-specific semantics. Full-hydration with bootstrap seed.
  Files: `src/server/core/documents/primary/cards/CardsStore.ts`, `src/server/core/documents/primary/cards/CardsRepository.ts`, `src/server/shared/types/documents.ts`, `src/tests/unit/documents/cards-store.test.ts`.
- [X] Register the four new Stores with `PrimaryDocumentCacheCoordinator` (per-type seeders) AND `modifyDocumentRouter` (direct + embedded handlers where applicable). Coordinator seeders use the existing per-type `dispatchDocumentSocket` pattern; consolidating onto `gameData` is a deferred post-alignment refactor that intersects with the CoreSocket connect-handler split.
  Files: `src/server/core/documents/primary/PrimaryDocumentCacheCoordinator.ts`.
- [X] Wire the four new repositories into `createRouteFoundryClient().dispatchDocument(...)` so direct writes for `RollTable`, `Macro`, `Playlist`, and `Cards` and parented writes for `RollTableResult`, `PlaylistSound`, and `Card` mirror through the new Stores instead of falling back to raw `client.dispatchDocument(...)`.
  Files: `src/server/shared/utils/createRouteFoundryClient.ts`.
- [X] Bridge the four Stores' events through `SystemService` as `<type>Changed` / `<type>ListInvalidated` matching the other Store bridges. `AppSocketGateway` fan-out adds per-socket `canReadDocument` filtering on the per-doc events and `targetUserIds` honoring on invalidations. Gateway system-client handler count goes 13 → 21 (4 new types × 2 events each).
  Files: `src/server/core/system/SystemService.ts`, `src/server/realtime/AppSocketGateway.ts`, `src/tests/unit/sockets/app-socket-gateway.test.ts`.
- [X] Add skinny SDK + shared realtime contracts for the four new types (`RealtimeRollTableChangedPayload` / `…ListInvalidatedPayload` and similar for Macro, Playlist, Cards). No browser subscriber is added — no in-tree consumer exists, matching the user/folder/item "decorative until subscribed" pattern.
  Files: `src/shared/contracts/realtime.ts`, `src/shared/sdk/contracts.ts`.
- [X] Add stub Stores for `SceneStore`, `FogExplorationStore`, `AdventureStore`, `SettingStore` — near-empty subclasses against `PrimaryDocumentStore<T>` with `documentType` set and a minimal `resolveOwnership` (standard ownership-map policy for Scene; per-user-id placeholder for FogExploration; GM-only placeholders for Adventure and Setting). **Not** registered with the coordinator or router. The classes exist so the `PrimaryDocumentType` union is complete.
  Files: `src/server/core/documents/primary/scenes/SceneStore.ts`, `src/server/core/documents/primary/fog-explorations/FogExplorationStore.ts`, `src/server/core/documents/primary/adventures/AdventureStore.ts`, `src/server/core/documents/primary/settings/SettingStore.ts`, `src/server/shared/types/documents.ts` (type stubs).
- [X] Confirm `PrimaryDocumentType` union in `src/server/core/documents/primary/base/PrimaryDocumentStore.ts` lists every Foundry primary doc type covered by the matrix (verified — all 15 types present).
  Files: `src/server/core/documents/primary/base/PrimaryDocumentStore.ts`.
- [X] Verify the exit-criteria closure items from earlier phases: (a) `modifyDocumentRouter` is the sole inbound dispatch path — verified at `CoreSocket._routeModifyDocument` (the single `modifyDocument` socket-listener entry calls `modifyDocumentRouter.route(...)`; `ClientSocket` no longer registers a `modifyDocument` listener); (b) `PrimaryDocumentCacheCoordinator.seedAll` is the sole bootstrap-seed path — verified at `SystemService.bootstrap()`'s single `await seedDocumentCache(client)` call (the deprecated wrapper calls `seedAll`); no per-type hardcoded actor-only seeding remains.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts`, `src/server/core/foundry/sockets/ClientSocket.ts`, `src/server/core/system/SystemService.ts`.
- [X] Rename the legacy Phase 1 wire event `actorUpdate` → `actorChanged` so every primary doc type uses uniform `<type>Changed` event names. The `actorListInvalidated` companion already exists, so this is single-event rename. Touch points completed: `SystemService` bridge emit, `AppSocketGateway` system-handler register/unregister + downstream `socket.emit`, browser subscribers (`FoundryContext`, `SDKProvider`, `GenericActorPage`), SDK React helper `onActorUpdate` → `onActorChanged`, `app-socket-gateway` test, exported realtime contract `RealtimeActorUpdatePayload` → `RealtimeActorChangedPayload`, SDK exports, module documentation (`MODULE_MANIFEST.md`), per-system module ActorPages (dnd5e / morkborg / shadowdark), and stale comments in `ActorStore` + `ClientSocket`. No alias retained — clean break.
  Files: `src/server/core/system/SystemService.ts`, `src/server/realtime/AppSocketGateway.ts`, `src/client/ui/context/FoundryContext.tsx`, `src/client/ui/providers/SDKProvider.tsx`, `src/client/ui/pages/GenericActorPage.tsx`, `src/shared/contracts/realtime.ts`, `src/shared/sdk/contracts.ts`, `src/shared/sdk/react.ts`, `src/shared/sdk/index.ts`, `src/modules/MODULE_MANIFEST.md`, `src/tests/unit/sockets/app-socket-gateway.test.ts`, `docs/adr/0012-primary-document-realtime-events.md`.
- [X] Extend the then-existing `CoreSocket.fetchByUuid` world-doc short-circuit to `RollTable`, `Macro`, `Playlist`, `Cards` — mirrors the Actor/Item branches, fails closed with `PrimaryDocumentCacheNotReadyError` if the Store isn't seeded. ADR-0016 later moved this Store-backed UUID behavior into `DocumentResolver`. The original ADR-0011 compendium follow-up is now superseded by ADR-0015's Pathway B shard lookup and parsed pack-document fallback prep.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts`.
- [X] Update stale comments that still describe Macro / Playlist / RollTable / Cards as unrouted. The `_routeModifyDocument` comment in `CoreSocket.ts` now enumerates the full routing surface; only stub types (Scene / FogExploration / Adventure / Setting) and synthetic tokens like `ActorDelta` are in the silent-drop list.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts`.
- [X] Flip the ADR status to **Accepted** in the front matter and tick the two cross-cutting exit-criteria checkboxes after closure verification.
  Files: `docs/adr/0011-primary-document-model.md`.
- [X] Add Phase 7 tests covering seed/clear + per-type ownership policies (standard map; Macro `author` is ignored for visibility but preserved on the raw document; Cards array handling), embedded mutation routing for RollTable / Playlist (`RollTableResult` and `PlaylistSound` array maintenance) and the Cards `Card` embedded handler (including paired cross-Cards-doc transfer events), and a stub-store presence check (exists in the type union, no router/coordinator registration). Router test extended with `RollTableResult` / `PlaylistSound` / `Card` embedded routing cases. Gateway test asserts the 21 handler count.
  Files: `src/tests/unit/documents/roll-table-store.test.ts`, `src/tests/unit/documents/macro-store.test.ts`, `src/tests/unit/documents/playlist-store.test.ts`, `src/tests/unit/documents/cards-store.test.ts`, `src/tests/unit/routing/modify-document-router.test.ts`, `src/tests/unit/run.ts`.
- [X] Verify with `npx tsc --noEmit` and `npm run test:unit`. Both pass.

Non-goals for Phase 7:

- Do not add browser-side context providers or refetch coalescing for the new full-hydration or stub types. There are no in-tree consumers; the wire-event surface is decorative until a real subscriber lands.
- Do not implement SDK helper APIs beyond what the existing `RouteFoundryClient` / `ModuleFoundryClient` already expose. The `drawTable` simulator stays the local-eval path; Macro execution stays on whatever surface it uses today (no `executeMacro` Store method).
- Do not migrate `fetchByUuid` into a full subject-aware Store lookup for every primary type or call site. Phase 7 **does** extend the existing world-doc short-circuit (Actor / Item) to the four new full-hydration types — that change is a cache read, not an authorization change. Phase 7 does **not** introduce subject filtering at the `fetchByUuid` site, does not rework compendium reads, and does not unify the route/module/utility UUID read paths. ADR-0016 later moves the UUID router to `DocumentResolver` while preserving this privilege model.
- Do not introduce a `CompendiumStore` or pack-doc full-hydration cache in Phase 7. Compendium docs aren't primary documents — they have no modify-document write surface, use pack-level `permission` instead of per-doc `ownership`, are namespaced by `Compendium.<vendor>.<pack>.<type>.<id>`, and don't fit the `PrimaryDocumentStore<T>` shape (no Repository, no `applyModifyDocument`, no embedded mutation routing). Full pack hydration is now represented by ADR-0015's module-declared Pathway B shards, and ADR-0016's `DocumentResolver` composes those shards with a parsed pack-document transport fallback. The `drawTable` simulator is unchanged — for world tables it benefits through the Store-backed UUID path; for compendium tables it uses the route/module `fetchByUuid` facade backed by `DocumentResolver`.
- Do not introduce a `LazyPrimaryDocumentStore<T>` subclass or any lazy-retention affordance. The earlier-considered "lazy because rarely-touched" hedge was dropped after `game.data` audit confirmed every primary doc type already ships at bootstrap, so the per-type wire cost is paid regardless. The bounded-retention tier stays rejected for the same reason.
- Do not consolidate bootstrap seeding onto `gameData` (the `CoreSocket.gameDataCache.<key>` shortcut that `UserStore`'s early seed already uses). This is a real optimization but intersects with the deferred CoreSocket connect-handler split and lands as its own post-alignment refactor.
- Do not wire stub Stores (Scene / FogExploration / Adventure / Setting) into bootstrap, routes, or the modifyDocument router. They're shape-uniformity scaffolding only.
- Do not migrate the deferred CoreSocket connect-handler split. Phase 7 may verify the coordinator path is authoritative but does not refactor connect-time orchestration.
- Do not introduce per-type Express routes for any of the new types.

Exit for Phase 7: All four new full-hydration Stores + Repositories exist, are seeded by `PrimaryDocumentCacheCoordinator`, and route through `modifyDocumentRouter`; route-client dispatch for those four types uses the repositories instead of raw primary-document writes; all four stub Stores exist as near-empty subclasses without coordinator or router registration; gateway system-client handler count moves to 21; the legacy `actorUpdate` wire event is renamed to `actorChanged` and every primary doc type uses uniform `<type>Changed` / `<type>ListInvalidated` event names; the then-existing world-doc UUID short-circuit covers RollTable / Macro / Playlist / Cards on top of the existing Actor / Item branches; bootstrap-ready gating waits on the four new Stores' seeds in addition to the existing Stores (same all-or-nothing semantics — `PrimaryDocumentCacheCoordinator.seedAll` already implies this); `modifyDocumentRouter` is verified as the sole inbound dispatch path; `PrimaryDocumentCacheCoordinator.seedAll` is verified as the sole bootstrap seed path; `npx tsc --noEmit` and `npm run test:unit` pass; ADR status flips to **Accepted**. ADR-0016 later moves UUID routing out of sockets and keeps this Store-backed behavior in `DocumentResolver`.

**Phase 7 closure addendum (all four full-hydration Stores + four stubs shipped)**

Phase 7 closure — RollTable + Macro landed in slice 1, Playlist + Cards + the four stubs + the `actorUpdate` rename + closure verification landed in slice 2. ADR-0011 flips to **Accepted**.

Slice 2 (this commit):

- `PlaylistStore` + `PlaylistRepository` with embedded `PlaylistSound` handler (in-place `sounds[]`, mutable `playing` / `pausedTime` / `repeat`).
- `CardsStore` + `CardsRepository` with embedded `Card` handler (in-place `cards[]`). Cross-Cards-doc transfers (`Cards#pass`) arrive as paired update/delete legs on two parents; each leg flows independently through its parent's handler. Covered by the cross-doc test in `cards-store.test.ts`.
- Stub Stores: `SceneStore` (standard ownership-map policy if/when wired), `FogExplorationStore` (per-user-id placeholder), `AdventureStore` + `SettingStore` (GM-only placeholders). All four are near-empty subclasses, **not** registered with the coordinator or router. Their classes exist so the `PrimaryDocumentType` union covers every Foundry primary doc type. The `stub-stores.test.ts` presence test confirms `documentType`, ownership policies, and the silent-drop contract at the router for unrouted stub-type events.
- `PlaylistDocument` / `PlaylistSoundDocument` / `CardsDocument` / `CardDocument` types in `documents.ts`. Stub types (`SceneDocument`, `FogExplorationDocument`, `AdventureDocument`, `SettingDocument`) shipped as minimal interfaces — the actual subsystems are out of scope for this round.
- Coordinator + router registration for Playlist + Cards (direct-type + embedded handlers for `PlaylistSound` and `Card`).
- `SystemService` bridges: `playlistChanged` / `playlistListInvalidated` and `cardsChanged` / `cardsListInvalidated`.
- `AppSocketGateway` per-socket handlers for the four new wire events with `canReadDocument` filtering and `targetUserIds` honoring. Handler count moves 17 → 21.
- `createRouteFoundryClient.dispatchDocument` routes Playlist + Cards direct-type writes and parented writes (`PlaylistSound` via `parentRootType === 'Playlist'`, `Card` via `parentRootType === 'Cards'`).
- The then-existing world-doc UUID short-circuit extended to Playlist + Cards; ADR-0016 later moved UUID routing into `DocumentResolver`.
- Realtime contracts for Playlist + Cards in `realtime.ts` and `sdk/contracts.ts`.
- **`actorUpdate` → `actorChanged` wire-event rename** completed across all touch points: `SystemService` bridge, `AppSocketGateway` handler register/unregister + downstream `socket.emit`, browser subscribers (`FoundryContext`, `SDKProvider`, `GenericActorPage`), SDK React helper `onActorUpdate` → `onActorChanged`, `RealtimeActorUpdatePayload` → `RealtimeActorChangedPayload` (re-exported from `@sheet-delver/sdk`), `app-socket-gateway` test, `MODULE_MANIFEST.md`, per-system module ActorPages (dnd5e / morkborg / shadowdark), and stale comments in `ActorStore` + `ClientSocket`. No alias retained — clean break.
- Closure verification: (a) `modifyDocumentRouter.route()` confirmed as the sole mutation entry — `CoreSocket._routeModifyDocument` is the only handler that calls it from the inbound `modifyDocument` socket listener, and `ClientSocket` no longer registers a `modifyDocument` listener; (b) `PrimaryDocumentCacheCoordinator.seedAll` confirmed as the sole bootstrap-seed path — `SystemService.bootstrap()` calls `seedDocumentCache` (deprecated wrapper around `seedAll`) once and has no per-type fallback.
- Router test extended with `runRollTableResultEmbeddedRouting`, `runPlaylistSoundEmbeddedRouting`, and `runCardEmbeddedRouting` (the last covers the paired cross-Cards-doc transfer pattern).
- Gateway test asserts `attachedHandlers === 3` (foundryClient lifecycle/shared-content only) and `systemAttachedHandlers === 21` post-Phase 7.
- `npx tsc --noEmit` and `npm run test:unit` pass.

ADR status: **Accepted** (front matter updated, exit-criteria checklist all green).

---

**Phase 7 partial-completion addendum (RollTable + Macro implemented)**

Shipping Phase 7 in two slices for session-size reasons. This slice lands RollTable + Macro (full-hydration Stores + Repositories) and the cross-cutting infrastructure that needs touching once per type. Playlist + Cards + the four stubs + the `actorUpdate` rename + closure verification remain pending for the next slice.

Done in this slice:

- `RollTableStore` + `RollTableRepository` with embedded `RollTableResult` handler (in-place `results[]` array, mutable `drawn` state). Subject-scoped `listByFolderIds` helper for folder-organized projections.
- `MacroStore` + `MacroRepository` with no embedded children. `author` carried on `MacroDocument` for attribution only; `resolveOwnership` reads the standard `ownership` map exclusively. `listByAuthor` helper is subject-filtered so `author` cannot grant read access on its own.
- `RollTableDocument` / `RollTableResultDocument` / `MacroDocument` types added to `src/server/shared/types/documents.ts`.
- Both Stores registered with `PrimaryDocumentCacheCoordinator` for bootstrap seed (per-type `dispatchDocumentSocket('<type>', 'get')` pattern, same as every other Store).
- Both Stores registered with `modifyDocumentRouter` for direct-type events; `RollTable` registered as an embedded-handler parent for `RollTableResult` events with `parentUuid: RollTable.<id>`.
- `SystemService` bridges both Stores as `rollTableChanged` / `rollTableListInvalidated` and `macroChanged` / `macroListInvalidated`.
- `AppSocketGateway` per-socket handlers added for the four new wire events with `canReadDocument` filtering on per-doc events (LIST_VISIBLE) and `targetUserIds` honoring on invalidations. System-client handler count moves 13 → 17 (gateway test asserts the new count).
- `createRouteFoundryClient.dispatchDocument` routes `RollTable` / `Macro` direct-type writes through the repositories, and `parent.type` starting with `RollTable` routes `RollTableResult` parented writes through `RollTableRepository`.
- The then-existing world-doc UUID short-circuit extended to `RollTable` and `Macro` (fail-closed with `PrimaryDocumentCacheNotReadyError` if the Store isn't seeded yet; mirrors the Actor/Item branches). ADR-0016 later moved UUID routing into `DocumentResolver`. The compendium follow-up called out in ADR-0011 is now owned by ADR-0015's Pathway B shard lookup and parsed pack-document fallback prep.
- `_routeModifyDocument` comment in `CoreSocket` updated — RollTable / RollTableResult / Macro are no longer in the "drops silently" list; remaining silent-drops are ActorDelta / Playlist / Cards.
- Skinny realtime contracts added in `src/shared/contracts/realtime.ts` and `src/shared/sdk/contracts.ts` for both types.
- Unit tests: `src/tests/unit/documents/roll-table-store.test.ts` (seed/clone, ownership, folder filter, embedded `RollTableResult` routing including the idempotent re-apply case, repository write-mirror) and `src/tests/unit/documents/macro-store.test.ts` (seed/clone, ownership policy + the `author-is-not-policy` assertion proving `author` doesn't grant access, `listByAuthor` + `listByFolderIds`, repository write-mirror). Both wired into `src/tests/unit/run.ts`. `app-socket-gateway` test updated to expect 17 handlers.
- `npx tsc --noEmit` and `npm run test:unit` pass.

Remaining for the next slice:

- `PlaylistStore` + `PlaylistRepository` (`PlaylistSound` embedded handler).
- `CardsStore` + `CardsRepository` (`Card` in-place array handler).
- Stub Stores for `SceneStore` / `FogExplorationStore` / `AdventureStore` / `SettingStore` (near-empty subclasses, not registered with coordinator or router).
- Coordinator + router registration for Playlist + Cards (direct + embedded).
- `SystemService` bridges + `AppSocketGateway` handlers for Playlist + Cards (gateway count moves 17 → 21).
- Realtime contracts for Playlist + Cards.
- `createRouteFoundryClient` direct + parent-aware routing for Playlist + Cards.
- `fetchByUuid` world-doc short-circuit extended to Playlist + Cards.
- `_routeModifyDocument` comment updated to remove Playlist + Cards from the silent-drops list.
- `actorUpdate` → `actorChanged` rename (single-event rename; `actorListInvalidated` already exists). Cross-cutting touch points already enumerated in the staged checklist item.
- Closure verification: `modifyDocumentRouter` sole inbound dispatch path; `PrimaryDocumentCacheCoordinator.seedAll` sole bootstrap-seed path.
- Unit tests for Playlist + Cards + stub-store presence check; router test updated for the new embedded parent types.
- ADR status flip to **Accepted** + two cross-cutting exit-criteria checkboxes ticked.

---

**Phase 8 amendment: primary-document socket boundary enforcement**

ADR-0011's repository/store rule is stronger than the current implementation: primary-document callers should not target `CoreSocket` or `ClientSocket` type-specific helper methods for either reads or writes. Sockets remain the low-level Foundry transport because Foundry permission checks require the acting user/session on outbound `modifyDocument` writes. They should not own primary-document semantics, even when a helper is only a transient relay to `systemService` or a Store-backed read.

The intended boundary is:

```text
Route / SDK / service facade
  -> RouteFoundryClient or ModuleFoundryClient
  -> <Type>Repository
  -> DocumentTransport
  -> socket.dispatchDocument(...) as transport only
  -> Foundry modifyDocument
  -> <Type>Store mirror + inbound modifyDocument idempotency
```

The anti-pattern Phase 8 removes is:

```text
Route / SDK / service facade
  -> client.getActor(...) / client.updateActor(...) / client.createActor(...)
  -> socket-owned primary-document helper
```

Gaps found by the Phase 8 socket audit before implementation:

- `ClientSocket` still exposes actor-shaped read/write helpers (`getActors`, `getActor`, `getActorRaw`, `createActor`, `updateActor`, `deleteActor`, `createActorItem`, `updateActorItem`, `deleteActorItem`). Some are direct user-socket dispatches; some proxy to `CoreSocket` or `systemService`. All forms leak primary-document ownership back into the socket layer.
- `CoreSocket` still exposes the same actor-shaped read/write helpers. Some are already Store-backed, which is behaviorally correct, but the socket surface is still wrong; these should be route/system facade responsibilities over `ActorStore` / `ActorRepository`.
- `ClientSocket.getChatLog(...)` and `CoreSocket.getChatLog(...)` are ChatMessage-shaped read helpers. `ChatService.getChatLog(...)` is Store-backed when `ChatMessageStore` is ready, but its cold-cache fallback still calls the socket helper. That fallback keeps a primary-document read surface alive on the sockets.
- `ClientSocket.roll(...)` / `CoreSocket.roll(...)` and `ClientSocket.useItem(...)` / `CoreSocket.useItem(...)` are not raw CRUD helpers after the Phase 1 chat write cleanup, but they still keep chat/actor domain semantics on the socket classes. `roll` creates `ChatMessage` documents through `ChatMessageRepository`; `useItem` reads an Actor and creates a `ChatMessage`. They should move behind route/module service facades or be explicitly documented as a non-primary-document exception if retained.
- `createRouteFoundryClient.updateActor(...)` still calls `client.updateActor(...)` to preserve the adapter `validateUpdate` path, then manually mirrors into `ActorStore`. That validation policy should move outside the socket and the write should mirror through `ActorRepository`.
- Socket-facing TypeScript interfaces still advertise actor read/write methods, allowing new call sites to compile against the old shape.

Allowed socket surface after Phase 8:

- `dispatchDocument(type, action, operation, parent?)` as the generic request-scoped `DocumentTransport` entry point.
- User-scoped `ClientSocket.dispatchDocument(...)` must fail closed when the user's Foundry socket is unavailable. It must never fall back to `CoreSocket` / the system account. System-account writes are allowed only when the caller was explicitly given a system route client (for example the service-token path), not as an implicit fallback from a user client.
- `dispatchDocumentSocket(...)` only for CoreSocket-owned low-level Foundry transport internals and cache-coordinator/bootstrap seeders that intentionally perform raw `get` operations. It must not be the public route/module primary-document CRUD facade.
- No actor-shaped socket read helpers (`getActors`, `getActor`, `getActorRaw`) or write helpers (`createActor`, `updateActor`, `deleteActor`, actor item CRUD). Route/module/service reads go through Store-backed facades; writes go through Repositories.
- No ChatMessage-shaped socket read helper (`getChatLog`). Chat reads go through `ChatService` / `ChatMessageStore`, with any cold-cache behavior owned by the service/facade layer rather than sockets.
- Non-primary-document transport concerns such as session lifecycle, world lifecycle, compendium fetches, setup/admin flows, and explicit subsystem exceptions documented outside ADR-0011.

Phase 8 action items:

- [x] Add `ActorRepository.updateActor(actorId, updates)` so all Actor CRUD has repository-owned create/update/delete parity.
  Files: `src/server/core/documents/primary/actors/ActorRepository.ts`, `src/tests/unit/actors/actor-store.test.ts` or a dedicated repository test.
- [x] Verify `createRouteFoundryClient.getActors/getActor/getActorRaw` remain Store-backed and become the only route-facing Actor read surface. Any route/debug/service call currently reaching through `session.client.getActor(...)` or socket actor getters should move to the route-client facade or directly to the appropriate Store-backed service boundary.
  Files: `src/server/shared/utils/createRouteFoundryClient.ts`, `src/server/services/debug/DebugService.ts`, `src/server/services/actors/ActorService.ts`, `src/server/services/combats/CombatService.ts`.
- [x] Move adapter `validateUpdate` filtering out of `ClientSocket.updateActor`. The validation can live in a small Actor write-policy helper or in `createRouteFoundryClient.updateActor(...)` immediately before calling `ActorRepository.updateActor(...)`; the socket must not own the policy.
  Files: `src/server/shared/utils/createRouteFoundryClient.ts`, `src/server/core/foundry/sockets/ClientSocket.ts`, actor service tests if touched.
- [x] Change `createRouteFoundryClient.createActor/updateActor/deleteActor` and actor embedded item helpers to call `ActorRepository` exclusively. `updateActor` must no longer call `client.updateActor(...)` or manually mirror into `ActorStore`.
  Files: `src/server/shared/utils/createRouteFoundryClient.ts`, `src/server/core/documents/primary/actors/ActorRepository.ts`.
- [x] Remove `getChatLog` from `ClientSocket` and `CoreSocket`. `ChatService.getChatLog(...)` should keep the Store-backed path and either fail closed while `ChatMessageStore` is cold or perform any explicit cold-cache fallback through a repository/service-owned facade, not a socket-shaped `ChatMessage` helper.
  Files: `src/server/core/foundry/sockets/ClientSocket.ts`, `src/server/core/foundry/sockets/CoreSocket.ts`, `src/server/services/chat/ChatService.ts`, `src/server/shared/utils/createRouteFoundryClient.ts`, `src/server/shared/types/documents.ts`.
- [x] Move `roll` / `useItem` route-module behavior off socket classes or explicitly document a narrower non-primary-document exception. The replacement path should use Store-backed Actor reads and `ChatMessageRepository` for chat creation without calling socket actor/chat helpers.
  Files: `src/server/core/foundry/sockets/ClientSocket.ts`, `src/server/core/foundry/sockets/CoreSocket.ts`, `src/server/services/chat/ChatService.ts`, `src/server/services/actors/ActorService.ts`, `src/server/services/combats/CombatService.ts`, `src/server/shared/utils/createRouteFoundryClient.ts`, `src/server/shared/utils/createModuleFoundryClient.ts`.
- [x] Enforce fail-closed user transport: `ClientSocket.dispatchDocument(...)` throws when the user socket is unavailable and has no CoreSocket fallback. Add regression coverage that a disconnected user client does not call `systemService.getSystemClient().dispatchDocument(...)`.
  Files: `src/server/core/foundry/sockets/ClientSocket.ts`, `src/tests/unit/sockets/client-socket-transport.test.ts`.
- [x] Remove the unauthenticated module API fallback to the system route client. Module API requests without an authenticated Foundry route client now return 401 instead of receiving `CoreSocket` as an implicit fallback.
  Files: `src/server/services/modules/ModuleProxyService.ts`, `src/server/routes/modules/createModuleRouter.ts`, `src/server/app/registerRoutes.ts`.
- [x] Remove type-specific Actor read/write helpers from `ClientSocket` and `CoreSocket`: `getActors`, `getActor`, `getActorRaw`, `createActor`, `updateActor`, `deleteActor`, `createActorItem`, `updateActorItem`, `deleteActorItem`.
  Files: `src/server/core/foundry/sockets/ClientSocket.ts`, `src/server/core/foundry/sockets/CoreSocket.ts`.
- [x] Remove actor read/write methods from socket-facing interfaces/types so TypeScript prevents new socket-owned primary-document call sites. Route/service-facing actor methods remain on `ActorServiceClientLike`; that type represents the route-client facade, not the socket surface.
  Files: `src/server/core/foundry/interfaces.ts`, `src/server/shared/types/documents.ts`, route-client types verified as facade-only.
- [x] Keep `createModuleFoundryClient`'s public Actor SDK shape intact, but ensure each method delegates to the repository-backed route client rather than socket helper methods.
  Files: `src/server/shared/utils/createModuleFoundryClient.ts`, `src/server/shared/utils/createRouteFoundryClient.ts`.
- [x] Add regression coverage proving route/module Actor reads and writes work with a fake client that exposes generic `dispatchDocument` but no type-specific actor helper methods.
  Files: `src/tests/unit/actors/actor-store.test.ts`.
- [x] Update or retire socket-specific legacy tests that directly exercise actor-shaped socket helpers. The replacement assertions should target route/module facades and the repository/store path; low-level socket tests may cover only generic transport.
  Files: active `src/tests/socket/*.test.ts` callers now use route clients; deprecated socket tests remain excluded from active verification.
- [x] Add a source-audit check to the Phase 8 verification notes: no live code outside repository/transport/bootstrap internals calls socket-owned primary-document read/write helpers, and no `ClientSocket`/`CoreSocket` actor helper methods remain.

Phase 8 completion notes:

- `ClientSocket` and `CoreSocket` no longer expose Actor helper methods, `getChatLog`, `roll`, or `useItem`; sockets retain only generic transport (`dispatchDocument` / `dispatchDocumentSocket`) plus non-primary-document metadata/session utilities.
- `createRouteFoundryClient` now owns Actor Store reads, Actor Repository writes, adapter `validateUpdate` filtering, route-scoped `roll`, and `useItem`. `roll` / `useItem` create chat output through `ChatMessageRepository` and read Actors through the Store-backed route facade.
- `ChatService.getChatLog(...)` now fails closed with `PrimaryDocumentCacheNotReadyError('ChatMessage')` while `ChatMessageStore` is cold instead of falling back to a socket chat-log helper.
- `DebugService` and socket integration tests now wrap raw sessions/sockets in route clients before using Actor facades. Unit coverage in `src/tests/unit/actors/actor-store.test.ts` verifies route-client reads and writes with a fake transport that has generic `dispatchDocument` but no type-specific Actor socket helpers.
- Source audit: no `ClientSocket` / `CoreSocket` definitions remain for `getActors`, `getActor`, `getActorRaw`, `createActor`, `updateActor`, `deleteActor`, `createActorItem`, `updateActorItem`, `deleteActorItem`, `getChatLog`, `roll`, `useItem`, or `rollTable`; no live non-deprecated code calls `systemService.getSystemClient()` for those removed helpers.

Non-goals for Phase 8:

- Do not remove socket transport. Foundry writes still flow over an authenticated socket; the change is who owns the primary-document abstraction.
- Do not treat generic `fetchByUuid(uuid)` as the same fault merely because it can return primary documents. It is a cross-type utility with its own deferred authorization/compendium design noted in Phase 7; Phase 8 targets type-shaped socket helpers and domain helpers that embed primary-document semantics.
- Do not change Actor ownership or visibility semantics. ADR-0013 remains unchanged unless a later implementation changes the authorization policy itself.
- Do not change ADR-0012's realtime event contract. Store events, gateway fan-out, and `modifyDocumentRouter` behavior remain as accepted.
- Do not tackle the deferred CoreSocket connect-handler split or the bootstrap seed-from-`gameData` optimization. Those remain separate post-alignment refactors.

Exit for Phase 8: route/module/service Actor and ChatMessage reads go through Store-backed facades, and primary-document writes reach Foundry only through the matching Repository + request-scoped `DocumentTransport`; user-scoped `ClientSocket.dispatchDocument(...)` fails closed when the user socket is unavailable and never falls back to the system account; `ClientSocket` and `CoreSocket` no longer expose actor-shaped or chat-log-shaped primary-document helper methods; socket-facing interfaces no longer advertise those helpers; adapter update validation lives outside the socket layer; `roll` / `useItem` no longer keep primary-document domain semantics on socket classes unless a narrower exception is explicitly documented; source audit confirms no primary-document read/write caller targets socket helper methods; `npx tsc --noEmit` and `npm run test:unit` pass.

---

## Exit Criteria

This ADR is fulfilled when every Foundry primary doc type covered by the alignment plan has its `<Type>Store` + `<Type>Repository` implementation against the shared base — including stubs for the types Sheet Delver doesn't currently use. Phase 8 is a post-acceptance enforcement amendment with its own exit criteria above; it does not reopen the Phase 1-7 acceptance checklist.

- [X] Phase 1: Base abstractions + `ChatMessageStore` + `ChatMessageRepository`. `ActorStore` / `ActorRepository` lifted onto the base.
- [X] Phase 2: `UserStore` + `UserRepository`. `userMap` / `gameDataCache.users` consolidate.
- [X] Phase 3: `FolderStore` + `FolderRepository`.
- [X] Phase 4: `JournalStore` + `JournalRepository` with two-level ownership.
- [X] Phase 5: `CombatStore` + `CombatRepository` with cross-store visibility.
- [X] Phase 6: `ItemStore` + `ItemRepository` (world-level).
- [X] Phase 7: `RollTableStore` / `MacroStore` / `PlaylistStore` / `CardsStore` (full hydration) + `SceneStore` / `FogExplorationStore` / `AdventureStore` / `SettingStore` (stubs).
- [X] `modifyDocumentRouter` replaces per-type switches in `CoreSocket` and removes the duplicate relay in `ClientSocket`.
- [X] `PrimaryDocumentCacheCoordinator` replaces the hardcoded actor-only seeding path in `SystemService.bootstrap()`.
- [X] Each phase's exit criteria verified before proceeding to the next.
- [X] Status flipped to **Accepted** when Phase 7 ships green.
