# ADR-0021: Startup Compendium Cataloging and Engagement Gates

**Status:** Proposed
**Date:** May 22, 2026
**Phase:** Startup Compendium and Readiness Follow-Up
**Supersedes:** None
**Revises:** ADR-0015 (Pathway A startup behavior)
**Related:** ADR-0015 (compendium architecture), ADR-0017 (world bootstrap and lifecycle), ADR-0020 (compendium UUID policy).

---

## Context

ADR-0015 split compendium behavior into Pathway A (platform-wide UUID/name index warmup) and Pathway B (module-declared pack rows). The split moved compendium readers out of sockets, but Pathway A still performs live `getCompendiumIndex` / `getDocuments` / `modifyDocument` traffic for every pack in `game.packs ∪ world.packs ∪ system.packs ∪ module.packs` on every cold start, regardless of whether any module declares those packs.

That is the wrong shape for application readiness. `game.data` already lists which packs exist. Seeing a pack in `game.data` should pre-file a record for it. It should not fetch the pack's index or documents.

ADR-0020 made normal module/SDK reads require declared compendium pack rows (hydrated for document reads; declared index rows for name/index reads). The store/service layer hasn't followed. Today there are three storage classes for what should be one read-only document store, and two services for what should be one:

- `CompendiumCache` — singleton UUID→name map (parallel data structure for indices that already exist elsewhere)
- `CompendiumStore` — in-memory pack indices and metadata
- `CompendiumPackStore` — persistent module-declared rows and manifest
- `CompendiumService` — Pathway A live-fetch primitives
- `CompendiumPackSyncService` — Pathway B declared-pack sync

The primary-document side of the codebase already shows the simpler pattern: one Store + one Service per document domain. Compendium is the same shape with two differences — it is **read-only** (no CRUD), and it is **cache-backed** so a restart begins from disk and only re-hydrates when source content has changed.

A startup log review also exposed an engagement/readiness issue. Browser clients are not supposed to be a control plane for `CoreSocket`, but the policy chain lets them affect it indirectly: a browser Socket.io connection updates `EngagementService`, and `EngagementService` can ask the service-account transport to reconnect on return-to-engagement. That wakeup behavior is useful for `offline` / `setup` monitoring, but it is wrong during `startup`. In `startup`, `CoreSocket` is already connected or connecting and `WorldBootstrapper` owns the in-flight bootstrap. A browser connection at that point should receive status only; it should not restart the system transport.

Finally, pack reads that fall through to `dispatchDocumentSocket(...)` can route `modifyDocument` responses through the world Store router. Foundry's compendium document type set overlaps with primary document classes (`Actor`, `Item`, `JournalEntry`, `RollTable`, `Scene`, `Macro`, `Playlist`, `Cards`, etc. — see [CONST.COMPENDIUM_DOCUMENT_TYPES](https://foundryvtt.com/api/variables/CONST.COMPENDIUM_DOCUMENT_TYPES.html)), so the boundary cannot be document type. The boundary is **scope**: world collection vs. compendium pack. Pack reads must not mirror into world Stores even when the returned class is a primary document class.

---

## Decision

ADR-0021 makes four decisions.

1. **One store, one service.** Replace `CompendiumCache` + `CompendiumStore` + `CompendiumPackStore` with one `CompendiumStore`. Replace `CompendiumService` + `CompendiumPackSyncService` with one `CompendiumService`. The pair mirrors the primary-document `Store + Service` pattern, minus CRUD: the store is read-only and cache-backed; the service owns module-driven hydration plus the on-demand fetch primitives. Persistent cache is authoritative — a restart begins from disk and re-hydrates a pack only when source content has changed.

2. **Bootstrap is passive.** `game.data.packs` is the only thing read at bootstrap, and it produces pre-filed pack records (id, document type, package source, label) in `CompendiumStore`. No live pack-index or pack-document fetches at bootstrap. The active module's `info.json` is the only signal that asks `CompendiumService` to hydrate or refresh a pack.

3. **Browser clients are status-only until readiness.** Browser Socket.io clients are not allowed to direct, restart, or wake `CoreSocket`. `EngagementService` may request a service-account monitor wakeup on return-to-engagement only from `offline` or `setup`; it must not request reconnect during `startup` or `active`. Per-user Foundry `ClientSocket` restore and world-backed listener attachment must wait until `SystemService.isReady()`.

4. **Pack reads do not mirror into world Stores.** Any explicit pack index/document fetch must use a transport path that does not proactively apply `operation.pack` results through `modifyDocumentRouter`. The dispatcher branches on `operation.pack`, not on the returned document's `type`.

---

## Details

### One Store, One Service

The target shape is:

```text
src/server/core/compendium/CompendiumStore.ts          // single read-only store
src/server/services/compendium/CompendiumService.ts    // single read-only service
```

The store owns two responsibilities:

- **Pack records pre-filed from `game.data.packs`**: id, document type, package source (game/world/system/module), label, on-disk path, ownership, and `flags` (which may carry a system-specific subtype hint such as `flags.dnd5e.types`). Written by bootstrap. Never fetched.
- **Pack rows and documents persisted across restart**: index rows for `hydrate: false` declared packs; full documents for `hydrate: true` declared packs; manifest with per-pack hash / lastUpdated / rowCount.

Both tiers live in one class so consumers ask one thing for one answer. There is no separate metadata cache, no UUID→name map, no separate pack-row reader.

The service owns:

- **`seedPackMetadataFromGameData(gameData)`** — passive, called by `WorldBootstrapper`. No transport calls.
- **`hydratePack(systemId, packDeclaration)`** — module-triggered. Checks persistent manifest first. If the pack's hash matches and on-disk rows exist, returns without transport calls. Otherwise issues one pack-scoped freshness fetch, recomputes the hash, and refreshes rows per the declaration's `hydrate` / `fields` policy.
- **`getPackIndex(packId, options?)`** — on-demand, scoped to a single pack. Used by `hydratePack` internally and available for diagnostics/admin.
- **`getPackDocument(packId, documentId, type?)`** — on-demand, scoped to a single pack. Used by `DocumentResolver` when ADR-0020 policy permits it.

The service has no `upsert` / `patch` / `delete`. Pack contents are owned upstream by Foundry; the platform only mirrors the slice modules declared.

`CompendiumStore.clear(reason)` discards **in-memory state only** — pre-filed metadata records and any cached row arrays held in the store instance. It must not delete persistent shards or the manifest. A transient service-account disconnect or world-close call should not wipe the on-disk warm cache; reconnect verifies the world identity and reuses persistent shards via the normal manifest-hash short-circuit. Persistent shards are only evicted by explicit operator action (admin reset) or world identity change.

### What `game.data.packs` does and does not carry

Foundry's bootstrap envelope exposes pack lists under `.packs`, `.world.packs`, `.system.packs`, and `.modules[*].packs`. Each entry is a **manifest record**, not document data. Verified against captured world dumps, each pack entry has exactly these fields:

```json
{
  "id": "dnd5e.heroes",
  "name": "heroes",
  "label": "Starter Heroes",
  "path": "systems/dnd5e/packs/heroes",
  "type": "Actor",
  "system": "dnd5e",
  "packageType": "system",
  "packageName": "dnd5e",
  "ownership": { "PLAYER": "OBSERVER", "ASSISTANT": "OWNER" },
  "flags": { "dnd5e": { "sourceBook": "SRD 5.1", "types": ["character"] } }
}
```

What is **not** in the envelope at any nesting level:

- no `index` array
- no `documents` / `entries` array
- no per-document `_id`, `name`, `img`, or other document fields

Implication: pre-filed metadata tells the platform *which* packs exist and *what kind* of documents they hold. It does not contain the documents or the per-document index rows. A `hydrate: false` declaration therefore still requires one Foundry index fetch per declared pack on cold start (the freshness fetch in the Cache Discipline table); a `hydrate: true` declaration adds chunked document fetches on top. Both are persisted, and warm restarts skip refetch when the manifest hash is current.

The `flags.<system>.types` array is a useful **subtype hint** (e.g. `["weapon", "equipment", "consumable", ...]` for an items pack). It can validate a module's declaration ("you declared `type: Item`, the pack confirms it carries items") but is not document data.

### Module Boundary: Declaration, Discovery, Sharding, Read Surface

The unification collapses three server-side storage classes and two services into one of each. The module-side surfaces — declaration source, registry accessor, persistent sharding strategy, and SDK reader — stay structurally where they are; they only switch their backing from `CompendiumPackStore` / `CompendiumCache` to the unified `CompendiumStore`.

End-to-end path:

1. **Declaration.** A module declares packs in `info.json` under `compendiumPacks.packs[]`, or returns the same shape from `adapter.getCompendiumPackConfig()` as a runtime fallback. Each entry names a pack `id`, document `type`, `hydrate: boolean`, and optional `fields`.

2. **Registry discovery.** [`getModuleCompendiumPackConfig(moduleId)`](src/modules/registry/core/server.ts) is the platform's only accessor for a module's pack config. It prefers `info.json` and falls back to the adapter hook. This is the canonical seam between the module side and the platform side; the ADR does not move it.

3. **Bootstrap consumption.** `WorldBootstrapper` resolves the active module's config via `getModuleCompendiumPackConfig` and asks `CompendiumService.hydratePacks(systemId, config)` to run the declared sync. Per-pack flow: check pre-filed metadata in `CompendiumStore` to confirm the pack exists in `game.data.packs`; if absent, log `[module:<id>] pack <pack-id> not found` and skip. If present, check the persistent manifest hash and on-disk shard; if fresh, skip with zero transport calls. Otherwise issue one freshness fetch and refresh the shard per `hydrate` / `fields`.

4. **Per-pack sharding.** Pack rows persist in `PersistentCache` as one shard per pack, keyed by `(systemId, "pack-<packId>")`. The systemId-scoped manifest under the same namespace records per-pack `hash` / `lastUpdated` / `rowCount`. Sharding is what makes "skip a fresh pack" cheap — per-pack hash plus per-pack rows mean a fresh pack costs one cache read, not a global reload. After unification this storage lives inside `CompendiumStore`; the shard key shape and systemId namespace are preserved so existing on-disk cache continues to be reused, not rebuilt.

5. **SDK read surface.** Modules see a scoped `CompendiumPackReader` exposed as `context.platform.compendiumPacks`. The reader is built by [`createScopedCompendiumPacks(moduleId)`](src/server/shared/utils/createModuleContext.ts). After unification, its backing flips from `CompendiumPackStore` to `CompendiumStore`. The interface (`findOne` / `findAll` / `getById`) and scoping rule (only declared pack ids) do not change.

Nothing in this path is dropped or rebuilt. The registry remains the authoritative source of pack declarations; the SDK reader remains the module-facing surface; per-pack sharding remains the persistence shape. The unification redirects the read/write endpoint from three classes to one — module discovery and sharding semantics carry through unchanged.

### Cache Discipline: No Duplicate Loads

The store contract guarantees that bootstrap + module onboarding never duplicates work the persistent cache already has:

| Phase | Transport calls |
|---|---|
| Bootstrap snapshot | one (existing) |
| Pack metadata seed from `game.data.packs` | **zero** |
| Module hydration, fresh persistent cache | **zero** (manifest hash match → skip) |
| Module hydration, cold start or stale | one freshness fetch per declared pack, then refresh per `hydrate` / `fields` |
| Runtime pack reads via SDK / DocumentResolver | zero (read declared rows from store) |
| Runtime live fallback | not allowed (ADR-0020) |

The bootstrap path must not call `getCompendiumIndex`, `getDocuments`, or `modifyDocument` for pack metadata. That work belongs to `CompendiumService.hydratePack`, which is called from declared-pack sync only.

When a declared pack is fresh in persistent cache, `hydratePack` returns without transport calls. This is the contract that makes restarts cheap.

### Pack Metadata Mutation Policy

- `WorldBootstrapper` replaces pack metadata from the accepted bootstrap snapshot.
- World change, world close, restart, and setup transition may clear/replace **in-memory** pack metadata as part of normal bootstrap lifecycle. Persistent shards survive; they are reused on reconnect when world identity matches and the manifest hash is current.
- Active-module change is handled by world bootstrap reload — the close/restart path tears down state and the next bootstrap follows the standard procedure. There is no in-place reconfiguration. Persistent rows belonging to a previously-active module's declarations remain on disk but are unreachable (no declaration scopes them); they may be evicted opportunistically but are not required to be.
- Module-declared pack hydration writes to the persistent rows side of the store; it must not mutate the pre-filed metadata.
- Runtime name/document resolution must not mutate the store at all.
- Route/module callers receive read-only snapshots, never a writable map.

### Module-Driven Hydration

`CompendiumService.hydratePack` is the only normal path that may fetch pack indices or documents. The scope is the active module's `info.json` pack config. If a module needs a compendium document at runtime, it declares `hydrate: true`. If it needs indexed rows (names, types, images), it declares `hydrate: false` with any required `fields`.

A `hydrate: false` declaration is not a failed hydrate. It is the intentional index-only shape for name/search use cases. Code must not treat "not hydrated" as permission to fetch live data — only stale or missing declared packs may be refreshed, and only per declaration.

Pre-filed metadata is not a fallback for undeclared packs or for missing module pack rows. If a module needs names or documents without a declaration, that is evidence its `info.json` is incomplete.

**Declared-but-absent packs.** If a pack in the module's `info.json` is not present in `game.data.packs` after bootstrap seed, `CompendiumService.hydratePack` logs an error against the module logger (`[module:<id>] pack <pack-id> not found`) and skips the pack. No transport call is made — the pack is not available in this world, so a live fetch would be wasted work. The module continues with whatever declared rows it does have; consumers of the missing pack see unresolved UUIDs per ADR-0020 policy.

### Browser Clients Are Not CoreSocket Control

The application has two relevant readiness states:

- `startup`: Foundry world is detected/connected, but Sheet Delver bootstrap is not complete.
- `active`: `WorldBootstrapper` finished snapshot acceptance, declared-pack sync, primary-document seeding, and adapter initialization.

The intended ownership model:

- `CoreSocket` is a server-owned service-account transport.
- `WorldBootstrapper` owns the application bootstrap and readiness transition.
- `EngagementService` owns coarse monitor policy for idle/setup/offline cases.
- Browser Socket.io clients receive status during `startup` and subscribe to world-backed events after readiness.
- Per-user `ClientSocket` instances are spawned/restored by server session policy, not by browser connection timing.

During `startup`, browser clients may connect to receive status. They are not yet world-backed clients, and must not cause side effects that restart the system transport or create per-user Foundry sockets.

**Terminology.** "Service-account monitor wakeup" and "reconnect on return-to-engagement" describe the same action from two sides. When the world is `offline` or `setup`, `CoreSocket` is disconnected and the platform polls Foundry on a heartbeat to detect when it becomes reachable — that is the monitoring loop. When the last-active browser returns, `EngagementService` can ask `CoreSocket` to attempt that reachability check immediately instead of waiting for the next heartbeat tick. From `EngagementService`'s perspective it is a *monitor wakeup*; from `CoreSocket`'s perspective the same call is a *reconnect attempt*. The wrong shape is firing that wakeup during `startup` or `active`, when `CoreSocket` is already connected/connecting and `WorldBootstrapper` owns the in-flight bootstrap.

Required policy:

- `EngagementService` may request reconnect on return-to-engagement only for `offline` / `setup` monitoring states.
- `EngagementService` must not request reconnect on return-to-engagement while lifecycle is `startup` or `active`.
- Heartbeat wakeups remain suspended during `startup`, matching the existing `shouldRunHeartbeat(...)` policy.
- `CoreSocket.connect()` does not replace an already-connected `startup` socket just because the world is not `active` yet.
- `AppSocketGateway` defers authenticated world-backed listener attachment until `SystemService.isReady()`.
- `SessionManager.getOrRestoreSession(...)` does not restore or create a per-user `ClientSocket` while bootstrap is incomplete; it defers or degrades to status-only until the world is ready.

HTTP world-backed routes retain their existing readiness gates. This ADR is about making browser socket connection and engagement behavior match those gates.

### Pack Reads Do Not Mirror Into World Stores

Foundry's [`CONST.COMPENDIUM_DOCUMENT_TYPES`](https://foundryvtt.com/api/variables/CONST.COMPENDIUM_DOCUMENT_TYPES.html) overlaps with primary document classes. The boundary is therefore not the document `type`. The boundary is **scope**:

- world collection scope, owned by Sheet Delver's primary Stores
- compendium pack scope, owned by `CompendiumStore`

`dispatchDocumentSocket(...)` currently mirrors `modifyDocument` results through the Store router as an initiator confirmation. That is correct for world collection mutations and world collection `get` refreshes. It is wrong for pack reads:

```ts
operation: {
  pack: 'dnd5e.items',
  index: true
}
```

A pack operation is a compendium operation, even when the returned class is `Actor` or `Item`. It must not apply into `ActorStore`, `ItemStore`, `JournalStore`, or any other world Store.

Implementation options:

- teach `dispatchDocumentSocket(...)` to skip proactive routing when `operation.pack` is present
- add a pack-scoped raw transport method used by `CompendiumService`
- remove `dispatchDocumentSocket(...)` from compendium service fallback paths

The exit condition is the same in all cases: compendium pack fetches cannot touch `modifyDocumentRouter`.

### Observability

Startup logs should make the new division obvious:

- one message for pack metadata seeding, including pack count and source count
- one message for declared-pack hydration, including declared pack count and how many were skipped because persistent cache was current
- live fetch logs only for stale/missing declared packs
- no broad "discovering indices for N packs in parallel" during normal startup
- no browser-engagement reconnect logs during `startup`

Socket trace logs should include enough context to distinguish pack-scoped reads from world-scoped reads when debug logging is enabled.

### Code Commentary

ADR-0021 touches policies that are easy to misread later because the runtime path crosses several layers. Implementation phases must leave short comments at each boundary:

- where `game.data.packs` is seeded, explain that the records are passive and do not trigger pack row/document fetches
- where `CompendiumService.hydratePack` short-circuits on a fresh persistent manifest, explain that the persistent cache is authoritative across restarts
- where `operation.pack` is detected, explain that compendium pack reads may return primary document classes but are pack-scoped and must not mirror into world Stores
- where engagement handles return-to-engagement, explain that browser clients may wake monitoring only from `offline` / `setup`, never during `startup`
- where AppSocket/session restore gates readiness, explain that startup clients are status-only until `SystemService.isReady()`

Comments describe ownership and direction of flow, not individual assignments.

---

## What Stays Out

- ADR-0021 does not hydrate all packs, build a global document registry, or add real world/pack dump fixtures.
- ADR-0021 does not re-enable live compendium UUID fallback by default. ADR-0020's cache-required resolver policy remains in force.
- ADR-0021 does not block public status. Browser clients during `startup` still receive status; the ADR blocks the side-effects (system reconnects, heartbeat wakeups, per-user Foundry socket restores, world-backed realtime listener attachment), not the status itself.
- ADR-0021 does not change Foundry transport primitives. `CompendiumService` retains the existing socket ladder (`modifyDocument` → `getDocuments` → `getCompendiumIndex`) for on-demand fetches; the change is *when* those primitives are called, not *how*.

---

## ADR-0021 Phase Staging

### Phase 1: Unify the store

**Status:** Completed May 23, 2026.

Phase 1 collapses the three storage classes into one read-only `CompendiumStore`.

**Action items:**

- [x] Define the unified `CompendiumStore` shape: pre-filed metadata records keyed by pack id, plus persistent manifest and pack rows.
  Files: `src/server/core/compendium/CompendiumStore.ts`, `src/server/core/compendium/types.ts`.

- [x] Move persistent manifest/rows storage (currently in `CompendiumPackStore`) into the unified `CompendiumStore`. Preserve the existing per-pack shard key shape (`pack-<packId>` under `(systemId, ...)`) and systemId namespace so the on-disk cache is reused by the unified store, not rebuilt.
  Files: `src/server/core/compendium/CompendiumStore.ts`, `src/server/core/compendium/CompendiumPackStore.ts` (delete).

- [x] Delete `CompendiumCache`. Its UUID→name responsibility is absorbed by declared pack rows; unresolved UUIDs stay unresolved.
  Files: `src/server/core/compendium/CompendiumCache.ts` (delete), `src/server/core/compendium/index.ts`.

- [x] Add `seedPackMetadataFromGameData(gameData)` and a read API that returns declared pack rows, declared documents, and pre-filed metadata in one shape.
  Files: `src/server/core/compendium/CompendiumStore.ts`, store tests.

- [x] Pin `CompendiumStore.clear(reason)` to in-memory state only: discard pre-filed metadata and cached row arrays held by the instance; do not delete persistent shards or the manifest. Add a comment at the method and a unit test that proves a `clear()` followed by reseed leaves on-disk shards untouched.
  Files: `src/server/core/compendium/CompendiumStore.ts`, store tests.

- [x] Add a comment at the metadata seed boundary explaining that records are passive and never trigger transport calls.
  Files: `src/server/core/compendium/CompendiumStore.ts`.

**Non-goals for Phase 1:**

- No behavior change in bootstrap yet.
- No consumer migration yet.

**Exit for Phase 1:** one `CompendiumStore` class exists with both tiers; `CompendiumCache` and `CompendiumPackStore` are removed; existing callers compile against the unified store (via transitional re-exports if needed).

### Phase 2: Unify the service and remove broad warmup

**Status:** Completed May 23, 2026.

Phase 2 merges `CompendiumPackSyncService` into `CompendiumService` and removes broad pack-index warmup from bootstrap.

**Action items:**

- [x] Merge `CompendiumPackSyncService.sync` into `CompendiumService` as `hydratePack(systemId, declaration)` / `hydratePacks(systemId, config)`. Preserve the existing freshness-hash + persistent-rows short-circuit. `WorldBootstrapper` continues to source declared config from `getModuleCompendiumPackConfig(moduleId)`; that registry accessor is unchanged.
  Files: `src/server/services/compendium/CompendiumService.ts`, `src/server/services/compendium/CompendiumPackSyncService.ts` (delete), `src/server/services/world/WorldBootstrapper.ts`, `src/server/services/compendium/index.ts`.

- [x] Replace `WorldBootstrapper`'s `discoverIndices` + `rebuildCompendiumCache` calls with `compendiumService.seedPackMetadataFromGameData(...)`. Bootstrap performs no pack-index transport calls.
  Files: `src/server/services/world/WorldBootstrapper.ts`.

- [x] Keep `CompendiumService.getPackIndex` / `getPackDocument` / `getPackDocuments` as on-demand primitives used by `hydratePack` and `DocumentResolver`. Remove `discoverIndices`.
  Files: `src/server/services/compendium/CompendiumService.ts`.

- [x] Add a comment in `hydratePack` documenting that persistent manifest is authoritative and that a fresh manifest skips all transport calls.
  Files: `src/server/services/compendium/CompendiumService.ts`.

- [x] Update startup logs: "seeded pack metadata from game data" + "hydrated N/M declared packs (K skipped, fresh)".
  Files: `src/server/services/world/WorldBootstrapper.ts`, `src/server/services/compendium/CompendiumService.ts`.

**Non-goals for Phase 2:**

- No consumer migration off `CompendiumCache` symbols (Phase 3).
- No transport boundary changes (Phase 4).

**Exit for Phase 2:** bootstrap issues zero pack-index/document socket calls; declared-pack hydration is the only path that may, and only for stale or missing packs.

### Phase 3: Migrate consumers off the legacy name map

**Status:** Completed May 23, 2026.

Phase 3 moves callers off the deleted `CompendiumCache` UUID→name surface.

**Action items:**

- [x] Migrate actor normalization and detail name projection. Names come from declared pack rows when available; otherwise preserve the unresolved UUID string.
  Files: `src/server/services/actors/ActorNormalizationService.ts`, `src/server/services/actors/ActorService.ts`, adapter tests.

- [x] Remove the legacy `CompendiumCache` fallback from `createScopedCompendiumPacks(...)`. The scoped reader returns declared rows or fails closed.
  Files: `src/server/shared/utils/createModuleContext.ts`, `src/tests/unit/compendium/module-context-compendium-packs.test.ts`.

- [x] Migrate `DocumentResolver` to read declared rows from `CompendiumStore`. Live fallback via `CompendiumService.getPackDocument` is permitted only where ADR-0020 policy allows it.
  Files: `src/server/services/documents/DocumentResolver.ts`, resolver tests.

- [x] Remove `CompendiumCache` symbols from `SystemService` clear/reset and `CoreSocket` disconnect; replace with `compendiumStore.clear(reason)`.
  Files: `src/server/core/system/SystemService.ts`, `src/server/core/foundry/sockets/CoreSocket.ts`.

- [x] Audit any remaining `CompendiumCache` import. Each is either migrated or removed; no compatibility shim survives this phase.
  Files: grep + update.

- [x] Update ADR-0015 wording that still describes Pathway A as broad startup index fetch.
  Files: `docs/adr/0015-compendium-architecture-and-pathway-b-read-gap.md`.

**Non-goals for Phase 3:**

- No new resolver primitives.
- No change to ADR-0020 policy.

**Exit for Phase 3:** no caller imports `CompendiumCache`; UUID→name resolution comes from declared rows or leaves the UUID unresolved.

### Phase 4: Pack transport scope guard

**Status:** Proposed

Phase 4 prevents pack-scoped reads from mirroring into world Stores.

**Action items:**

- [ ] In `dispatchDocumentSocket(...)`, branch on `operation.pack`. Pack-scoped reads return to the caller without proactive `modifyDocumentRouter` routing.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts`.

- [ ] Add a comment at the `operation.pack` guard noting that compendium pack reads may return primary document classes, but are pack-scoped and must not route through world Stores.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts`.

- [ ] If clearer, expose a pack-scoped raw transport method used by `CompendiumService` fallback paths; otherwise the in-place guard is sufficient.
  Files: `src/server/services/compendium/CompendiumService.ts`, transport types.

- [ ] Add tests proving pack reads do not call `modifyDocumentRouter` / world Store apply paths.
  Files: `src/tests/unit/compendium/*`, socket/core tests if appropriate.

- [ ] Audit local pack document-type constants against [`CONST.COMPENDIUM_DOCUMENT_TYPES`](https://foundryvtt.com/api/variables/CONST.COMPENDIUM_DOCUMENT_TYPES.html). Add a reconciliation comment near the constants.
  Files: `src/server/services/compendium/CompendiumService.ts`, `src/server/services/documents/DocumentResolver.ts`.

**Non-goals for Phase 4:**

- No removal of world-document `dispatchDocumentSocket(...)` routing for world-scoped operations.
- No change to world primary-document write semantics.

**Exit for Phase 4:** pack fetches cannot mirror into world Stores; world document operations still do.

### Phase 5: Engagement and startup readiness gates

**Status:** Proposed

Phase 5 prevents browser connections during `startup` from restarting transport or restoring per-user Foundry sockets before bootstrap is ready.

**Action items:**

- [ ] Change `EngagementService` reconnect-on-engagement policy so only `offline` / `setup` may request reconnect; `startup` and `active` must not.
  Files: `src/server/services/world/EngagementService.ts`, `src/tests/unit/services/engagement-service.test.ts`.

- [ ] Add a comment near the engagement reconnect policy noting that browser engagement is a monitoring wakeup signal, not a client control path for `CoreSocket`.
  Files: `src/server/services/world/EngagementService.ts`.

- [ ] Make `CoreSocket.connect()` a no-op when the socket is already connected and lifecycle is `startup`.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts`.

- [ ] Add a comment in `CoreSocket.connect()` explaining that an already-connected `startup` socket belongs to the in-flight bootstrap.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts`.

- [ ] Gate authenticated `AppSocketGateway` world-backed listener attachment on `SystemService.isReady()`.
  Files: `src/server/realtime/AppSocketGateway.ts`, realtime tests.

- [ ] Defer `SessionManager` per-user `ClientSocket` restore while lifecycle is `startup` or otherwise not ready.
  Files: `src/server/core/session/SessionManager.ts`, session restore tests.

- [ ] Add comments at the AppSocket readiness gate and session-restore deferral explaining that startup clients are status-only until the world is bootstrapped.
  Files: `src/server/realtime/AppSocketGateway.ts`, `src/server/core/session/SessionManager.ts`.

- [ ] Keep public status delivery during `startup`.
  Files: `src/server/realtime/AppSocketGateway.ts`, status tests if present.

**Non-goals for Phase 5:**

- No removal of status sockets.
- No change to ready-state HTTP route 503 behavior except where tests assert it.
- No client UX redesign beyond receiving status/not-ready state consistently.

**Exit for Phase 5:** browser connections during `startup` do not create extra `CoreSocket` connection flows, do not restore user Foundry sockets, and do not attach world-backed listener fan-out until bootstrap is ready.

### Phase 6: Verification, documentation, and startup audit

**Status:** Proposed

**Action items:**

- [ ] Update public docs and module authoring docs with the final compendium startup policy.
  Files: `README.md`, `docs/CONTRIBUTING.md`, `docs/MODULE_AUTHORING.md`, `src/modules/MODULE_MANIFEST.md` if needed.

- [ ] Update ADR-0017 if its bootstrap sequence still describes Pathway A as fetching broad indices during readiness.
  Files: `docs/adr/0017-world-bootstrap-and-lifecycle-orchestration.md`.

- [ ] Run unit/type checks.
  Commands: `npm run test:unit`; `npx tsc --noEmit`; `git diff --check`.

- [ ] Run targeted source audits.
  Commands: `rg -n "discoverIndices\\(|CompendiumCache|CompendiumPackStore|CompendiumPackSyncService|operation\\.pack|setActiveBrowserCount|shouldReconnectOnEngagement" src/server src/tests docs/adr`.

- [ ] Capture a fresh startup log manually. Verify normal startup has no broad pack index fetch, no engagement-induced `CoreSocket` reconnect during `startup`, no pack-read world Store routing, and that a warm restart shows declared packs as "skipped, fresh".

**Non-goals for Phase 6:**

- No committed real startup logs or Foundry data fixtures.
- No unrelated socket-boundary cleanup.

**Exit for Phase 6:** ADR-0021 can be marked accepted with startup logs and tests confirming the new boundaries.

---

## Alternatives Considered

### Keep broad Pathway A index warmup

Rejected. It makes startup dependent on every exposed pack in the Foundry world and produces noisy fallback traffic. ADR-0020 already made normal module/SDK reads depend on declared compendium pack rows, so broad live warmup no longer matches the architecture.

### Keep broad warmup but cache the results more aggressively

Rejected. Better caching reduces repeated work but still makes startup responsible for undeclared packs and still hides incomplete module pack declarations.

### Two stores + two services

Rejected. Three storage classes and two services for one read-only domain is more surface area than the primary-document pattern needs. The unified `Store + Service` shape (read-only, cache-backed) is the simpler match.

### Block all browser status sockets until ready

Rejected. Public status during `startup` is useful for login/loading UI. The problem is not the status socket; the problem is allowing that connection to trigger transport reconnects, per-user Foundry socket restore, or world-backed listener attachment before readiness.

---

## Consequences

- Bootstrap performs no pack-index or pack-document transport calls.
- A warm restart skips all hydration when the persistent manifest is current.
- Module authors get clearer feedback when they forgot to declare a pack: names stay unresolved instead of being silently filled by a global map.
- One store and one service replace five files; consumer code reads from a single surface.
- Startup logs become easier to read because metadata seeding, declared-pack hydration, and primary-document seeding are distinct steps.
- Browser page transitions or early client connects no longer restart the `CoreSocket` connection flow during bootstrap.

---

## Verification Checklist

- [ ] Normal startup seeds compendium pack metadata from `game.data.packs` without live pack index/document fetches.
- [ ] Only declared module packs are hydrated, and only when stale or missing on disk.
- [ ] A warm restart with current persistent manifest performs zero pack transport calls.
- [ ] `context.platform.compendiumPacks` reads declared rows from `CompendiumStore` only.
- [ ] Missing/non-hydrated compendium pack rows do not trigger a legacy UUID→name Foundry fetch; unresolved UUIDs stay unresolved.
- [ ] Compendium pack reads do not route through world Stores, even when the returned document class is a primary document type.
- [ ] `EngagementService` still wakes monitoring from `offline` / `setup` but not from `startup` / `active`.
- [ ] Browser clients during `startup` receive status but do not trigger `CoreSocket` reconnect, per-user `ClientSocket` restore, or world-backed listener attachment.
- [ ] No source file imports `CompendiumCache`, `CompendiumPackStore`, or `CompendiumPackSyncService`.
- [ ] Public docs and ADR-0015 / ADR-0017 references reflect the revised Pathway A behavior.
