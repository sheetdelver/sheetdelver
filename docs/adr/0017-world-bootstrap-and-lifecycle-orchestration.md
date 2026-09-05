# ADR-0017: World Bootstrap and Lifecycle Orchestration

**Status:** Accepted - Phases 1-6 completed May 20, 2026.
**Date:** May 20, 2026
**Phase:** World Bootstrap (Phase 4 of the ADR-0014 arc)
**Supersedes:** None. Consumes ADR-0014 world/lifecycle Stores, ADR-0015 compendium services, and ADR-0016 document resolution.
**Related:** ADR-0011 (primary document model), ADR-0014 (non-document world state and socket boundary), ADR-0015 (compendium architecture), ADR-0016 (document resolution), ADR-0018 (socket-boundary completion), ADR-0019 (Foundry version compatibility).

---

## Part of the ADR-0014 arc

This ADR is the fourth decision in the ADR-0014 arc. ADR-0014 moved non-document world state out of sockets. ADR-0015 moved compendium reads out of sockets. ADR-0016 moved UUID routing out of sockets. ADR-0017 moves bootstrap orchestration, adapter ownership, engagement policy, and sync-token ownership out of sockets.

| ADR | Scope | Depends on |
|---|---|---|
| ADR-0014 - Non-Document World State and the Socket Boundary Principle | `WorldStateStore`, `WorldLifecycleStore`, `SharedContentStore`, file-layout convention, and removal of world-state readers from sockets. | none |
| ADR-0015 - Compendium Architecture and the Pathway B Read Gap | `CompendiumStore`, `CompendiumService`, `CompendiumPackStore` / shard reader. Fixes SDK discovery shard reads, de-duplicates Pathway A/B index work, and removes compendium readers from sockets. | ADR-0014 |
| ADR-0016 - Document Resolution and UUID Routing | `DocumentResolver`; removes `fetchByUuid` from `CoreSocket` and `ClientSocket`; parses world, embedded, and compendium UUIDs; delegates compendium lookup to ADR-0015 shard/fallback primitives. | ADR-0015 |
| **ADR-0017 (this ADR)** - World Bootstrap and Lifecycle Orchestration | `WorldBootstrapper`, delayed `active`, adapter ownership, `EngagementService`, and `SyncTokenService`. Removes adapter, heartbeat-policy, bootstrap-orchestration, and sync-token leftovers from sockets. | ADR-0014 through ADR-0016 |
| ADR-0018 - Socket Boundary Enforcement Completion | Completed residual socket-boundary cleanup after the named extractions: URL utility extraction, session-state split, stale-comment cleanup, and final socket-surface verification. | ADR-0014 through ADR-0017 |
| ADR-0019 - Foundry Version Compatibility | Completed compatibility policy using the typed `release` shape and the `WorldBootstrapper` insertion point. | ADR-0017 |

**Reading order if you land here cold:** read ADR-0014 first, then ADR-0015 and ADR-0016. ADR-0017 assumes Stores/services already own world state, compendium reads, and UUID routing.

---

## Context

The codebase now has the right state/service owners, and `WorldBootstrapper.bootstrap()` is the application-readiness boundary behind the `SystemService.bootstrap()` facade.

`CoreSocket.connect()` still does more than establish a Foundry socket:

- probes setup/offline/startup state
- resolves the service account user id
- logs in
- opens the socket.io transport
- checks Foundry world activity and leaves lifecycle in `startup`
- exposes a raw bootstrap-snapshot fetch for `game.data` and scene data
- starts the heartbeat transport loop through `EngagementService` policy callbacks

`WorldBootstrapper.bootstrap()` now performs the application bootstrap and readiness transition:

- accepts the connected-world `game.data` / scene snapshot
- seeds `WorldStateStore`
- seeds `UserStore` and `UserPresence`
- passive compendium pack metadata seed from `game.data.packs` (no transport calls — superseded by ADR-0021; was previously a broad Pathway A index fetch)
- module-declared compendium pack hydration via `CompendiumService.hydratePacks(systemId, config)` — only stale or missing declared packs fetch (ADR-0021)
- primary-document Store seeding through `seedDocumentCache(client)`
- adapter initialization
- lifecycle transition to `active`
- `world:ready` emission

ADR-0014 defined `active` as "Sheet Delver is ready to serve world-backed requests." Phase 5 now matches that contract: Foundry-active maps to `startup`, and `active` is written only after Sheet Delver bootstrap completes.

After Phase 6, the remaining socket-boundary leftovers were narrow and explicitly ADR-0018 scope. ADR-0018 has since closed them:

- `CoreSocket.connect()` still owns the handshake/probe/login/raw socket state machine.
- `CoreSocket` still owns service-account identity resolution, retry/backoff, and the raw heartbeat transport probe; `EngagementService` owns the policy inputs.
- `CoreSocket.getBootstrapSnapshot()` is a raw transport fetch; `WorldBootstrapper` decides when the snapshot is accepted.
- URL utility extraction and the session-state half of restore moved to ADR-0018 and are now complete.

Phase 1 removed the previous `CoreSocket.lastActorChange` status leak; `actorSyncToken` now comes from `SyncTokenService`.
Phase 2 removed browser-count, last-activity, heartbeat-pause, and adaptive-heartbeat policy from `CoreSocket`; those now live in `EngagementService`.
Phase 3 removed socket-owned active-adapter state and adapter reader/loader methods; `WorldBootstrapper` now owns the active adapter.
Phase 4 moved compendium discovery, discovery shard sync, primary-document Store seeding, adapter initialization, and readiness tracking out of `SystemService` and into `WorldBootstrapper`. `SystemService` remains the public event/readiness facade.
Phase 5 moved connected-world snapshot acceptance and user/presence bootstrap into `WorldBootstrapper`, delayed `active` until bootstrap completion, and gates world-backed realtime fan-out on application readiness.
Phase 6 removed remaining public world-snapshot mirrors from `CoreSocket`, updated stale ADR/audit references, and closed ADR-0017 with targeted boundary audits.

---

## Decision

Introduce service-layer owners for the remaining non-transport behavior:

- `WorldBootstrapper` in `src/server/services/world/WorldBootstrapper.ts`
- `EngagementService` in `src/server/services/world/EngagementService.ts`
- `SyncTokenService` in `src/server/services/status/SyncTokenService.ts`

`WorldBootstrapper` owns the application bootstrap sequence:

1. consume the connected Foundry transport
2. seed `WorldStateStore` from the accepted `game.data` snapshot
3. seed presence/user state from that same snapshot
4. passively seed compendium pack metadata from `game.data.packs` into the unified `CompendiumStore` (no transport calls — see ADR-0021)
5. hydrate module-declared compendium packs via `CompendiumService.hydratePacks(systemId, config)`; fresh persistent shards short-circuit with zero transport calls
6. seed primary-document Stores
7. resolve, cache, and initialize the active adapter
8. transition lifecycle to `active`
9. emit ready state through `SystemService`

`CoreSocket` remains the transport owner:

- handshake/probe/login mechanics
- socket.io connection/disconnection
- raw socket events
- `emitSocketEvent(...)`
- `dispatchDocumentSocket(...)`
- inbound `modifyDocument` event capture that hands off to `modifyDocumentRouter`

Lifecycle semantics after ADR-0017:

- `offline`: no usable Foundry connection; runtime Stores empty.
- `setup`: Foundry setup/no active world; setup cache may exist.
- `startup`: Foundry world detected or connected, but Sheet Delver bootstrap is not complete.
- `active`: `WorldBootstrapper` finished compendium discovery, primary Store seed, and adapter initialization.
- `closed`: service account/world configuration failure that requires admin action.

`active` must not be written by `CoreSocket` when Foundry merely reports an active world. `WorldBootstrapper` writes `active` only after the app is ready.

### Adapter Ownership

The active adapter is not world-state data and not transport data. It is a runtime service object resolved from the active world system id plus the module registry.

`WorldBootstrapper` owns:

- `loadActiveAdapter(systemId)`
- `getActiveAdapter()`
- `clearActiveAdapter(reason?)`

Route validation (`createRouteFoundryClient` actor update filtering) should read the active adapter through `SystemService` / `WorldBootstrapper`, not from `CoreSocket`.

### Engagement Policy

Browser engagement is an application policy, not socket transport.

`EngagementService` owns:

- active browser count
- last user activity timestamp
- adaptive heartbeat delay policy
- reconnect-on-engagement decision
- heartbeat pause state used during long compendium scans

`CoreSocket` may expose narrow raw probe/connect primitives, but `EngagementService` owns heartbeat scheduling and engagement policy. The service decides when to probe, pause, or ask for reconnect; the socket only performs the transport operation.

### Sync Token

`actorSyncToken` is a status projection over Actor/Item changes. It is not transport state.

`SyncTokenService` owns the timestamp/token source by subscribing to Store events. `StatusService` reads it directly. `CoreSocket.lastActorChange` is removed.

### Gateway Readiness

App socket clients may still connect during `startup` and receive status payloads. World-backed authenticated document fan-out and request paths must treat `startup` as not ready. This means `active` and/or `SystemService.isReady()` are the readiness gates for world-backed behavior.

---

## What Stays Out

ADR-0017 did not move URL helpers off `SocketBase`; ADR-0018 later extracted URL utilities and removed the socket wrappers.

ADR-0017 did not split `ClientSocket.restoreSession(...)` cookie-state handling; ADR-0018 later moved restore policy to `SessionManager` and left only wire reconnect on `ClientSocket`.

ADR-0017 did not implement Foundry version min/max compatibility checks; ADR-0019 later used this ADR's `WorldBootstrapper` insertion point to add that policy.

ADR-0017 does not broadly optimize primary-document seeding from `game.data`. Phase 5 intentionally seeds `UserStore` and `UserPresence` from the accepted bootstrap snapshot because user presence is part of readiness/status semantics. Other primary-document Stores keep `seedDocumentCache(client)` semantics intact; broader seed-from-snapshot optimization is a separate follow-up after the bootstrap boundary is stable.

ADR-0017 does not broaden Scene, FogExploration, Adventure, or Setting routing. Stub Store policy remains unchanged.

ADR-0017 does not change route/module public APIs except removing socket-only adapter delegation. Route/module facades should preserve their existing call shapes where those shapes are service contracts.

---

## ADR-0017 Phase Staging

This section follows ADR-0011 through ADR-0016: each phase has a named scope, status, action checklist with file touchpoints, non-goals, and a concrete exit statement.

### Phase 1: SyncTokenService and status decoupling

**Status:** Completed May 20, 2026.

Phase 1 removes the narrow `lastActorChange` status leak from `CoreSocket`.

**Action items:**

- [x] Add `SyncTokenService` with a monotonic token/timestamp and Store event subscriptions for the Actor/Item changes that currently drive `actorSyncToken`.
  Files: `src/server/services/status/SyncTokenService.ts`, `src/server/services/status/index.ts` if needed.

- [x] Update `StatusService` to read the sync token from `SyncTokenService` instead of `systemService.getSystemClient().lastActorChange`.
  Files: `src/server/services/status/StatusService.ts`.

- [x] Remove `lastActorChange` from `CoreSocket` and from the narrow status-facing system-client type.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts`, `src/server/shared/types/foundry.ts`.

- [x] Add unit coverage proving Actor/Item changes bump the token and unrelated document types do not unless intentionally added.
  Files: `src/tests/unit/services/sync-token-service.test.ts`, `src/tests/unit/run.ts`.

- [x] Verify Phase 1 with unit/type checks and sync-token audits.
  Commands: `npm run test:unit`; `npx tsc --noEmit`; `git diff --check`; `rg -n "lastActorChange" src/server`; `rg -n "actorSyncToken" src/server`.

**Phase 1 implementation note:** `SyncTokenService` subscribes to `ActorStore` and `ItemStore` `documentChanged` events, keeps the status-facing token monotonic even when multiple changes land in the same millisecond, and guards the tracked document types so unrelated Store events do not bump the token. `actorSyncToken` remains in the status payload as the public refetch hint; the remaining server-side `actorSyncToken` audit hit is the expected `StatusService` projection.

**Non-goals for Phase 1:**

- No lifecycle timing changes.
- No adapter migration.
- No engagement or heartbeat changes.
- No bootstrap sequencing changes.

**Exit for Phase 1:** Status payloads still expose `actorSyncToken`, but the token source is Store/service-owned; `CoreSocket` no longer exposes or mutates `lastActorChange`; tests and audits pass.

### Phase 2: EngagementService and heartbeat policy extraction

**Status:** Completed May 20, 2026.

Phase 2 moves browser engagement and heartbeat policy out of `CoreSocket` while preserving existing reconnect behavior.

**Action items:**

- [x] Add `EngagementService` with active-browser count, last-activity timestamp, heartbeat pause state, adaptive delay calculation, and a narrow reconnect callback.
  Files: `src/server/services/world/EngagementService.ts`, `src/server/services/world/index.ts`.

- [x] Move `AppSocketGateway` connect/disconnect accounting from `systemService.getSystemClient().updateActiveBrowserCount(count)` to `EngagementService`.
  Files: `src/server/realtime/AppSocketGateway.ts`, `src/tests/unit/sockets/app-socket-gateway.test.ts`.

- [x] Move heartbeat scheduling decisions to `EngagementService`. `CoreSocket` may keep a narrow raw probe/connect primitive, but it should not own the timer cadence or active-client policy.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts`.

- [x] Move long-operation heartbeat pause state to `EngagementService` while preserving the `CompendiumService` transport behavior.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts`, `src/server/services/compendium/CompendiumService.ts` if transport wiring needs adjustment, `src/server/shared/utils/createRouteFoundryClient.ts`.

- [x] Remove `CoreSocket.updateActiveBrowserCount(...)` and the socket-owned engagement fields.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts`.

- [x] Verify Phase 2 with unit/type checks and engagement audits.
  Commands: `npm run test:unit`; `npx tsc --noEmit`; `git diff --check`; `rg -n "updateActiveBrowserCount|activeBrowserCount|lastUserActivityTimestamp|heartbeatPaused" src/server`.

**Phase 2 implementation note:** `EngagementService` is the policy owner for browser-count changes, return-from-idle wakeups, reconnect-on-engagement, heartbeat cadence, and long-operation heartbeat suspension. `CoreSocket` registers narrow callbacks for the raw operations (`startHeartbeat`, retry reset, reconnect) and still performs the actual probe/connect work. `AppSocketGateway` is now the browser-count writer.

**Non-goals for Phase 2:**

- No delayed `active` semantics yet.
- No bootstrapper extraction yet.
- No adapter migration unless required by transport wiring.

**Exit for Phase 2:** Browser engagement and heartbeat policy live in `EngagementService`; `CoreSocket` no longer owns browser-count policy fields; existing reconnect/heartbeat behavior is preserved; tests and audits pass.

### Phase 3: Adapter ownership migration

**Status:** Completed May 20, 2026.

Phase 3 moves active adapter ownership out of socket classes.

**Action items:**

- [x] Add active-adapter ownership to the world service layer. If `WorldBootstrapper` is not ready yet, add the minimal shell needed for `loadActiveAdapter(systemId)`, `getActiveAdapter()`, and `clearActiveAdapter(reason?)`.
  Files: `src/server/services/world/WorldBootstrapper.ts`, `src/server/services/world/index.ts`.

- [x] Migrate route-client actor update validation to read the active adapter from `SystemService` / `WorldBootstrapper`, not from the request socket.
  Files: `src/server/shared/utils/createRouteFoundryClient.ts`, `src/tests/unit/actors/actor-store.test.ts` or a focused route-client test.

- [x] Remove `getSystemAdapter()` and `loadSystemAdapter(systemId)` from `CoreSocket`, the `ClientSocket` delegation, and socket-facing interfaces.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts`, `src/server/core/foundry/sockets/ClientSocket.ts`, `src/server/core/foundry/interfaces.ts`.

- [x] Update comments/docs that still describe adapter ownership as socket-owned.
  Files: `docs/adr/0014-non-document-world-state-and-socket-boundary.md`, `docs/adr/0017-world-bootstrap-and-lifecycle-orchestration.md`, touched code comments.

- [x] Verify Phase 3 with unit/type checks and adapter audits.
  Commands: `npm run test:unit`; `npx tsc --noEmit`; `git diff --check`; `rg -n "getSystemAdapter|loadSystemAdapter|private adapter" src/server`.

**Phase 3 implementation note:** `WorldBootstrapper` now owns the active adapter cache and exposes `loadActiveAdapter(systemId)`, `getActiveAdapter()`, and `clearActiveAdapter(reason?)`. `SystemService` remains the facade for route code. `CoreSocket` still reaches the adapter-load point during the legacy connect flow, but it delegates the load/cache to `WorldBootstrapper` and no longer exposes adapter methods. Route actor-update validation reads `SystemService.getActiveAdapter()`.

**Non-goals for Phase 3:**

- No adapter initialization timing change beyond moving ownership.
- No broad module registry rewrite.
- No route/module public API break beyond deleting socket-only adapter methods.

**Exit for Phase 3:** The active adapter is service-owned; route validation reads the service-owned adapter; `CoreSocket` and `ClientSocket` no longer expose adapter reader/loader methods; tests and audits pass.

### Phase 4: WorldBootstrapper behavior-preserving bootstrap move

**Status:** Completed May 20, 2026.

Phase 4 moves `SystemService.bootstrap()` orchestration into `WorldBootstrapper` without changing lifecycle timing yet.

**Action items:**

- [x] Move the compendium discovery, discovery shard sync, primary-document seed, adapter initialization, and ready-result logic into `WorldBootstrapper.bootstrap(transport)`.
  Files: `src/server/services/world/WorldBootstrapper.ts`, `src/server/core/system/SystemService.ts`.

- [x] Keep `SystemService` as the public facade for initialization, readiness, and events. It should delegate bootstrap work to `WorldBootstrapper`.
  Files: `src/server/core/system/SystemService.ts`.

- [x] Preserve idempotence: concurrent bootstrap calls share one promise; failures clear the promise; successful bootstrap marks readiness exactly once.
  Files: `src/server/services/world/WorldBootstrapper.ts`, tests.

- [x] Keep current lifecycle timing in this phase. `active` may still be set before bootstrap while the orchestration move lands.
  Files: `src/server/core/system/SystemService.ts`, `src/server/core/foundry/sockets/CoreSocket.ts`.

- [x] Add unit coverage for bootstrap ordering, idempotence, failure reset, and adapter initialization delegation using synthetic transports/services.
  Files: `src/tests/unit/world/world-bootstrapper.test.ts`, `src/tests/unit/run.ts`.

- [x] Verify Phase 4 with unit/type checks and bootstrap ownership audits.
  Commands: `npm run test:unit`; `npx tsc --noEmit`; `git diff --check`; `rg -n "Beginning world bootstrap|discoverIndices\\(|seedDocumentCache\\(|adapter.initialize" src/server/core src/server/services`.

**Phase 4 implementation note:** `WorldBootstrapper` now owns the behavior-preserving application bootstrap sequence: Pathway A compendium discovery, Pathway B shard sync, primary-document Store seed, adapter initialization, ready tracking, in-flight promise sharing, and failure reset. `SystemService.bootstrap()` delegates to `WorldBootstrapper.bootstrap(...)` and emits `world:ready` through an `onReady` callback so callers keep the same facade. Lifecycle timing intentionally did not change in this phase; `CoreSocket.connect()` can still set `active` early until Phase 5.

**Non-goals for Phase 4:**

- No delayed `active` behavior.
- No CoreSocket connect-handler split yet.
- No seed-from-`game.data` optimization.

**Exit for Phase 4:** `WorldBootstrapper` owns application bootstrap orchestration; `SystemService` delegates and remains the event/readiness facade; behavior is otherwise preserved; tests and audits pass.

### Phase 5: Delayed active and CoreSocket connect-handler split

**Status:** Completed May 20, 2026.

Phase 5 is the semantic change: `active` becomes application-ready, and `CoreSocket.connect()` shrinks toward transport.

**Action items:**

- [x] Change the world-active socket path to leave `WorldLifecycleStore` in `startup` until `WorldBootstrapper.bootstrap(...)` completes.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts`, `src/server/services/world/WorldBootstrapper.ts`, `src/server/core/system/SystemService.ts`.

- [x] Move game-data and scene-data acceptance into the bootstrap boundary. `CoreSocket` may fetch raw bytes, but `WorldBootstrapper` owns deciding when the snapshot is accepted and when Stores are seeded.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts`, `src/server/services/world/WorldBootstrapper.ts`, `src/server/core/world/WorldStateStore.ts` if helper shape changes.

- [x] Move UserStore/UserPresence bootstrap seeding out of `CoreSocket.connect()` and into `WorldBootstrapper`.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts`, `src/server/services/world/WorldBootstrapper.ts`.

- [x] Update `SystemService` lifecycle events so `world:connected` can represent transport/world detection and `world:ready` represents app readiness. Status broadcasts should show `startup` during bootstrap and `active` after ready.
  Files: `src/server/core/system/SystemService.ts`, `src/server/realtime/SystemStatusBroadcaster.ts`, `src/server/services/status/StatusService.ts`.

- [x] Gate world-backed realtime/document behavior on application readiness. App socket status payloads may still flow during `startup`; document fan-out and request assumptions must not treat startup as ready.
  Files: `src/server/realtime/AppSocketGateway.ts`, `src/server/core/session/SessionManager.ts`, route middleware if needed.

- [x] Add lifecycle/bootstrapping tests that prove `active` is delayed until compendium discovery, primary Store seed, and adapter initialization complete.
  Files: `src/tests/unit/world/world-bootstrapper.test.ts`, `src/tests/unit/system/system-service-bootstrap.test.ts` if needed.

- [x] Verify Phase 5 with unit/type checks and lifecycle audits.
  Commands: `npm run test:unit`; `npx tsc --noEmit`; `git diff --check`; `rg -n "setWorldState\\('active'|setState\\('active'|foundry-world-active" src/server`.

**Phase 5 implementation note:** `CoreSocket` now treats Foundry-active as a bootstrap signal and leaves `WorldLifecycleStore` in `startup`. It exposes `getBootstrapSnapshot()` as a raw transport fetch and no longer seeds `WorldStateStore`, `UserStore`, `UserPresence`, or the adapter from `connect()`. `WorldBootstrapper` accepts the snapshot, seeds world/user state, runs compendium discovery and primary-document seeds, initializes the adapter, marks lifecycle `active`, and then calls the `SystemService` `world:ready` callback. `SystemService` starts the runtime heartbeat after readiness. `AppSocketGateway` still sends status during `startup`, but world-backed realtime fan-out drops until `SystemService.isReady()` is true.

**Non-goals for Phase 5:**

- No retry/backoff algorithm rewrite beyond separating transport from bootstrap.
- No primary-document seed optimization.
- No session restore state split.
- No URL utility extraction.

**Exit for Phase 5:** `active` means Sheet Delver bootstrap complete; `startup` covers the entire bootstrap window; `CoreSocket.connect()` no longer owns application Store seeding or adapter initialization; tests and audits pass.

### Phase 6: Closure and socket-boundary audit

**Status:** Completed May 20, 2026.

Phase 6 closed ADR-0017 and prepared the now-complete ADR-0018 residual pass.

**Action items:**

- [x] Remove transitional comments and dead fields left by Phases 1-5.
  Files: touched socket, world service, status, and ADR docs.

- [x] Update ADR-0014 / ADR-0016 references that named ADR-0017 leftovers as pending.
  Files: `docs/adr/0014-non-document-world-state-and-socket-boundary.md`, `docs/adr/0016-document-resolution-and-uuid-routing.md`.

- [x] Confirm the remaining `CoreSocket` surface is transport plus retry/backoff, and record the then-pending ADR-0018 leftovers. ADR-0018 has since closed them.
  Files: `docs/adr/0017-world-bootstrap-and-lifecycle-orchestration.md`.

- [x] Verify closure with targeted audits.
  Commands: `npm run test:unit`; `npx tsc --noEmit`; `git diff --check`; `rg -n "lastActorChange|updateActiveBrowserCount|activeBrowserCount|lastUserActivityTimestamp|heartbeatPaused|getSystemAdapter|loadSystemAdapter|private adapter" src/server`; `rg -n "actorSyncToken" src/server` (expected: status projection only); `rg -n "setWorldState\\('active'|setState\\('active'|foundry-world-active" src/server/core/foundry`.

- [x] Flip this ADR status to **Accepted** after all phases ship green.
  Files: `docs/adr/0017-world-bootstrap-and-lifecycle-orchestration.md`.

**Phase 6 implementation note:** `CoreSocket` no longer keeps public `gameDataCache`, `sceneDataCache`, `cachedWorldData`, `cachedWorlds`, `probeWorldData`, or `probeUserCount` mirrors. Setup cache, probe data, scene data, and connected-world snapshots live in `WorldStateStore`; `CoreSocket` only triggers raw reads/probes and clears runtime Store state on transport teardown. Stale ADR-0014 / ADR-0016 references now point at the completed ADR-0017 ownership split. ADR-0018 later closed the remaining URL/session boundary work.

**Non-goals for Phase 6:**

- No ADR-0018 URL/session cleanup.
- No ADR-0019 compatibility policy in this ADR; that follow-up is now completed by ADR-0019.
- No opportunistic refactors outside the named socket-boundary leftovers.

**Exit for Phase 6:** `WorldBootstrapper`, `EngagementService`, and `SyncTokenService` own their domains; sockets no longer own adapter state, engagement policy, application bootstrap, delayed-readiness semantics, or sync-token state; unit/type checks and audits pass; ADR status is accepted.

---

## Alternatives Considered

### Keep bootstrap in `SystemService`

Rejected because `SystemService` is already the public facade and event bridge. Keeping the whole bootstrap algorithm there makes it hard to test ordering, readiness, adapter ownership, and failure reset without dragging in the singleton service. `WorldBootstrapper` gives the sequence a focused, injectable home.

### Let `CoreSocket` keep writing `active`

Rejected because it preserves the current semantic bug. Foundry-active and Sheet-Delver-ready are different states. The gateway, routes, sessions, and status payload need `active` to mean the Stores and adapter are ready.

### Keep adapter cache on `CoreSocket`

Rejected because the adapter is resolved from active world system id and module registry state. It is neither socket state nor raw transport. Leaving it on the socket keeps route validation tied to a transport instance.

### Fold sync-token logic into `StatusService`

Viable, but a small `SyncTokenService` is preferred because the token is event-sourced and may be reused by status broadcasts, routes, or future clients without making `StatusService` subscribe to Store internals directly.

### Do seed-from-`game.data` optimization now

Rejected for scope. The bootstrap boundary must be clear first. After ADR-0017, a focused optimization can decide which primary-document Stores may seed from the accepted snapshot without changing lifecycle semantics.

---

## Consequences

### Positive

- Lifecycle semantics finally match the ADR-0014 contract.
- Bootstrap ordering becomes testable and injectable.
- Route validation no longer depends on socket-held adapter state.
- Browser engagement and heartbeat policy move out of transport.
- Status sync-token generation no longer leaks through `CoreSocket`.
- ADR-0018 later became a true residual cleanup pass rather than another architecture extraction.

### Tradeoffs

- Phase 5 is high risk because it changes lifecycle timing and reconnect/bootstrap sequencing.
- Some tests will need to distinguish transport-connected, Foundry-active, and Sheet-Delver-ready.
- The service boundaries introduce more small classes, but each class replaces state that currently lives in a large socket method.

---

## Related Decisions

- **ADR-0011** - established primary-document Stores and the deferred connect-handler split.
- **ADR-0014** - established Store ownership for world state and defined target lifecycle semantics.
- **ADR-0015** - extracted compendium service/shard work consumed during bootstrap.
- **ADR-0016** - extracted UUID routing, clearing the last dependency before bootstrap cleanup.
- **ADR-0018** - completed residual socket-boundary cleanup after this ADR.
- **ADR-0019** - uses `WorldBootstrapper` as the Foundry version compatibility insertion point.

---

## Validation

Each phase validates both behavior and boundary shrinkage.

- Sync-token tests prove status tokens no longer read from sockets.
- Engagement tests prove browser count and heartbeat delay policy no longer live on `CoreSocket`.
- Adapter audits prove socket classes no longer expose `getSystemAdapter` / `loadSystemAdapter`.
- Bootstrapper tests prove ordering, idempotence, and failure reset.
- Lifecycle tests prove `startup` remains visible until bootstrap completes and `active` follows `world:ready`.
- Closure audits confirm ADR-0017 leftovers are gone; ADR-0018 later closed the explicitly documented residuals.
- `git diff --check`, `npx tsc --noEmit`, and `npm run test:unit` pass for every phase before moving to the next.

---

## Exit Criteria

This ADR is fulfilled when world bootstrap and readiness are service-owned and sockets no longer own application orchestration.

- [x] Phase 1: `SyncTokenService` replaces `CoreSocket.lastActorChange`.
- [x] Phase 2: `EngagementService` owns browser engagement and heartbeat policy.
- [x] Phase 3: active adapter ownership moves out of sockets.
- [x] Phase 4: `WorldBootstrapper` owns bootstrap orchestration behind behavior-preserving timing.
- [x] Phase 5: `active` is delayed until Sheet Delver bootstrap completes and `CoreSocket.connect()` no longer seeds application Stores.
- [x] Phase 6: closure audits pass and ADR-0017 status flips to **Accepted**.
- [x] No tracked tests use real world or compendium dumps as fixtures.
- [x] `git diff --check`, `npx tsc --noEmit`, and `npm run test:unit` pass.

ADR-0018 closed the residual socket-boundary enforcement pass. ADR-0019 then completed the Foundry version compatibility follow-up.
