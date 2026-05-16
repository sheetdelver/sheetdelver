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

- **Ownership.** Actor / Item / RollTable / Macro / Playlist / Scene / JournalEntry use the standard `{ default, userId }` map. ChatMessage uses `whisper` + `blind` + `author`. Combat derives from combatants. User has none (users are subjects, not targets). Folder uses Foundry's `permission` map; when the map or a key is omitted, the effective permission is `NONE`.
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
- **Scattered patterns consolidate.** `userMap` + `gameDataCache.users` → `UserStore`. Dual broadcast emit points → single `modifyDocumentRouter`. Inline folder pruning → `FolderStore` consumed by folder-aware Stores through each document's `folder` id. Authorization helpers per service → `Store.canReadDocument`. Each migration phase closes one or more of these silos as a side effect.

### Tradeoffs

- **More files per type.** Three files per subsystem (Store, Repository, document-events) plus optional test files. For minimal types (Macro, Playlist, Cards, stubs) this is mostly boilerplate. The cost is real but bounded.
- **A learning curve for the abstraction.** Future contributors need to understand the base/subclass split and where policy lives versus protocol. This ADR (and the related event/ownership ADRs to follow) is the mitigation; subclasses themselves should be small enough to read alongside the base for orientation.
- **One additional dispatch layer in the hot path.** Reads go through `Store.get` instead of a direct cache map lookup. This is microseconds — not measurable in normal use — but worth noting.
- **Cross-store dependencies must be declared.** `CombatStore` needs `ActorStore` for combatant visibility; folder-aware Stores consume `FolderStore` for folder-organized list views by joining from their own `folder` field. These dependencies need explicit wiring at module-init time. The plan documents which Stores depend on which.

---

## Per-Type Policy Matrix

Captured here for durability (not in working planning docs). Subclass implementations encode each row.

| Type | Ownership policy | Embedded children | Cross-store deps | Retention |
|---|---|---|---|---|
| Actor | `ownership` map (standard) | `Item`, `ActiveEffect` | `UserStore` (subject role) | Full + bootstrap seed |
| ChatMessage | `whisper[]` + `blind` + `author` (no ownership map) | none | `UserStore` | Full + bootstrap seed |
| User | None — users are subjects, not targets | none | none | Full + bootstrap seed |
| Folder | `permission` map; omitted map/key means effective `NONE` | none | none | Full + bootstrap seed |
| JournalEntry | `ownership` map at entry level AND per-page | `JournalEntryPage` (each has own ownership map) | `FolderStore` (folder ancestry/permission where applicable) | Full + bootstrap seed |
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

**Phase 1 verification addendum (May 15, 2026):**

- `npx tsc --noEmit` passed.
- `npm run test:unit` passed when rerun outside the sandbox; the sandboxed run failed before tests started because `tsx` could not open its IPC pipe.
- Structural Phase 1 pieces are present: base Store/Repository abstractions, `modifyDocumentRouter`, cache coordinator, `ChatMessageStore` / `ChatMessageRepository`, and `ActorStore` / `ActorRepository` lifted onto the base.
- [x] Fix blind-message visibility ordering in `ChatMessageStore.resolveOwnership`: `blind: true` must restrict visibility to author + GMs before whisper recipients are considered.
- [x] Align browser realtime listeners with the new server events. Server-side Phase 1 emits `chatMessageChanged` / `chatMessageListInvalidated`; `ChatContext` now listens for those events while retaining the legacy `chatUpdate` listener for compatibility.
- [x] Complete chat write-path migration onto `ChatMessageRepository`: `ChatService.sendChatMessage()` no longer uses `client.sendMessage()` for writes, and slash-roll output is created through request-scoped `ChatMessage` document dispatch after local roll evaluation.
- [x] Preserve the route-facing chat DTO projection when reads come from `ChatMessageStore`. Store-backed reads now project raw messages into enriched fields such as `user`, `isRoll`, `rollTotal`, and `rollFormula`.

**Phase 1 addendum 2: remove socket-owned chat writes**

Phase 1 still has a legacy socket-owned `sendMessage` surface on `CoreSocket` and `ClientSocket`. That surface should be removed now that `ChatMessageRepository` exists. Primary document writes must flow through the primary-document repository framework; raw `modifyDocument` dispatch should remain behind `PrimaryDocumentRepository` / `DocumentTransport`, not at service, module facade, or socket helper call sites.

This addendum is about the internal server route client (`RouteFoundryClient`, built by `src/server/shared/utils/createRouteFoundryClient.ts`), not the public module SDK API. The public SDK can keep `sendMessage(data, options?)`; its implementation should delegate to the internal repository-backed helper.

- [x] Add a repository-backed internal route-client chat helper, e.g. `createChatMessage(data)`, implemented by `createRouteFoundryClient()` with `ChatMessageRepository.send(data)`.
  Files: `src/server/shared/types/documents.ts`, `src/server/shared/types/requestContext.ts` if needed, `src/server/shared/utils/createRouteFoundryClient.ts`, `src/server/core/documents/primary/chat-messages/ChatMessageRepository.ts` if the repository surface needs a small adjustment, `src/server/core/documents/primary/chat-messages/chatMessagePayload.ts`.
- [x] Update `ChatService.sendChatMessage()` to call the repository-backed helper for both plain chat and slash-roll chat output. It should not call `client.sendMessage()` and should not issue raw `dispatchDocument('ChatMessage', ...)` itself.
  Files: `src/server/services/chat/ChatService.ts`, `src/tests/unit/chat-service.test.ts`.
- [x] Keep the public module SDK `sendMessage(data, options?)` facade for compatibility, but reimplement `createModuleFoundryClient().sendMessage` through the repository-backed route-client helper.
  Files: `src/server/shared/utils/createModuleFoundryClient.ts`, `src/shared/sdk/contracts.ts` only if docs/comments need clarification, `src/tests/unit/sdk-integrity.test.ts`.
- [x] Replace `CoreSocket.roll()` fallback chat creation and `CoreSocket.useItem()` chat creation with repository-backed chat creation, or move those flows behind route/module service helpers that already use `ChatMessageRepository`.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts` plus any route/service wrapper introduced for the replacement.
- [x] Remove `CoreSocket.sendMessage()` and `ClientSocket.sendMessage()` after all callers are migrated.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts`, `src/server/core/foundry/sockets/ClientSocket.ts`.
- [x] Remove `sendMessage` from internal socket/client interfaces and route-client type requirements; update unit mocks and socket probes accordingly.
  Files: `src/server/core/foundry/interfaces.ts`, `src/server/shared/types/documents.ts`, `src/server/shared/types/requestContext.ts` if touched, `src/tests/unit/*.test.ts`.
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
  Files: `src/tests/unit/user-store.test.ts`, `src/tests/unit/run.ts`, plus focused updates to route-client/realtime tests.

Non-goals for Phase 2:

- `sceneDataCache` and non-document world metadata remain on `CoreSocket`; broader world-state consolidation is outside this phase.
- Full ADR-0012 wire-event rename remains outside this phase unless needed for user events.
- User documents have no embedded children and no ownership map; visibility policy is the ADR-0013 user policy: authenticated users can observe the roster, GMs are owners.

Exit for Phase 2: `UserStore` / `UserRepository` exist, user document mutations route through the primary-document framework, role/subject lookup reads from `UserStore`, duplicate user state is no longer authoritative, and `npx tsc --noEmit` plus `npm run test:unit` pass.

**Phase 2 verification addendum (May 15, 2026):**

- `npx tsc --noEmit` passed.
- `npm run test:unit` passed when rerun outside the sandbox; the sandboxed run failed before tests started because `tsx` could not open its IPC pipe.
- Structural Phase 2 pieces are present: `UserStore`, `UserRepository`, `RawUser`, coordinator registration, modifyDocument router registration, `userChanged` / `userListInvalidated` bridge events, user presence separated from User document fields, and unit coverage in `user-store.test.ts`.
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
  Files: `src/tests/socket/04-users-compendia.test.ts`, `src/tests/socket/07-user-status.test.ts`, `src/tests/unit/*.test.ts`.
- [x] Verify the cleanup with `rg "\.getUser\(|\.getUsers\(|getUser\(|getUsers\(" src/server -g "*.ts"`, `npx tsc --noEmit`, and `npm run test:unit`.

Closure verification (May 16, 2026): Store-backed user helpers now own role lookup, presence-composed rosters, and GM recipient lookup. `UserPresence` owns runtime `active` state outside User documents. Exact cleanup grep finds no `getUser()` / `getUsers()` call sites under `src/server` or `src`. `npx tsc --noEmit` passed. `npm run test:unit` passed when rerun outside the sandbox; the sandboxed run failed before tests started because `tsx` could not open its IPC pipe.

**Phase 3 staging: FolderStore + FolderRepository**

ADR-0011 Phase 3 promotes Foundry `Folder` documents into the primary-document framework. `FolderStore` models the folder tree itself, not the primary documents that happen to be nested under it. Its core helpers should be generic over folder ids and ancestry; Foundry's Folder `type` is metadata for optional filtering, not a reason for FolderStore to understand Actor, JournalEntry, Item, or any other document payload. JournalService is the first existing call site to migrate because it currently owns inline folder ancestry pruning, not because Journals are the only folder-aware document type.

Foundry Folder schema assumptions for this phase: core fields include `_id`, `name`, `type`, `parent`, `sort`, `color`, `flags`, optional `children`, optional `private`, optional `img`, and optional `permission`. `permission` is a map keyed by user id or role id when explicit permissions are set; if Foundry omits the map or a key because nothing is explicitly set, `FolderStore` should normalize that absence to effective `NONE`. `type` identifies the contained collection (`Actor`, `Item`, `JournalEntry`, `Scene`, `RollTable`, `Card`, `Playlist`, `Macro`, `Compendium`, etc.) but does not make FolderStore responsible for validating contained document schemas. Current Sheet Delver DTOs may still expose a `folder` parent alias; Phase 3 should normalize that to `parent` at the Store/type boundary.

Observed v13 dump note: folderable primary documents carry their own `folder` id and join to the Folder collection from the document side. In `game-data-dump-example-02.json`, `actors`, `items`, `journal`, `tables`, `macros`, `playlists`, and `scenes` all expose a `folder` field, with non-null examples for all except playlists in that sample. FolderStore therefore owns folder docs/tree/type metadata only; it must not maintain child document collections or store nested primary document payloads.

Scope:

- [x] Add `FolderStore` and `FolderRepository` under `src/server/core/documents/primary/folders/`, plus a RawFolder type that reflects Foundry's Folder schema and normalizes legacy/local parent aliases.
  Files: `src/server/core/documents/primary/folders/FolderStore.ts`, `src/server/core/documents/primary/folders/FolderRepository.ts`, `src/server/shared/types/documents.ts` or `src/server/shared/types/folders.ts`.
- [x] Register `FolderStore` with `PrimaryDocumentCacheCoordinator` and `modifyDocumentRouter`; seed from Foundry's `Folder` documents at bootstrap.
  Files: `src/server/core/documents/primary/PrimaryDocumentCacheCoordinator.ts`.
- [x] Model Folder read helpers around the folder tree itself: list folders, optionally filter by Folder `type`, lookup by id, traverse ancestors/descendants using `parent`, resolve permission/visibility with omitted maps/keys defaulting to `NONE`, and return the folder ids required to display a visible tree. These helpers should not inspect or depend on the document type nested under the folder.
  Files: `src/server/core/documents/primary/folders/FolderStore.ts`, `src/server/services/journals/JournalService.ts`.
- [x] Implement Folder permission resolution. Direct folder `permission` wins; omitted map/key normalizes to effective `NONE`. Only an explicit inherited permission value, if present in the Foundry payload/version, walks `parent` ancestry with a cycle guard and fail-closed behavior for missing parents.
  Files: `src/server/core/documents/primary/folders/FolderStore.ts`, `src/tests/unit/folder-store.test.ts`.
- [x] Move JournalService's inline folder ancestry pruning to `FolderStore` helpers while keeping `JournalEntry` reads/writes on the existing path until Phase 4.
  Files: `src/server/services/journals/JournalService.ts`, `src/tests/unit/journal-smoke.test.ts`.
- [x] Route Folder create/update/delete through `FolderRepository` for existing Journal route flows where `type === 'Folder'`; leave `JournalEntry` mutation responsibility unchanged until Phase 4.
  Files: `src/server/services/journals/JournalService.ts`, `src/server/shared/utils/createRouteFoundryClient.ts`, `src/server/shared/types/documents.ts`.
- [x] Remove socket/client-owned Folder reads once callers are migrated.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts`, `src/server/core/foundry/sockets/ClientSocket.ts`, `src/server/shared/utils/createRouteFoundryClient.ts`, `src/server/shared/types/documents.ts`, `src/tests/unit/*.test.ts`.
- [x] Update socket probes or legacy tests that still exercise `client.getFolders()` so they verify the Store-backed Folder path instead.
  Files: `src/tests/deprecated/socket-legacy/06-journals.test.ts`, `src/tests/unit/journal-smoke.test.ts`.
- [x] Add Phase 3 tests covering seed/clear, schema normalization, type filtering, permission resolution, default-`NONE` normalization, explicit inheritance if present, tree mutation, router application, repository writes, JournalService folder pruning, and removal of socket-owned Folder reads.
  Files: `src/tests/unit/folder-store.test.ts`, `src/tests/unit/modify-document-router.test.ts`, `src/tests/unit/journal-smoke.test.ts`, `src/tests/unit/run.ts`.

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
- Structural Phase 3 pieces are present: `FolderStore`, `FolderRepository`, `RawFolder` schema expansion, coordinator seeding, modifyDocument router registration, `folderChanged` / `folderListInvalidated` bridge events, JournalService folder pruning through `FolderStore`, and Folder create/update/delete through `FolderRepository`.

**Phase 2/3 audit addendum (May 16, 2026): wire-event surface for User and Folder is emit-only**

Audit of the Phase 2 and Phase 3 work surfaced one shared gap and a few smaller observations. The User/Folder Store-to-systemClient bridges are in place, but no consumer subscribes to the new wire events, so they are decorative until a downstream subscriber is added. Browsers keep seeing user-presence transitions through the broader `systemStatusUpdate` rebroadcast (driven by `userConnected` / `userDisconnected` / `userActivity`), and they pick up roster/folder snapshots from REST refetch and from the `systemStatus` payload — but a bare User document mutation (rename, color, role change) or a bare Folder mutation (rename, move, permission change) does not currently push through any realtime path. This is consistent with the Phase 2 / Phase 3 staging "Full ADR-0012 wire-event rename remains outside this phase" language, but the wire surface is wired up partway and worth tracking explicitly.

- [x] Wire `userChanged` / `userListInvalidated` fan-out in `AppSocketGateway` alongside the existing `chatMessageChanged` subscription, with per-socket subject resolution and `targetUserIds` filtering for invalidations.
  Files: `src/server/realtime/AppSocketGateway.ts`, `src/tests/unit/app-socket-gateway.test.ts` (system-handler count assertion now 7).
- [x] Wire `folderChanged` / `folderListInvalidated` fan-out in `AppSocketGateway`. Folder reads have no per-user ownership map today, so the gate is world-broadcast to authenticated sockets pending Phase 4 / future folder visibility policy; `targetUserIds` is still honored if a future emit populates it.
  Files: `src/server/realtime/AppSocketGateway.ts`, `src/tests/unit/app-socket-gateway.test.ts`.
- [x] Add a client-side subscriber for `userChanged` / `userListInvalidated` so user roster/role/color changes refresh without waiting for a `systemStatus` broadcast. Implemented as an in-flight-coalesced `/api/status` refetch that updates the `users` slice only.
  Files: `src/client/ui/context/FoundryContext.tsx`.
- [x] Add a client-side subscriber for `folderChanged` / `folderListInvalidated` so folder rename/move/permission updates refresh the journal/folder view without manual reload. Implemented with the same in-flight-coalesce + 75 ms debounce shape used by `ChatContext`.
  Files: `src/client/ui/context/JournalProvider.tsx`.
- [x] Confirm `documentListInvalidated` ownership-change diffs on `UserStore` populate `targetUserIds` where applicable. Result: User docs carry no `ownership` field, so the base `diffOwnershipAndEmitInvalidation` and `usersWithEffectiveVisibility` always produce `undefined` for User events; `userListInvalidated` is always broadcast-wide. Documented on the `UserStore` class header.
  Files: `src/server/core/documents/primary/users/UserStore.ts`.

Closure verification (May 16, 2026): `npx tsc --noEmit` passed. `npm run test:unit` passed (`unit test suite passed`), with the updated `app-socket-gateway.test.ts` assertion against 7 system handlers / 5 foundry handlers reflecting the new user + folder bridge wiring.

Secondary audit notes (no action required for Phase 2/3, but worth recording for Phase 4 and beyond):

- `FolderStore.canReadDocument()` permission resolution (direct id, role id, default, `INHERIT` with cycle guard, missing-parent fail-closed) is implemented and covered by `folder-store.test.ts`, but no production read path calls it. `JournalService.listJournals()` derives "visible folders" from the ancestry of visible JournalEntries, not from `folderStore.canReadDocument()`. That matches Phase 3 scope ("Journal visibility stays in Phase 4"), but the implemented Folder permission policy is unexercised by callers today. Phase 4 should decide whether JournalStore consults FolderStore permission or stays journal-ownership-only.
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
- ~~`RawFolder.folder` (legacy DTO alias) is live, not vestigial.~~ **Resolved May 16, 2026 (Phase 4 follow-up):** the alias was dropped. `JournalFolderDto.folder` is now `JournalFolderDto.parent`; `RawFolder.folder` is removed; `FolderStore` / `FolderRepository` no longer normalize a `folder` field on input; `journalApi.createJournalFolder` posts `{ parent }`; `JournalBrowser` reads `f.parent`. `JournalEntryDto.folder` was *not* renamed — Foundry's actual `JournalEntry` document field is `folder`, so that DTO field is not an alias.

**Phase 4 staging: JournalStore + JournalRepository**

ADR-0011 Phase 4 promotes Foundry `JournalEntry` documents into the primary-document framework. `JournalStore` owns the hydrated JournalEntry cache, entry-level visibility, embedded `JournalEntryPage` visibility, page mutation application, and folder-aware list projection by joining `journal.folder` to `FolderStore`. `JournalService` remains the route-facing orchestration layer for DTO projection and compatibility routes, but it should read from `JournalStore` and write through `JournalRepository` rather than fetching or mutating JournalEntry documents directly through the socket.

Foundry Journal assumptions for this phase: observed v13 JournalEntry payloads use a standard `ownership` map at the entry level, carry an optional `folder` id, and embed `pages`. Folder membership is read from `journal.folder` and joined against `FolderStore` for tree projection; `FolderStore` should not hold JournalEntry payloads or maintain a child-document collection. Each `JournalEntryPage` has its own `_id`, `name`, `type`, content payload fields such as `text`, `image`, `video`, `src`, optional `ownership`, `flags`, and `_stats`. Page visibility is two-level: the caller must be able to read the entry, then the page's own ownership is applied. An explicit page `INHERIT` should resolve to the entry's effective ownership; omitted page ownership should fail closed unless Foundry's actual payload semantics prove a different default during implementation.

Shared-content note: Foundry GM sharing is currently integrated through `SocketBase.setupSharedContentListeners()` (`shareImage` and `showEntry`), `UtilityService.getSharedContent()`, `/shared-content`, and realtime `sharedContentUpdate`. The exact Foundry semantics still need verification: sharing a journal page may be a live reference, a copied/snapshotted presentation payload, or a temporary GM presentation grant. Phase 4 should not create a second JournalEntry read path for shared journal content. If shared journal content is hydrated in this phase, resolve it through `JournalService` / `JournalStore` using the requesting user's subject and the shared UUID/id as input; if Foundry actually sends copied content, preserve it as a shared-content snapshot instead of refetching. A richer GM-share handler is likely needed later, and that policy should live in shared-content handling rather than weakening normal JournalStore ownership.

Scope:

- [x] Add `JournalStore` and `JournalRepository` under `src/server/core/documents/primary/journals/`, plus RawJournal/RawJournalPage types that reflect entry ownership, folder id, and embedded page ownership/content fields.
  Files: `src/server/core/documents/primary/journals/JournalStore.ts`, `src/server/core/documents/primary/journals/JournalRepository.ts`, `src/server/shared/types/documents.ts`.
- [x] Register `JournalStore` with `PrimaryDocumentCacheCoordinator` and `modifyDocumentRouter`; seed from Foundry's `JournalEntry` documents at bootstrap after `FolderStore` is ready.
  Files: `src/server/core/documents/primary/PrimaryDocumentCacheCoordinator.ts`.
- [x] Implement JournalEntry visibility in `JournalStore.resolveOwnership()` using the standard entry `ownership` map and `UserStore` subject roles; keep folder access lookups isolated to folder-organized list projection unless implementation confirms Folder permission gates entry visibility in Foundry. Folder-permission gating remains a deferred decision — `FolderStore.canReadDocument` is documented in the Store header as the lever to pull when Foundry behavior confirms it, but Phase 4 does not flip that switch.
  Files: `src/server/core/documents/primary/journals/JournalStore.ts`, `src/tests/unit/journal-store.test.ts`.
- [x] Implement embedded `JournalEntryPage` handling: apply create/update/delete events with `parentUuid: JournalEntry.<id>`, expose `canReadPage(entryId, pageId, subject)`, and filter pages for route DTOs via `visiblePages(entryId, subject)`.
  Files: `src/server/core/documents/primary/journals/JournalStore.ts`, `src/tests/unit/journal-store.test.ts`, `src/tests/unit/modify-document-router.test.ts`.
- [x] Move `JournalService.listJournals()` and `getJournalById()` reads to `JournalStore`; the service stays the route-facing DTO/projection layer and continues to use `FolderStore` for visible folder ancestry. Detail fetch now applies entry-level + page-level filtering before projecting the DTO.
  Files: `src/server/services/journals/JournalService.ts`, `src/tests/unit/journal-smoke.test.ts`.
- [x] Route JournalEntry create/update/delete through `JournalRepository`; preserve the existing `type === 'Folder'` branch through `FolderRepository`. `JournalEntry` and `JournalEntryPage` types now dispatch through `JournalRepository` inside `createRouteFoundryClient`.
  Files: `src/server/services/journals/JournalService.ts`, `src/server/shared/utils/createRouteFoundryClient.ts`, `src/server/shared/types/documents.ts`.
- [x] Investigate Foundry `showEntry` / journal-page sharing semantics. Result: `showEntry` carries a UUID reference only (`SocketBase.setupSharedContentListeners` stores `{ id, uuid }`); the browser hydrates the entry through `/api/journals/:id`, which now runs through `JournalStore.get(id, { subject, DETAIL_VISIBLE })`. No separate hydration path is needed — shared journal content inherits the same ownership policy as direct journal reads. The GM "force-show" override remains a future custom shared-content policy concern and is intentionally out of scope.
  Files: `src/server/core/foundry/sockets/SocketBase.ts` (no change), `src/server/services/journals/JournalService.ts`.
- [x] Remove socket/client-owned JournalEntry reads once callers are migrated. `CoreSocket.getJournals` and `ClientSocket.getJournals` are gone; the `JournalClientLike` route-client type no longer requires `getJournals` or `dispatchDocumentSocket`.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts`, `src/server/core/foundry/sockets/ClientSocket.ts`, `src/server/shared/utils/createRouteFoundryClient.ts`, `src/server/shared/types/documents.ts`, `src/tests/deprecated/socket-legacy/06-journals.test.ts`, `src/tests/unit/actor-store.test.ts`, `src/tests/unit/auth-status-smoke.test.ts`.
- [x] Add Phase 4 tests covering seed/clear, clone-on-read, entry ownership, page ownership, page `INHERIT`, folder-aware list projection, detail authorization, embedded page mutation routing, and repository writes.
  Files: `src/tests/unit/journal-store.test.ts`, `src/tests/unit/journal-smoke.test.ts`, `src/tests/unit/modify-document-router.test.ts`, `src/tests/unit/run.ts`.

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
- Structural Phase 4 pieces are present: `JournalStore`, `JournalRepository`, `RawJournal` + `RawJournalPage` schema expansion, coordinator seeding after Folder, modifyDocument router registration with embedded handler for `JournalEntryPage`, `journalChanged` / `journalListInvalidated` bridge events with gateway fan-out, `JournalService.listJournals()` + `getJournalById()` reading from `JournalStore` with page-level visibility filtering, and JournalEntry/JournalEntryPage writes through `JournalRepository`.
- Shared-content `showEntry` reference path keeps the existing `SocketBase` listener; client-side hydration goes through `/api/journals/:id` which now enforces `JournalStore.get` ownership at `DETAIL_VISIBLE`. No bypass path was introduced.
- Client: `JournalProvider` subscribes to `journalChanged` / `journalListInvalidated` and refetches via the existing in-flight-coalesced + 75 ms debounced path.

**Phase 5 staging: CombatStore + CombatRepository (embedded Combatant)**

ADR-0011 Phase 5 promotes Foundry `Combat` documents into the primary-document framework with embedded `Combatant` handling. `CombatStore` owns the hydrated combat cache, combat-level visibility (cross-referenced against `ActorStore`), embedded combatant mutation application, and the list-invalidation surface that fires when actor visibility crossings affect which combats a subject can see. `CombatRepository` owns combat-level and combatant-level writes. `CombatService` keeps the route-facing orchestration role: list/turn/initiative projections, GM/active-combatant authorization, and DTO enrichment with normalized actor payloads. Phase 5 also retires the legacy `combatUpdate` bespoke wire event (currently emitted from both `CoreSocket` and `ClientSocket`) and replaces it with the standard `combatChanged` / `combatListInvalidated` bridge pattern, matching the post-Phase 1 wire surface used by `chatMessageChanged`, `userChanged`, `folderChanged`, and `journalChanged`.

Foundry Combat assumptions for this phase: the observed v13 dump shows Combat documents carry `_id`, `active`, `type`, `system`, `scene` (nullable), `groups`, `combatants[]`, `round`, `turn`, `sort`, `flags`, `_stats`. **Combat documents do not carry an `ownership` map.** Visibility is derived: GMs are owners of every combat; non-GM subjects observe a combat if it contains at least one non-hidden combatant whose `actorId` resolves to an actor they can read at `LIST_VISIBLE`. The `RawCombat` / `RawCombatant` types in `src/server/shared/types/documents.ts` are currently bare and will need to expand (combat: `active`, `scene`, `type`, `sort`, `flags`, `system`, `groups`; combatant: `tokenId`, `sceneId`, `hidden`, `defeated`, `group`, `type`, `system`, `flags`, `name`, `img`). Combatants have a `hidden: true` flag that filters them from non-GM views of the combat (combatant payloads should be pruned in the route DTO projection for non-GMs).

Cross-store visibility: `CombatStore.resolveOwnership` reads `actorStore.canReadActor` for each non-hidden combatant. Because the answer changes when actor ownership maps shift, `CombatStore` exposes a `bindActorVisibilityBridge(actorStore)` method that subscribes to `actorStore.documentListInvalidated` and translates each event into a `combatListInvalidated` emit for combats containing the affected actor, preserving the original `targetUserIds`. The coordinator calls `combatStore.bindActorVisibilityBridge(actorStore)` once, in the same place the existing Store registrations happen — so a developer reading `PrimaryDocumentCacheCoordinator.ts` sees the cross-store wiring in one greppable line, and a developer reading `CombatStore.ts` sees the dependency declared explicitly as a method on the Store. This is the first cross-store dependency in the framework and the pattern Phase 6+ Stores follow. The seed order in `PrimaryDocumentCacheCoordinator` must register `CombatStore` after `ActorStore` so the first `seedAll` pass has actors available for the visibility computation triggered by combatant arrivals.

Wire-event rename (committed): `combatUpdate` is currently a bespoke "fat" event emitted from per-type `modifyDocument` switches in both `CoreSocket` (line ~470) and `ClientSocket` (line ~380), with a SDK contract (`RealtimeCombatUpdatePayload` in `src/shared/sdk/contracts.ts` and `src/shared/contracts/realtime.ts`) shaped as `{ _id, active, round, turn, combatants[], sceneId }`. The only browser consumer (`FoundryContext.handleCombatUpdate`) already ignores the payload and just refetches; the SDK shape has no in-tree module consumers. Phase 5 removes both emit sites and replaces them with skinny `combatChanged { combatId, action }` and `combatListInvalidated { reason, combatId?, targetUserIds? }` events bridged from `CombatStore` through `SystemService`. The SDK contract type is replaced (not aliased) — `RealtimeCombatUpdatePayload` becomes `RealtimeCombatChangedPayload` + `RealtimeCombatListInvalidatedPayload`. This matches Phase 1's treatment of `chatUpdate → chatMessageChanged` and the post-Phase 1 surface used by `userChanged`, `folderChanged`, and `journalChanged`.

Scope:

- [x] Add `CombatStore` and `CombatRepository` under `src/server/core/documents/primary/combats/`, plus expand `RawCombat` / `RawCombatant` shapes to reflect the observed v13 fields.
  Files: `src/server/core/documents/primary/combats/CombatStore.ts`, `src/server/core/documents/primary/combats/CombatRepository.ts`, `src/server/shared/types/documents.ts`.
- [x] Register `CombatStore` with `PrimaryDocumentCacheCoordinator` after `ActorStore`; register direct-type and `Combat`-parent embedded handlers on `modifyDocumentRouter`.
  Files: `src/server/core/documents/primary/PrimaryDocumentCacheCoordinator.ts`.
- [x] Implement combat visibility in `CombatStore.resolveOwnership()`: GM → OWNER; non-GM → OBSERVER iff `combat.combatants` contains a non-hidden entry whose `actorId` resolves to an actor the subject can read at `LIST_VISIBLE` via `actorStore.canReadActor`. Missing actors fail closed; combats with zero readable combatants resolve to NONE for non-GMs; a Store without an ActorStore binding also fails closed for non-GMs.
  Files: `src/server/core/documents/primary/combats/CombatStore.ts`, `src/tests/unit/combat-store.test.ts`.
- [x] Implement embedded `Combatant` handling: apply create/update/delete events with `parentUuid: Combat.<combatId>`, mutate the parent combat's `combatants[]` array, and emit `combatChanged` (update) on the parent so newly-added readable combatants are observable to fan-out subscribers.
  Files: `src/server/core/documents/primary/combats/CombatStore.ts`, `src/tests/unit/combat-store.test.ts`, `src/tests/unit/modify-document-router.test.ts`.
- [x] Wire the cross-store subscription as a Store-owned method: `CombatStore.bindActorVisibilityBridge(actorStore: ActorStore)` subscribes to `actorStore.documentListInvalidated` and emits `combatListInvalidated` for combats containing the affected actor (preserving `targetUserIds`). The coordinator calls this once alongside the existing Store/router registrations. Translation logic (`findCombatsContainingActor`) stays on `CombatStore` next to `resolveOwnership`.
  Files: `src/server/core/documents/primary/combats/CombatStore.ts`, `src/server/core/documents/primary/PrimaryDocumentCacheCoordinator.ts`, `src/tests/unit/combat-store.test.ts`.
- [x] Move `CombatService.listCombats()`, `advanceTurn()`, `previousTurn()`, and `rollInitiative()` reads onto `CombatStore`. Service-level enrichment (actor DTO normalization through `deps.normalizeActors`) stays at the service boundary; `ensureReady` gates each entry point.
  Files: `src/server/services/combats/CombatService.ts`, `src/tests/unit/actor-combat-smoke.test.ts`.
- [x] Route combat and combatant writes through `CombatRepository`. `advanceTurn` / `previousTurn` use `combatRepository.update(combatId, { round, turn })`; `rollInitiative` uses `combatRepository.updateCombatant(combatId, combatantId, { initiative })`. `createRouteFoundryClient.dispatchDocument('Combat'|'Combatant', ...)` routes through `CombatRepository`.
  Files: `src/server/services/combats/CombatService.ts`, `src/server/shared/utils/createRouteFoundryClient.ts`, `src/server/shared/types/documents.ts`, `src/tests/unit/actor-combat-smoke.test.ts`.
- [x] Bridge `CombatStore` events through `SystemService` as `combatChanged` / `combatListInvalidated`; remove the bespoke `combatUpdate` emit on `CoreSocket.modifyDocument` listener and the duplicate `combatUpdate` emit on `ClientSocket.setupDocumentListeners`. `AppSocketGateway` now subscribes to the system-client events with `combatStore.canReadDocument` per-socket on `combatChanged` and `targetUserIds` filtering on invalidations.
  Files: `src/server/core/system/SystemService.ts`, `src/server/core/foundry/sockets/CoreSocket.ts`, `src/server/core/foundry/sockets/ClientSocket.ts`, `src/server/realtime/AppSocketGateway.ts`, `src/tests/unit/app-socket-gateway.test.ts` (system-handler count goes 9 → 11; foundry-handler count goes 5 → 4).
- [x] Replace the SDK / shared realtime `RealtimeCombatUpdatePayload` with `RealtimeCombatChangedPayload` and `RealtimeCombatListInvalidatedPayload`; update the browser subscriber `FoundryContext.tsx` to listen on the new event names with refetch.
  Files: `src/shared/sdk/contracts.ts`, `src/shared/contracts/realtime.ts`, `src/client/ui/context/FoundryContext.tsx`.
- [x] Remove socket/client-owned Combat reads. `CoreSocket.getCombats`, `ClientSocket.getCombats`, the route-client `getCombats` surface, and `RouteFoundryClient.dispatchDocumentSocket` (now dead because no client type requires it) are gone; `CombatClientLike` requires `dispatchDocument` + `getActor` only.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts`, `src/server/core/foundry/sockets/ClientSocket.ts`, `src/server/shared/utils/createRouteFoundryClient.ts`, `src/server/shared/types/documents.ts` (`CombatClientLike`), `src/tests/unit/actor-store.test.ts`, `src/tests/unit/auth-status-smoke.test.ts`, `src/tests/deprecated/socket-legacy/06-combats.test.ts`.
- [x] Filter `hidden: true` combatants from non-GM DTO projections in `CombatService.listCombats`. GMs see hidden combatants; players see them pruned. Service-side projection step, not a Store-side filter.
  Files: `src/server/services/combats/CombatService.ts`.
- [x] Add Phase 5 tests covering seed/clear, GM-vs-non-GM visibility against `ActorStore`, missing-actor fail-closed, unbound-Store fail-closed, hidden-combatant exclusion, embedded combatant mutation routing, repository writes, and cross-store invalidation propagation. Updated `actor-combat-smoke.test.ts` to seed `combatStore` and capture `dispatchDocument` calls.
  Files: `src/tests/unit/combat-store.test.ts`, `src/tests/unit/actor-combat-smoke.test.ts`, `src/tests/unit/modify-document-router.test.ts`, `src/tests/unit/app-socket-gateway.test.ts`, `src/tests/unit/run.ts`.
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
- Structural Phase 5 pieces are present: `CombatStore`, `CombatRepository`, expanded `RawCombat` / `RawCombatant` types, coordinator seeding after ActorStore, modifyDocument router registration with embedded `Combatant` handler, `bindActorVisibilityBridge` wired in coordinator, `combatChanged` / `combatListInvalidated` bridge events with gateway fan-out + ownership filtering, `CombatService.listCombats / advanceTurn / previousTurn / rollInitiative` reading from `CombatStore` and writing through `CombatRepository`, hidden-combatant filtering in non-GM DTO projections, and removal of socket-owned Combat reads.
- Wire-event cleanup: `combatUpdate` is gone from `CoreSocket`, `ClientSocket`, the SDK contracts (`RealtimeCombatUpdatePayload` → `RealtimeCombatChangedPayload` + `RealtimeCombatListInvalidatedPayload`), and the browser subscriber (`FoundryContext` listens on `combatChanged` / `combatListInvalidated`). Exact cleanup grep finds only documentation comments under `src/server`, `src/client`, `src/shared`.
- Incidental cleanup: `RouteFoundryClient.dispatchDocumentSocket` was removed because no route-client consumer required it anymore after Phase 5; the type narrowed correspondingly. The Phase 5 audit found this dead surface while migrating CombatService off it.

---

## Exit Criteria

This ADR is fulfilled when every Foundry primary doc type covered by the alignment plan has its `<Type>Store` + `<Type>Repository` implementation against the shared base — including stubs for the types Sheet Delver doesn't currently use.

- [X] Phase 1: Base abstractions + `ChatMessageStore` + `ChatMessageRepository`. `ActorStore` / `ActorRepository` lifted onto the base.
- [X] Phase 2: `UserStore` + `UserRepository`. `userMap` / `gameDataCache.users` consolidate.
- [X] Phase 3: `FolderStore` + `FolderRepository`.
- [X] Phase 4: `JournalStore` + `JournalRepository` with two-level ownership.
- [X] Phase 5: `CombatStore` + `CombatRepository` with cross-store visibility.
- [ ] Phase 6: `ItemStore` + `ItemRepository` (world-level).
- [ ] Phase 7: `RollTableStore` / `MacroStore` / `PlaylistStore` / `CardsStore` (lazy) + `SceneStore` / `FogExplorationStore` / `AdventureStore` / `SettingStore` (stubs).
- [ ] `modifyDocumentRouter` replaces per-type switches in `CoreSocket` and removes the duplicate relay in `ClientSocket`.
- [ ] `PrimaryDocumentCacheCoordinator` replaces the hardcoded actor-only seeding path in `SystemService.bootstrap()`.
- [ ] Each phase's exit criteria verified before proceeding to the next.
- [ ] Status flipped to **Accepted** when Phase 7 ships green.
