# ADR-0012: Primary Document Realtime Events and Per-Type Subscription

**Status:** Accepted — implementation completed by ADR-0011 Phase 7.
**Date:** May 15, 2026
**Phase:** Primary Documents (Phase 1 onward)
**Supersedes:** None. Refines the Round 01 actor-event behavior into a model that applies to every primary doc type.
**Related:** ADR-0011 (primary document model), ADR-0013 (ownership and visibility)

---

## Context

ADR-0011 commits Sheet Delver to a uniform per-type Store + Repository for every Foundry primary document type. That model leaves one question unanswered: **how each Store communicates state changes to the rest of the platform**.

The Round 01 actor work established a working pattern but with rough edges:

- `ActorStore` emits internal `actorChanged` and `actorListInvalidated` events on its own emitter.
- `SystemService` bridges those to a public `actorUpdate` socket event consumed by browser clients.
- `AppSocketGateway` fans `actorUpdate` to authenticated user sockets with ownership filtering.
- A separate `ClientSocket` instance independently relays `'modifyDocument'` → `'actorUpdate'`, duplicating the route into `AppSocketGateway` from a different source.

For non-actor types the story is worse. `'chatUpdate'` and `'combatUpdate'` exist as bespoke events emitted from per-type switches in both `CoreSocket` and `ClientSocket`. `JournalEntry` emits nothing at all — GM journal updates silently fail to reach other connected users.

The asymmetry creates several concrete problems:

- **No uniform subscription pattern.** A cross-cutting consumer (audit logger, debug overlay, future SDK helper) that wants to react to any document change has to enumerate every per-type event and subscribe individually.
- **Duplicate emit points.** `CoreSocket` and `ClientSocket` both emit `'chatUpdate'` and `'combatUpdate'` from independent `modifyDocument` listeners. Without dedupe, the same broadcast reaches `AppSocketGateway` twice.
- **Bespoke ownership filtering per type.** Each per-type emit site decides what to filter and when. The Round 01 actor path filters dynamically per event; the others mostly don't filter at all.
- **No list-vs-document distinction.** A user gaining or losing ownership on an existing doc is structurally different from the doc itself changing. The ad-hoc events conflate them.
- **No idempotency contract.** When Sheet Delver-initiated writes apply a diff twice (once when the Repository mirrors the Foundry result, once when the broadcast arrives), per-type emitters can fire the change event twice.

ADR-0011's "uniform shape" promise can't be kept without committing to a uniform event surface. This ADR commits the platform to that.

---

## Decision

Every `<Type>Store` emits the same three events with the same payload shape and the same firing rules. Subscribers register **per-type** against the specific Store(s) they care about — they don't receive events for types they didn't ask about. Inbound Foundry events route through a single `modifyDocumentRouter` (replacing the duplicate emit points in `CoreSocket` and `ClientSocket`). Fan-out to browser clients happens through `AppSocketGateway` with dynamic per-event ownership filtering via each Store's `canReadDocument` predicate.

### Three events per Store

```ts
// Per-document change. Fires when an apply produces an observable state change.
interface DocumentChangedEvent<TName extends string> {
    id: string;
    action: 'create' | 'update' | 'delete';
}

// User-visible-set change. Fires when ownership transitions, creates, deletes,
// or other access-affecting mutations alter which docs a user can see.
interface DocumentListInvalidatedEvent {
    reason: string;             // human-readable label, used for debugging
    targetUserIds?: string[];   // when scoped to specific users; absent = broadcast-wide
}
```

Each Store emits these as type-specific events for ergonomic per-type subscription:

- `actorChanged` / `actorListInvalidated`
- `chatMessageChanged` / `chatMessageListInvalidated`
- `combatChanged` / `combatListInvalidated`
- `journalChanged` / `journalListInvalidated`
- `itemChanged` / `itemListInvalidated`
- `userChanged` / `userListInvalidated`
- `folderChanged` / `folderListInvalidated`
- `rollTableChanged` / `rollTableListInvalidated`
- `macroChanged` / `macroListInvalidated`
- `playlistChanged` / `playlistListInvalidated`
- `cardsChanged` / `cardsListInvalidated`
- and equivalents for stubbed types if/when those stubs are later wired (Scene / FogExploration / Adventure / Setting).

### Cross-cutting event on the base

For consumers that want to react to *any* primary document change without enumerating types — audit logging, telemetry, debug overlays, future generalized SDK helpers — the base also emits:

```ts
interface PrimaryDocumentChangedEvent {
    type: PrimaryDocumentType;  // 'Actor' | 'ChatMessage' | 'Combat' | ...
    id: string;
    action: 'create' | 'update' | 'delete';
}
```

Emitted as `primaryDocumentChanged` from the base emitter, alongside the type-specific event. Always paired — never emitted on its own. Subscribers pick: per-type for targeted consumers, generic for cross-cutting ones.

### Per-type subscription, not a global router for downstream consumers

There is exactly one inbound dispatcher — the `modifyDocumentRouter` — that routes Foundry `modifyDocument` events into the right Store's `applyModifyDocument` method. That's the single point of inbound routing.

**Downstream of the Stores, subscribers register per-type.** A consumer that only needs `ActorStore` events listens to `actorStore.on('actorChanged', ...)`; it does not receive `chatMessageChanged` or `combatChanged`. This matches the principle from ADR-0011 that policy lives at the type level — events are part of that policy boundary. Cross-cutting consumers can opt in by subscribing to `primaryDocumentChanged` on the base emitter, but they have to ask for it explicitly.

### Three firing rules every Store must obey

These live in the base abstraction; subclasses inherit them automatically:

1. **Emit only on observable change.** Applying a diff that produces no actual state change emits nothing. No-op upsert (identical doc already present), no-op patch (deep-merge resolves to equal values), no-op delete (id doesn't exist) — all silent. Required because Sheet Delver-initiated writes apply each diff twice (Repository mirror + broadcast). Without this rule every write fans out as two duplicate events.

2. **No emission during seeding.** Bootstrap seeding populates the cache silently. Events fire only after `isReady()` returns true. Without this rule every world reload would spam a flood of change events for documents that didn't change from any user's perspective.

3. **List-invalidation is a separate event.** Ownership transitions (a user gaining or losing visibility on an existing doc), creates, and deletes emit `<type>ListInvalidated`, not `<type>Changed`. The client adds or removes from its list rather than trying to patch a per-document view. Conversely, content changes to a doc a user already sees emit `<type>Changed`, not `<type>ListInvalidated`. The distinction lets clients respond optimally — patch a card or refetch a list, but not both.

### Fan-out via `AppSocketGateway` with dynamic ownership filtering

`AppSocketGateway` subscribes to each Store's events through a `SystemService` event bridge. For each event, it iterates connected users and calls `store.canReadDocument(id, subject, LIST_VISIBLE)` to decide whether the user should receive the event over their socket. The filter is applied **per event, at fan-out time** — not at subscription time. Ownership changes take effect immediately on the next event without re-subscribing.

For `<type>ListInvalidated` events with `targetUserIds`, the gateway fans only to listed users. For `targetUserIds` absent, the invalidation is broadcast-wide; Stores scope list invalidations when the affected user set is knowable, and omit `targetUserIds` for world-visible or deletion/create cases that should make every subscribed client re-check its list.

For world-visible types (ChatMessage in the no-whisper case), `canReadDocument` returns true uniformly; the filter is still called but always passes. This keeps the fan-out path uniform.

---

## Details

### Event Sequence for a Sheet-Delver-Initiated Write

1. Caller invokes `<type>Repository.update(id, diff)` (or `create`, or `delete`).
2. Repository dispatches via the request-scoped document transport to Foundry.
3. Foundry returns the mutation result *and* broadcasts a `modifyDocument` event back to all connected clients.
4. Repository forwards the result to `<Type>Store.applyModifyDocument(...)` before returning to the caller — the Store mirrors the change.
5. `<Type>Store` applies the diff. If it produces an observable state change, the Store emits `<type>Changed { id, action }` plus the generic `primaryDocumentChanged { type, id, action }`.
6. Repository returns the result.
7. Concurrently, `CoreSocket` receives the Foundry broadcast and routes it through `modifyDocumentRouter` to the same Store's `applyModifyDocument`. The Store applies the same diff — observable-change-only rule short-circuits the duplicate apply, no second event fires.

Net: one `<type>Changed` event per logical mutation, regardless of which path lands first.

### Event Sequence for a Foundry-Initiated Mutation

A player updates HP in Foundry, the GM toggles a status effect, a token moves and triggers an attribute update:

1. Foundry broadcasts a `modifyDocument` event.
2. `CoreSocket` receives the broadcast.
3. `modifyDocumentRouter` routes the event by `(type, parentUuid)` to the right `<Type>Store.applyModifyDocument`.
4. The Store applies the diff and emits `<type>Changed`.
5. `AppSocketGateway` fans the event to subscribers who pass the ownership filter.

No Repository involvement — this path is broadcast-only.

### Ownership Transitions and `listInvalidated`

When an Actor's `ownership` map changes:

- The Store computes the affected user set: users whose effective access crosses the visibility threshold (`LIST_VISIBLE` per ADR-0013) in either direction.
- For each affected user, the Store emits `actorListInvalidated { reason: 'ownership-change', targetUserIds: [...] }`.
- It does **not** emit `actorChanged` for the ownership change itself. Doc content didn't change from anyone's perspective who already had access; new viewers need to add the doc to their list; lost viewers need to remove it.

Same logic on create (new viewers gain a doc) and delete (all prior viewers lose it). Embedded-child mutations on the same parent doc — items on an actor, pages on a journal, combatants on a combat — emit the parent's `<type>Changed`, not list invalidation.

### Replacing the Duplicate `modifyDocument` Emit Points

Today's `CoreSocket` and `ClientSocket` both run per-type switches over `modifyDocument` events. Both emit per-type events. `AppSocketGateway` listens to whichever client is active. After this ADR ships:

- `modifyDocumentRouter` becomes the sole inbound dispatch point. It runs on `CoreSocket` (the long-lived platform socket) and routes events to the right Store.
- `ClientSocket`'s `modifyDocument` listener and per-type emit switch are removed.
- `<Type>Store` emitters become the sole source of downstream events; `AppSocketGateway` subscribes through `SystemService`'s bridge of those events.
- Existing event names (`actorUpdate`, `chatUpdate`, `combatUpdate`) are replaced with their `<type>Changed` / `<type>ListInvalidated` counterparts. No alias is retained — modules and browser clients switch over together.

### Wire-Format Continuity

The internal event names are the type-specific ones documented above; the wire format that reaches the browser is the same shape with the same field names. The browser receives `actorChanged { actorId, action }` (renaming `actorId` to match `id` on the wire is also fine — name details are settled at the SDK boundary, not in this ADR).

### Subscriber Categories and Patterns

- **Internal platform code** (services, cross-store dependencies). Subscribes directly to the Store's emitter. Example: `CombatStore` subscribes to `actorStore.actorListInvalidated` to recompute combatant visibility and emit its own `combatListInvalidated` for users whose access to the combat changed.

- **Realtime fan-out** (`AppSocketGateway`). Subscribes through `SystemService`'s bridge of each Store's events. Applies the ownership filter at fan-out time. Emits over the user's WebSocket.

- **Module SDK** (post-core round). Future React hooks (`useSDK().on<Type>Update(...)`, etc.) subscribe through the wire-event surface, not directly against Store emitters. Modules don't reach into the platform's internal event bus.

- **Cross-cutting consumers** (audit, telemetry, debug). Subscribe to `primaryDocumentChanged` on the base emitter for a fire-hose of all changes with type tagging. This is opt-in — typical platform code uses per-type subscriptions for the relevant slice.

---

## Alternatives Considered

### Keep per-type events as today, accept duplication

Don't unify. Each `<Type>Store` keeps its current bespoke event name (`actorUpdate`, `chatUpdate`, `combatUpdate`), invents one if missing (Journal), and `AppSocketGateway` keeps its per-type relay table.

Rejected because it reproduces the existing scatter. Cross-cutting consumers can't subscribe uniformly; the duplicate emit points stay; idempotency and list-invalidation contracts are re-invented per type. Round 01 already established the cleaner shape for actor; not generalizing discards that work.

### Single global event with type discrimination

Every Store emits a single shared event like `documentChanged { type, id, action }`. No per-type events.

Rejected because most consumers care about one type — combatant visibility recompute, journal page refresh, chat-feed append. A global event forces every consumer to filter by `event.type === 'whatever'`, which is both verbose and a leaky abstraction: cross-type consumers leak their consumption pattern across the codebase.

Per-type events with an optional global cross-cutting event is the right shape: targeted consumers stay targeted; cross-cutting consumers opt in explicitly.

### Single shared event router downstream of Stores

A central router that aggregates every Store's events and dispatches them to subscribers based on filter criteria. Subscribers tell the router "I want types X, Y, Z."

Rejected as premature abstraction. The router would need to know about every Store; every Store would need to register with the router; and the per-type listener registration model is simpler and matches the per-type Store + Repository pattern from ADR-0011. If a real need for cross-cutting filtering emerges later, it can be added on top of per-type subscriptions without breaking existing consumers.

### Emit on every apply, dedupe at fan-out

Stores emit unconditionally; `AppSocketGateway` keeps a short-lived sequence map and drops duplicates.

Rejected because dedupe-at-fan-out is fragile and only addresses the wire path. Internal subscribers (`CombatStore` watching `ActorStore`) would still see duplicates and either need their own dedupe or tolerate spurious work. Emit-only-on-observable-change is a stricter invariant that simplifies every subscriber's lifecycle.

### Subscription-time ownership filter

Each subscriber pre-computes its allowed doc id set when it subscribes, then receives events without runtime filtering.

Rejected because ownership changes during a session would require subscribers to re-subscribe. Round 01 settled this: dynamic per-event filtering is the only correct approach. A user who gains ownership at second 30 should receive the event at second 31, not at the next subscription cycle.

---

## Consequences

### Positive

- **Uniform event contract across every primary doc type.** Subscribers reason about one event shape, one set of firing rules, regardless of doc type.
- **Drift prevention.** New Stores inherit the firing rules from the base; old Stores can't drift away from them without explicit subclass overrides (which would surface in code review).
- **Idempotency guaranteed.** Sheet Delver-initiated writes emit exactly one change event per logical mutation, regardless of whether the Repository mirror or the Foundry broadcast lands first.
- **No bootstrap-time event storm.** Seeding is silent; events fire only after the Store is ready.
- **Clean list/document separation.** Clients can respond to per-document updates and per-list invalidations differently — patch a card vs refetch a list — without server-side ambiguity about which the event represents.
- **Single inbound dispatch point.** `modifyDocumentRouter` eliminates the duplicate per-type switches in `CoreSocket` and `ClientSocket`.
- **Cross-cutting consumers cheap.** Audit / telemetry / debug overlays subscribe to one event (`primaryDocumentChanged`) with type tagging instead of enumerating per-type events.

### Tradeoffs

- **More event names.** Every type has two events plus the generic one — that's 25+ event names once the full primary-doc set lands. The redundancy is intentional (per-type ergonomics + cross-cutting opt-in), but the namespace grows.
- **Compile-time enforcement of firing rules is partial.** The base can enforce that `applyModifyDocument` calls into the right emit method, but it can't catch every subtle break of the observable-change-only rule — a subclass that overrides `upsert` poorly could still emit on a no-op. Mitigated by base-contract unit tests that every subclass must pass.
- **Cross-store subscriptions create implicit dependencies.** `CombatStore` listening to `ActorStore` is an implicit dependency that doesn't show up in constructor signatures. The plan documents these explicitly; subsystem authors must wire them at module-init time.
- **Wire-event rename is a breaking change for browser clients.** Removing `actorUpdate` in favor of `actorChanged` requires the browser side to update in lockstep. No alias is retained per this ADR.

---

## Related Decisions

- **ADR-0011 (primary document model)** — establishes the per-type Store + Repository shape this ADR's events ride on top of.
- **ADR-0013 (planned: ownership and visibility model)** — defines `canReadDocument` and the `LIST_VISIBLE` threshold that `AppSocketGateway` uses for fan-out filtering. The events defined here have no semantic meaning without those visibility predicates.

---

## Validation

Validated at the base-abstraction level and per-type:

- Base-contract unit tests against a mock document type assert all three firing rules: observable-change-only, no-emission-during-seeding, list-vs-document separation.
- Each per-type Store inherits these tests as regression coverage; subclass-specific tests assert the type-specific event names fire as expected.
- Vertical smoke tests per phase wire a real Store + Repository + `modifyDocumentRouter` against a fake socket, issue a write, simulate a Foundry broadcast, and assert exactly one event reaches a fake `AppSocketGateway` subscriber after the ownership filter.
- A test in `AppSocketGateway` coverage asserts that a non-owning user does not receive `<type>Changed` for a doc they can't see; and that `<type>ListInvalidated { targetUserIds: [...] }` reaches only the listed users.

The structural end-state validation:

- `grep`-ing for ad-hoc event emit calls (`emit('actorUpdate')`, `emit('chatUpdate')`, etc.) outside the Store/Repository/gateway layer returns no live callers.
- `ClientSocket` no longer has a `modifyDocument` listener; routing happens entirely through `modifyDocumentRouter` attached to `CoreSocket`.
- A cross-cutting subscriber (e.g., a debug logger) can be added with a single `on('primaryDocumentChanged', ...)` registration and receives events for every doc type without per-type wiring.

## ADR-0011 Phase 1 Notes

**May 15, 2026 — ADR-0011 Phase 1 event bursts and client refresh coalescing.** ADR-0011 Phase 1 proved the Store-level event semantics for Actor and ChatMessage, but it also exposed a browser reaction issue: a single create can legitimately produce both a document-level change and a list-level invalidation. That is not a duplicate mutation. It means the document changed and the visible list may have changed.

Browser consumers must not treat each event in a burst as an independent network-refresh command. They should either choose the narrowest useful response or coalesce refreshes. ADR-0011 Phase 1 added that coalescing in `ChatContext` for `chatMessageChanged` / `chatMessageListInvalidated` / send-success refreshes, and in `GenericActorPage` for bursty Actor refreshes.

**May 15, 2026 — ADR-0011 Phase 1 transitional wire surface.** ADR-0011 Phase 1 was intentionally hybrid while the broader ADR remained open. Foundry still emitted native `modifyDocument` events for `ChatMessage`; Sheet Delver's server realtime layer no longer re-emitted those as the legacy `chatUpdate` app event. Instead, `ChatMessageStore` emitted through the new `chatMessageChanged` / `chatMessageListInvalidated` path, while the client kept a legacy `chatUpdate` listener harmlessly. Actor events still bridged to the legacy `actorUpdate` wire event until the full ADR-0012 rename completed. This kept ADR-0011 Phase 1 compatible while later phases finished the global event-surface migration.

**May 17, 2026 — ADR-0011 Phase 7 closure.** ADR-0011 Phase 7 completes the realtime surface migration for every shipped primary-document Store. The legacy `actorUpdate` wire event is renamed to `actorChanged` with no server-side alias; browser consumers and SDK exports now use `actorChanged` / `onActorChanged` / `RealtimeActorChangedPayload`. Server-side `chatUpdate` and `combatUpdate` emits were already removed in earlier ADR-0011 phases; the inert `ChatContext` `chatUpdate` listener and `RealtimeChatUpdatePayload` contract exports are removed as part of closure cleanup so new consumers cannot accidentally depend on the retired event. `ClientSocket` no longer listens to `modifyDocument` or Foundry presence events for primary-document/status fan-out. User document changes flow through `UserStore`; login/logout presence shifts update `userPresence` in `CoreSocket` and trigger one system-owned status refresh through `SystemService`.

---

## Exit Criteria

This ADR is fulfilled when the event contract is in force across every Store and the duplicate emit points are removed.

- [x] Base abstraction in `PrimaryDocumentStore<T>` provides the three firing rules and emits the document/list/generic events consistently.
- [x] `modifyDocumentRouter` is the sole inbound cache-mutation dispatch for `modifyDocument` events; the per-type realtime switches in `CoreSocket` are removed.
- [x] `ClientSocket` no longer relays primary-document mutation or presence/status events; its duplicate per-type emits and the transitional `User` status relay are removed.
- [x] Every shipped Store emits document-change, list-invalidation, and generic `primaryDocumentChanged` events per the firing rules; `SystemService` bridges those to the public `<type>Changed` / `<type>ListInvalidated` wire names.
- [x] `AppSocketGateway` fan-out applies dynamic per-event ownership filtering via `canReadDocument`.
- [x] Legacy event names (`actorUpdate`, `chatUpdate`, `combatUpdate`) are removed from the server-emitted wire surface; browser clients switched to the new event names.
- [x] Each phase's tests cover idempotency, no-emission-during-seeding, and the list-vs-document separation.
- [x] Status flipped to **Accepted** when the contract is in force for every shipped Store.
