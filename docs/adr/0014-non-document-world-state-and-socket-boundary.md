# ADR-0014: Non-Document World State and the Socket Boundary Principle

**Status:** Accepted — first of five coordinated ADRs in the *ADR-0014 arc* (see below). Implementation completed May 19, 2026.
**Date:** May 18, 2026
**Phase:** Non-Document Architecture (Phase 1 of the ADR-0014 arc)
**Supersedes:** None. Extends what ADR-0011 Phase 8 began for primary documents to the non-document surface.
**Related:** ADR-0011 (primary document model — established the pattern this ADR extends), ADR-0012 (realtime events), ADR-0013 (ownership and visibility). Sister ADRs in the same arc: ADR-0015 (compendium), ADR-0016 (document resolution), ADR-0017 (world bootstrap), ADR-0018 (socket-boundary completion).

---

## Part of the ADR-0014 arc

This ADR is the first of five coordinated ADRs implementing a socket-boundary cleanup for non-document state. The arc emerged from an architectural audit that found `CoreSocket` and `ClientSocket` still own non-document world state, compendium discovery, UUID routing, bootstrap orchestration, and engagement/lifecycle policy — concerns that should live as Stores and services per the pattern ADR-0011 established for primary documents.

The full scope is too large for a single ADR. It splits along dependency-driven slice boundaries:

| ADR | Scope | Depends on |
|---|---|---|
| **ADR-0014 (this ADR)** — Non-Document World State and the Socket Boundary Principle | Umbrella principle + `WorldStateStore`, `WorldLifecycleStore`, `SharedContentStore` with typed v13 shapes. File-layout convention. Cheap outliers (`compendium-cache.ts` rename, `instance.ts` audit, `classes/Roll.ts` flatten). Removes `getGameData` / `getSceneData` / `getSystem` / `getSystemConfig` / `getSharedContent` from sockets. `getSystemAdapter` stays until ADR-0017 (adapter lifecycle belongs with `WorldBootstrapper`). | (none — foundation) |
| ADR-0015 — Compendium Architecture and the Pathway B Read Gap | `CompendiumStore`, `CompendiumService`, `DiscoveryShardStore` / shard reader. Fixes the latent bug where pathway B writes hydrated shards no SDK caller reads. De-duplicates pathway A/B at the freshness-hash layer. Moves `getAllCompendiumIndices` / `getPackEntries` / `getPackIndex` / `getPackDocuments` off `CoreSocket`. | ADR-0014 (`core/compendium/` layout, naming convention) |
| ADR-0016 — Document Resolution and UUID Routing | `DocumentResolver`. Removes `fetchByUuid` from `CoreSocket` and `ClientSocket` cleanly (no transitional stub). Embedded-UUID parent-aware parse path. Stub-type resolver policy. | ADR-0015 (`CompendiumService.fetchByUuid` for the compendium branch) |
| ADR-0017 — World Bootstrap and Lifecycle Orchestration | `WorldBootstrapper` (the central application glue). `EngagementService` as presence signal source. The "`active` means application-ready, not Foundry-active" semantic tightening. Lifecycle-gated gateway acceptance. `SyncTokenService` (or folded into StatusService). | ADR-0014, ADR-0015, ADR-0016 |
| ADR-0018 — Socket Boundary Enforcement Completion | Residual `ClientSocket` boundary verification and cleanup after ADR-0014 / ADR-0016 / ADR-0017 remove the named delegations. Session-state split with `SessionManager`. URL utility extraction. Stale-comment cleanup. Confirms what's left on `CoreSocket` / `ClientSocket` / `SocketBase` is purely transport going forward. | ADR-0014 through ADR-0017 |
| ADR-0019 (deferred — post-arc) — Foundry Version Compatibility | Compat flag work. Reads `release.generation`; refuses below min, warns above max. Lands after the main arc completes. | ADR-0017 (needs `WorldBootstrapper` as insertion point) and ADR-0014 (typed `release` shape) |

**Why this split:** each ADR is single-concern and reviewable independently. Dependencies are linear and explicit. Each ADR can fail or be revisited without invalidating the others. File-layout reorganization is cross-cutting — ADR-0014 establishes the convention; subsequent ADRs apply it as they touch files.

**Reading order if you land here cold:** start with this ADR (it establishes the principle and the layout). Sister ADRs reference back to this one as the arc opener.

---

## Context

ADR-0011 Phase 8 removed every type-specific primary-document helper (`getActors`, `getActor`, `getChatLog`, `roll`, `useItem`, …) from `CoreSocket` and `ClientSocket`. That established the principle:

> **Stores hold state. Services orchestrate. Transports just move bytes.**

After ADR-0011 Phase 8, the socket surface for primary documents is correctly thin — sockets are user-scoped or service-account dispatch + the inbound `modifyDocument` listener, nothing more.

But the socket files still own a meaningful surface of **non-document concerns**:

- World metadata cached as `gameDataCache` on `CoreSocket` — typed `any`, holding the entire `game.data` payload (world manifest, system manifest, module manifests, server options, release info, schema model, …).
- World lifecycle state (`worldState` field on `CoreSocket` with transitions inline in `connect()`).
- Scene cache derived from `gameData.scenes` for background URL projection.
- Multi-world cache (`cachedWorlds`) for the setup-mode landing page.
- Probe data (`probeWorldData`, `probeUserCount`) gathered when the world is closed.
- GM shared-content payloads (`sharedContent` on `SocketBase`, asymmetric event source from the world payload).
- Plus everything covered by the sister ADRs: compendium discovery, UUID routing, bootstrap orchestration, engagement/heartbeat policy, URL utilities.

Today every route, service, and orchestration concern that needs any of this reaches *into the socket* to read it (`coreSocket.getGameData()`, `coreSocket.getSystem()`, `coreSocket.getSystemAdapter()`, `coreSocket.getSharedContent()`, etc.). That's the same boundary violation ADR-0011 Phase 8 fixed for primary documents — just on the non-document surface this time.

This ADR (and the rest of the ADR-0014 arc) applies the same fix: extract state into typed Stores, move orchestration into services, leave the sockets owning only what's actually transport.

---

## Decision

This ADR introduces three new Stores for non-document world state, types the shapes explicitly as Foundry v13 contracts, establishes the file-layout convention used by the rest of the ADR-0014 arc, and removes the corresponding state-reading methods from `CoreSocket` and `ClientSocket`.

### Three new Stores

**`WorldStateStore`** (`src/server/core/world/WorldStateStore.ts`) — holds the residual `game.data` content after primary documents and compendium packs are factored out. Two categories:

*Stable-shape, instance-uniform* — same keys and shape in every Foundry instance:

- World manifest (`world` — 27 keys: title, id, description, system, systemVersion, version, background, authors, compatibility, lastPlayed, nextSession, playtime, …).
- System manifest (`system` — 26 keys: title, id, version, description, grid, documentTypes, primaryTokenAttribute, …).
- Foundry release info (`release` — generation, channel, suffix, build, time, …).
- Update info (`coreUpdate`, `systemUpdate`).
- Server options (`options` — language, port, routePrefix, updateChannel).
- Network info (`addresses` — local, remote, remoteIsAccessible).
- File storage (`files` — storages, s3).
- Game flags (`paused`, `demoMode`, `idleLogout`).
- Diagnostics (`packageWarnings`, `template`).
- Connection identity (`userId`).
- Presence shadow (`activeUsers`).

*Stable-shape, instance-variable* — same shape per entry but count/contents vary per Foundry instance or active system:

- Module manifests (`modules` — array; one entry per loaded module). Count and ids vary per Foundry; each entry's shape is stable.
- Schema model (`model` — per-document-type schema shapes for all 34 Foundry types). Top-level keys are stable; per-type contents vary per active system.

Plus the legacy non-`game.data` snapshots: `probeWorldData`, `probeUserCount`, `cachedWorldData`, `cachedWorlds`, `sceneDataCache`.

**`WorldLifecycleStore`** (`src/server/core/world/WorldLifecycleStore.ts`) — holds the world lifecycle state (`offline | setup | startup | active | closed`) and emits transition events. Separated from `WorldStateStore` because:

- Several consumers care about lifecycle without needing the full world payload (the gateway's connection-acceptance gate, `StatusService`, `SessionManager`).
- ADR-0017's `WorldBootstrapper` is the central application glue; consumers subscribe to lifecycle transitions through this Store rather than polling state on the socket.
- This ADR names the target semantics: `active` must mean **Sheet Delver is ready to serve world-backed requests**, not merely "Foundry's `getWorldStatus()` returned true." The bootstrap window (primary-doc seeds, compendium discovery, adapter init) stays in `startup`. This delay is what makes the gateway connection-gate safe in ADR-0017; ADR-0014 gives lifecycle a Store boundary and documents the target, while ADR-0017 changes the transition timing to satisfy it.

**`SharedContentStore`** (`src/server/core/world/SharedContentStore.ts`) — holds the latest GM shared-content payload (`shareImage`, `showEntry` events) and timestamp. Separate from `WorldStateStore` because the event source is asymmetric (live wire events, not the world bootstrap payload) and the lifecycle is different (presentation state can change without re-bootstrapping the world). The Store keeps the original/raw Foundry payload, including relative image URLs. Client/request-aware URL normalization belongs to `UtilityService` as a projection helper that returns a resolved copy.

### Typed shapes

Today `coreSocket.gameDataCache` is typed as `any`. This ADR introduces typed interfaces in `src/server/core/world/types.ts`:

- `WorldManifest`, `SystemManifest`, `ModuleManifest`
- `FoundryRelease`, `FoundryUpdate`
- `ServerOptions`, `ServerAddresses`, `FileStorage`
- `SchemaModel` (keyed by `SchemaModelTypeName`, the union of all 34 Foundry doc-type names)
- `PackageWarnings`
- `GameData` composing the above into the top-level envelope

Store accessors return typed shapes — `getWorld(): WorldManifest`, `getModules(): ModuleManifest[]`, `getModel(): SchemaModel`, `getModelForType(name): DocumentTypeModel`, etc. No more `any`-typed cache surface; the typechecker catches drift when Foundry v14 introduces shape changes (see *Foundry version coupling* in *Details* below).

**Naming note — no `Raw` prefix.** The existing primary-document types in `src/server/shared/types/documents.ts` (`RawActor`, `RawItem`, `RawJournal`, etc.) use a `Raw` prefix. That convention came from "wire shape vs. application shape" intent, but in practice no non-`Raw` counterpart exists for any of those types — `RawActor` is THE actor type used throughout the codebase. The prefix is dead semantics: it adds a word to every import without disambiguating anything (the file location already communicates wire-coupled-to-Foundry). This ADR introduces new types without the prefix; a separate follow-up will rename the legacy `Raw*` primary-doc types for consistency. The temporary inconsistency between new (un-prefixed) and legacy (`Raw*`) types is accepted; the alternative — propagating dead semantics to new code — is worse.

### File-layout convention

This ADR establishes the directory structure that the rest of the ADR-0014 arc uses:

```
src/server/core/
├── cache/                          (existing — PersistentCache)
├── documents/                      (existing — primary doc Stores, ADR-0011)
├── world/                          (NEW — non-document world state Stores)
│   ├── WorldStateStore.ts
│   ├── WorldLifecycleStore.ts
│   ├── SharedContentStore.ts
│   ├── SetupManager.ts
│   └── types.ts                    (WorldManifest, SystemManifest, GameData, etc.)
├── compendium/                     (NEW — compendium concerns, populated by ADR-0015)
│   └── CompendiumCache.ts          (renamed from foundry/compendium-cache.ts in this ADR)
├── foundry/                        (slimmed — transport + Foundry-coupled utilities only)
│   ├── sockets/                    (transport)
│   ├── Roll.ts                     (moved from foundry/classes/Roll.ts in this ADR; single-file classes/ wrapper dropped)
│   ├── DirectScraper.ts
│   ├── interfaces.ts
│   └── types.ts
├── security/                       (existing)
├── session/                        (existing)
└── system/                         (existing)

src/server/services/                (existing convention)
├── ...
└── world/                          (NEW — populated by ADR-0017)
```

The principle: **group by concern, not by TypeScript construct**. Every subdirectory says what's there (`sockets/`, `world/`, `compendium/`), not what kind of file (no `classes/`, `utils/`, `helpers/`). Matches the established `documents/primary/<type>/` pattern from ADR-0011.

### Sockets shrink

Remove from `CoreSocket`:

- `getGameData()` — readers move to `worldStateStore.getWorld()` / `getSystem()` / `getModules()` / etc.
- `getSceneData()` — readers move to `worldStateStore.getSceneData()` (legacy compatibility) or compose from primary doc Stores after Phase 7 of ADR-0011.
- `getSystem()` — socket readers move to `worldStateStore.getSystem()`. Request-facing facades such as `RouteFoundryClient.getSystem()` may remain as stable service/module APIs, but their implementation reads the Store instead of forwarding through `CoreSocket` / `ClientSocket`.
- `getSystemConfig()` — clean removal. Despite the name, this method returns `gameDataCache?.system` (the system manifest) with a socket-emit fallback for probe-time. The cache path is exactly `worldStateStore.getSystem()` once seeded; the socket-fallback path is a probe-time concern that belongs in `WorldBootstrapper`'s probe pipeline (ADR-0017). There are zero external callers of `getSystemConfig()` today other than `ClientSocket`'s delegation — so the public method is removed in ADR-0014 and the fallback emit folds into the bootstrap pipeline when ADR-0017 lands. Until then, the bootstrapper's probe still happens inside `CoreSocket.connect()`; the probe code reads `gameDataCache?.system` internally if it needs the early system info.
- `worldState` public field — readers move to `worldLifecycleStore.getState()`.

**Stays on `CoreSocket` until ADR-0017** (called out so this ADR's exit criteria are honest):

- `getSystemAdapter()`, `loadSystemAdapter(systemId)`, the cached `this.adapter` reference. These are **adapter-lifecycle concerns, not world state.** The adapter is a function of (active world's system id) × (registered modules), resolved via `getMatchingAdapter(systemId)` from the module registry. The active adapter's home is `WorldBootstrapper.getActiveAdapter()` (ADR-0017) — the bootstrapper already loads and initializes it; exposing the cached reference is a natural addition there. Putting the adapter on `WorldStateStore` would conflate world state with module-registry resolution. ADR-0014 leaves the adapter caching on `CoreSocket` so callers (`createRouteFoundryClient.ts:41` uses it for `validateUpdate`) aren't stranded; ADR-0017 migrates the caller and removes the socket methods.

Remove from `SocketBase`:

- `getSharedContent()` — readers move to `sharedContentStore.getCurrent()` through `UtilityService` projections. The socket listeners (`setupSharedContentListeners`) stay on `SocketBase` as event sources, but they now `sharedContentStore.set(payload)` instead of holding the value themselves. `SharedContentStore` returns immutable snapshots (clone-on-write and clone-on-read, or an equivalent readonly-copy contract) so request projections like URL resolution cannot mutate canonical shared-content state. The stored image URL remains the raw Foundry event value; `UtilityService` resolves it on a copy for the requesting client.

Remove from `ClientSocket`:

- `getSystem()` and `getSystemConfig()` delegation methods. Their `CoreSocket` sources are removed in this ADR, so the delegations have nothing to forward to. Callers (none outside the delegations themselves, in the case of `getSystemConfig`) migrate to the Store accessors.

**Stays on `ClientSocket` until ADR-0017:** `getSystemAdapter()` delegation method, paired with the `CoreSocket` source it forwards to. ADR-0017 removes both atomically.

Update `src/server/core/foundry/interfaces.ts`:

- Remove socket-world-state readers from the socket-facing interfaces. In the current file this means `getSystem()` drops from `FoundryMetadataClient`, and `getSystem()` / `getSystemConfig()` drop from `FoundryClient`; route/service client-like interfaces may keep their Store-backed `getSystem()` contracts.
- Leave `getSystemAdapter(): any` for now; ADR-0017 removes it alongside the socket source methods.

### Trivial outliers landed in this ADR

These don't depend on later ADRs and are too small to defer:

- **Rename** `src/server/core/foundry/compendium-cache.ts` → `src/server/core/compendium/CompendiumCache.ts`. The only kebab-case-named-class file in the entire server tree.
- **Move** `src/server/core/foundry/classes/Roll.ts` → `src/server/core/foundry/Roll.ts`. The `classes/` subdirectory was a category-only name holding exactly one file.
- **Move** `src/server/core/foundry/SetupManager.ts` → `src/server/core/world/SetupManager.ts`. Its concern is world metadata, not Foundry runtime.
- **Audit** `src/server/core/foundry/instance.ts`. The legacy global singleton (`_foundryClient`) is superseded by `systemService.getSystemClient()`. If unused, delete; if still referenced, migrate callers.

---

## Details

### Foundry version coupling

Every shape `WorldStateStore` holds is a **Foundry v13 contract**. v12 has materially different module and world packaging; v14 will likely drift in field placement or new fields. The audit dumps in the working notes confirm the v13 shapes are stable across instances; the typed interfaces in `core/world/types.ts` capture that contract explicitly.

When Foundry v14 arrives, drift surfaces as typed-cast failures or undefined-field reads at the consumer sites — which is the point. The current `any`-typed cache hides drift; the typed Stores make it visible. **Phase 1 typed shapes are an explicit v13 anchor**; v14 support is a separate effort with its own typed updates.

Per-version handling (refuse below min, warn above max) is deferred to ADR-0019, which gets `WorldBootstrapper` as an insertion point from ADR-0017 and typed `release.generation` from this ADR.

### World-state test data policy

The audit dumps in `temp/game-data-dump-example*.json` were used only as local audit evidence for the v13 shape. They must not be copied into tracked test fixtures, committed under `src/tests/fixtures/`, or used as runtime test dependencies. World-state contract tests should use tiny synthetic in-code fixtures that preserve the shape being exercised without carrying real world data.

The canonical Phase 1 example lives in `src/tests/unit/world-state-store.test.ts` as `createGameDataFixture()` plus `sceneMapFromFixture()`. It intentionally covers the Store surface with minimal synthetic values:

- `world`: `id`, `title`, `description`, `system`, `systemVersion`, `background`, `nextSession`, `playtime`.
- `system`: `id`, `title`, `version`, `background`, and `documentTypes` for `Actor` / `Item`.
- `modules`: two small module manifests with `id`, `title`, `version`.
- Version/config envelopes: `release` (`generation: 13`, `channel`, `build`), `coreUpdate`, `systemUpdate`, `options`, `addresses`, `files`.
- Runtime flags and diagnostics: `paused`, `demoMode`, `idleLogout`, `packageWarnings`.
- Identity/presence: `userId`, `activeUsers`, and one synthetic GM user in `users`.
- Schema and scene projections: `model.Actor`, `model.Item`, and one scene with `_id` plus `background.src`.
- Probe/setup cache coverage: synthetic `probeWorldData`, `probeUserCount`, and a tiny `CacheData` map with `currentWorldId` / `worlds`.

If later phases need broader shape coverage, extend the synthetic fixture with only the missing fields needed for that behavior. Do not promote real audit dumps into fixtures.

### Granularity: single `WorldStateStore`, not split

The dumps confirm that all the residual non-doc, non-pack data arrives in a single wire payload (`game.data`), refreshes together at world bootstrap, and clears together at teardown. There's no asymmetric event source within this scope that would justify per-area Stores (`WorldManifestStore`, `ModuleManifestStore`, `SchemaModelStore`, etc.). A single `WorldStateStore` with typed sub-accessors is the right shape. Promote to focused sub-Stores only if a future feature needs per-area events (e.g., a modules-tab UI that wants a modules-only event surface).

`SharedContentStore` *is* separated because its event source is asymmetric (live `shareImage` / `showEntry` events, not the world bootstrap payload) and its lifecycle is independent (presentation state can update without re-bootstrapping the world).

`WorldLifecycleStore` is also separated — see *Three new Stores* above. The lifecycle is read by gateway / status / session consumers that don't need the full world payload; keeping it focused gives those consumers a typed event surface to subscribe to.

### Lifecycle state semantics

The five states are:

- `offline` — no socket connection; Stores empty.
- `setup` — Foundry is in setup mode (no active world). `cachedWorlds` is populated; primary-doc Stores remain empty.
- `startup` — socket connected, Foundry world active, **but Sheet Delver bootstrap not yet complete**. Compendium discovery, primary-doc seeds, adapter init may still be running. Routes/gateway should treat this as not-ready.
- `active` — full bootstrap complete; Sheet Delver is ready to serve world-backed requests.
- `closed` — world closed or shutdown received; Stores cleared.

The current code transitions to `active` immediately when Foundry reports world-active, before primary-doc seeds and adapter init complete. **This ADR defines the target Store semantics and moves lifecycle state out of the socket; it does not yet change transition timing.** Until ADR-0017 ships, the lifecycle state machine inside `CoreSocket` continues to populate `WorldLifecycleStore` with the existing premature-`active` behavior. ADR-0017 lands the actual delayed transition via `WorldBootstrapper` and supersedes that path entirely.

### Seeding and clearing

`WorldStateStore.seed(rawGameData)` populates all the typed shapes in one call from the inbound wire payload. `WorldStateStore.clear(reason)` resets to empty.

`WorldLifecycleStore.setState(next, reason)` transitions state; emits `transition` events with `{ from, to, reason }`.

`SharedContentStore.set(payload)` updates the current shared-content snapshot; `clear(reason)` resets. Reads return a defensive copy or immutable snapshot. The stored payload must stay relative/raw; presentation-time URL resolution and other request-specific projections happen outside the Store. `UtilityService.getSharedContent(client?)` is the Phase 3 home for that projection: it reads the Store snapshot, resolves `image` payload URLs on a copy via `client.resolveUrl(...)`, and never mutates Store-owned data.

`CoreSocket.connect()` is the seed/clear caller today (called inline). After this ADR, it still calls into the Stores (because the bootstrap orchestration extraction is ADR-0017's job, not this ADR's). The point of this slice is that **the state lives in the Stores**, not on the socket; *who calls the seed* is orthogonal and stays where it is for now.

### What stays on `CoreSocket` / `ClientSocket` / `SocketBase` after this ADR

Just transport, plus orchestration that subsequent ADRs will extract:

- **Stays** (transport, not in scope for this ADR or any other in the arc): `emitSocketEvent`, `dispatchDocument`, `dispatchDocumentSocket`, `connect` (the wire-level handshake/login parts), `disconnect`, `setupSharedContentListeners` (the event source — the cache moves to the Store), socket.io session management, retry/backoff, the inbound `modifyDocument` listener that calls `modifyDocumentRouter.route(...)`.
- **Stays for now, removed by ADR-0015**: `getAllCompendiumIndices`, `getPackEntries`, `getPackIndex`, `getPackDocuments`.
- **Stays for now, removed by ADR-0016**: `fetchByUuid` (on `CoreSocket` and the matching `ClientSocket` delegation).
- **Stays for now, removed by ADR-0017**: `getSystemAdapter()` + `loadSystemAdapter(systemId)` + cached `this.adapter` reference on `CoreSocket`; `getSystemAdapter()` delegation on `ClientSocket`; `interfaces.ts`'s `getSystemAdapter(): any` declaration. Also `connect()`'s bootstrap orchestration body, `updateActiveBrowserCount` / heartbeat policy, and the temporary `lastActorChange` / `actorSyncToken` bridge. ADR-0017 introduces `SyncTokenService` (or folds that concern into `StatusService`) so status payloads no longer read the socket-owned timestamp.
- **Stays for now, verified or removed by ADR-0018**: any residual `ClientSocket` delegation left after ADR-0014 / ADR-0016 / ADR-0017, URL utilities on `SocketBase`, session-state half of `restoreSession`.

This ADR removes only the state-reading methods named in *Sockets shrink* above. The rest is each follow-up ADR's scope.

---

## ADR-0014 Phase Staging

This section tracks implementation phases in the same style as ADR-0011 through ADR-0013: each phase has a named scope, status, action checklist with file touchpoints, non-goals, and a concrete exit statement. Phase 1 is intentionally behavior-preserving. It creates the typed world-state home and moves readers off socket-owned state, but it does not delete the old socket shims yet; deletion is Phase 5.

### Phase 1: WorldStateStore and reader migration

**Status:** Closed May 18, 2026.

Phase 1 introduces `WorldStateStore` and the typed v13 world-state contract. `CoreSocket.connect()` remains the seeding caller during this phase, but routes/services stop reading non-document world state from `CoreSocket`. During the transition, `CoreSocket` may keep temporary `getGameData()` / `getSceneData()` / `getSystem()` / `getSystemConfig()` wrappers as Store-backed compatibility shims. New code must not read world state from the socket.

**Action items:**

- [x] Add typed world-state contracts in `src/server/core/world/types.ts`. Include `WorldManifest`, `SystemManifest`, `ModuleManifest`, `FoundryRelease`, `FoundryUpdate`, `ServerOptions`, `ServerAddresses`, `FileStorage`, `SchemaModel`, `PackageWarnings`, and the composed `GameData` envelope.
  Files: `src/server/core/world/types.ts`.

- [x] Add `WorldStateStore` with clone-on-read snapshots for object/array accessors. Required first-pass accessors: `getGameDataSnapshot()` (temporary compatibility only), `getWorld()`, `getSystem()`, `getModules()`, `getRelease()`, `getCoreUpdate()`, `getSystemUpdate()`, `getOptions()`, `getAddresses()`, `getFiles()`, `isPaused()`, `isDemoMode()`, `isIdleLogout()`, `getModel()`, `getModelForType(typeName)`, `getPackageWarnings()`, `getSceneData()`, `getProbeData()`, `getProbeUserCount()`, `getCachedWorld(worldId)`, `listCachedWorlds()`, `getCurrentWorldId()`, and `getUserId()`.
  Files: `src/server/core/world/WorldStateStore.ts`, optional `src/server/core/world/index.ts`.

- [x] Add unit coverage for `WorldStateStore` seed, clear, typed accessor projection, clone-on-read behavior, scene-data retention, probe data, cached world list, and current-world id lookup. Tests use tiny synthetic in-code fixtures that preserve the needed shape without committing real world dump data; see *World-state test data policy* for the exact example shape.
  Files: `src/tests/unit/world-state-store.test.ts`, `src/tests/unit/run.ts`.

- [x] Make `CoreSocket` seed `WorldStateStore` instead of owning the authoritative non-document world snapshot. After `getWorldData()` / scene projection succeeds, call `worldStateStore.seed(rawGameData, { sceneData })`. Setup/probe/cache paths write focused Store state for `probeWorldData`, `probeUserCount`, `cachedWorldData`, and `cachedWorlds`; disconnect/setup/closed paths clear or partially reset the Store.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts`, `src/server/core/world/WorldStateStore.ts`.

- [x] Convert temporary `CoreSocket.getGameData()`, `getSceneData()`, `getSystem()`, and `getSystemConfig()` wrappers to read from `WorldStateStore` until Phase 5 removes them. Direct socket fields such as `gameDataCache`, `sceneDataCache`, `probeWorldData`, `probeUserCount`, `cachedWorldData`, and `cachedWorlds` stop being read outside `CoreSocket`.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts`.

- [x] Move status payload world/system/probe/scene/cache reads to `WorldStateStore`. Keep lifecycle reads on the current source until Phase 2 introduces `WorldLifecycleStore`; keep URL resolution as a projection outside the Store.
  Files: `src/server/services/status/StatusService.ts`, `src/server/shared/types/foundry.ts`.

- [x] Move session world-id reads off `systemService.getSystemClient().getGameData()` and onto `worldStateStore.getCurrentWorldId()` / `getWorld()?.id`. Leave lifecycle-state behavior for Phase 2.
  Files: `src/server/core/session/SessionManager.ts`.

- [x] Move protected system routes off `getSystemClient().getGameData()` / `getSceneData()`. `/system`, `/system/data`, and `/system/scenes` should read through `WorldStateStore`.
  Files: `src/server/routes/protected/registerSystemRoutes.ts`.

- [x] Move `SystemService` bootstrap/system-id reads and adapter lookup preconditions to `worldStateStore.getSystem()`. `getSystemAdapter()` stays socket-backed until ADR-0017.
  Files: `src/server/core/system/SystemService.ts`.

- [x] Replace `ClientSocket` service-client `getGameData()?.users` and world-id checks with `userStore` / `WorldStateStore` reads, retaining the existing probe fallback for user discovery.
  Files: `src/server/core/foundry/sockets/ClientSocket.ts`.

- [x] Keep the public `RouteFoundryClient.getSystem()` facade, but implement it from `worldStateStore.getSystem()` instead of `client.getSystem()`. Leave `client.getSystemAdapter()` in `filterActorUpdatePayload()` until ADR-0017.
  Files: `src/server/shared/utils/createRouteFoundryClient.ts`, `src/server/shared/types/actors.ts`, `src/server/shared/types/requestContext.ts`.

- [x] Adjust socket-facing types so migrated readers no longer require `getGameData()` / `getSceneData()` / `getSystemConfig()` from the system client. Keep request-facing `getSystem()` where services/modules use it as a facade.
  Files: `src/server/shared/types/foundry.ts`, `src/server/core/foundry/interfaces.ts`, `src/server/shared/types/requestContext.ts`.

- [x] Verify Phase 1 with unit/type checks and source audits. Remaining audit hits are allowed only in `CoreSocket`, `WorldStateStore`, phase-documented compatibility shims, and synthetic unit-test data.
  Commands: `npm run test:unit`; `npx tsc --noEmit`; `rg -n "getSystemClient\(\)\.(getGameData|getSceneData|getSystem\b|getSystemConfig|gameDataCache|sceneDataCache|probeWorldData|probeUserCount|cachedWorldData|cachedWorlds)" src/server`; `rg -n "\.(getGameData|getSceneData|getSystemConfig)\(" src/server`; `rg -n "gameDataCache|sceneDataCache|probeWorldData|probeUserCount|cachedWorldData|cachedWorlds" src/server`.

**Non-goals for Phase 1:**

- No lifecycle timing change and no delayed-`active` behavior. Phase 2 introduces `WorldLifecycleStore`; ADR-0017 changes transition timing.
- No adapter migration. `getSystemAdapter()` / `loadSystemAdapter()` stay until ADR-0017.
- No `SharedContentStore`; that is Phase 3.
- No compendium, UUID resolver, URL utility, or session-state split work.
- No deletion of the Store-backed socket compatibility shims until Phase 5.

**Exit for Phase 1:** `WorldStateStore` and typed v13 world-state contracts exist; `CoreSocket` seeds the Store and exposes only temporary Store-backed compatibility shims for the old world-state getters; status, session, system routes, system bootstrap reads, `ClientSocket` world-id/user-discovery reads, and `RouteFoundryClient.getSystem()` no longer read non-document world state from the socket; `npm run test:unit`, `npx tsc --noEmit`, and the Phase 1 source audits pass under the allowed-hit policy.

**Phase 1 closed (May 18, 2026).** All action items above ticked. Verification passed: `npx tsc --noEmit`, `npm run test:unit`, `git diff --check`, and the Phase 1 source audits. The remaining `gameDataCache` / `sceneDataCache` / probe/cache field hits are isolated to `CoreSocket` internals and `WorldStateStore`; the remaining `getSceneData()` method hit is the temporary Store-backed `CoreSocket` compatibility shim plus Store call sites.

### Phase 2: WorldLifecycleStore and lifecycle reader migration

**Status:** Closed May 18, 2026.

Phase 2 introduces `WorldLifecycleStore` as the authoritative owner for world lifecycle state (`offline | setup | startup | active | closed`). This phase is behavior-preserving: `CoreSocket.connect()` still drives the same transitions at the same points in the existing connection flow. The difference is ownership and reader direction. CoreSocket writes lifecycle transitions into the Store; routes/services/admin/session/status code read lifecycle state from the Store instead of `CoreSocket.worldState`. The public `CoreSocket.worldState` compatibility getter may remain temporarily for legacy/manual tooling, but it is Store-backed and new code must not read lifecycle state from the socket.

**Action items:**

- [x] Add `WorldLifecycleStore` with typed state values, snapshot access, idempotent `setState(next, reason)`, `reset(reason)`, and `transition` events carrying `{ from, to, reason, at }`.
  Files: `src/server/core/world/WorldLifecycleStore.ts`, `src/server/core/world/index.ts`.

- [x] Add unit coverage for initial state, transition event emission, idempotent same-state writes, defensive transition snapshots, and reset-to-offline behavior.
  Files: `src/tests/unit/world-lifecycle-store.test.ts`, `src/tests/unit/run.ts`.

- [x] Make `CoreSocket` write lifecycle transitions through a single Store-backed helper. Keep existing transition timing and retry behavior unchanged; do not implement delayed-`active` semantics in this phase.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts`.

- [x] Replace lifecycle reads in status projection, session validation/restoration, system-service bootstrap gating, admin status, and manual retry gating with `worldLifecycleStore.getState()` / `isState()`.
  Files: `src/server/services/status/StatusService.ts`, `src/server/core/session/SessionManager.ts`, `src/server/core/system/SystemService.ts`, `src/server/services/admin/AdminService.ts`, `src/server/routes/admin/createAdminRouter.ts`, `src/server/shared/types/foundry.ts`.

- [x] Update socket-facing lifecycle types and tests/manual tooling so they no longer depend on `getSystemClient().worldState` or other direct socket lifecycle reads.
  Files: `src/server/core/foundry/interfaces.ts`, `src/tests/socket/03-world-transition.test.ts`, `src/tests/deprecated/socket-legacy/07-handoff.test.ts`.

- [x] Bridge lifecycle transitions into existing status fan-out by having `SystemService` emit `system:status-update` when `WorldLifecycleStore` transitions.
  Files: `src/server/core/system/SystemService.ts`.

- [x] Verify Phase 2 with unit/type checks and source audits. Remaining direct `.worldState` hits are allowed only inside `CoreSocket` as the Store-backed compatibility getter/internal state-machine read, or in type/interface declarations documenting compatibility.
  Commands: `npm run test:unit`; `npx tsc --noEmit`; `rg -n "getSystemClient\(\)\.worldState|client\.worldState|systemClient\.worldState|sys\.worldState|core\.worldState" src/server src/tests`; `rg -n "\.worldState\b" src/server`.

**Non-goals for Phase 2:**

- No lifecycle timing change. `active` still mirrors the current CoreSocket timing until ADR-0017 moves bootstrap orchestration and delays `active` until Sheet Delver is ready.
- No adapter migration. `getSystemAdapter()` / `loadSystemAdapter()` stay until ADR-0017.
- No `SharedContentStore`; that is Phase 3.
- No deletion of the Store-backed `CoreSocket.worldState` compatibility getter while legacy/manual tooling may still use it.
- No compendium, UUID resolver, URL utility, engagement-service, heartbeat-policy, or session-state split work.

**Exit for Phase 2:** `WorldLifecycleStore` exists and is exported from `core/world`; CoreSocket writes lifecycle transitions into the Store; status, session, system-service, admin, and test readers no longer read lifecycle state from `CoreSocket`; lifecycle transition events reach the existing status broadcaster through `SystemService`; `npm run test:unit`, `npx tsc --noEmit`, and the Phase 2 source audits pass under the allowed-hit policy.

**Phase 2 closed (May 18, 2026).** All action items above ticked. Verification passed: `npx tsc --noEmit`, `npm run test:unit`, and the Phase 2 source audits. The broad direct `.worldState` audit now hits only `CoreSocket`'s Store-backed compatibility/internal reads under the allowed-hit policy; the targeted external-reader audit returns no hits.

### Phase 3: SharedContentStore and client projection

**Status:** Closed May 19, 2026.

Phase 3 introduces `SharedContentStore` as the authoritative owner for the latest GM shared-content payload from Foundry socket events (`shareImage`, `showEntry`). The Store keeps canonical content raw: image URLs stay exactly as Foundry emitted them, usually relative paths. Client/request-specific URL resolution moves into `UtilityService` as an explicit projection helper that returns a copy with `data.url` resolved for the requesting client. Socket listeners remain the event source, but they write through the Store instead of caching on `SocketBase`.

**Action items:**

- [x] Add `SharedContentStore` with typed payload shape, clone-on-write / clone-on-read semantics, `set(payload)`, idempotent `clear(reason?)`, `getCurrent()`, and `sharedContentChanged` events carrying immutable snapshots.
  Files: `src/server/core/world/SharedContentStore.ts`, `src/server/core/world/index.ts`.

- [x] Add unit coverage for image payload storage, journal payload storage, timestamp preservation from socket-normalized payloads, clone-on-read, clone-on-write, clear behavior, unsubscribe behavior, and `sharedContentChanged` event emission.
  Files: `src/tests/unit/shared-content-store.test.ts`, `src/tests/unit/run.ts`.

- [x] Move `SocketBase.setupSharedContentListeners()` writes to `sharedContentStore.set(...)`. Remove the `SocketBase.sharedContent` field. Realtime fan-out is preserved by subscribing the app gateway to `SharedContentStore` and emitting the existing browser-facing `sharedContentUpdate` event from there.
  Files: `src/server/core/foundry/sockets/SocketBase.ts`.

- [x] Move shared-content reads off socket clients. `UtilityService.getSharedContent(client?)` reads `sharedContentStore.getCurrent()` and resolves `image` payload URLs on the defensive copy via `client.resolveUrl(...)`.
  Files: `src/server/services/utility/UtilityService.ts`, `src/server/shared/types/utility.ts`.

- [x] Remove the unused request-facing `RouteFoundryClient.getSharedContent()` facade instead of preserving it. `UtilityService` is the only route-facing shared-content projection surface.
  Files: `src/server/shared/utils/createRouteFoundryClient.ts`, `src/server/shared/types/requestContext.ts`.

- [x] Remove `SocketBase.getSharedContent()` once all readers are Store-backed. Update socket-facing types so shared-content reads are no longer optional methods on route/client-like interfaces.
  Files: `src/server/core/foundry/sockets/SocketBase.ts`, `src/server/shared/types/utility.ts`.

- [x] Bridge realtime fan-out from `SharedContentStore` to browser sockets. Browser clients still receive `sharedContentUpdate`; the gateway no longer subscribes to per-session `foundryClient.on('sharedContentUpdate', ...)`.
  Files: `src/server/realtime/AppSocketGateway.ts`, `src/tests/unit/app-socket-gateway.test.ts`.

- [x] Clear `SharedContentStore` when `CoreSocket` tears down active-world runtime state, so browser clients receive the existing empty shared-content payload instead of replaying presentation state from a prior world/session.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts`.

- [x] Verify Phase 3 with unit/type checks and source audits. Remaining `sharedContent` hits should be limited to `SharedContentStore`, realtime UI/client state, documented event names, and test fixtures; remaining `getSharedContent` hits should be request-facing route/service names, not socket reads or route-client mocks.
  Commands: `npm run test:unit`; `npx tsc --noEmit`; `rg -n "sharedContent|getSharedContent|shareImage|showEntry|setupSharedContentListeners|SharedContentStore" src/server src/tests/unit`; `rg -n "client\.getSharedContent|foundryClient\.getSharedContent|coreSocket\.getSharedContent|systemClient\.getSharedContent" src/server src/tests`.

**Non-goals for Phase 3:**

- No URL utility extraction from `SocketBase`; ADR-0018 owns residual URL utility cleanup.
- No realtime contract rename. The client-facing event remains `sharedContentUpdate`.
- No client UI state refactor. React state may still be named `sharedContent`; the socket-boundary concern is server-side ownership.
- No lifecycle or bootstrap timing changes.
- No compendium, UUID resolver, adapter, engagement-service, heartbeat-policy, or session-state split work.

**Exit for Phase 3:** `SharedContentStore` exists and is exported from `core/world`; socket listeners write raw shared-content payloads through the Store; `UtilityService` resolves image URLs only on request-specific copies; active-world runtime teardown clears the Store; socket-owned `sharedContent` and `SocketBase.getSharedContent()` are gone; `npm run test:unit`, `npx tsc --noEmit`, and the Phase 3 audits pass under the allowed-hit policy.

**Phase 3 closed (May 19, 2026).** All action items above ticked. Verification passed: `npx tsc --noEmit`, `npm run test:unit`, and the Phase 3 source audits. The implementation chose the cleaner Store-direct realtime path: `AppSocketGateway` subscribes to `sharedContentStore.onSharedContentChanged(...)` and emits the unchanged browser-facing `sharedContentUpdate` event, rather than having `SocketBase` re-emit shared-content updates through each Foundry client. `CoreSocket` clears shared content with active-world runtime state during setup/disconnect teardown. The remaining `getSharedContent` audit hits are request-facing route/service calls; targeted socket-reader audits return no hits.

### Phase 4: File-layout outliers

**Status:** Closed May 19, 2026.

Phase 4 lands the behavior-preserving layout cleanup named by this ADR. It removes the remaining file-path outliers without changing compendium behavior, Roll behavior, setup cache behavior, or the global-client replacement strategy. The point is to put already-existing concerns in their ADR-0014 homes before later ADRs add more code around them.

**Action items:**

- [x] Move `CompendiumCache` from `src/server/core/foundry/compendium-cache.ts` to `src/server/core/compendium/CompendiumCache.ts`, with an optional `src/server/core/compendium/index.ts` barrel if useful. Update static and dynamic imports to the new PascalCase path.
  Files: `src/server/core/foundry/compendium-cache.ts`, `src/server/core/compendium/CompendiumCache.ts`, `src/server/core/system/SystemService.ts`, `src/server/core/foundry/sockets/CoreSocket.ts`, `src/server/shared/utils/createModuleContext.ts`, `src/server/services/actors/ActorNormalizationService.ts`, `src/server/services/actors/ActorService.ts`, `src/tests/deprecated/module-specific/shadowdark/05-compendium-resolution.test.ts`.
  Local ignored verification touchpoint: `data/local/modules/shadowdark/src/server/Registry.ts`.

- [x] Move `Roll` from `src/server/core/foundry/classes/Roll.ts` to `src/server/core/foundry/Roll.ts`. Remove the empty `classes/` directory after the move and update the dynamic import used by route roll helpers.
  Files: `src/server/core/foundry/classes/Roll.ts`, `src/server/core/foundry/Roll.ts`, `src/server/shared/utils/createRouteFoundryClient.ts`.
  Local ignored verification touchpoint: `data/local/modules/shadowdark/src/server/api/level-up.ts`.

- [x] Move `SetupManager` from `src/server/core/foundry/SetupManager.ts` to `src/server/core/world/SetupManager.ts`. Update all imports and keep the public `SetupManager`, `CacheData`, and `WorldData` exports intact so setup/admin/status behavior is unchanged.
  Files: `src/server/core/foundry/SetupManager.ts`, `src/server/core/world/SetupManager.ts`, `src/server/core/foundry/sockets/CoreSocket.ts`, `src/server/core/world/WorldStateStore.ts`, `src/server/services/status/StatusService.ts`, `src/server/services/admin/AdminService.ts`, `src/server/shared/types/admin.ts`, `src/server/app/registerRoutes.ts`, `src/scripts/tools/admin/import-worlds.ts`, `src/tests/unit/world-state-store.test.ts`.

- [x] Audit `src/server/core/foundry/instance.ts`. `_foundryClient` / `getClient()` / `setClient()` had no server/runtime callers after migrating the Shadowdark module spell route to the request-scoped module client, so the legacy global singleton file was deleted.
  Files: `src/server/core/foundry/instance.ts`.
  Local ignored verification touchpoints: `data/local/modules/shadowdark/src/server/api/spells.ts`, `data/local/modules/shadowdark/src/server/index.ts`.

- [x] Update comments/docs/tests that refer to the old paths so future grep output points at the canonical layout. Source, script, test, and local module old-path audits are clean; this ADR keeps historical source-to-target path references only where they explain the migration.
  Files: `docs/adr/0014-non-document-world-state-and-socket-boundary.md`.

- [x] Verify Phase 4 with type/unit checks and file-layout audits. No old-path imports should remain, `core/foundry/classes/` should be gone, and `core/compendium/CompendiumCache.ts` plus `core/world/SetupManager.ts` should exist.
  Commands: `npm run test:unit`; `npx tsc --noEmit`; `rg -n "core/foundry/compendium-cache|foundry/compendium-cache|../compendium-cache|@core/foundry/classes/Roll|core/foundry/classes/Roll|@core/foundry/SetupManager|core/foundry/SetupManager|from '../SetupManager'" src src/scripts data/local/modules`; `rg --files src/server/core/foundry src/server/core/world src/server/core/compendium | rg "(compendium-cache|CompendiumCache|classes/Roll|SetupManager|instance)\.ts$"`.

**Non-goals for Phase 4:**

- No `CompendiumStore`, `CompendiumService`, shard-reader, or pathway A/B behavior changes; ADR-0015 owns compendium architecture.
- No SetupManager scrape/cache behavior changes.
- No Roll evaluator behavior changes.
- No socket-boundary method deletions beyond stale import-path fallout.
- No adapter, lifecycle, bootstrap, UUID resolver, URL utility, engagement-service, heartbeat-policy, or session-state split work.

**Exit for Phase 4:** `CompendiumCache`, `SetupManager`, and `Roll` live at the paths declared by this ADR; `core/foundry/classes/` is gone; `instance.ts` is deleted or has a documented migrated-caller outcome; all old-path imports/comments are removed; `npm run test:unit`, `npx tsc --noEmit`, and the Phase 4 file-layout audits pass.

**Phase 4 closed (May 19, 2026).** All action items above ticked. Verification passed: `git diff --check`, `npx tsc --noEmit`, `npm run test:unit`, the old-path import audit, and the file-layout audit. The implementation found additional Shadowdark local-module touchpoints under ignored `data/local/modules`: `Registry.ts` now imports `CompendiumCache` from `@core/compendium/CompendiumCache`, `level-up.ts` imports `Roll` from `@core/foundry/Roll`, and the spell route no longer reads the deleted global `@core/foundry/instance` singleton. Those local ignored changes are workspace verification hygiene and should not be staged.

### Phase 5: Remove residual world-state socket readers

**Status:** Closed May 19, 2026.

Phase 5 removes the remaining world-state compatibility shims from the socket classes now that `WorldStateStore` is the canonical read model. This is the closure pass for ADR-0014's socket-boundary promise: `CoreSocket` may still fetch and seed world data during bootstrap until ADR-0017, but routes, services, scripts, and tests must no longer read world state through socket methods. Route-facing facades like `RouteFoundryClient.getSystem()` may remain where they are Store-backed and part of service contracts; socket-owned `getSystem()` / `getSystemConfig()` methods do not.

**Action items:**

- [x] Remove the remaining Store-backed world-state compatibility methods from `CoreSocket`: `getGameData()`, `getSceneData()`, `getSystem()`, and `getSystemConfig()`. Delete the `getSystemConfig` fallback socket emit path rather than moving it.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts`.

- [x] Remove the matching world-state delegation methods from `ClientSocket`: `getSystem()` and `getSystemConfig()`. Keep `getSystemAdapter()` until ADR-0017.
  Files: `src/server/core/foundry/sockets/ClientSocket.ts`.

- [x] Remove the final public `CoreSocket.worldState` compatibility getter and switch remaining manual tooling to `WorldLifecycleStore`.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts`, `src/server/core/foundry/interfaces.ts`, `src/scripts/verify-architecture.ts`.

- [x] Tighten socket-facing interfaces. Remove `getSystem()` from `FoundryMetadataClient` if the interface only needs compendium metadata after this phase, and remove `getSystem()` / `getSystemConfig()` from the socket-level `FoundryClient` contract. Keep route/service client-like interfaces that explicitly need Store-backed `getSystem()`.
  Files: `src/server/core/foundry/interfaces.ts`, `src/server/shared/types/actors.ts`, `src/server/shared/types/requestContext.ts`.

- [x] Update scripts and socket/debug tests that still read world state through sockets. Replace them with `worldStateStore` reads after `connect()` where the script is still useful, or narrow/remove tests that only asserted the deleted compatibility surface.
  Files: `src/scripts/capture-world-data.ts`, `src/scripts/verify-architecture.ts`, `src/scripts/TEST_STATES.md`, `src/tests/socket/02-system-info.test.ts`, `src/tests/socket/04-users-compendia.test.ts`, `src/tests/socket/04-compedium-fetch.test.ts`, `src/tests/socket/05-write-operations.test.ts`, `src/tests/socket/debug-scene-data.test.ts`, `src/tests/socket/socket_diagnostic.ts`.

- [x] Confirm route and module service readers still use Store-backed route facades or direct Store access, not socket methods. `ActorService`, `ActorNormalizationService`, `CombatService`, and `createModuleFoundryClient` may continue to call their injected `RouteFoundryClient.getSystem()` because `createRouteFoundryClient` projects that value from `WorldStateStore`.
  Files: `src/server/shared/utils/createRouteFoundryClient.ts`, `src/server/shared/utils/createModuleFoundryClient.ts`, `src/server/services/actors/ActorService.ts`, `src/server/services/actors/ActorNormalizationService.ts`, `src/server/services/combats/CombatService.ts`.

- [x] Update comments/docs/tests that still describe these methods as socket-owned compatibility shims.
  Files: `docs/adr/0014-non-document-world-state-and-socket-boundary.md`, `src/server/core/foundry/sockets/ClientSocket.ts`, `src/server/core/world/WorldStateStore.ts`.

- [x] Verify Phase 5 with type/unit checks and targeted socket-reader audits. Remaining `getSystem` hits should be direct `worldStateStore.getSystem()` reads or route-facing Store-backed facades, not methods on `CoreSocket` / `ClientSocket`.
  Commands: `npm run test:unit`; `npx tsc --noEmit`; `rg -n "public (async )?(getGameData|getSceneData|getSystem|getSystemConfig)\\b|getSystemConfig\\(\\):" src/server/core/foundry`; `rg -n "\\b(client|core|coreSocket|foundryClient|systemClient)\\.(getGameData|getSceneData|getSystemConfig)\\(" src/server src/scripts src/tests data/local/modules`; `rg -n "\\b(core|coreSocket|foundryClient|systemClient)\\.getSystem\\(" src/server src/scripts src/tests data/local/modules`.

**Non-goals for Phase 5:**

- No `getSystemAdapter()` / `loadSystemAdapter()` / adapter cache removal; ADR-0017 owns adapter lifecycle through `WorldBootstrapper`.
- No compendium method removal (`getAllCompendiumIndices`, `getPackEntries`, `getPackIndex`, `getPackDocuments`); ADR-0015 owns compendium architecture.
- No UUID resolver removal (`fetchByUuid`); ADR-0016 owns document resolution.
- No bootstrap orchestration, heartbeat, engagement-service, lifecycle timing, URL utility, or session-state split work.
- No service-contract cleanup for route-facing `getSystem()` unless the call is socket-backed. Store-backed route facades are allowed.
- No actor sync-token cleanup. The temporary `lastActorChange` / `actorSyncToken` bridge remains until ADR-0017 moves it into `SyncTokenService` or the status/bootstrap layer.

**Exit for Phase 5:** `CoreSocket` no longer exposes `getGameData()`, `getSceneData()`, `getSystem()`, or `getSystemConfig()`; `ClientSocket` no longer exposes `getSystem()` or `getSystemConfig()`; socket-facing interfaces no longer require those world-state readers; scripts/tests are updated away from socket state reads; route-facing `getSystem()` remains Store-backed; `npm run test:unit`, `npx tsc --noEmit`, and the Phase 5 socket-reader audits pass.

**Phase 5 closed (May 19, 2026).** All action items above ticked. Verification passed: `git diff --check`, `npx tsc --noEmit`, `npm run test:unit`, and the targeted Phase 5 socket-reader audits. Remaining `getSystem()` calls are Store-backed route/service facades or direct `worldStateStore.getSystem()` reads; the socket classes no longer expose the world-state reader methods or the old public `worldState` lifecycle reader. The separate `lastActorChange` / `actorSyncToken` socket read remains an ADR-0017 sync-token concern, not a Phase 5 world-state reader.

---

## Alternatives Considered

### Keep state on the socket

Don't extract. The socket has accessors that work; let routes/services continue to reach in.

Rejected because this is the same boundary violation ADR-0011 Phase 8 fixed for primary documents. Routes and services reaching *into* a transport to read state means the transport owns concerns it shouldn't, and changes to that state surface ripple across every consumer's import graph. The ADR-0011 pattern proved that extracting state into typed Stores is reviewable, testable, and prevents drift.

### One mega-Store for everything in `game.data`

A single `GameDataStore` holding the entire payload, including the primary docs.

Rejected because primary docs already have their own Stores (ADR-0011) with per-type ownership policies, embedded children, change events, etc. Folding them back into a mega-Store would invalidate ADR-0011's structure and lose all the per-type policy work. The right shape is *additive*: primary docs in their existing Stores, packs in `CompendiumStore` (ADR-0015), residual non-doc-non-pack state in `WorldStateStore`.

### Fold `WorldLifecycleStore` into `WorldStateStore`

Lifecycle is just one more field on the world environment — why a separate Store?

Rejected because the consumer set is different. The gateway, status service, and session manager need to react to lifecycle transitions specifically without subscribing to every world-state change. Separating gives them a focused event surface; folding would either fire transition events for every world-state write (noisy) or require subscribers to filter (boilerplate). The cost of two Stores is minimal; the cost of conflating two distinct event surfaces is paid every time someone writes a lifecycle-only consumer.

### Fold `SharedContentStore` into `WorldStateStore`

Shared content is just a small payload — can the world Store hold it too?

Rejected because the event source is different. Shared content arrives via `shareImage` / `showEntry` socket events at any time; the world payload arrives once at bootstrap and refreshes only on reconnect. Conflating them would force shared-content writes to either fire `worldStateChanged` (incorrect — the world payload didn't change) or require a separate sub-event (boilerplate). Same separation rationale as `WorldLifecycleStore`.

### Defer the typing work

Get the Stores in place first; type the shapes later.

Rejected because the whole point of moving state to the Stores is to make drift visible. An `any`-typed `WorldStateStore.getWorld()` is no better than `coreSocket.gameDataCache.world`. The typing IS the contract — without it, the Foundry version coupling stays invisible and ADR-0019's compat flag has nothing typed to gate on. Phase 1 of this ADR includes the types.

### Land file-layout reorganization as its own ADR

Treat the directory restructure as a separate concern.

Rejected because new Stores and services need destinations. If ADR-0014 introduces `WorldStateStore` in the existing grab-bag `core/foundry/`, ADR-0015 introduces `CompendiumStore` somewhere else, etc., each ADR makes incremental layout decisions that drift. Establishing the convention in this ADR (the arc opener) and applying it across all five ADRs is cheaper than landing a separate "reorganize the layout" ADR after the fact. Trivial outliers (`compendium-cache.ts`, `classes/Roll.ts`, `SetupManager.ts`, `instance.ts`) ride along here because they don't depend on later ADRs.

---

## Consequences

### Positive

- **State has a typed home.** `coreSocket.gameDataCache` typed as `any` becomes `WorldStateStore` with typed accessors. The typechecker becomes a real safety net when Foundry shapes drift.
- **Boundary enforcement extends to non-document concerns.** ADR-0011 Phase 8 fixed the primary-doc surface; this ADR is the first slice that does the same for what's left.
- **`WorldLifecycleStore` names the target semantics up front.** ADR-0014 creates the Store boundary and documents that `active` ultimately means application-ready. ADR-0017 lands the delayed-`active` transition that makes the runtime behavior match that target.
- **The file-layout convention is established once.** Subsequent ADRs in the arc apply it as they touch files; no per-ADR re-litigation of where things go.
- **Foundry version coupling becomes explicit.** v13 shapes are now typed contracts; v14 drift surfaces at the typecheck layer, not as undefined-field bugs at runtime.

### Tradeoffs

- **Wide migration surface.** Every site that currently reads `coreSocket.getGameData()` / `getSystem()` / `getSystemConfig()` / `getSharedContent()` etc. gets touched. Routes, services, the realtime gateway, the session manager — every reader migrates. Mechanical but not small. (`getSystemAdapter` callers are *not* migrated in this ADR — that's ADR-0017's scope.)
- **Three new Stores increases the cognitive surface.** Readers used to looking at `coreSocket.gameDataCache` for "world stuff" now need to know about `WorldStateStore`, `WorldLifecycleStore`, and `SharedContentStore`. Mitigated by the typed accessors and by the colocation in `core/world/`.
- **Typed shapes require maintenance when Foundry drifts.** When v14 ships, the manifest types (`WorldManifest`, `SystemManifest`, `ModuleManifest`, etc.) need updates. This is the *intended* tradeoff — drift becoming visible at the type layer instead of hiding in runtime — but it does mean a typed-update PR is required at each Foundry generation bump.
- **`CoreSocket.connect()` still owns the bootstrap orchestration body until ADR-0017.** This ADR moves *state* off the socket but doesn't move *who seeds the state*. The seed call stays inline in `connect()` for now. That's fine; subsequent ADRs in the arc unwind it. But during the gap (ADR-0014 shipped, ADR-0017 not yet shipped), `CoreSocket.connect()` continues to be the orchestrator. Implementers should not invest in cleaning up `connect()` further during this ADR's window — ADR-0017 will rewrite it.

---

## Related Decisions

This ADR is the first of five coordinated ADRs (see *Part of the ADR-0014 arc* above). Sister ADRs in dependency order:

- **ADR-0015**: Compendium architecture and the pathway B read gap.
- **ADR-0016**: Document resolution and UUID routing.
- **ADR-0017**: World bootstrap and lifecycle orchestration.
- **ADR-0018**: Socket-boundary enforcement completion.
- **ADR-0019 (deferred)**: Foundry version compatibility flag.

Adjacent ADRs from other arcs:

- **ADR-0011** — primary document model. Established the pattern this ADR extends (Stores hold state, services orchestrate, transports just move bytes). Phase 8 of ADR-0011 removed primary-doc type-specific helpers from sockets; this arc continues that work on the non-document surface.
- **ADR-0012** — realtime events. Defines the wire-event surface; not directly touched by this ADR but referenced by ADR-0017 for lifecycle-driven fan-out gating.
- **ADR-0013** — ownership and visibility. Defines the subject and threshold model used by Store accessors; not directly touched by this ADR.

---

## Validation

Each phase validates at the Store-contract layer and at the migration boundary:

- Base-contract unit tests against `WorldStateStore` assert `seed(rawGameData)` correctly populates every typed accessor, that `clear(reason)` resets all fields, and that the typed accessors return the documented shapes using the synthetic fixture shape documented in *World-state test data policy*. Real audit dump data must not be copied into tracked test fixtures.
- `WorldLifecycleStore` unit tests assert the state-machine transition rules and that `transition` events fire with `{ from, to, reason }`.
- `SharedContentStore` unit tests assert `set` / `clear` semantics and the `sharedContentChanged` event surface.
- Migration audit uses targeted `rg` checks instead of one broad grep:
  - `rg -n "getSystemClient\(\)\.(getGameData|getSceneData|getSystem|getSystemConfig|worldState|gameDataCache|sceneDataCache|probeWorldData|probeUserCount|cachedWorldData|cachedWorlds)" src/server` returns no hits outside the seeding caller and phase-documented exceptions.
  - `rg -n "\.(getGameData|getSceneData|getSystemConfig|getSharedContent)\(" src/server` returns no socket-reader hits. `RouteFoundryClient.getSystem()` may remain as a facade method, but its implementation must be Store-backed rather than socket-backed.
  - `rg -n "\.worldState\b|gameDataCache|sceneDataCache|probeWorldData|probeUserCount|cachedWorldData|cachedWorlds" src/server` returns no direct world-state reads outside `CoreSocket`, the new Stores, and the seeding caller.
  - `rg -n "lastActorChange|actorSyncToken" src/server` remains a documented ADR-0017 exception: until `SyncTokenService` lands, the only runtime path is the `CoreSocket` timestamp update, the `StatusService` payload projection, and the narrow `FoundrySystemClientLike` type.
  - `getSystemAdapter` / `loadSystemAdapter` intentionally still exist on `CoreSocket` and `ClientSocket` until ADR-0017; their removal audit belongs to ADR-0017.
- Phase 4 file-layout audit verifies that `compendium-cache.ts` is gone, `core/foundry/classes/` is gone, `core/world/SetupManager.ts` exists, and `core/compendium/CompendiumCache.ts` exists.
- Phase 5 socket-reader audit verifies that the deleted world-state methods no longer exist on `CoreSocket` / `ClientSocket`, and that any remaining `getSystem()` readers are direct `worldStateStore.getSystem()` calls or Store-backed route facades.
- `npx tsc --noEmit` and `npm run test:unit` pass.

---

## Exit Criteria

This ADR is fulfilled when the non-document world-state foundation is in place and the rest of the ADR-0014 arc has a clean base to build on.

- [x] Phase 1: `WorldStateStore` + typed shapes (`core/world/types.ts`) + readers migrated.
- [x] Phase 2: `WorldLifecycleStore` + lifecycle-state migration from `CoreSocket.worldState`.
- [x] Phase 3: `SharedContentStore` at `core/world/SharedContentStore.ts` with the immutable-snapshot contract (clone-on-write + clone-on-read; stored payload stays relative/raw). `SocketBase.setupSharedContentListeners` writes through to the Store via `sharedContentStore.set(payload)`; `CoreSocket` clears the Store alongside active-world runtime state teardown; the legacy `protected sharedContent` field and public `getSharedContent()` accessor are gone. `UtilityService.getSharedContent()` reads `sharedContentStore.getCurrent()` and projects URL resolution onto the defensive copy. `UtilityClientLike.getSharedContent` removed from the type; `createRouteFoundryClient` no longer exposes the facade method. Realtime gateway subscribes to `sharedContentStore.onSharedContentChanged(...)` directly (no longer to per-session `foundryClient.on('sharedContentUpdate', ...)`); the gateway test asserts the foundryClient handler count drops 3 → 2. Browser sockets still receive the `sharedContentUpdate` wire event unchanged. Tests in [shared-content-store.test.ts](../../src/tests/unit/shared-content-store.test.ts).
- [x] Phase 4: File-layout outliers — `compendium-cache.ts` renamed and moved to `core/compendium/CompendiumCache.ts`; `classes/Roll.ts` flattened to `foundry/Roll.ts`; `SetupManager.ts` moved to `core/world/`; `instance.ts` audited and deleted after remaining local-module callers moved to request-scoped clients.
- [x] Phase 5: Remove `getGameData` / `getSceneData` / `getSystem` / `getSystemConfig` and the public `worldState` lifecycle reader from `CoreSocket`; remove matching `getSystem` / `getSystemConfig` delegation methods from `ClientSocket`; remove socket-world-state reader declarations from `interfaces.ts`. Leave `getSystemAdapter` / `loadSystemAdapter` / cached `this.adapter` on `CoreSocket` and the `getSystemAdapter` delegation on `ClientSocket` (ADR-0017 removes them alongside the new `WorldBootstrapper.getActiveAdapter()`).
- [x] `rg` migration audit confirms no remaining socket reads for the migrated fields outside the seeding caller and phase-documented exceptions.
- [x] `npx tsc --noEmit` and `npm run test:unit` pass.
- [x] Status flipped to **Accepted** when all phases ship green.
- [x] Each phase verified before proceeding to the next.

Sister ADRs in the arc track their own exit criteria; this ADR is complete when its own phases ship, independent of the others.
