# ADR-0023: Foundry Socket Transport Boundary and Post-ADR-0022 Stabilization

**Status:** Completed.
**Date:** May 29, 2026
**Phase:** Transport Boundary Completion
**Supersedes:** None
**Revises:** ADR-0014 (socket boundary), ADR-0017 (world bootstrap / lifecycle ownership), ADR-0021 (engagement gates), ADR-0022 (core cleanup and boundary completion)
**Related:** ADR-0011 (primary document model), ADR-0014 (non-document world state and socket boundary), ADR-0017 (world bootstrap and lifecycle orchestration), ADR-0021 (startup compendium cataloging and engagement gates), ADR-0022 (core cleanup and boundary completion).

---

## Context

ADR-0014 through ADR-0022 progressively moved application state out of sockets, clarified Store ownership, introduced world lifecycle orchestration, split compendium behavior, added engagement gates, and finally removed the most obvious `core/` -> `services/` import violations.

That work improved the dependency graph, but it did not fully change the shape of the Foundry socket layer. The issue is not limited to `CoreSocket`.

At the start of this ADR, `CoreSocket` still owned or directly touched:

- the Socket.io client instance, connection/login/session mechanics, and emit/ack timeouts
- heartbeat scheduling and reconnect timing
- retry/backoff counters
- world lifecycle transitions through `WorldLifecycleStore`
- cache and Store teardown on disconnect
- user presence mutation
- document mutation routing through `modifyDocumentRouter`
- shared-content Store clearing
- Foundry progress/shutdown/reload interpretation
- `launchWorld()` / `shutdownWorld()` stubs
- an injected engagement policy that asks service-layer questions from inside the transport class

`SocketBase` also crossed the target boundary:

- `setupSharedContentListeners(...)` listens to Foundry `shareImage` / `showEntry` events and writes directly to `SharedContentStore`
- `probeWorldState(...)` mixes transport probing with world/system/user discovery data that callers use as application identity/context

`ClientSocket` had the same class of issue in a smaller surface:

- it imports `UserStore` and uses Store readiness plus `findByName(...)` while establishing socket identity
- it falls back to `probeWorldState(...)?.users` to resolve the Foundry user id
- it installs `SocketBase` shared-content listeners, which write to `SharedContentStore`
- it relays Foundry `shutdown` / `reload` as application-named lifecycle events

ADR-0022 fixed the `CoreSocket` import direction by injecting `CoreSocketEngagementPolicy` instead of importing `EngagementService` into `CoreSocket`. That was a useful boundary repair, but it was not the final architecture. It kept the policy questions inside the socket:

- should reconnect happen after this disconnect?
- should heartbeat run in this lifecycle state?
- what is the next heartbeat delay?
- should this operation pause heartbeat?

Those are service/controller decisions. A transport should expose connection primitives and raw protocol events. It should not interpret world lifecycle, decide engagement policy, mutate Stores, resolve application identity from Stores, or route domain events.

The post-ADR-0022 audit also found smaller stabilization issues: registry satellite files import back through `./server`, `registry/core/server.ts` still has unused imports after the split, `CoreSocket.launchWorld()` / `shutdownWorld()` are empty while admin routes report success, and a few local hygiene items remain. Those are still valid, but the deeper issue is the socket-layer shape. ADR-0023 therefore makes transport-boundary completion the primary decision and treats registry/local cleanup as supporting stabilization work.

---

## Decision

ADR-0023 makes six decisions.

1. **Make the Foundry socket layer transport-only.** `SocketBase`, `CoreSocket`, and `ClientSocket` own connection mechanics, low-level Socket.io event binding, session/cookie transport facts, and emit/ack/timeout helpers. They emit neutral transport/protocol events upward. They do not decide lifecycle policy, mutate application Stores, route document changes, or resolve application identity from Stores.

2. **Introduce service-layer owners for interpretation.** A world transport controller owns heartbeat, reconnect/backoff, lifecycle transitions, engagement policy, and admin world-control orchestration. A Foundry event ingress service owns translation from raw Foundry protocol events into Stores/application events.

3. **Move Foundry user connection orchestration above `ClientSocket`.** A service-layer `FoundryUserConnectionService` owns per-user upstream Foundry connection lifecycle and uses `ClientSocket` as transport. A `FoundryUserIdentityResolver` chooses the Foundry user id before the socket connects. `ClientSocket` can hold the resolved transport identity, but it should not consult `UserStore` or use world discovery as an application fallback. App-admin/backend sessions stay separate under `src/server/security`.

4. **Remove policy injection from `CoreSocket`.** The injected policy was an intermediate ADR-0022 compromise. After the controller extraction, services own policy directly and command the transport. `CoreSocket` no longer asks engagement questions.

5. **Make admin world control truthful after the controller exists.** `launchWorld` / `shutdownWorld` behavior belongs to the service/controller layer. The controller may use `CoreSocket` to dispatch raw Foundry payloads, but routes may not report success through empty transport methods.

6. **Keep the registry and local hygiene work, but sequence it behind or alongside the transport boundary.** The registry cycle, stale imports, ESLint warning, empty fixture directory, and stale combat TODO remain valid cleanup tasks. They should not distract from the fundamental socket-boundary correction.

---

## Details

### Transport-Only Contract

The target Foundry socket role:

```text
SocketBase / CoreSocket / ClientSocket
  Owns:
    - Socket.io client instance
    - connect / disconnect / login / setup handshake mechanics
    - session id, cookie, and transport identity facts already resolved for the socket
    - emitSocketEvent(event, ...payloads) with ack timeout behavior
    - low-level Foundry socket listener registration
    - neutral upward events

  Does not own:
    - heartbeat scheduling
    - reconnect/backoff policy
    - world lifecycle state transitions
    - engagement/idle policy
    - application Store mutation
    - modifyDocument routing
    - proactive Store mutation from dispatch acknowledgements
    - user presence mutation
    - shared-content mutation
    - user identity lookup from application Stores
    - world/system/user discovery ownership
    - setup-cache loading or cached-world Store seeding
    - compendium/world cache teardown policy
    - admin world-control success semantics
```

The sockets may still maintain transport-local state such as "is a connection attempt currently in progress?" because that protects the socket primitive itself. Retry count, next heartbeat delay, world lifecycle state, engagement decisions, shared-content snapshots, and application identity decisions move out.

The transport emits neutral events. Exact names can change during implementation, but the shape should be close to:

```ts
type FoundrySocketEvents = {
    'transport:connected': { userId: string | null };
    'transport:disconnected': { reason: string };
    'transport:error': { error: Error };
    'foundry:session': { userId?: string };
    'foundry:shutdown': void;
    'foundry:reload': void;
    'foundry:progress': unknown;
    'foundry:modifyDocument': unknown;
    'foundry:documentCompatibility': unknown;
    'foundry:documentDispatchConfirmed': unknown;
    'foundry:shareImage': unknown;
    'foundry:showEntry': unknown;
    'foundry:userConnected': unknown;
    'foundry:userDisconnected': unknown;
    'foundry:userActivity': unknown;
};
```

The key rule is that these are facts from the transport/protocol, not application decisions. A socket can say "Foundry emitted shutdown" or "Foundry emitted showEntry." It should not itself decide "set world lifecycle to setup, clear these Stores, start heartbeat, reconnect, and update the shared-content snapshot."

### Service-Layer Controllers

ADR-0023 introduces four owners above transport.

**World transport controller** (name can settle during implementation: `WorldTransportController`, `SystemTransportController`, or similar):

- owns heartbeat start/stop/schedule
- owns retry/backoff counters
- owns engagement policy decisions
- listens to neutral service-account transport events
- updates `WorldLifecycleStore`
- commands `CoreSocket.connect()` / `disconnect()` / raw emits
- coordinates launch/shutdown requests
- invokes bootstrap/readiness orchestration through `SystemService` / `WorldBootstrapper`

**Foundry event ingress**:

- listens to raw Foundry protocol events from `CoreSocket` and `ClientSocket`
- routes `modifyDocument` into `modifyDocumentRouter`
- updates `userPresence`
- updates `SharedContentStore` for shared image / journal events
- clears Stores when directed by lifecycle/controller events
- emits application-level invalidation/status events

**Foundry user connection service**:

- owns user-scoped upstream Foundry connection lifecycle
- creates, restores, tracks, and destroys `ClientSocket` instances
- owns persisted Foundry connection cache/restore policy and world-binding checks
- exposes login/logout/restore/dispatch access to HTTP/realtime callers
- does not own app-admin/backend sessions

**Foundry user identity resolver**:

- resolves a user-scoped Foundry user id before `ClientSocket` connects
- may consult `UserStore`, bootstrap results, or discovery services from the service layer
- passes resolved identity and credentials into `ClientSocket`
- owns fallback behavior when user identity cannot be resolved

This split keeps the socket classes mechanical while preserving the behavior the app already depends on.

### State Ownership Map

| Concern | Target owner |
| --- | --- |
| Socket.io client instance | `SocketBase` / `CoreSocket` / `ClientSocket` |
| Connect/disconnect handshakes | `SocketBase` / `CoreSocket` / `ClientSocket` |
| Transport session id / cookie | `SocketBase` |
| Emit/ack timeout mechanics | `CoreSocket` / `ClientSocket` |
| World/user discovery probing | service-layer discovery / `FoundryUserIdentityResolver` |
| User-scoped Foundry socket identity | `FoundryUserConnectionService` / `FoundryUserIdentityResolver` |
| Foundry user connection cache/restore policy | `FoundryUserConnectionService` |
| App-admin/backend session claims | `src/server/security/adminSessionService.ts` |
| Retry/backoff count | World transport controller |
| Heartbeat timer | World transport controller |
| Engagement policy | `EngagementService` / world transport controller |
| World lifecycle transitions | `SystemService` / world transport controller |
| World/bootstrap readiness | `WorldBootstrapper` / `SystemService` |
| Setup-mode cached world loading | setup/cache bootstrap owner + `WorldStateStore` |
| Store clearing on teardown | lifecycle/controller + ingress service |
| `modifyDocument` Store routing, including legacy user events and dispatch confirmations | Foundry event ingress |
| User presence mutation | Foundry event ingress |
| Shared-content mutation | Foundry event ingress |
| Admin launch/shutdown success contract | Admin service + world transport controller |

This table is the heart of the ADR. A future change that adds application meaning to `SocketBase`, `CoreSocket`, or `ClientSocket` should be treated as a boundary regression unless it is explicitly transport-local.

### Event Ingress Boundary

Foundry document and shared-content events are transport input, but Store mutation is application behavior. Today `CoreSocket` receives `modifyDocument` and immediately calls `_routeModifyDocument(...)`, which routes into the primary-document Stores. It also routes legacy `createUser` / `updateUser` / `deleteUser` events and proactively mirrors successful `dispatchDocumentSocket(...)` acknowledgements into Stores. `SocketBase.setupSharedContentListeners(...)` receives `shareImage` / `showEntry` and writes directly to `SharedContentStore`. These paths all couple transport to application model ownership.

Target flow:

```text
CoreSocket receives Foundry modifyDocument
  -> emits foundry:modifyDocument
  -> FoundryEventIngress receives event
  -> FoundryEventIngress calls modifyDocumentRouter.route(...)
  -> Stores emit application invalidations
```

The same boundary applies to compatibility events and dispatch confirmations:

```text
CoreSocket receives createUser/updateUser/deleteUser
  -> emits neutral Foundry document compatibility event
  -> FoundryEventIngress normalizes to document mutation
  -> FoundryEventIngress calls modifyDocumentRouter.route(...)

CoreSocket dispatches modifyDocument and receives an ack
  -> returns raw ack to caller and/or emits document dispatch confirmation
  -> FoundryEventIngress owns any proactive Store apply
```

The same pattern applies to shared content:

```text
SocketBase-derived socket receives Foundry shareImage/showEntry
  -> emits foundry:shareImage/foundry:showEntry
  -> FoundryEventIngress receives event
  -> FoundryEventIngress updates SharedContentStore
  -> gateway/status broadcaster fans out app-level updates
```

And to user presence:

```text
CoreSocket receives userConnected/userDisconnected/userActivity
  -> emits raw user event
  -> FoundryEventIngress updates userPresence
  -> status broadcaster/app gateway fans out app-level updates
```

This is not a behavior redesign. It is an ownership move.

### Foundry User Connection Boundary

`ClientSocket` is user-scoped Foundry transport. It can carry a resolved Foundry user id and restored credential, but it should not be responsible for application identity lookup or connection lifecycle orchestration. At the start of this ADR it imported `UserStore`, checked Store readiness, called `findByName(...)`, and fell back to `probeWorldState(...)?.users`. `src/server/core/session/SessionManager.ts` also owned app-level Foundry connection lifecycle, persisted restore policy, and world-binding checks from inside `core/`.

Those responsibilities should move to service boundaries:

- `FoundryUserConnectionService` owns per-user upstream Foundry connection lifecycle and uses `ClientSocket` as transport.
- `FoundryUserIdentityResolver` resolves username/restored credential input to a Foundry user id.
- `ClientSocket` performs only user-scoped Foundry login/connect/emit/disconnect.

Target flow:

```text
HTTP/realtime caller requests user Foundry connection
  -> FoundryUserConnectionService coordinates login/restore/destroy
  -> FoundryUserIdentityResolver resolves Foundry user id
  -> FoundryUserConnectionService creates ClientSocket with resolved identity/credential
  -> ClientSocket performs transport login/connect only
  -> ClientSocket emits neutral session/transport events
  -> FoundryUserConnectionService exposes the connected transport to callers
```

`probeWorldState(...)` can remain as a low-level probe helper only if it returns raw discovery data to a service-layer owner. If callers use that data to decide user identity, readiness, or world state, that decision belongs outside `SocketBase`.

### App Admin Session Boundary

App-admin/backend sessions are a separate concern from upstream Foundry user connections. They are represented by `AdminSessionClaims` with `principalType: 'app-admin'` and live under `src/server/security/adminSessionService.ts`.

ADR-0023 does not move admin auth/session behavior into `FoundryUserConnectionService`, even if future admin backend features use a socket or other transport. The naming is intentional:

```text
src/server/security/adminSessionService.ts
  -> app-admin/backend authentication sessions

FoundryUserConnectionService
  -> per-user upstream Foundry connection lifecycle

ClientSocket
  -> upstream Foundry user transport only
```

### Setup Cache Boundary

Setup-mode cached world loading is also outside transport. Today `CoreSocket.loadInitialCache()` reads `SetupManager.loadCache()` and writes `worldStateStore.setCachedWorlds(...)` because `CoreSocket` already owns startup. Under the target boundary, startup/cache hydration belongs to the world/bootstrap/setup-cache owner:

```text
App startup / world bootstrap owner
  -> loads setup cache via SetupManager or successor
  -> seeds WorldStateStore cached-world projection

CoreSocket
  -> does not import SetupManager
  -> does not write cached-world Store state
```

The socket can still report raw transport facts that help the controller decide whether setup mode is reachable. It should not load disk-backed setup state or mutate the world Store.

### Lifecycle and Engagement Boundary

Heartbeat and reconnect are not transport-only behaviors in this app. They depend on:

- current world lifecycle state
- setup/offline/startup/active distinction
- browser engagement policy
- bootstrap readiness
- retry/backoff timing

Those belong above the service-account transport.

Target flow:

```text
CoreSocket emits transport:disconnected(reason)
  -> WorldTransportController decides whether this was expected
  -> EngagementService / lifecycle state decide whether reconnect is allowed
  -> controller schedules heartbeat or reconnects the transport
```

`CoreSocket.startRuntimeHeartbeat()`, `startHeartbeat(...)`, `withHeartbeatPaused(...)`, `setEngagementPolicy(...)`, `NOOP_ENGAGEMENT_POLICY`, and the policy interface should disappear from `CoreSocket` as part of the extraction. Equivalent behavior moves into the controller.

### Admin World Control Contract

World launch/shutdown should not be transport methods with application success semantics. The controller/service owns the operation:

```text
POST /api/admin/world/launch
  -> AdminService.launchWorld(worldId)
  -> WorldTransportController.launchWorld(worldId)
  -> CoreSocket.emitSocketEvent(raw Foundry payload)
```

The route can return success only when the controller knows the request was accepted by the transport/Foundry layer. If the supported Foundry launch/shutdown payload cannot be verified, the admin controls and routes should be disabled or removed rather than left as no-ops.

`CoreSocket` may expose a generic emit helper or a narrow raw transport method, but it should not decide lifecycle consequences or fabricate success messages.

### Registry and Local Stabilization

The non-socket Audit A findings remain valid:

- remove unused declarations from `src/modules/registry/core/server.ts`
- break registry satellite imports back to `./server`
- fix the `ModuleLifecycleControl` expression-statement warning
- delete the unused empty `src/tests/fixtures/world/` directory if no placeholder convention exists
- rewrite or remove the stale combat-route TODO

These are included in ADR-0023 because they came from the same post-ADR-0022 audit. They are mechanically independent and can land before, during, or after the transport-boundary phases.

---

## What Stays Out

- ADR-0023 does not change app-admin authentication/session behavior under `src/server/security`.
- ADR-0023 does not change the client/UI architecture from Audit B.
- ADR-0023 does not solve the broader test-runner/coverage issues from Audit C.
- ADR-0023 does not do SDK alignment work.
- ADR-0023 does not enable `noUnusedLocals` globally; that is a separate hygiene pass.
- ADR-0023 does not split `registerAdminModuleRoutes.ts` immediately. Revisit if it approaches 1000 LoC or source-profile CRUD grows into a separate domain.
- ADR-0023 does not extract the `CompendiumService` fallback ladder immediately. Extract it when the file is already being touched for compendium behavior or when tests can lock the ladder semantics down.

---

## ADR-0023 Phase Staging

### Phase 1: Characterize and Define the Transport Contract

**Status:** Completed.

Before moving behavior, lock down the current socket-layer behaviors that must survive extraction and define the neutral event surface.

**Action items:**

- [x] Add or update tests that characterize the current important `CoreSocket` behaviors: connect/disconnect event handling, `modifyDocument` ingress, user presence ingress, shutdown/reload/progress handling, heartbeat/reconnect triggers, and store clearing on teardown.
  Files: `src/tests/unit/sockets/`, existing socket/service tests as appropriate.

- [x] Add or update tests that characterize `SocketBase` shared-content ingress and `ClientSocket` user identity/connection behavior.
  Files: `src/tests/unit/sockets/`, existing session tests as appropriate.

- [x] Define the typed neutral event contract emitted by the socket layer.
  Files: `src/server/core/foundry/sockets/` or a nearby transport event type file.

- [x] Add neutral event emission in parallel with the current in-place behavior where useful, so later extraction can be reviewed in smaller diffs.
  Files: `src/server/core/foundry/sockets/{SocketBase.ts,CoreSocket.ts,ClientSocket.ts}`.

**Exit for Phase 1:** tests describe the current behavior; the target socket event surface is explicit; no runtime ownership has moved yet unless covered by tests.

### Phase 2: Extract Foundry Event Ingress

**Status:** Completed.

Move application Store mutation and document/user/shared-content event interpretation out of the socket layer.

**Action items:**

- [x] Create a Foundry event ingress service that subscribes to socket neutral events.
  Files: `src/server/services/world/FoundryEventIngress.ts` or another service-layer location chosen during implementation.

- [x] Move all document Store routing out of `CoreSocket` into the ingress service: inbound `modifyDocument`, legacy `createUser` / `updateUser` / `deleteUser`, and proactive Store applies from `dispatchDocumentSocket(...)` acknowledgements.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts`, `src/server/services/world/FoundryEventIngress.ts`.

- [x] Move user presence mutation out of `CoreSocket` into the ingress service.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts`, `src/server/services/world/FoundryEventIngress.ts`.

- [x] Move shared-content mutation out of `SocketBase` into the ingress service.
  Files: `src/server/core/foundry/sockets/SocketBase.ts`, `src/server/services/world/FoundryEventIngress.ts`.

- [x] Move `ClientSocket` `shutdown` / `reload` relays out of app-named `worldShutdown` / `worldReload` events and into neutral Foundry protocol events consumed by the ingress/controller/status broadcaster.
  Files: `src/server/core/foundry/sockets/ClientSocket.ts`, `src/server/realtime/AppSocketGateway.ts`, `src/server/services/world/FoundryEventIngress.ts`.

- [x] Move Store/cache clearing triggered by transport/lifecycle events out of `CoreSocket`; the controller or ingress service should own the teardown decision.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts`, service-layer owner chosen during implementation.

**Exit for Phase 2:** socket files no longer import primary Stores, `modifyDocumentRouter`, `userPresence`, `worldStateStore`, `sharedContentStore`, or `compendiumStore`; `CoreSocket` no longer calls `_routeModifyDocument(...)`; `ClientSocket` no longer emits app-named lifecycle events; unit tests prove document/user/shared-content/lifecycle-relay/teardown behavior still works.

### Phase 3: Extract Lifecycle, Heartbeat, and Engagement Control

**Status:** Completed.

Move the remaining lifecycle policy out of `CoreSocket`.

**Action items:**

- [x] Create a world transport controller that owns heartbeat timers, retry/backoff counters, reconnect policy, and engagement integration.
  Files: `src/server/services/world/WorldTransportController.ts` or equivalent.

- [x] Move `startHeartbeat(...)`, runtime heartbeat scheduling, reconnect-after-disconnect decisions, and heartbeat pause behavior out of `CoreSocket`.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts`, `src/server/services/world/WorldTransportController.ts`.

- [x] Remove `CoreSocketEngagementPolicy`, `NOOP_ENGAGEMENT_POLICY`, `setEngagementPolicy(...)`, and `startRuntimeHeartbeat()` from `CoreSocket` once the controller owns the behavior.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts`.

- [x] Move `CoreSocket.loadInitialCache()` behavior out of the socket. Setup cache loading and `worldStateStore.setCachedWorlds(...)` should be performed by the world/bootstrap/setup-cache owner during startup.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts`, `src/server/services/world/SystemService.ts` or setup-cache owner chosen during implementation.

- [x] Retire the remaining ADR-0022 Phase 2 plumbing now that the controller commands the transport directly: remove `CoreSocketTransportCallbacks`, `getTransportCallbacks()`, and the locally-redeclared `WorldBootstrapSnapshot` interface from `CoreSocket`. If `CoreSocket.getBootstrapSnapshot()` remains, its return type must come from a neutral core/shared transport contract (for example `FoundryBootstrapSnapshot`), not `services/world`; otherwise move snapshot production into the controller/bootstrapper and remove the socket method. The corresponding `EngagementService.setTransportCallbacks(...)` bridge wired in `SystemService.initialize(...)` should also be unwound. Update or replace `engagement-service.test.ts` so it asserts the controller's behavior instead of the now-removed bridge.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts`, `src/server/services/world/SystemService.ts`, `src/server/services/world/EngagementService.ts`, `src/tests/unit/services/engagement-service.test.ts`.

- [x] Wire the controller from `SystemService.initialize(...)` or another service-layer composition point.
  Files: `src/server/services/world/SystemService.ts`, `src/server/services/world/index.ts`.

**Exit for Phase 3:** `CoreSocket` no longer receives policy; heartbeat/reconnect behavior lives above transport; setup cache loading no longer happens in the socket; `rg "EngagementPolicy|NOOP_ENGAGEMENT_POLICY|setEngagementPolicy|startHeartbeat|TransportCallbacks|getTransportCallbacks|export interface WorldBootstrapSnapshot|SetupManager|setCachedWorlds" src/server/core/foundry/sockets/CoreSocket.ts` shows no policy, callback, locally-redeclared bootstrap type, or setup-cache ownership; the ADR-0022 Phase 2 engagement bridge in `SystemService.initialize(...)` is removed; tests pass.

### Phase 4: Extract Foundry User Connection Orchestration

**Status:** Completed.

Move application user lookup, discovery fallback, and per-user upstream Foundry connection lifecycle out of `core/session` and user-scoped transport.

**Action items:**

- [x] Create `FoundryUserConnectionService` to own per-user upstream Foundry connection lifecycle and use `ClientSocket` as transport.
  Files: `src/server/services/foundry/FoundryUserConnectionService.ts` or another clearly Foundry-scoped service location chosen during implementation.

- [x] Create `FoundryUserIdentityResolver` to resolve Foundry user ids before `ClientSocket.connect()`.
  Files: `src/server/services/foundry/FoundryUserIdentityResolver.ts` or another clearly Foundry-scoped service location chosen during implementation.

- [x] Move `core/session/SessionManager` orchestration, persisted Foundry connection cache/restore policy, and world-binding checks into the Foundry user connection service. Keep a temporary compatibility facade only if required by route/gateway migration.
  Files: `src/server/core/session/SessionManager.ts`, `src/server/services/foundry/FoundryUserConnectionService.ts`, app composition wiring.

- [x] Migrate all HTTP/realtime consumers from the concrete `SessionManager` / `SessionManagerLike` boundary to the Foundry user connection abstraction. This includes route registration, socket registration, auth middleware, initialization middleware, realtime gateway auth, status service readiness, debug session lookup, shared request/session types, and the app composition root.
  Files: `src/server/index.ts`, `src/server/app/registerRoutes.ts`, `src/server/app/registerSockets.ts`, `src/server/middleware/{authenticateSession.ts,tryAuthenticateSession.ts,ensureInitialized.ts}`, `src/server/realtime/AppSocketGateway.ts`, `src/server/services/status/StatusService.ts`, `src/server/routes/{public/registerPublicRoutes.ts,debug/registerDebugRoutes.ts}`, `src/server/services/debug/DebugService.ts`, `src/server/shared/types/foundry.ts`, `src/server/types/express.d.ts`, `src/server/shared/types/moduleProxy.ts`.

- [x] Replace or rename `SessionManagerLike` / `UserSessionLike` contracts so their names describe Foundry user connections, not generic app/admin sessions.
  Files: `src/server/shared/types/foundry.ts`, consumers listed above.

- [x] Remove `UserStore` imports and Store readiness checks from `ClientSocket`.
  Files: `src/server/core/foundry/sockets/ClientSocket.ts`.

- [x] Move any `probeWorldState(...)` identity fallback behind `FoundryUserIdentityResolver`, or extract the probe into a service-layer discovery component.
  Files: `src/server/core/foundry/sockets/SocketBase.ts`, `src/server/services/foundry/FoundryUserIdentityResolver.ts`, service-layer owner chosen during implementation.

- [x] Keep `ClientSocket` responsible only for user-scoped login/connect, restored-cookie transport mechanics, emit/ack helpers, and neutral protocol events.
  Files: `src/server/core/foundry/sockets/ClientSocket.ts`.

- [x] Leave app-admin/backend sessions under `src/server/security/adminSessionService.ts`; do not merge them into the Foundry user connection service.
  Files: `src/server/security/adminSessionService.ts`, `src/server/security/types/admin-auth.types.ts`.

**Exit for Phase 4:** `core/session` no longer owns Foundry user connection orchestration; app/middleware/realtime/status/debug callers depend on the Foundry user connection abstraction rather than concrete `SessionManager`; `ClientSocket` no longer imports `UserStore` or resolves user identity from world discovery; user-scoped transport receives identity from `FoundryUserConnectionService`; app-admin sessions remain isolated under `src/server/security`; tests cover login, restore, auth middleware, realtime gateway auth, and restored credential paths.

### Phase 5: Implement Truthful World Control Through the Controller

**Status:** Completed.

Fill or remove admin launch/shutdown behavior after the transport controller exists.

**Action items:**

- [x] Verify the supported Foundry world launch/shutdown payloads for the service-account transport.
  Files: implementation notes in this ADR or nearby code comments.
  Note: verified against the local Foundry v13 source in `temp/foundry.mjs`: setup launch posts `{ action: "launchWorld", world }` to `/setup`; active-world shutdown posts `{ shutdown: true }` to `/setup`.

- [x] Implement `launchWorld(worldId)` / `shutdownWorld()` on the service/controller layer, using `CoreSocket` only for raw transport dispatch.
  Files: `src/server/services/world/WorldTransportController.ts`, `src/server/core/foundry/sockets/CoreSocket.ts` only if a raw helper is needed.

- [x] Update `AdminService` and `registerAdminWorldRoutes` so success means the controller accepted/confirmed the request.
  Files: `src/server/services/admin/AdminService.ts`, `src/server/routes/admin/registerAdminWorldRoutes.ts`.

- [x] Add tests for success and failure paths. A failed dispatch must not return route/service success.
  Files: `src/tests/unit/sockets/`, `src/tests/unit/admin/` or `src/tests/unit/routes/`.

- [x] If the Foundry payload cannot be verified, disable or remove the admin UI controls and route handlers instead of preserving no-ops.
  Files: `src/app/(admin)/components/WorldManagementPanel.tsx`, `src/server/routes/admin/registerAdminWorldRoutes.ts`, `src/server/services/admin/AdminService.ts`.
  Note: not needed after payload verification; controls remain enabled and now fail closed on rejected dispatch.

**Exit for Phase 5:** admin launch/shutdown cannot return success through an empty transport method; world-control policy is in the service/controller layer; tests cover success and failure behavior.

### Phase 6: Registry and Local Hygiene

**Status:** Completed.

Close the independent post-split cleanup items.

**Action items:**

- [x] Remove unused declarations from `src/modules/registry/core/server.ts`.
  Files: `src/modules/registry/core/server.ts`.

- [x] Move `FALLBACK_ADAPTER`, `initializeRegistry`, and `refreshRegistry` out of `server.ts` so registry satellites no longer import from `./server`.
  Files: `src/modules/registry/core/{server.ts,bootstrap.ts,fallbackAdapter.ts,adapterResolution.ts,moduleSources.ts,managedModules.ts,lifecyclePreflight.ts}`.

- [x] Preserve the public `@modules/registry/server` export surface.
  Files: `src/modules/registry/core/server.ts`, `src/modules/registry/server.ts`.

- [x] Fix the `ModuleLifecycleControl` ternary expression statement.
  Files: `src/app/(admin)/components/ModuleLifecycleControl.tsx`.

- [x] Delete `src/tests/fixtures/world/` if no intentional placeholder convention exists.
  Files: `src/tests/fixtures/world/`.

- [x] Rewrite or remove the stale combat-route TODO. Per Audit B §2.11, the next/previous-turn endpoints exist and `CombatService.advanceTurn()` updates round/turn correctly — the TODO is scoped to a narrower `actorId`-keyed auto-advance ("add next or finish round if `actorId` matches current `combatant.actorId`"). Either implement that narrower behavior or close the TODO; do not treat this as a missing endpoint.
  Files: `src/server/routes/protected/registerCombatRoutes.ts`.

- [x] Document the `lifecycleStore` mutation contract: the `const` re-export at `src/modules/registry/core/state.ts:43` must always be mutated in-place (e.g. `lifecycleStore.modules = X`), never replaced through `registryState.lifecycleStore = X`. Add a short comment at the export site explaining why (per Audit D §4). Optionally extract a helper to force in-place writes.
  Files: `src/modules/registry/core/state.ts`.

- [x] Note the `IS_DEV` capture in `src/modules/registry/core/state.ts:53` (per Audit D §5). The constant is evaluated once at module load, so tests that flip `NODE_ENV` afterward will not see the change. If any new behavior gates on `IS_DEV`, convert to a `getIsDev()` thunk. No code change required today — this is a one-line comment and a forward note.
  Files: `src/modules/registry/core/state.ts`.

**Exit for Phase 6:** registry satellites do not import from `./server`; local hygiene items are closed; `npx tsc --noEmit`, `npm run test:unit`, and targeted ESLint for `ModuleLifecycleControl.tsx` are clean.

### Phase 7: Close-Out

**Status:** Completed.

Document and verify the completed transport boundary.

**Action items:**

- [x] Update this ADR's phase statuses as work lands.
- [x] Update `docs/architecture.md` with the new transport/controller/ingress ownership map.
- [x] Run boundary greps:
  - `rg "modifyDocumentRouter|actorStore|userStore|userPresence|worldStateStore|worldLifecycleStore|sharedContentStore|compendiumStore" src/server/core/foundry/sockets`
  - `rg "_routeModifyDocument|worldShutdown|worldReload" src/server/core/foundry/sockets`
  - `rg "EngagementPolicy|NOOP_ENGAGEMENT_POLICY|setEngagementPolicy|startHeartbeat|TransportCallbacks|getTransportCallbacks|export interface WorldBootstrapSnapshot|SetupManager|setCachedWorlds" src/server/core/foundry/sockets`
  - `test ! -d src/server/core/session`
  - `rg "SessionManagerLike|UserSessionLike|@core/session/SessionManager|core/session|\\bSessionManager\\b" src/server/{app,middleware,realtime,services,routes,shared,types}`
  - `rg "@server/services|services/world|services/system" src/server/core`
  - `rg "from './server'" src/modules/registry/core`
- [x] Run `npx tsc --noEmit` and `npm run test:unit`.

**Exit for Phase 7:** `SocketBase`, `CoreSocket`, and `ClientSocket` are transport-only by the ownership map above; services/controllers own lifecycle, engagement, ingress, Foundry user connection orchestration, identity resolution, and world control; app-admin sessions remain under `src/server/security`; ADR-0023 can be marked accepted/completed.

---

## Alternatives Considered

### Continue with ADR-0022's policy injection model

Rejected. Policy injection fixed import direction but left policy questions inside transport. It is a valid intermediate step, not the final architecture.

### Require engagement policy in the CoreSocket constructor

Rejected. Constructor injection would make unwired sockets harder to create, but it would still make `CoreSocket` ask lifecycle/engagement questions. That improves safety without changing ownership.

### Keep SocketBase shared-content writes as the ADR-0014 exception

Rejected. ADR-0014 accepted the socket as the wire-event source while `SharedContentStore` owned the canonical snapshot. Under the stricter transport-only target, the socket should still be the event source, but the Store write belongs to ingress.

### Let ClientSocket resolve users from UserStore

Rejected. The lookup is convenient, but it ties user-scoped transport to application bootstrap timing and Store readiness. `FoundryUserIdentityResolver` can perform the same lookup and hand `ClientSocket` a resolved transport identity.

### Put Foundry user connection orchestration in a generic SessionService

Rejected. This app already has app-admin/backend sessions under `src/server/security`. A generic session service would blur admin auth, browser session claims, and upstream Foundry user connections. The new service name should make the upstream Foundry connection scope explicit.

### Move `EngagementService` back into `CoreSocket`

Rejected. That would restore the old boundary violation and make transport even less transport-only.

### Rewrite the socket layer in one big replacement

Rejected. The direction is a real boundary rewrite, but the implementation should be staged. Characterization tests and neutral events allow behavior to move without a high-risk big bang.

### Implement world controls directly in CoreSocket first

Rejected. That would add more application behavior to the class we are trying to shrink. World controls should be implemented through the service/controller layer after or during extraction.

### Treat registry cleanup as a separate ADR

Considered. The registry work is mechanically independent, but it came from the same post-ADR-0022 audit and is small enough to keep as a later phase here. If the transport-boundary work grows too large, the registry/local hygiene phase can be split into a separate ADR without changing the socket decision.

---

## Consequences

- The Foundry socket layer becomes easier to reason about: it transports Foundry protocol facts and commands, not application policy.
- World lifecycle, engagement, and reconnect behavior become testable without constructing a transport-heavy socket.
- Store mutation, document ingress, shared-content ingress, and Foundry user identity resolution move to service owners where application semantics belong.
- Foundry user connection lifecycle moves out of `core/session` into a Foundry-scoped service boundary.
- App-admin/backend sessions stay isolated under `src/server/security`, even if future admin backend features use a socket or other transport.
- Admin launch/shutdown becomes a truthful service operation instead of an empty transport method with route-level success.
- ADR-0022's import-boundary improvement is preserved, but ADR-0023 completes the deeper behavioral boundary it only hinted at.
- The extraction touched sensitive startup/reconnect behavior, so controller, ingress, gateway, restore, and boundary tests are part of the completion bar.

---

## Verification Checklist

- [x] `SocketBase`, `CoreSocket`, and `ClientSocket` no longer import or reference application Stores, `modifyDocumentRouter`, `userPresence`, or world lifecycle Stores.
- [x] `CoreSocket` no longer defines or consumes engagement policy.
- [x] Heartbeat/reconnect/backoff behavior is owned by a service-layer controller.
- [x] Foundry document, user, and shared-content events route through an ingress service.
- [x] Legacy document compatibility events and dispatch acknowledgements do not mutate Stores from socket classes.
- [x] Setup-cache loading and cached-world Store seeding do not happen in `CoreSocket`.
- [x] User-scoped Foundry lifecycle relays are neutral protocol events, not app-named `ClientSocket` events.
- [x] User-scoped Foundry socket identity is resolved outside `ClientSocket`.
- [x] Foundry user connection orchestration no longer lives in `core/session`.
- [x] App/middleware/realtime/status/debug callers use the Foundry user connection abstraction rather than concrete `SessionManager`.
- [x] App-admin/backend sessions remain under `src/server/security`.
- [x] Admin launch/shutdown behavior is implemented or explicitly disabled; no no-op route returns success.
- [x] Registry satellites no longer import from `./server`.
- [x] `npx tsc --noEmit` is clean.
- [x] `npm run test:unit` is clean.
- [x] `docs/architecture.md` reflects the transport/controller/ingress split.

---

## Corrective Amendment: Import-Time Transport Boundary (August 21, 2026)

The Phase 7 source audit missed one residual dependency:
`CoreSocket.ts` still side-effect imported
`PrimaryDocumentCacheCoordinator`, whose evaluation registered application
Stores and `modifyDocumentRouter` handlers. The socket did not call a Store
directly, but importing the transport class still initialized application
document infrastructure, so the original transport-only verification was
incomplete.

ADR-0032 removed that import. `WorldBootstrapper` remains the application
owner for coordinator seeding, and `SystemService` loads application
composition before attaching document ingress. The active unit suite now
parses import declarations in `SocketBase.ts`, `CoreSocket.ts`, and
`ClientSocket.ts` and rejects Store, coordinator, router, service, or registry
registration dependencies. Bootstrap seeding, mutation routing, and direct
transport tests remained green after the correction.
