# ADR-0015: Compendium Architecture and the Pathway B Read Gap

**Status:** Proposed — Phases 1-2 completed May 19, 2026; Phases 3-5 not started.
**Date:** May 19, 2026
**Phase:** Compendium Architecture (Phase 2 of the ADR-0014 arc)
**Supersedes:** None. Builds on ADR-0014's `core/compendium/` layout and socket-boundary principle.
**Related:** ADR-0011 (primary document model), ADR-0014 (non-document world state and socket boundary), ADR-0016 (document resolution), ADR-0017 (world bootstrap), ADR-0018 (socket-boundary completion).

---

## Part of the ADR-0014 arc

This ADR is the second decision in the ADR-0014 arc. ADR-0014 moved non-document world state out of sockets and established the layout convention. ADR-0015 applies the same principle to compendium discovery and pack reads.

| ADR | Scope | Depends on |
|---|---|---|
| ADR-0014 — Non-Document World State and the Socket Boundary Principle | `WorldStateStore`, `WorldLifecycleStore`, `SharedContentStore`, file-layout convention, and removal of world-state readers from sockets. | none |
| **ADR-0015 (this ADR)** — Compendium Architecture and the Pathway B Read Gap | `CompendiumStore`, `CompendiumService`, `DiscoveryShardStore` / shard reader. Fixes the gap where module-declared discovery writes persistent shards that are not exposed through the SDK discovery surface (`context.platform.discovery`). De-duplicates Pathway A/B index fetches and moves `getAllCompendiumIndices` / `getPackEntries` / `getPackIndex` / `getPackDocuments` off sockets. | ADR-0014 |
| ADR-0016 — Document Resolution and UUID Routing | `DocumentResolver`; removes `fetchByUuid` from `CoreSocket` and `ClientSocket`; parses compendium UUIDs and delegates to ADR-0015's shard lookup plus pack-document fetch primitives. | ADR-0015 |
| ADR-0017 — World Bootstrap and Lifecycle Orchestration | `WorldBootstrapper`, delayed `active`, adapter ownership, engagement policy, sync-token cleanup. | ADR-0014 through ADR-0016 |
| ADR-0018 — Socket Boundary Enforcement Completion | Residual socket-boundary cleanup after the named extractions. | ADR-0014 through ADR-0017 |

**Reading order if you land here cold:** read ADR-0014 first. It explains why Stores/services are replacing socket-owned state and why new compendium files live under `core/compendium/` and `services/compendium/`.

---

## Context

Compendium behavior currently lives in three places that do not line up cleanly:

- `CoreSocket` owns pack discovery and pack fetch methods: `getAllCompendiumIndices()`, `getPackEntries()`, `getPackIndex()`, and `getPackDocuments()`.
- `CompendiumCache` in `core/compendium/CompendiumCache.ts` is a small in-memory UUID-to-name map. It warms by calling `client.getAllCompendiumIndices()`, which still means "ask the socket to do discovery".
- `DiscoveryService` in `core/foundry/DiscoveryService.ts` syncs module-declared packs into persistent `pack-<packId>` shards, but `createScopedDiscovery()` does not read those shards. It only wraps the name-only `CompendiumCache`, `findAll()` returns `[]`, and `findOne()` / `getById()` are best-effort UUID-to-name lookups.
- Some modules can and do read the shards by importing internal platform pieces such as `PersistentCache` directly. That proves the declared-shard intent, but it bypasses the SDK boundary ADR-0010 is trying to make real.

The result is two separate compendium pathways:

**Pathway A — platform-wide UUID/name index**

- Entry point today: `CoreSocket.getAllCompendiumIndices()`.
- Scope: every pack exposed by the world (`game.packs`, `world.packs`, `system.packs`, `modules[].packs`).
- Detail level: pack index rows, used today to build UUID-to-name lookup.
- Storage: in-memory for the active world.
- Consumer: name resolution for UUID references throughout the app.

**Pathway B — module-declared discovery shards**

- Entry point today: `DiscoveryService.sync(client, systemId, config)`.
- Scope: only packs declared in a module's `info.json` or adapter `getDiscoveryConfig()`.
- Detail level: either full documents when `hydrate: true`, or projected index rows when `fields` are specified.
- Storage: persisted under `PersistentCache` as `manifest-<systemId>` plus `pack-<packId>`.
- Intended consumer: module adapters via `context.platform.discovery`.

The current gap is Pathway B's SDK read side. The write path exists and can populate shards, and modules may reach them today through internal imports, but the official SDK discovery surface does not expose them. That means module-declared hydration has no supported platform read model. Separately, Pathway A and B duplicate the default index fetch for any pack that appears in both paths.

None of this is transport. It is pack discovery, cache policy, shard freshness, and API compatibility over several Foundry socket events. The socket still provides bytes through `emitSocketEvent(...)` and `dispatchDocumentSocket(...)`, but it should not own the compendium domain.

---

## Decision

Introduce a compendium architecture with three focused pieces:

- `CompendiumStore` in `src/server/core/compendium/CompendiumStore.ts` owns active-world pack metadata and index snapshots.
- `CompendiumService` in `src/server/services/compendium/CompendiumService.ts` owns pack discovery, pack index/doc fetch strategies, and parsed pack-document fetch primitives.
- `DiscoveryShardStore` or `DiscoveryShardReader` owns the persistent Pathway B shard read model and backs `context.platform.discovery`.

`CompendiumCache` remains, but only as the UUID-to-name map. It should rebuild from `CompendiumStore` data rather than calling a socket-facing metadata client.

`DiscoveryService` moves from `core/foundry/DiscoveryService.ts` to `services/compendium/DiscoveryService.ts`. It remains the module-declared shard sync service, but it collaborates with `CompendiumStore` / `CompendiumService` instead of calling socket methods directly.

### Socket Surface

Remove from `CoreSocket` by the end of this ADR:

- `getAllCompendiumIndices(onlyGamePacks?)`
- `getPackEntries(packId, options?)`
- `getPackIndex(packId, type)`
- `getPackDocuments(packId, type)`

Remove from `ClientSocket` by the end of this ADR:

- `getAllCompendiumIndices()` delegation.

Route-facing or module-facing facades may keep a `getAllCompendiumIndices()` method if existing consumers need it, but the implementation must call `CompendiumService` or read `CompendiumStore`. The socket classes must not expose the compendium reader methods.

`fetchByUuid(uuid)` is not moved or removed in ADR-0015. ADR-0015 prepares the compendium pieces ADR-0016 will need: a Pathway B shard lookup for declared packs and a parsed pack-document transport fallback. ADR-0016 owns UUID parsing, `DocumentResolver`, and the clean deletion of `CoreSocket.fetchByUuid()` / `ClientSocket.fetchByUuid()`.

### Transport Boundary

`CompendiumService` should depend on a narrow transport shape, not the full `CoreSocket` type:

- `isConnected: boolean`
- `emitSocketEvent<T>(event, ...payloads): Promise<T>`
- `dispatchDocumentSocket(type, action, operation, parent?, failHard?): Promise<unknown>`
- optional `runWithHeartbeatPaused<T>(operation): Promise<T>` or equivalent transition helper while heartbeat policy still lives on `CoreSocket`

The optional heartbeat wrapper preserves today's `getPackEntries()` behavior, which pauses the heartbeat during long pack fetches. ADR-0017 moves heartbeat/engagement policy out of `CoreSocket`; ADR-0015 should avoid entangling compendium logic further with that private field.

### Pathway A and B

Pathway A stays broad and lightweight. It discovers every pack index and builds a UUID/name map. It must not hydrate every pack.

Pathway B stays module-declared and potentially hydrated. Full documents are fetched only for packs a module explicitly declares with `hydrate: true`. This is the policy that prevents unrelated module packs from bloating bootstrap.

Where Pathway A and B overlap, de-duplicate the default index fetch:

- If `CompendiumStore` already has a default index for the pack, `DiscoveryService` uses it to compute the same freshness hash Pathway B computes today.
- If a non-hydrated shard needs field-specific rows not present in the default index, `DiscoveryService` fetches that field-aware variant through `CompendiumService` and stores it as a variant.
- If a hydrated shard is stale, `DiscoveryService` still fetches full docs. The default index only avoids redundant freshness work; it does not replace declared hydration.

### Test Data Policy

Do not commit real compendium shards, real pack dumps, or local Foundry pack data as fixtures. Persistent shards under local data directories are runtime evidence only.

Compendium tests should use tiny synthetic in-code fixtures:

- Pack metadata: `id`, `label`, `name`, `type` / `entity` / `documentName`, `packageName`, `source`, optional `moduleId`.
- Index rows: `_id`, `name`, `type`, `img`, optional flattened fields such as `system.class` or `system.tier`.
- Hydrated documents: `_id`, `uuid`, `name`, `type`, `img`, and a minimal `system` object.
- Discovery manifest: `systemId`, `_instanceId`, and `packs[packId]` entries with `id`, `hash`, `lastUpdated`, `rowCount`.

If a future behavior needs broader shape coverage, extend these synthetic fixtures with the specific missing fields. Do not promote `temp/` audit data or live `PersistentCache` shards into tracked fixtures.

---

## Details

### `CompendiumStore`

`CompendiumStore` owns active-world pack index state. It is memory-backed and clears with the active world.

Suggested public surface:

- `seedDiscoveredPacks(packs, reason?)`
- `setPackIndex(packId, metadata, index, options?)`
- `getPackIndex(packId, options?)`
- `listPackIndices(options?)`
- `getPackMetadata(packId)`
- `findIndexEntry(uuid)`
- `clear(reason?)`

Index variants are field-aware. The default Pathway A index is not equivalent to a field-projected index if the projected fields are not present. A simple stable fields key (`default` or sorted field names joined by `|`) is enough.

`CompendiumStore` should clone on write and clone on read, matching the Store contracts from ADR-0014. Compendium index rows are mutable-looking Foundry objects; callers must not mutate Store-owned rows.

### `CompendiumCache`

`CompendiumCache` remains the UUID-to-name map because adapter/name resolution already depends on that small surface.

Changes:

- Replace `initialize(client: FoundryMetadataClient)` with a Store/service-backed warmup path such as `rebuildFromIndices(indices)` or `initializeFromStore()`.
- Keep `getName(uuid)`, `resolve(text)`, `set(uuid, name)`, `getKeys()`, and `reset()`.
- Reset it on world disconnect/setup alongside `CompendiumStore`.

It should not know how to call Foundry. It reads already-discovered index data and projects names.

### `CompendiumService`

`CompendiumService` owns the current socket method semantics:

- `discoverIndices(options?)`
- `getPackEntries(packId, options?)`
- `getPackIndex(packId, type, options?)`
- `getPackDocuments(packId, type, options?)`
- `getPackDocument(packId, documentId, type?, options?)`

The service preserves the existing API-compatibility ladders:

- `getPackEntries()` currently tries `modifyDocument`, then `getDocuments`, then `getCompendiumIndex`.
- `getPackIndex()` currently tries `getCompendiumIndex`, then `getDocuments` with type fallbacks, then `modifyDocument`.
- `getPackDocuments()` currently tries `getDocuments` with type fallbacks, then `modifyDocument`.
- `getPackDocument()` owns only the parsed pack/id/type transport fallback currently embedded inside `CoreSocket.fetchByUuid()`'s compendium branch. It should not parse UUIDs. It preserves the current `modifyDocument` then `getDocuments` strategy across inferred core types. A `getCompendiumIndex` lookup fallback may be added only as an explicitly documented compatibility improvement with tests.

The service writes successful index results into `CompendiumStore`. It should not write full hydrated docs into `CompendiumStore` unless a later feature needs an active-world in-memory full-doc cache. Hydrated Pathway B docs belong to the discovery shard store.

### `DiscoveryShardStore` / Shard Reader

Pathway B needs a real read model over the persistent shards already written by `DiscoveryService`.

Suggested public surface:

- `loadManifest(systemId)`
- `getShard(systemId, packId)`
- `setShard(systemId, packId, documents, manifestEntry)`
- `findOne(systemId, type, query, options?)`
- `findAll(systemId, type, query?, options?)`
- `getById(systemId, type, id, options?)`
- `findDocument(systemId, packId, documentId, type?)`

The shard reader should know pack scope. A module's `context.platform.discovery` must only read shards for packs declared by that module's discovery config. If no discovery config exists, it should fail closed to an empty result set rather than scanning every persisted shard.

`createScopedDiscovery(moduleId)` should use this read model. The existing SDK interface can stay:

- `findOne(type, query)`
- `findAll(type, query?)`
- `getById(type, id)`

The implementation becomes shard-backed first, with the UUID-to-name cache used only as a fallback for name-only lookups where that behavior already exists.

### Discovery Service Move

`DiscoveryService` moves to `src/server/services/compendium/DiscoveryService.ts`. It is a service, not a Foundry transport primitive.

The sync algorithm stays compatible:

1. Compute the freshness hash from index rows using the same hash input as today.
2. If the manifest hash matches and the shard exists, skip the fetch.
3. If stale and `hydrate: true`, fetch full documents in chunks.
4. If stale and not hydrated, fetch projected index rows with the configured `fields`.
5. Write the shard and manifest through the shard store.

The first pass should preserve manifest compatibility. Do not force a cache rebuild by changing the hash input unless a manifest version bump is deliberate and documented.

### What Stays Out

ADR-0015 does not implement `DocumentResolver`; ADR-0016 owns that.

ADR-0015 does not move or remove `fetchByUuid` from sockets; ADR-0016 owns that deletion. ADR-0015 deliberately avoids adding a second UUID-shaped public resolver. It provides parsed compendium document primitives for ADR-0016 to compose.

ADR-0015 does not move adapter lifecycle or `getSystemAdapter()`; ADR-0017 owns that.

ADR-0015 does not rewrite bootstrap timing; ADR-0017 owns the move from `SystemService.bootstrap()` / `CoreSocket.connect()` into `WorldBootstrapper`.

ADR-0015 does not perform broad external-module import cleanup. Local ignored modules may be touched for verification hygiene, but SDK import cleanup remains governed by ADR-0010 and module-specific migration work.

---

## ADR-0015 Phase Staging

This section follows ADR-0011 through ADR-0014: each phase has a named scope, status, action checklist with file touchpoints, non-goals, and a concrete exit statement. Phase 1 is intentionally behavior-preserving.

### Phase 1: CompendiumStore and typed index contracts

**Status:** Closed May 19, 2026.

Phase 1 introduces the canonical in-memory home for active-world pack indices. Existing callers continue through the current socket methods while the Store and tests land.

**Action items:**

- [x] Add typed compendium contracts for pack metadata, index rows, field-aware index variants, discovery results, and shard manifest entries.
  Files: `src/server/core/compendium/types.ts`.

- [x] Add `CompendiumStore` with clone-on-write / clone-on-read semantics, default and field-aware index variants, metadata lookup, UUID/index-entry lookup, and idempotent `clear(reason?)`.
  Files: `src/server/core/compendium/CompendiumStore.ts`, `src/server/core/compendium/index.ts`.

- [x] Add unit coverage for seed, clear, metadata lookup, default index lookup, field-aware variant lookup, UUID entry lookup, clone-on-read, and clone-on-write behavior using tiny synthetic fixtures.
  Files: `src/tests/unit/compendium-store.test.ts`, `src/tests/unit/run.ts`.

- [x] Document the compendium synthetic fixture policy so future tests do not commit real pack or shard data.
  Files: `docs/adr/0015-compendium-architecture-and-pathway-b-read-gap.md`.

- [x] Verify Phase 1 with unit/type checks and source audits. Remaining compendium socket methods are allowed in this phase.
  Commands: `npm run test:unit`; `npx tsc --noEmit`; `rg -n "CompendiumStore|CompendiumCache|getAllCompendiumIndices|getPackEntries|getPackIndex|getPackDocuments" src/server src/tests`.

**Non-goals for Phase 1:**

- No caller migration.
- No `CompendiumService` extraction.
- No shard reader.
- No socket method deletion.
- No `fetchByUuid` changes.

**Exit for Phase 1:** `CompendiumStore` and typed compendium index contracts exist with unit coverage; tests use synthetic in-code pack/index/shard shapes; no runtime behavior changes; `npm run test:unit` and `npx tsc --noEmit` pass.

**Phase 1 closed (May 19, 2026).** All action items above ticked. Implementation added `CompendiumStore`, typed compendium index/shard contracts, and synthetic unit coverage. No runtime callers migrated; existing socket compendium methods remain until later phases by design.

### Phase 2: CompendiumService and Pathway A migration

**Status:** Closed May 19, 2026.

Phase 2 moves platform-wide pack discovery (Pathway A) out of `CoreSocket` and into `CompendiumService`. The socket may keep temporary compatibility methods during this phase, but they should delegate to the service or remain as thin wrappers only until Phase 5 removes them.

**Action items:**

- [x] Add `CompendiumService` with a narrow transport dependency and methods for `discoverIndices`, `getPackEntries`, `getPackIndex`, and `getPackDocuments`.
  Files: `src/server/services/compendium/CompendiumService.ts`, `src/server/services/compendium/index.ts`.

- [x] Preserve the existing API-compatibility ladders for pack entries, pack index, and full pack docs. If behavior changes, call it out as an explicit compatibility improvement with tests.
  Files: `src/server/services/compendium/CompendiumService.ts`, `src/tests/unit/compendium-service.test.ts`.

- [x] Preserve the current heartbeat-pause behavior for long pack entry fetches through a narrow transport helper or service-local wrapper until ADR-0017 moves heartbeat policy.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts`, `src/server/services/compendium/CompendiumService.ts`.

- [x] Make `discoverIndices()` walk `game.packs`, `world.packs`, `system.packs`, and `modules[].packs` from `WorldStateStore.getGameDataSnapshot()` or typed Store accessors, de-dupe by pack id, fetch indices in parallel, and write results into `CompendiumStore`.
  Files: `src/server/services/compendium/CompendiumService.ts`, `src/server/core/compendium/CompendiumStore.ts`.

- [x] Change `CompendiumCache` warmup so it rebuilds from `CompendiumStore` / `CompendiumService` results instead of calling `client.getAllCompendiumIndices()`.
  Files: `src/server/core/compendium/CompendiumCache.ts`, `src/server/core/system/SystemService.ts`.

- [x] Update `SystemService.bootstrap()` to warm Pathway A through `CompendiumService` and rebuild `CompendiumCache` from the Store-backed result.
  Files: `src/server/core/system/SystemService.ts`.

- [x] Reset `CompendiumStore` and `CompendiumCache` on world disconnect/setup teardown. Persistent Pathway B shards remain on disk; active-world in-memory indices do not.
  Files: `src/server/core/system/SystemService.ts`, `src/server/core/foundry/sockets/CoreSocket.ts` if setup teardown is the only reliable hook before ADR-0017.

- [x] Verify Phase 2 with unit/type checks and Pathway A audits. Remaining socket methods are allowed only as temporary wrappers.
  Commands: `npm run test:unit`; `npx tsc --noEmit`; `rg -n "CompendiumCache\\.getInstance\\(\\)\\.initialize\\(|gameDataCache\\.indices|getAllCompendiumIndices\\(" src/server`; `rg -n "getPackEntries\\(|getPackIndex\\(|getPackDocuments\\(" src/server`.

**Non-goals for Phase 2:**

- No shard reader.
- No Pathway A/B de-duplication beyond writing Pathway A indices into `CompendiumStore`.
- No deletion of temporary socket wrappers.
- No `fetchByUuid` migration.
- No route/module facade cleanup unless a caller is already easy to point at `CompendiumService`.

**Exit for Phase 2:** `CompendiumService` owns Pathway A discovery and pack fetch semantics; `CompendiumStore` holds discovered indices; `CompendiumCache` warms from Store/service results; bootstrap calls the service rather than asking `CompendiumCache` to call the socket; active-world compendium state clears on teardown; unit/type checks pass.

**Phase 2 closed (May 19, 2026).** All action items above ticked. Implementation added `CompendiumService`, converted `CoreSocket` compendium readers into temporary service wrappers, preserved the pack-entry heartbeat pause through `withHeartbeatPaused(...)`, moved bootstrap Pathway A warmup into `SystemService`, rebuilt `CompendiumCache` from Store/service results, and cleared active-world compendium state on setup/disconnect teardown. Route facades may still expose `getAllCompendiumIndices()` for compatibility, but the implementation now calls `CompendiumService` rather than `client.getAllCompendiumIndices()`. Tests use synthetic in-code pack/index shapes only; no real world, pack dump, shard, or fixture content was added.

### Phase 3: Discovery shard read model and SDK discovery wiring

**Status:** Not started.

Phase 3 closes the Pathway B read gap. Persistent discovery shards that `DiscoveryService` writes become readable through `context.platform.discovery`.

**Action items:**

- [ ] Move `DiscoveryService` from `src/server/core/foundry/DiscoveryService.ts` to `src/server/services/compendium/DiscoveryService.ts`.
  Files: `src/server/core/foundry/DiscoveryService.ts`, `src/server/services/compendium/DiscoveryService.ts`, `src/server/core/system/SystemService.ts`.

- [ ] Add `DiscoveryShardStore` or `DiscoveryShardReader` over `PersistentCache` with manifest load, shard read/write, `findOne`, `findAll`, and `getById` helpers.
  Files: `src/server/core/compendium/DiscoveryShardStore.ts` or `src/server/services/compendium/DiscoveryShardReader.ts`.

- [ ] Make shard reads module-scoped. `createScopedDiscovery(moduleId)` should only expose packs declared by that module's discovery config and should fail closed to empty results when no scope is available.
  Files: `src/server/shared/utils/createModuleContext.ts`, `src/modules/registry/core/server.ts` if module discovery metadata needs to be exposed to the context factory.

- [ ] Implement SDK discovery methods against shards: `findOne(type, query)`, `findAll(type, query?)`, and `getById(type, id)`. Keep UUID-to-name fallback only where existing behavior already provides it.
  Files: `src/server/shared/utils/createModuleContext.ts`, `src/shared/sdk/context.ts`.

- [ ] Add unit coverage for shard manifest loading, module-scoped shard lookup, empty-scope fail-closed behavior, `findOne`, `findAll`, `getById`, and persisted-shard shape compatibility.
  Files: `src/tests/unit/discovery-shard-store.test.ts`, `src/tests/unit/module-context-discovery.test.ts`, `src/tests/unit/run.ts`.

- [ ] Verify Phase 3 with unit/type checks and old-path audits.
  Commands: `npm run test:unit`; `npx tsc --noEmit`; `rg -n "core/foundry/DiscoveryService|from ['\\\"].*foundry/DiscoveryService|@core/foundry/DiscoveryService" src data/local/modules`; `rg -n "findAll: async \\([^)]*\\) => \\[\\]|createScopedDiscovery" src/server/shared/utils/createModuleContext.ts`.

**Non-goals for Phase 3:**

- No manifest hash behavior change.
- No Pathway A/B de-duplication yet.
- No full external module import cleanup.
- No `fetchByUuid` socket removal.
- No broad SDK contract expansion; the existing `CompendiumCache` SDK shape is enough for this phase.

**Exit for Phase 3:** `DiscoveryService` lives under `services/compendium`; Pathway B shards have a real read model; `context.platform.discovery` reads scoped persistent shards instead of returning empty arrays; no old `core/foundry/DiscoveryService` imports remain; unit/type checks pass.

### Phase 4: Pathway A/B de-duplication and pack-document lookup primitives

**Status:** Not started.

Phase 4 makes the two pathways collaborate without merging their policy. It also adds parsed pack-document lookup primitives so ADR-0016 can implement UUID resolution without inheriting socket logic.

**Action items:**

- [ ] Make `DiscoveryService.syncPack()` use `CompendiumStore.getPackIndex(packId)` for the default freshness index when the cached index has the required fields.
  Files: `src/server/services/compendium/DiscoveryService.ts`, `src/server/core/compendium/CompendiumStore.ts`.

- [ ] Add field-aware index fetch/storage for non-hydrated discovery packs whose configured `fields` are not covered by the default index.
  Files: `src/server/services/compendium/DiscoveryService.ts`, `src/server/services/compendium/CompendiumService.ts`, `src/server/core/compendium/CompendiumStore.ts`.

- [ ] Preserve manifest hash compatibility unless an explicit manifest version bump is introduced. Existing shards should not rebuild just because the service moved.
  Files: `src/server/services/compendium/DiscoveryService.ts`, `src/tests/unit/discovery-service.test.ts`.

- [ ] Add a Pathway B shard document lookup such as `DiscoveryShardStore.findDocument(systemId, packId, documentId, type?)`. Declared hydrated shards should be the first place ADR-0016 looks after it parses a compendium UUID.
  Files: `src/server/core/compendium/DiscoveryShardStore.ts` or `src/server/services/compendium/DiscoveryShardReader.ts`, `src/tests/unit/discovery-shard-store.test.ts`.

- [ ] Add a parsed pack-document transport fallback such as `CompendiumService.getPackDocument(packId, documentId, type?)`. It should not parse UUIDs; it receives already-parsed parts and preserves the existing socket API ladder when no declared shard serves the document.
  Files: `src/server/services/compendium/CompendiumService.ts`, `src/tests/unit/compendium-service.test.ts`.

- [ ] Remove or rewrite the stale "full pack-doc hydration at bootstrap" TODO in `CoreSocket.fetchByUuid` so the code points to this ADR's Pathway B policy until ADR-0016 removes the method.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts`.

- [ ] Verify Phase 4 with unit/type checks and socket-call accounting tests where practical. A declared hydrated shard lookup should serve without a transport call; an undeclared/missing pack document should fall back to `CompendiumService.getPackDocument(...)`.
  Commands: `npm run test:unit`; `npx tsc --noEmit`; `rg -n "full pack-doc hydration|gameDataCache\\.indices|client\\.getPackEntries\\(" src/server docs/adr`.

**Non-goals for Phase 4:**

- No across-all-packs full hydration.
- No deletion or rewiring of `CoreSocket.fetchByUuid` or `ClientSocket.fetchByUuid`; ADR-0016 owns that.
- No new public UUID resolver. This phase adds parsed pack-document primitives only.
- No route/module facade call-shape breakage.
- No bootstrap timing changes.

**Exit for Phase 4:** Pathway B reuses Pathway A's default index where semantically valid; field-specific variants are fetched only when needed; module-declared hydrated shards have a direct `findDocument`-style lookup that can serve without a socket round trip; missing pack documents can fall back to a parsed `CompendiumService.getPackDocument(...)` transport ladder; unit/type checks pass.

### Phase 5: Remove residual compendium socket readers

**Status:** Not started.

Phase 5 closes ADR-0015's socket-boundary promise. The compendium service/store/shard reader are now the read surfaces; sockets only provide raw transport.

**Action items:**

- [ ] Remove `CoreSocket.getAllCompendiumIndices()`, `getPackEntries()`, `getPackIndex()`, and `getPackDocuments()`.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts`.

- [ ] Remove `ClientSocket.getAllCompendiumIndices()` delegation.
  Files: `src/server/core/foundry/sockets/ClientSocket.ts`.

- [ ] Tighten socket-facing interfaces by removing compendium reader requirements from `FoundryMetadataClient` / `FoundryClient`. Keep request-facing facades only where they are service-backed.
  Files: `src/server/core/foundry/interfaces.ts`, `src/server/shared/types/requestContext.ts`, `src/server/shared/utils/createRouteFoundryClient.ts`.

- [ ] Migrate scripts/tests/direct callers that still invoke compendium readers on sockets to `CompendiumService`, `CompendiumStore`, or a service-backed route facade.
  Files: `src/tests/socket/04-users-compendia.test.ts`, `src/tests/socket/04-compedium-fetch.test.ts`, `src/tests/deprecated/module-specific/shadowdark/05-compendium-resolution.test.ts`, `src/tests/socket/socket_diagnostic.ts`, relevant scripts if any.

- [ ] Update local ignored module touchpoints only as verification hygiene where they call service-backed facades. Do not stage ignored local module data unless explicitly requested.
  Local ignored verification touchpoints: `data/local/modules/shadowdark/src/server/api/spells.ts`, `data/local/modules/shadowdark/src/server/Registry.ts`.

- [ ] Verify Phase 5 with type/unit checks and targeted socket-reader audits.
  Commands: `npm run test:unit`; `npx tsc --noEmit`; `rg -n "public async (getAllCompendiumIndices|getPackEntries|getPackIndex|getPackDocuments)\\b|getAllCompendiumIndices\\(\\):" src/server/core/foundry`; `rg -n "\\b(core|client|coreSocket|foundryClient|systemClient)\\.(getAllCompendiumIndices|getPackEntries|getPackIndex|getPackDocuments)\\(" src/server src/scripts src/tests data/local/modules`; `rg -n "FoundryMetadataClient|getAllCompendiumIndices" src/server/core/foundry src/server/shared/types src/server/shared/utils`.

**Non-goals for Phase 5:**

- No `fetchByUuid` socket deletion; ADR-0016 owns it.
- No `getSystemAdapter()` / adapter cache removal; ADR-0017 owns it.
- No heartbeat/engagement extraction; ADR-0017 owns it.
- No session-state or URL utility cleanup; ADR-0018 owns it.
- No broad external module import cleanup.

**Exit for Phase 5:** `CoreSocket` no longer exposes compendium reader methods; `ClientSocket` no longer delegates compendium reads; socket-facing interfaces no longer require compendium readers; Pathway A reads go through `CompendiumService` / `CompendiumStore`; Pathway B reads go through the shard reader; service-backed facades remain only where needed; `npm run test:unit`, `npx tsc --noEmit`, and the Phase 5 audits pass.

---

## Alternatives Considered

### Keep compendium reads on `CoreSocket`

Rejected because the current methods are not just transport. They aggregate pack metadata, infer document types, manage compatibility fallback ladders, cache results, and interact with module discovery policy. That is service/store work that happens to use socket events.

### Merge Pathway A and Pathway B into one cache

Rejected because their policies differ. Pathway A is broad and lightweight across every exposed pack. Pathway B is narrow and optionally hydrated only for module-declared packs. A single cache would either over-hydrate unrelated packs or make module discovery less useful.

### Hydrate every pack at bootstrap

Rejected. Foundry worlds often expose packs from systems or modules the active adapter will never use. Full hydration is expensive and should remain a module-declared decision through `DiscoveryConfig`.

### Leave `context.platform.discovery` name-only

Rejected because it makes Pathway B write-only from the SDK's point of view. If the platform writes persistent shards but `context.platform.discovery` cannot read them, adapters either bypass the SDK with internal imports or duplicate cache logic.

### Move `fetchByUuid` entirely in ADR-0015

Rejected for scope. The full resolver covers world UUID routing, embedded UUIDs, stub Store policy, and compendium UUIDs. ADR-0015 prepares the compendium branch with shard lookup and parsed pack-document fetch primitives; ADR-0016 owns UUID parsing, the full `DocumentResolver`, and socket method deletion.

---

## Consequences

### Positive

- **Compendium reads get a real home.** Pack discovery and compatibility ladders move into `CompendiumService`; index state moves into `CompendiumStore`.
- **Pathway B becomes useful.** Module-declared hydrated shards are readable through `context.platform.discovery`.
- **Bootstrap does less duplicate work.** Declared discovery packs can reuse the default Pathway A index when the fields match.
- **Sockets shrink again.** `CoreSocket` and `ClientSocket` lose compendium reader methods, continuing the ADR-0014 boundary cleanup.
- **ADR-0016 gets clean dependencies.** The shard reader can serve declared hydrated pack documents, and `CompendiumService` can fetch a parsed pack document through the compatibility ladder. `DocumentResolver` can compose those pieces without inheriting socket logic.

### Tradeoffs

- **More moving parts.** `CompendiumStore`, `CompendiumService`, `DiscoveryShardStore`, `DiscoveryService`, and `CompendiumCache` have distinct jobs. The phase docs must keep those boundaries clear.
- **Manifest compatibility needs care.** Pathway B's freshness hash must remain stable unless we intentionally bump the manifest format.
- **Transport compatibility ladders need tests.** Foundry compendium APIs drift across versions; moving the ladders increases the importance of unit coverage for fallback ordering.
- **Temporary heartbeat coupling remains.** Long compendium fetches still need the existing heartbeat-pause behavior until ADR-0017 moves heartbeat policy out of `CoreSocket`.

---

## Related Decisions

- **ADR-0014** — created `core/compendium/`, moved `CompendiumCache`, and removed world-state socket readers.
- **ADR-0016** — consumes the shard lookup plus parsed pack-document fetch primitive, introduces `DocumentResolver.fetchByUuid`, and removes `fetchByUuid` from sockets.
- **ADR-0017** — moves bootstrap orchestration, adapter lifecycle, heartbeat/engagement policy, and sync-token ownership.
- **ADR-0018** — verifies the remaining socket boundary after the arc's named extractions.
- **ADR-0010** — governs external module SDK cleanup. ADR-0015 improves the SDK discovery implementation but does not complete all external-module import migration.

---

## Validation

Each phase validates both the Store/service contract and the socket boundary.

- `CompendiumStore` unit tests assert clone-on-write, clone-on-read, default index lookup, field-aware variant lookup, metadata lookup, UUID entry lookup, and clear behavior.
- `CompendiumService` unit tests assert pack discovery de-duplication, fallback ladder ordering, Store writes, and no transport call when a cached/indexed result should serve.
- `DiscoveryShardStore` / shard reader tests assert manifest load, scoped shard access, `findOne`, `findAll`, `getById`, and empty-scope fail-closed behavior.
- `context.platform.discovery` tests assert `findAll()` no longer returns an unconditional empty array when declared shards exist.
- Pathway A/B de-duplication tests assert a declared pack can reuse the default index for freshness while field-specific discovery still fetches required fields.
- Pack-document lookup tests assert hydrated declared shards serve through the shard reader without transport and missing documents fall back to `CompendiumService.getPackDocument(...)` with the existing socket strategy ladder.
- Migration audits use targeted `rg` checks:
  - `rg -n "public async (getAllCompendiumIndices|getPackEntries|getPackIndex|getPackDocuments)\b|getAllCompendiumIndices\(\):" src/server/core/foundry` returns no socket method declarations after Phase 5.
  - `rg -n "\b(core|client|coreSocket|foundryClient|systemClient)\.(getAllCompendiumIndices|getPackEntries|getPackIndex|getPackDocuments)\(" src/server src/scripts src/tests data/local/modules` returns no socket-reader calls after Phase 5.
  - `rg -n "core/foundry/DiscoveryService|from ['\"].*foundry/DiscoveryService|@core/foundry/DiscoveryService" src data/local/modules` returns no old-path imports after Phase 3.
  - `rg -n "gameDataCache\.indices|CompendiumCache\.getInstance\(\)\.initialize\(client\)" src/server` returns no legacy Pathway A cache ownership after Phase 2.
- `git diff --check`, `npx tsc --noEmit`, and `npm run test:unit` pass for every phase before moving to the next.

---

## Exit Criteria

This ADR is fulfilled when compendium discovery and module shard reads have service/store ownership and sockets no longer expose compendium reader methods.

- [x] Phase 1: `CompendiumStore` + typed index contracts + synthetic fixture policy.
- [x] Phase 2: `CompendiumService` owns Pathway A discovery and pack fetch semantics; `CompendiumCache` warms from Store/service results.
- [ ] Phase 3: `DiscoveryService` lives under `services/compendium`; Pathway B shards are readable through scoped `context.platform.discovery`.
- [ ] Phase 4: Pathway A/B index de-duplication lands; declared hydrated shards expose direct document lookup; parsed pack-document fallback through `CompendiumService` preserves the existing transport ladder.
- [ ] Phase 5: `CoreSocket` / `ClientSocket` compendium reader methods are removed and socket-facing interfaces are tightened.
- [ ] No real compendium/world shard data is added to tracked fixtures.
- [ ] `rg` migration audits confirm no remaining socket compendium reader declarations or direct socket-reader calls.
- [ ] `git diff --check`, `npx tsc --noEmit`, and `npm run test:unit` pass.
- [ ] Status flips to **Accepted** after all phases ship green.

ADR-0016 owns the next step: full document resolution and UUID routing.
