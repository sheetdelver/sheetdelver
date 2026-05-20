# ADR-0016: Document Resolution and UUID Routing

**Status:** Accepted - Phases 1-5 completed May 20, 2026.
**Date:** May 19, 2026
**Phase:** Document Resolution (Phase 3 of the ADR-0014 arc)
**Supersedes:** None. Consumes ADR-0015's compendium shard lookup and parsed pack-document primitive.
**Related:** ADR-0011 (primary document model), ADR-0014 (non-document world state and socket boundary), ADR-0015 (compendium architecture), ADR-0017 (world bootstrap), ADR-0018 (socket-boundary completion).

---

## Part of the ADR-0014 arc

This ADR is the third decision in the ADR-0014 arc. ADR-0014 moved non-document world state out of sockets. ADR-0015 moved compendium discovery and pack reads into Store/service ownership. ADR-0016 removes UUID routing from sockets and composes the Stores/services that now exist.

| ADR | Scope | Depends on |
|---|---|---|
| ADR-0014 - Non-Document World State and the Socket Boundary Principle | `WorldStateStore`, `WorldLifecycleStore`, `SharedContentStore`, file-layout convention, and removal of world-state readers from sockets. | none |
| ADR-0015 - Compendium Architecture and the Pathway B Read Gap | `CompendiumStore`, `CompendiumService`, `DiscoveryShardStore` / shard reader. Fixes SDK discovery shard reads, de-duplicates Pathway A/B index work, and removes compendium readers from sockets. | ADR-0014 |
| **ADR-0016 (this ADR)** - Document Resolution and UUID Routing | `DocumentResolver`; removes `fetchByUuid` from `CoreSocket` and `ClientSocket`; parses world, embedded, and compendium UUIDs; delegates compendium lookup to ADR-0015 shard/fallback primitives. | ADR-0015 |
| ADR-0017 - World Bootstrap and Lifecycle Orchestration | `WorldBootstrapper`, delayed `active`, adapter ownership, engagement policy, sync-token cleanup. | ADR-0014 through ADR-0016 |
| ADR-0018 - Socket Boundary Enforcement Completion | Residual socket-boundary cleanup after the named extractions. | ADR-0014 through ADR-0017 |

**Reading order if you land here cold:** read ADR-0014 first, then ADR-0015. ADR-0015 explains why the compendium branch can now be shard-first without broad pack hydration.

---

## Context

At the start of ADR-0016, `CoreSocket.fetchByUuid(uuid)` was still a routing function living on a transport class.

It had two branches:

- **World UUIDs** such as `Actor.<id>` or `RollTable.<id>` parse the first two segments and sometimes read Stores directly. Actor, Item, RollTable, Macro, Playlist, and Cards short-circuit to Stores. Store-backed types such as JournalEntry, Folder, User, Combat, and ChatMessage still fall through to a generic socket `dispatchDocumentSocket(..., 'get', ...)` path.
- **Compendium UUIDs** such as `Compendium.<packId>.<type?>.<id>` are parsed inline, then fetched through a compatibility ladder (`modifyDocument` then `getDocuments`) over several inferred core document types.

At the start of ADR-0016, `ClientSocket.fetchByUuid(uuid)` was only a delegation to `systemService.getSystemClient().fetchByUuid(uuid)`.

Request and module surfaces still expose `fetchByUuid(uuid)`, but those surfaces should not depend on sockets owning UUID parsing. They should delegate to a resolver service that can read Stores, ask ADR-0015 compendium services for pack documents, and use sockets only as raw transport where a service explicitly needs bytes.

This is the same boundary pattern used by ADR-0011 and ADR-0015:

> Stores hold state. Services orchestrate. Transports just move bytes.

---

## Decision

Introduce `DocumentResolver` as the single service-layer UUID router.

Canonical path:

- `src/server/services/documents/DocumentResolver.ts`

Public surface:

- `fetchByUuid(uuid: string): Promise<unknown | null>`
- parser helpers exported only if tests or later services need them

`DocumentResolver` owns:

- world primary-document UUID parsing and Store reads
- embedded world-document UUID parsing and parent Store traversal
- compendium UUID parsing
- shard-first compendium lookup for declared hydrated Pathway B packs
- fallback to `CompendiumService.getPackDocument(packId, documentId, type?)`

Remove from sockets by the end of this ADR:

- `CoreSocket.fetchByUuid(uuid)`
- `ClientSocket.fetchByUuid(uuid)` delegation

Route-facing and module-facing facades may keep `fetchByUuid(uuid)` as a stable public contract, but the implementation must call `DocumentResolver`. The socket classes must not expose UUID reader methods.

### No Transitional Socket Stub

Do not leave a deprecated `CoreSocket.fetchByUuid(...)` wrapper that forwards to `DocumentResolver`.

Keeping a socket-side shim preserves two places developers might update when UUID behavior changes. ADR-0011 Phase 8 and ADR-0015 Phase 5 both used compiler-driven deletion instead: remove the socket method, update the real call sites, and let type/audit failures find stragglers.

### Authorization Scope

ADR-0016 preserves the current resolver privilege model. Today route/module `fetchByUuid` ultimately resolves through the system socket or unfiltered Store reads. This ADR moves ownership of the routing logic; it does not introduce new per-route visibility policy.

Route-specific read thresholds remain owned by route services and Store projection methods. A later security hardening pass may add a subject-aware resolver variant, but that is not required to remove UUID routing from sockets.

---

## Details

### World UUIDs

World UUIDs have the root shape:

- `<DocumentType>.<documentId>`

`DocumentResolver` should route full Store-backed types directly:

- `Actor` -> `actorStore`
- `Item` -> `itemStore`
- `ChatMessage` -> `chatMessageStore`
- `Folder` -> `folderStore`
- `User` -> `userStore`
- `JournalEntry` -> `journalStore`
- `Combat` -> `combatStore`
- `RollTable` -> `rollTableStore`
- `Macro` -> `macroStore`
- `Playlist` -> `playlistStore`
- `Cards` -> `cardsStore`

If a Store-backed type is not ready, throw `PrimaryDocumentCacheNotReadyError(type)` for the same fail-closed behavior the existing Actor/Item path uses.

Stub/unwired types stay explicit:

- `Scene`
- `FogExploration`
- `Adventure`
- `Setting`

These stub Stores exist for shape uniformity, but they are not bootstrapped or routed today. ADR-0016 should return `null` for these UUIDs with a short code comment explaining that a future wiring phase must define their visibility and seeding policy before they can resolve. Do not add a generic socket fallback for them.

For unknown world document types, return `null`. A generic "ask Foundry by type" fallback would recreate the socket-owned policy gap ADR-0016 is removing.

### Embedded World UUIDs

Embedded UUIDs are parent-scoped. The resolver must not treat the second segment as a world document id.

Initial embedded paths:

- `Actor.<actorId>.Item.<itemId>`
- `Actor.<actorId>.ActiveEffect.<effectId>`
- `Actor.<actorId>.Item.<itemId>.ActiveEffect.<effectId>`
- `JournalEntry.<entryId>.JournalEntryPage.<pageId>`
- `Combat.<combatId>.Combatant.<combatantId>`
- `Playlist.<playlistId>.PlaylistSound.<soundId>`
- `Cards.<cardsId>.Card.<cardId>`

`RollTableResult` is intentionally not listed as an embedded resolver path. Roll table result data is read as part of the direct `RollTable.<tableId>` document payload; ADR-0016 should not expose a separate result UUID reader.

The first implementation can traverse the parent Store snapshot directly with small resolver-local helpers. If those helpers become useful elsewhere, promote them to Store methods in a later small cleanup. Avoid adding broad abstractions before the embedded read needs are clear.

### Compendium UUIDs

Compendium UUIDs have the root shape:

- `Compendium.<packId>.<documentId>`
- `Compendium.<packId>.<DocumentType>.<documentId>`

`packId` may contain dots. The resolver should treat the segment before the final id as a document type only when it is a known core document root (`Item`, `Actor`, `JournalEntry`, `RollTable`, `Scene`, `Macro`, `Playlist`, `Cards`). Do not rely only on capitalization.

Resolution order:

1. Parse `packId`, optional `type`, and `documentId`.
2. Resolve the active system id from `WorldStateStore`.
3. Check `DiscoveryShardStore` manifest entry for that pack. Only a hydrated shard (`hydrate: true`) may satisfy `fetchByUuid`, because non-hydrated shards can contain projected index rows rather than full documents.
4. If hydrated and `DiscoveryShardStore.findDocument(systemId, packId, documentId, type?)` returns a row, return it without a transport call.
5. Otherwise call `CompendiumService.getPackDocument(packId, documentId, type?)`.

The resolver must not trigger hydration as a side effect. Full hydration remains a per-module declared decision through `DiscoveryConfig`, as established in ADR-0015.

Compendium embedded UUID traversal is out of scope for the first ADR-0016 implementation unless an existing caller requires it. If encountered, resolve the root pack document first and return `null` for the embedded tail until a specific shape and test are added.

### Facades

Keep the stable public method where callers already use it:

- `RouteFoundryClient.fetchByUuid(uuid)`
- `ModuleFoundryClient.fetchByUuid(uuid)`
- `UtilityClientLike.fetchByUuid(uuid)`

Change their implementation to call `DocumentResolver`, not a socket method.

Manual socket tests and diagnostics that instantiate `CoreSocket` directly must be migrated to create/use a resolver or a route client. Direct socket calls to `fetchByUuid` should not remain after Phase 5.

---

## What Stays Out

ADR-0016 does not move bootstrap orchestration; ADR-0017 owns `WorldBootstrapper`.

ADR-0016 does not remove `getSystemAdapter()` or adapter caching from sockets; ADR-0017 owns adapter lifecycle.

ADR-0016 does not extract URL helpers or session-state restore; ADR-0018 owns residual socket-boundary cleanup.

ADR-0016 does not add subject-aware `fetchByUuid` authorization. It preserves the existing resolver contract while moving it to the correct layer.

ADR-0016 does not hydrate undeclared compendium packs and does not use non-hydrated discovery rows as full documents.

ADR-0016 does not perform broad external module cleanup. Local ignored modules may be touched for verification hygiene only where they call socket `fetchByUuid` directly.

---

## ADR-0016 Phase Staging

This section follows ADR-0011 through ADR-0015: each phase has a named scope, status, action checklist with file touchpoints, non-goals, and a concrete exit statement.

### Phase 1: DocumentResolver shell and UUID parser

**Status:** Completed May 19, 2026.

Phase 1 introduces the service home and parser contract without moving callers yet.

**Action items:**

- [x] Add `DocumentResolver` with dependency injection for Stores, `WorldStateStore`, `DiscoveryShardStore`, and `CompendiumService` / a factory for it.
  Files: `src/server/services/documents/DocumentResolver.ts`, `src/server/services/documents/index.ts`.

- [x] Add parser helpers for invalid UUIDs, direct world UUIDs, embedded world UUIDs, and compendium UUIDs with dotted pack ids and optional known type segment.
  Files: `src/server/services/documents/DocumentResolver.ts`.

- [x] Add unit coverage for parser shapes, including dotted pack ids, optional compendium type segments, invalid UUIDs, and embedded world paths.
  Files: `src/tests/unit/documents/document-resolver.test.ts`, `src/tests/unit/run.ts`.

- [x] Verify Phase 1 with unit/type checks.
  Commands: `npm run test:unit`; `npx tsc --noEmit`; `git diff --check`.

**Non-goals for Phase 1:**

- No caller migration.
- No socket method deletion.
- No Store reads beyond parser-level tests.
- No compendium transport calls.

**Exit for Phase 1:** `DocumentResolver` exists with a tested UUID parser; no runtime behavior changes; unit/type checks pass.

**Phase 1 closure:** `DocumentResolver` now exists under `src/server/services/documents` with injectable Store, world-state, discovery-shard, and compendium-service dependencies. The exported parser covers invalid UUIDs, direct world UUIDs, embedded world UUID paths, and compendium UUIDs with dotted pack ids and optional known type segments. `fetchByUuid` intentionally returns `null` in this phase so no route, module, or socket runtime behavior moves before Phase 2.

### Phase 2: Store-backed world document resolution

**Status:** Completed May 19, 2026.

Phase 2 makes direct world UUIDs resolve from primary-document Stores and closes the current fall-through inconsistency for Store-backed types.

**Action items:**

- [x] Route direct world UUIDs for full Store-backed primary documents: Actor, Item, ChatMessage, Folder, User, JournalEntry, Combat, RollTable, Macro, Playlist, and Cards.
  Files: `src/server/services/documents/DocumentResolver.ts`.

- [x] Preserve fail-closed readiness behavior by throwing `PrimaryDocumentCacheNotReadyError(type)` when a required Store is not seeded.
  Files: `src/server/services/documents/DocumentResolver.ts`.

- [x] Add explicit stub/unwired policy for Scene, FogExploration, Adventure, and Setting: return `null` with a code comment explaining that seeding/visibility policy must land before these resolve.
  Files: `src/server/services/documents/DocumentResolver.ts`.

- [x] Add unit coverage for Store-backed hits, Store-not-ready failures, unknown type nulls, and stub type nulls using synthetic documents.
  Files: `src/tests/unit/documents/document-resolver.test.ts`.

- [x] Verify Phase 2 with unit/type checks and an audit that no new generic world-document transport fallback was introduced.
  Commands: `npm run test:unit`; `npx tsc --noEmit`; `rg -n "dispatchDocumentSocket\\([^\\n]*['\\\"]get['\\\"]" src/server/services/documents`.

**Non-goals for Phase 2:**

- No embedded UUID resolution yet.
- No compendium UUID resolution yet.
- No caller migration.
- No socket method deletion.

**Exit for Phase 2:** Direct world UUIDs resolve from Stores, Store-backed types no longer need socket dispatch, stub/unwired types fail closed, and unit/type checks pass.

**Phase 2 closure:** `DocumentResolver.fetchByUuid` now resolves direct world UUIDs for Actor, Item, ChatMessage, Folder, User, JournalEntry, Combat, RollTable, Macro, Playlist, and Cards from primary-document Stores. Store-backed types throw `PrimaryDocumentCacheNotReadyError(type)` when their Store is not seeded. Scene, FogExploration, Adventure, and Setting remain explicit fail-closed `null` results until their seeding and visibility policy is ready. Embedded world UUIDs and compendium UUIDs still return `null` pending Phases 3 and 4.

### Phase 3: Embedded world UUID resolution

**Status:** Completed May 19, 2026.

Phase 3 adds parent-aware embedded UUID traversal over Store snapshots.

**Action items:**

- [x] Resolve Actor-owned embedded paths for Actor items, Actor active effects, active effects under Actor-owned items, and world Item active effects.
  Files: `src/server/services/documents/DocumentResolver.ts`.

- [x] Resolve embedded document paths for JournalEntryPage, Combatant, PlaylistSound, and Card.
  Files: `src/server/services/documents/DocumentResolver.ts`.

- [x] Add unit coverage for each supported embedded path, missing parent, missing child, and malformed embedded path.
  Files: `src/tests/unit/documents/document-resolver.test.ts`.

- [x] Verify Phase 3 with unit/type checks.
  Commands: `npm run test:unit`; `npx tsc --noEmit`; `git diff --check`.

**Non-goals for Phase 3:**

- No embedded compendium traversal.
- No Store API promotion unless resolver-local helpers become too awkward.
- No caller migration.
- No socket method deletion.

**Exit for Phase 3:** Supported embedded world UUIDs resolve through parent Stores without socket transport; missing or malformed embedded UUIDs return `null`; unit/type checks pass.

**Phase 3 closure:** `DocumentResolver.fetchByUuid` now resolves embedded world UUIDs by reading the root parent from its primary-document Store and walking supported child arrays on that defensive snapshot. Supported paths are Actor Item, Actor ActiveEffect, Actor Item ActiveEffect, world Item ActiveEffect, JournalEntry JournalEntryPage, Combat Combatant, Playlist PlaylistSound, and Cards Card. Roll table result data stays part of the direct `RollTable.<tableId>` payload, not a separate embedded UUID route. Missing parents, missing children, unsupported child types, and malformed embedded paths return `null`; compendium UUIDs remain queued for Phase 4.

### Phase 4: Compendium UUID resolution

**Status:** Completed May 20, 2026.

Phase 4 composes ADR-0015's shard lookup and parsed pack-document fallback.

**Action items:**

- [x] Parse compendium UUIDs into `packId`, optional `type`, and `documentId` using known document roots rather than capitalization alone.
  Files: `src/server/services/documents/DocumentResolver.ts`.

- [x] Add shard-first lookup for declared hydrated Pathway B packs. Check the manifest entry and only let `hydrate: true` shards satisfy full document resolution.
  Files: `src/server/services/documents/DocumentResolver.ts`, `src/server/core/compendium/DiscoveryShardStore.ts` if a manifest helper is needed.

- [x] Add fallback to `CompendiumService.getPackDocument(packId, documentId, type?)` when no hydrated shard serves the document.
  Files: `src/server/services/documents/DocumentResolver.ts`.

- [x] Add unit coverage proving hydrated shard hits avoid transport, non-hydrated shard rows do not satisfy full resolution, missing shards fall back to `CompendiumService`, and disconnected fallback returns `null`.
  Files: `src/tests/unit/documents/document-resolver.test.ts`.

- [x] Verify Phase 4 with unit/type checks and a targeted audit for UUID parsing remaining inside sockets.
  Commands: `npm run test:unit`; `npx tsc --noEmit`; `rg -n "Compendium\\.|fetchByUuid Strategy|Agnostically parse" src/server/core/foundry/sockets`.

**Non-goals for Phase 4:**

- No hydration side effects.
- No across-all-packs full document cache.
- No `getCompendiumIndex` document fallback unless explicitly documented as a compatibility improvement with tests.
- No embedded compendium traversal unless an existing caller requires it.
- No socket method deletion yet.

**Exit for Phase 4:** Compendium UUIDs resolve through hydrated discovery shards first, then `CompendiumService.getPackDocument(...)`; non-hydrated shards are not treated as full documents; unit/type checks pass.

**Phase 4 closure:** `DocumentResolver.fetchByUuid` now resolves compendium UUIDs by checking the active system's `DiscoveryShardStore` manifest first. Only manifest entries with `hydrate: true` may satisfy full document resolution from `findDocument(...)`; indexed/non-hydrated shards are skipped even when a matching row exists. If no hydrated shard serves the document, the resolver calls `CompendiumService.getPackDocument(packId, documentId, type?)`. The resolver does not trigger hydration or full-pack reads as a side effect. The legacy compendium parser branch remained in sockets until Phase 5 removed socket-owned `fetchByUuid`.

### Phase 5: Caller migration and socket deletion

**Status:** Completed May 20, 2026.

Phase 5 closes ADR-0016's socket-boundary promise.

**Action items:**

- [x] Rewire `RouteFoundryClient.fetchByUuid(uuid)` to call `DocumentResolver.fetchByUuid(uuid)`.
  Files: `src/server/shared/utils/createRouteFoundryClient.ts`, `src/server/shared/types/requestContext.ts`, `src/server/services/utility/UtilityService.ts` if constructor wiring changes.

- [x] Keep `ModuleFoundryClient.fetchByUuid(uuid)` stable while letting it continue to delegate through the route client.
  Files: `src/server/shared/utils/createModuleFoundryClient.ts`, `src/shared/sdk/contracts.ts`.

- [x] Remove `CoreSocket.fetchByUuid(uuid)` and `ClientSocket.fetchByUuid(uuid)`.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts`, `src/server/core/foundry/sockets/ClientSocket.ts`.

- [x] Tighten socket-facing interfaces by removing `fetchByUuid` from `FoundryClient` / socket-only types while preserving route/module client contracts.
  Files: `src/server/core/foundry/interfaces.ts`, `src/server/shared/types/utility.ts`, `src/server/shared/types/requestContext.ts` if needed.

- [x] Migrate direct socket test/diagnostic callers to `DocumentResolver`, `CompendiumService`, or route clients.
  Files: `src/tests/socket/socket_diagnostic.ts`, `src/tests/socket/12-query-table-results.test.ts`, `src/tests/socket/list-tables.test.ts`, `src/tests/deprecated/module-specific/shadowdark/05-compendium-resolution.test.ts`, relevant local ignored module diagnostics if any.

- [x] Update comments and ADR references that describe `CoreSocket.fetchByUuid` as the UUID router.
  Files: `docs/adr/0011-primary-document-model.md`, `docs/adr/0014-non-document-world-state-and-socket-boundary.md`, `docs/adr/0015-compendium-architecture-and-pathway-b-read-gap.md`, code comments near migrated call sites.

- [x] Verify Phase 5 with unit/type checks and targeted socket-reader audits.
  Commands: `npm run test:unit`; `npx tsc --noEmit`; `git diff --check`; `rg -n "public async fetchByUuid|fetchByUuid\\(uuid" src/server/core/foundry`; `rg -n "systemService\\.getSystemClient\\(\\)\\.fetchByUuid|socket\\.fetchByUuid\\(|coreSocket\\.fetchByUuid\\(" src/server src/tests data/local/modules`.

**Non-goals for Phase 5:**

- No `getSystemAdapter()` socket deletion; ADR-0017 owns adapter lifecycle.
- No bootstrap orchestration move; ADR-0017 owns `WorldBootstrapper`.
- No URL utility/session restore cleanup; ADR-0018 owns the residual pass.
- No broad external module import cleanup.

**Exit for Phase 5:** `CoreSocket` and `ClientSocket` no longer expose `fetchByUuid`; route/module facades still expose stable `fetchByUuid` backed by `DocumentResolver`; direct socket callers are migrated; unit/type checks and audits pass.

**Phase 5 closure:** `RouteFoundryClient.fetchByUuid` now builds a `DocumentResolver` and delegates UUID routing to it. The resolver composes Store reads, `DiscoveryShardStore`, and `CompendiumService.getPackDocument(...)`; route/module call sites keep their public `fetchByUuid(uuid)` shape. Session route clients preserve the previous privilege model by using the service-account CoreSocket as the compendium fallback transport, matching the old `ClientSocket.fetchByUuid` delegation while keeping parsing/routing out of sockets. `CoreSocket.fetchByUuid`, `ClientSocket.fetchByUuid`, and the socket-facing `FoundryClient.fetchByUuid` type member are removed. Direct socket diagnostics/tests now use a route client or `DocumentResolver` directly.

---

## Alternatives Considered

### Keep `fetchByUuid` on `CoreSocket`

Rejected because `fetchByUuid` is not transport. It parses UUIDs, routes by document type, reads Stores, applies stub policy, and runs compendium compatibility fallback logic. The socket should provide the raw events used by services, not own the routing cascade.

### Leave a deprecated socket shim

Rejected because it preserves a second place for UUID behavior to drift. Deleting the method gives the compiler a clean migration boundary.

### Use transport fallback for every unknown world type

Rejected because it bypasses Store readiness and visibility policy. Stub/unwired types need explicit policy before they resolve.

### Hydrate compendium documents on demand

Rejected. ADR-0015 made hydration a module-declared decision. ADR-0016 may read declared hydrated shards or fetch one parsed document through `CompendiumService`, but it must not write new hydrated shards as a side effect of UUID resolution.

---

## Consequences

### Positive

- UUID routing gets a real service home.
- The socket surface shrinks again and loses another non-transport concern.
- Store-backed world document reads become consistent across all bootstrapped primary document types.
- Embedded UUID behavior becomes explicit and testable.
- Compendium UUIDs can finally prefer declared hydrated shards before using transport fallback.

### Tradeoffs

- The resolver needs careful parser tests because Foundry UUIDs allow dotted pack ids and embedded paths.
- Route/module `fetchByUuid` remains a privileged resolver surface for now; authorization hardening is a later concern.
- Stub/unwired types intentionally return `null`, which is safer but may expose callers that were relying on generic socket fallback.

---

## Related Decisions

- **ADR-0011** - established primary-document Stores and embedded mutation handling.
- **ADR-0014** - established the socket-boundary principle and world/compendium layout.
- **ADR-0015** - provides `DiscoveryShardStore.findDocument(...)` and `CompendiumService.getPackDocument(...)`, which ADR-0016 composes for compendium UUIDs.
- **ADR-0017** - removes adapter lifecycle and bootstrap orchestration from sockets after UUID routing is gone.
- **ADR-0018** - completes residual socket-boundary verification.

---

## Validation

Each phase validates both resolver behavior and socket-boundary shrinkage.

- Parser tests cover direct world, embedded world, compendium, invalid, and dotted-pack UUIDs.
- World resolver tests cover Store-backed hits, Store-not-ready failures, unknown type nulls, and stub policy.
- Embedded resolver tests cover each supported embedded path plus missing parent/child cases.
- Compendium resolver tests cover hydrated shard hit with no transport, non-hydrated shard skip, fallback transport, and disconnected fallback.
- Phase 5 migration audits confirm no `fetchByUuid` declarations remain on socket classes and no direct socket `fetchByUuid` calls remain.
- `git diff --check`, `npx tsc --noEmit`, and `npm run test:unit` pass for every phase before moving to the next.

---

## Exit Criteria

This ADR is fulfilled when UUID routing has service ownership and sockets no longer expose `fetchByUuid`.

- [x] Phase 1: `DocumentResolver` shell + UUID parser contract.
- [x] Phase 2: direct world UUIDs resolve from Stores; stub/unwired types fail closed.
- [x] Phase 3: embedded world UUIDs resolve through parent Stores.
- [x] Phase 4: compendium UUIDs resolve through hydrated shards first and `CompendiumService.getPackDocument(...)` fallback second.
- [x] Phase 5: `CoreSocket` / `ClientSocket` `fetchByUuid` methods are removed and socket-facing interfaces are tightened.
- [x] No real world or compendium fixture data is added to tracked tests.
- [x] `rg` migration audits confirm no remaining socket `fetchByUuid` declarations or direct socket calls.
- [x] `git diff --check`, `npx tsc --noEmit`, and `npm run test:unit` pass.
- [x] Status flips to **Accepted** after all phases ship green.

ADR-0017 owns the next step: world bootstrap and lifecycle orchestration.
