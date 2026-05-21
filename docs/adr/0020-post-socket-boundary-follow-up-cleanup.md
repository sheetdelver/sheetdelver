# ADR-0020: Post Socket-Boundary Follow-Up Cleanup

**Status:** Accepted - Completed May 21, 2026.
**Date:** May 21, 2026
**Phase:** Post Socket-Boundary Follow-Up
**Supersedes:** None. Follows ADR-0014 through ADR-0019.
**Related:** ADR-0011 (primary document model), ADR-0014 (non-document world state and socket boundary), ADR-0015 (compendium architecture), ADR-0016 (document resolution), ADR-0017 (world bootstrap), ADR-0018 (socket-boundary completion), ADR-0019 (Foundry version compatibility).

---

## Context

ADR-0014 through ADR-0019 closed the socket-boundary arc:

- non-document world state lives in Stores
- compendium discovery and shard reads live in compendium services/Stores
- UUID routing lives in `DocumentResolver`
- bootstrap orchestration lives in `WorldBootstrapper`
- engagement/session/URL/status leftovers no longer live on sockets
- Foundry generation compatibility is a bootstrap diagnostic/gate

The final audit sweep did not find another material socket-boundary extraction, but it did leave follow-up cleanup that is worth handling while the architecture is still fresh:

- legacy primary-document types used the `Raw*` prefix even though there was no non-raw counterpart
- `game.data` ownership is correct in code but still needs a clearer written map for future contributors
- primary-document stub Stores exist for shape uniformity and should remain unseeded until a real vertical needs them
- embedded UUID resolution already exists for supported world documents, but the traversal model needs clearer documentation
- compendium UUID fallback currently can reach Foundry when no hydrated discovery shard serves the lookup, which can hide bad module declarations or stale references
- some tracked ADR wording still reads like earlier transition questions are open even though ADR-0014 through ADR-0019 resolved them

ADR-0020 is therefore a cleanup and policy-tightening ADR, not another socket-boundary ADR.

---

## Decision

ADR-0020 makes six decisions.

1. Remove the legacy `Raw*` naming from primary-document types in two phases. Use canonical `*Document` names such as `ActorDocument`, `ItemDocument`, `JournalEntryDocument`, and `RollTableDocument`. Keep runtime behavior unchanged. Completed in Phases 1 and 2.

2. Document `game.data` as a Foundry bootstrap envelope, not a single application domain object. The ADR will distinguish fields retained by `WorldStateStore`, fields used as bootstrap inputs for other Stores/services, and fields that should never become canonical world-state.

3. Keep `Scene`, `FogExploration`, `Adventure`, and `Setting` as stub primary-document Stores. Do not seed or route them in this ADR. Their visibility and lifecycle policy should be designed only when Sheet Delver needs those verticals.

4. Document current embedded world UUID traversal. Direct world UUIDs resolve by Store id lookup. Embedded world UUIDs resolve by loading the parent Store snapshot and walking supported child arrays. This is local parent traversal, not a global UUID scan.

5. Tighten compendium UUID resolution to be cache/shard-first and cache-required by default. A compendium UUID that is not present in a declared hydrated discovery shard should return `null` and emit a developer-facing warning instead of silently fetching from Foundry. Live Foundry fallback may exist only behind an explicit opt-in configuration flag for diagnostics or transitional local workflows.

6. Correct stale tracked ADR wording after the policy and docs above are accepted.

---

## Details

### Primary Document Type Names

The existing `Raw*` prefix came from an earlier "wire shape vs. application shape" idea. In practice, there is no second non-raw type for these documents. `RawActor` is the Actor document shape used by Stores, services, routes, tests, and SDK-facing adapters.

The new convention is:

| Current | Target |
|---|---|
| `RawActor` | `ActorDocument` |
| `RawItem` | `ItemDocument` |
| `RawJournal` | `JournalEntryDocument` |
| `RawJournalPage` | `JournalEntryPageDocument` |
| `RawChatMessage` | `ChatMessageDocument` |
| `RawCombat` | `CombatDocument` |
| `RawCombatant` | `CombatantDocument` |
| `RawFolder` | `FolderDocument` |
| `RawUser` | `UserDocument` |
| `RawRollTable` | `RollTableDocument` |
| `RawRollTableResult` | `RollTableResultDocument` |
| `RawMacro` | `MacroDocument` |
| `RawPlaylist` | `PlaylistDocument` |
| `RawPlaylistSound` | `PlaylistSoundDocument` |
| `RawCards` | `CardsDocument` |
| `RawCard` | `CardDocument` |
| `RawScene` | `SceneDocument` |
| `RawFogExploration` | `FogExplorationDocument` |
| `RawAdventure` | `AdventureDocument` |
| `RawSetting` | `SettingDocument` |

Phase 1 kept temporary type aliases so the migration could be reviewed without one giant mechanical rename. Phase 2 removed the aliases and verified no `Raw*` primary-document types remain in active source.

### `game.data` Ownership Map

`game.data` is the large Foundry bootstrap envelope returned when a world is active. It is not one cohesive application object. It contains multiple classes of data that Sheet Delver now routes to different owners.

`WorldStateStore` retains the residual world environment snapshot:

- world manifest: id, title, description, system id, system version, compatibility, background, session/playtime metadata
- system manifest: id, title, version, document types, grid/default metadata, adapter-relevant manifest fields
- module manifests: loaded modules, versions, compatibility, pack declarations, scripts/esmodules
- Foundry release/update metadata: generation, build, channel, suffix, core/system update summaries
- server/runtime configuration: options, addresses, file storage
- runtime flags: paused, demo mode, idle logout
- schema model: Foundry document model metadata for the active system
- diagnostics: package warnings, template metadata where present
- connection/bootstrap identity: current user id and active user ids
- legacy setup/probe state: probe world data, probe user count, cached setup worlds
- scene/background projection compatibility data until scene-backed projections are deliberately redesigned

Other `game.data` content is only bootstrap input:

- `users` seeds `UserStore` / `UserPresence` during bootstrap readiness work
- primary document arrays belong to the primary-document Stores from ADR-0011, not to `WorldStateStore`
- pack metadata contributes to `CompendiumStore` and module discovery decisions
- system id/version feeds adapter selection and compatibility diagnostics

The following are not `game.data` world-state responsibilities:

- shared content events (`shareImage`, `showEntry`) belong to `SharedContentStore`
- app readiness belongs to `WorldBootstrapper` and `WorldLifecycleStore`
- adapter lifecycle belongs to `WorldBootstrapper` / `SystemService`
- session restore belongs to `SessionManager`
- URL projection belongs to `foundryUrl.ts` and route/module facades

The practical rule: `game.data` is an input envelope. A field should remain in `WorldStateStore` only when it is residual world environment state that does not already have a more specific Store/service owner.

### Stub Primary Documents

`Scene`, `FogExploration`, `Adventure`, and `Setting` currently have stub Store classes so the primary-document type universe is explicit. That does not mean they are ready to serve reads, writes, realtime events, or UUID resolution.

ADR-0020 keeps the current policy:

- do not register these Stores with `PrimaryDocumentCacheCoordinator`
- do not register them with `modifyDocumentRouter`
- do not resolve direct UUIDs for them
- do not add generic socket fallback for them
- do leave short comments explaining that seeding and visibility policy must land first

The future design work is vertical-specific:

- `Scene` needs canvas/scene visibility rules.
- `FogExploration` is per-user state and needs a subject-aware model.
- `Adventure` import/export semantics are not a normal document read path.
- `Setting` is key-value state and may need admin/system policy rather than ordinary document ownership.

### UUID Traversal

ADR-0016 already implemented supported embedded world UUID resolution. This ADR documents what that means so it is not mistaken for a global UUID index or an unfinished search engine.

Direct world UUIDs have the shape:

```text
Actor.<actorId>
RollTable.<tableId>
```

These resolve by dispatching to the correct primary-document Store and asking for the document id. Store internals are map-backed for the active cache, so this should be treated as effectively constant-time lookup from the resolver's point of view.

Embedded world UUIDs have the shape:

```text
Actor.<actorId>.Item.<itemId>
Actor.<actorId>.Item.<itemId>.ActiveEffect.<effectId>
JournalEntry.<entryId>.JournalEntryPage.<pageId>
Combat.<combatId>.Combatant.<combatantId>
Playlist.<playlistId>.PlaylistSound.<soundId>
Cards.<cardsId>.Card.<cardId>
```

These resolve by:

1. reading the root document from its Store
2. walking the configured embedded child collection on the defensive snapshot
3. repeating for nested embedded children when supported

The traversal cost is bounded by the parent document's child arrays. It is not a scan across all world documents. Today the resolver uses array `find(...)` on the relevant embedded collection, so the child step is O(n) for that one collection. If a future parent contains enough embedded children for this to matter, promote an id-indexed embedded helper into the Store; do not add a global UUID registry preemptively.

`RollTableResult` remains intentionally absent from embedded UUID resolution. Roll table result rows are part of the `RollTable.<tableId>` payload used by local draw simulation, not standalone UUID targets. Looking up a table by UUID should return the table; drawing/simulating the result remains a RollTable-domain operation.

Compendium embedded UUID traversal remains out of scope unless a real caller needs it. If that lands later, it should mirror the world pattern: resolve the root compendium document from a hydrated shard, then walk the embedded child arrays on that document. It should not fetch undeclared packs from Foundry as a side effect.

### Compendium UUID Policy

ADR-0016 currently resolves compendium UUIDs in this order:

1. parse pack id, optional type, and document id
2. check the active system's `DiscoveryShardStore` manifest
3. if the pack has `hydrate: true`, ask the shard for the document
4. if no hydrated shard serves the document, call `CompendiumService.getPackDocument(...)`

ADR-0020 changes the default policy for step 4.

Normal module/SDK compendium UUID resolution should be **declared hydrated shard only**:

- If the pack is not declared in the discovery manifest, return `null` and warn.
- If the pack is declared but not hydrated, return `null` and warn that `fetchByUuid` requires `hydrate: true`.
- If the pack is hydrated but the document id is missing, return `null` and warn.
- If no active system id or manifest exists, return `null` and warn at debug/warn level appropriate for bootstrap state.

This makes bad module references visible. A miss usually means one of:

- the module forgot to declare the pack
- the pack id was misspelled
- the document id changed
- the module references stale content after a system/module update
- the discovery config requested an index row but not hydrated documents

Live Foundry fallback may remain only as an explicit diagnostic escape hatch. The default must be disabled.

Suggested configuration shape:

```yaml
foundry:
  allow-live-compendium-uuid-fallback: false
```

Suggested env override:

```text
APP_ALLOW_LIVE_COMPENDIUM_UUID_FALLBACK=false
```

Implementation may choose a different final name if it better matches the config conventions, but the behavior is fixed: production/module SDK paths are cache-required by default.

When live fallback is enabled:

- log that the fallback path was used
- include pack id, document id, optional type, and active system id
- do not persist the fetched document as a hydrated shard
- do not mask the fact that the module discovery config should be corrected

### Future Pack-Document Caching

"Future pack-doc caching" means caching individual pack document fetches after a live fallback, keyed by active system id, pack id, optional type, and document id. It does not mean hydrating all packs.

ADR-0020 rejects adding that cache now.

Reasons:

- cache misses should pressure modules to declare the packs they need
- invalidation rules for live compendium documents are not yet defined
- a cache could hide misspelled/stale references until much later
- hydrated Pathway B shards are already the intended durable read model
- module-facing behavior should be deterministic from declared discovery config

If repeated live compendium document fetches become a real performance issue in diagnostic mode, pack-doc caching should get its own small ADR or phase with explicit invalidation and observability.

---

## What Stays Out

ADR-0020 does not reopen the socket-boundary extraction. Socket classes should not regain state readers, compendium readers, UUID routers, URL helpers, session policy, adapter ownership, or bootstrap orchestration.

ADR-0020 does not seed `Scene`, `FogExploration`, `Adventure`, or `Setting`.

ADR-0020 does not add subject-aware `fetchByUuid` authorization. It preserves ADR-0016's current privilege model while tightening compendium source policy.

ADR-0020 does not implement compendium embedded UUID traversal.

ADR-0020 does not add pack-document caching.

ADR-0020 does not commit real Foundry world dumps, compendium shards, or local data as fixtures. Tests should continue using tiny synthetic in-code shapes.

---

## ADR-0020 Phase Staging

This section follows ADR-0011 through ADR-0019: each phase has a named scope, status, action checklist with file touchpoints, non-goals, and a concrete exit statement.

### Phase 1: Canonical primary-document type names

**Status:** Completed May 21, 2026.

Phase 1 introduces canonical non-`Raw` primary-document type names and migrates the core implementation while keeping temporary aliases for review safety.

**Action items:**

- [x] Rename primary-document interfaces to `*Document` names or add canonical `*Document` aliases where a direct interface rename would be too noisy for the first pass.
  Files: `src/server/shared/types/actors.ts`, `src/server/shared/types/documents.ts`, `src/server/shared/types/users.ts`.

- [x] Migrate primary-document Stores, repositories, services, route types, and unit tests to the canonical names.
  Files: `src/server/core/documents/primary/**`, `src/server/services/**`, `src/server/routes/**`, `src/tests/unit/**`.

- [x] Keep temporary `Raw*` aliases only in the shared type files and mark them as deprecated migration shims.
  Files: `src/server/shared/types/actors.ts`, `src/server/shared/types/documents.ts`, `src/server/shared/types/users.ts`.

- [x] Verify no migrated implementation file imports `Raw*` directly except the shim definitions.
  Commands: `npm run test:unit`; `npx tsc --noEmit`; `git diff --check`; `rg -n "\\bRaw(Actor|Item|Journal|JournalPage|ChatMessage|Combat|Combatant|Folder|User|RollTable|RollTableResult|Macro|Playlist|PlaylistSound|Cards|Card|Scene|FogExploration|Adventure|Setting)\\b" src/server src/tests`.

**Non-goals for Phase 1:**

- No runtime behavior changes.
- No Store seeding changes.
- No deletion of compatibility aliases yet.

**Exit for Phase 1:** canonical `*Document` names exist and the core implementation uses them; remaining `Raw*` hits are isolated to explicit deprecated aliases and any consciously deferred call sites.

**Phase 1 closure:** Canonical `*Document` interfaces now live in `actors.ts`, `documents.ts`, and `users.ts`; active Stores, repositories, services, and unit tests were migrated to those names. Temporary `Raw*` aliases existed only as migration shims until Phase 2 removed them.

### Phase 2: Remove `Raw*` migration shims

**Status:** Completed May 21, 2026.

Phase 2 deletes the temporary aliases and completes the naming cleanup.

**Action items:**

- [x] Migrate any remaining server, shared, SDK, script, and test references from `Raw*` to `*Document`.
  Files: `src/server/**`, `src/shared/**`, `src/scripts/**`, `src/tests/**`, local diagnostic tests if tracked.

- [x] Remove deprecated `Raw*` aliases from shared type files.
  Files: `src/server/shared/types/actors.ts`, `src/server/shared/types/documents.ts`, `src/server/shared/types/users.ts`.

- [x] Update ADR-0011 / ADR-0014 references that describe the `Raw*` prefix as a pending cleanup.
  Files: `docs/adr/0011-primary-document-model.md`, `docs/adr/0014-non-document-world-state-and-socket-boundary.md`.

- [x] Verify the prefix is gone from primary-document source and tests.
  Commands: `npm run test:unit`; `npx tsc --noEmit`; `git diff --check`; `rg -n "\\bRaw(Actor|Item|Journal|JournalPage|ChatMessage|Combat|Combatant|Folder|User|RollTable|RollTableResult|Macro|Playlist|PlaylistSound|Cards|Card|Scene|FogExploration|Adventure|Setting)\\b" src/server src/shared src/scripts src/tests`.

**Non-goals for Phase 2:**

- No DTO shape changes.
- No route contract changes.
- No document visibility policy changes.

**Exit for Phase 2:** primary-document wire shapes use canonical names without `Raw*` aliases; docs no longer describe the cleanup as pending.

**Phase 2 closure:** Deprecated aliases were removed. Active source/tests no longer reference the legacy primary-document names; unrelated local names such as scraper internals or terminal `setRawMode` are outside this primary-document cleanup.

### Phase 3: `game.data` ownership documentation

**Status:** Completed May 21, 2026.

Phase 3 documents the bootstrap envelope clearly enough that future contributors know which service/Store owns each class of data.

**Action items:**

- [x] Add a concise ownership comment or doc block near `WorldStateStore` / world types explaining that `game.data` is an input envelope and `WorldStateStore` owns only residual world environment state.
  Files: `src/server/core/world/WorldStateStore.ts`, `src/server/core/world/types.ts`.

- [x] Update ADR-0014 with the final `game.data` ownership map and synthetic-fixture policy.
  Files: `docs/adr/0014-non-document-world-state-and-socket-boundary.md`.

- [x] Add or update documentation in this ADR's implementation notes as the source-of-truth summary.
  Files: this ADR.

- [x] Verify no tracked tests or docs instruct developers to commit local world dump fixtures.
  Commands: `rg -n "real world dump|world dump fixture|PersistentCache shard|local Foundry" docs src/tests`.

**Non-goals for Phase 3:**

- No Store field migration.
- No primary-document seed-from-`game.data` optimization.
- No scene projection redesign.

**Exit for Phase 3:** docs explain which `game.data` fields stay in `WorldStateStore`, which are bootstrap inputs, and which belong elsewhere.

**Phase 3 closure:** `WorldStateStore` and `GameData` comments now call `game.data` a bootstrap envelope and name the Store/service owners for residual world state, primary documents, users/presence, packs, and adapter/compatibility inputs. ADR-0014 has the same ownership map and no longer points at local audit dump paths.

### Phase 4: Resolver traversal docs and compendium cache-required policy

**Status:** Completed May 21, 2026.

Phase 4 tightens resolver policy where ADR-0016 intentionally preserved a live fallback bridge.

**Action items:**

- [x] Document the supported embedded world UUID traversal model in `DocumentResolver` comments and ADR-0016.
  Files: `src/server/services/documents/DocumentResolver.ts`, `docs/adr/0016-document-resolution-and-uuid-routing.md`.

- [x] Keep `RollTableResult` excluded and explain that table result rows are part of the `RollTable.<id>` payload used by draw simulation.
  Files: `src/server/services/documents/DocumentResolver.ts`, `src/server/shared/utils/createModuleFoundryClient.ts`, ADR docs if needed.

- [x] Add a resolver option/config path for live compendium UUID fallback, defaulting to disabled.
  Files: `src/server/services/documents/DocumentResolver.ts`, `src/server/shared/utils/createRouteFoundryClient.ts`, `src/server/core/config.ts`, `src/shared/interfaces/index.ts`.

- [x] Change default compendium UUID misses to return `null` with a warning instead of calling `CompendiumService.getPackDocument(...)`.
  Files: `src/server/services/documents/DocumentResolver.ts`.

- [x] Preserve opt-in live fallback for diagnostics/transitional workflows only, with tests proving it is disabled by default.
  Files: `src/tests/unit/documents/document-resolver.test.ts`, config tests if present.

- [x] Verify no socket-owned UUID fallback reappears.
  Commands: `npm run test:unit`; `npx tsc --noEmit`; `git diff --check`; `rg -n "fetchByUuid|getPackDocument|Compendium\\." src/server/core/foundry/sockets src/server/services/documents`.

**Non-goals for Phase 4:**

- No compendium embedded traversal.
- No pack-doc cache.
- No across-all-packs hydration.
- No subject-aware resolver authorization.

**Exit for Phase 4:** module/SDK compendium UUID resolution is declared hydrated shard-only by default; live Foundry fallback is explicit opt-in diagnostic behavior.

**Phase 4 closure:** `DocumentResolver` now returns `null` with a warning for undeclared, non-hydrated, missing, or not-ready compendium shard lookups. Live Foundry fallback is disabled unless `foundry.allow-live-compendium-uuid-fallback` / `foundry.allowLiveCompendiumUuidFallback` or `APP_ALLOW_LIVE_COMPENDIUM_UUID_FALLBACK` enables it. Route clients pass that policy into the resolver; tests prove default misses do not call transport and opt-in fallback still works.

### Phase 5: Tracked ADR wording cleanup

**Status:** Completed May 21, 2026.

Phase 5 fixes stale tracked documentation wording that survived the socket-boundary arc.

**Action items:**

- [x] Correct tracked ADR wording for resolved decisions: `WorldLifecycleStore` stayed separate, `EngagementService` stayed separate from `WorldBootstrapper`, and `DocumentResolver` lives in `services/documents`.
  Files: `docs/adr/0014-non-document-world-state-and-socket-boundary.md`, `docs/adr/0016-document-resolution-and-uuid-routing.md`, `docs/adr/0017-world-bootstrap-and-lifecycle-orchestration.md`.

- [x] Review transitional notes about `SocketBase.resolveUrl(...)` / `resolveHtml(...)` wrappers and leave only historical phase notes that also record wrapper deletion.
  Files: `docs/adr/0018-socket-boundary-enforcement-completion.md` only if needed.

- [x] Rewrite Pathway B caveat language so it says the shard read model is complete and the remaining compendium policy is cache-required UUID resolution from ADR-0020.
  Files: `docs/adr/0015-compendium-architecture-and-pathway-b-read-gap.md`, `docs/adr/0016-document-resolution-and-uuid-routing.md`.

- [x] Update this ADR with phase closure notes and flip status to Accepted after implementation is complete.
  Files: this ADR.

- [x] Run final documentation/source audits.
  Commands: `npm run test:unit`; `npx tsc --noEmit`; `git diff --check`; targeted stale-wording audit over `docs/adr/001*.md`; targeted primary-document legacy-name audit over `src/server src/shared src/scripts src/tests`.

**Non-goals for Phase 5:**

- No new implementation beyond doc cleanup.
- No historical rewrite that hides why earlier ADRs made transitional choices.

**Exit for Phase 5:** tracked ADR wording reflects the completed ADR-0014 through ADR-0020 decisions without stale open-question breadcrumbs.

**Phase 5 closure:** Tracked ADRs no longer reference untracked audit-report paths, ADR-0011/0014 use the canonical document type names, and ADR-0015/0016 document the cache-required compendium UUID policy from this ADR.

---

## Alternatives Considered

### Leave `Raw*` names alone

Rejected. The prefix now communicates a distinction the codebase does not have. Removing it reduces import noise and aligns primary-document types with the unprefixed world-state types introduced by ADR-0014.

### Seed stub primary documents now

Rejected. Stubs exist for type-universe completeness, not because the application understands the visibility/lifecycle semantics of those document types. Seeding them now would create a false sense of support.

### Keep live compendium fallback as the default

Rejected. It hides missing or stale module discovery declarations. Module authors should learn that a pack id/document id is wrong at development time instead of accidentally relying on a live Foundry lookup.

### Add a pack-document cache for fallback results

Rejected for this ADR. A fallback cache would make the hidden-declaration problem worse unless invalidation, diagnostics, and cache authority are designed first.

### Build a global UUID index

Rejected. Direct Store lookup plus parent-local embedded traversal is enough for current callers. A global UUID index adds lifecycle and invalidation complexity without a proven need.

---

## Consequences

### Positive

- Primary-document type names become clearer.
- `game.data` ownership is easier to understand for future contributors.
- Stub document types remain honestly unsupported instead of half-wired.
- Module authors get clearer feedback when compendium references are stale or undeclared.
- Compendium UUID reads become deterministic from declared discovery config.
- The audit stops pointing at decisions that are already resolved.

### Tradeoffs

- The `Raw*` rename will touch many files even though behavior does not change.
- Disabling live compendium fallback by default may expose missing module declarations that previously appeared to work.
- The opt-in fallback flag adds one more configuration surface.
- Hydrated shard lookup is currently array-backed within a pack shard; if very large hydrated shards become common, a later id-index may be useful.

---

## Related Decisions

- **ADR-0011** - primary-document Store model and stub Store policy.
- **ADR-0014** - typed world-state shapes and the original `Raw*` naming note.
- **ADR-0015** - Pathway A/B compendium architecture and discovery shards.
- **ADR-0016** - `DocumentResolver`, embedded world UUIDs, and compendium UUID parsing.
- **ADR-0018** - final socket-surface cleanup.
