# ADR-0022: Core Cleanup and Boundary Completion

**Status:** Accepted - Completed May 26, 2026.
**Date:** May 26, 2026
**Phase:** Core Hygiene Pass
**Supersedes:** None
**Revises:** ADR-0017 (world bootstrap / lifecycle ownership — completes the core/services layering it began)
**Related:** ADR-0011 (primary document model), ADR-0014 (non-document world state + socket boundary), ADR-0017 (world bootstrap and lifecycle), ADR-0020 (post-socket-boundary cleanup), ADR-0021 (startup compendium cataloging and engagement gates).

---

## Context

A ground-up audit of the application (dated May 25, 2026) surveyed the codebase as it stands today, independent of ADR claims. The structure is sound at the macro level — no `@server` ↔ `@client` boundary violations, one entry point, single-instance singletons, uniform logger usage, and 21 ADRs accurately reflecting recent work. The issues that surfaced are a mix of housekeeping cruft and one architectural boundary that ADR-0017 began but did not finish.

**Boundary completion (the real architectural item).** Two imports cross the layering that the ADR arc was supposed to settle:

- [src/server/core/system/SystemService.ts:6](src/server/core/system/SystemService.ts) — `import { worldBootstrapper } from '@server/services/world';`
- [src/server/core/foundry/sockets/CoreSocket.ts:16](src/server/core/foundry/sockets/CoreSocket.ts) — `import { engagementService, type WorldBootstrapSnapshot } from '@server/services/world';`

Both are `core/` reaching up into `services/`. ADR-0014 / ADR-0017 explicitly said sockets move bytes and services orchestrate; the present state contradicts that. The root cause isn't that `WorldBootstrapper` / `EngagementService` are misplaced — they're correctly in `services/`. The root cause is:

1. `SystemService` lives under `core/system/` but behaves as a services-layer facade — it emits `world:ready` / `world:connected` / `world:disconnected`, exposes `bootstrap()` / `isReady()` / `getSystemClient()`, and delegates straight to `WorldBootstrapper`. It is orchestration in a state-holder's location.
2. `CoreSocket` self-registers with `EngagementService` from its constructor (`engagementService.setTransportCallbacks({ ... })`). The runtime *direction* is right — engagement calls back into the socket — but the *import* is upside-down.

The fix is structural and bounded: move `SystemService` into `services/world/`, lift the engagement wiring out of CoreSocket's constructor into the composition root. After that, core never imports services.

**Housekeeping cruft.** Three orphan directories from a route-group refactor (`src/app/actors/[id]/`, `src/app/tools/[systemId]/[toolId]/`, `src/server/api/`) are empty leftovers — confirmed via `ls -la` and git log. Five `@deprecated` shims survive past their migration windows (coordinator `seedDocumentCache` / `clearDocumentCache` wrappers, two `ActorRepository` / `ActorStore` Round-01 aliases, the `SetupManager` "scraping disabled/muted" stub). Two ADR-0021 Phase 5 behaviors landed without direct test coverage (`AppSocketGateway` deferred-attach, `SessionManager.getOrRestoreSession` startup-undefined branch).

**Scrape thread.** A disabled in-app world-scraping path lives in `SetupManager` with two related TODOs. There is no current use case but enough plausibility that deletion would lose institutional knowledge. The right home is a `scripts/tools/admin/` CLI: removed from the production path, preserved as a one-shot operator tool.

**Large-file splits (no behavior change).** Two files dominate the tree by line count:

- [src/modules/registry/core/server.ts](src/modules/registry/core/server.ts) — **2038 lines, 25 exports**, spanning module registry init, source switching, managed-module install / upgrade / uninstall / validate (plus dry-run variants), adapter resolution, lifecycle preflight, and compendium pack config lookup. Each export reads cleanly; the file just collects too many concerns.
- [src/server/routes/admin/createAdminRouter.ts](src/server/routes/admin/createAdminRouter.ts) — **1082 lines, 32 endpoints** for auth, setup, status, worlds, cache, audit, and managed modules. The codebase's other route domains use the `registerXxxRoutes.ts` pattern under `protected/`; admin is the lone exception.

Neither is buggy; both are navigation problems. Splitting them is pure reorganization behind the existing public re-exports.

This ADR consolidates the cleanup into four sequenced phases. Phase 1 is housekeeping. Phase 2 is the architectural completion. Phases 3 and 4 are large-file splits with no behavior change.

---

## Decision

ADR-0022 makes four decisions.

1. **Housekeeping cleanup (Phase 1).** Delete the three orphan directories. Delete the five `@deprecated` shims after confirming no callers remain. Add direct tests for the two ADR-0021 Phase 5 behaviors that landed without coverage. Extract the disabled scrape path from `SetupManager` into a `src/scripts/tools/admin/scrape-world.ts` operator script; remove the matching admin route stub and the two scrape-related TODOs.

2. **Boundary completion (Phase 2).** Relocate `SystemService` from `src/server/core/system/` to `src/server/services/world/`. Lift `engagementService.setTransportCallbacks(...)` out of `CoreSocket`'s constructor and wire it from the composition root (`src/server/index.ts` or a thin init in `services/world`). After this phase, `rg "@server/services" src/server/core` returns no results.

3. **Split `registry/core/server.ts` (Phase 3).** Behind the existing `@modules/registry/server` re-export, decompose the 2038-line file into focused modules: a slim core (`server.ts`), module-source operations, managed-module operations, adapter resolution, lifecycle preflight, and compendium pack config lookup. No public API change.

4. **Split `createAdminRouter.ts` (Phase 4).** Behind the existing `createAdminRouter(deps)` factory, decompose the 1082-line router into `registerAdmin*Routes.ts` files matching the `protected/` pattern: auth, setup, worlds, status / audit, modules. The composer becomes a ~100-line `createAdminRouter.ts` that mounts the registers in order.

---

## Details

### Phase 1: Housekeeping

**Orphan directories.** All three are empty (verified by `ls -la`, including hidden files):

- `src/app/actors/[id]/` — leftover from `99e3f94 "Begin separating player and admin routes"`. The live route is `src/app/(player)/actors/[id]/page.tsx`.
- `src/app/tools/[systemId]/[toolId]/` — same migration; live route at `src/app/(player)/tools/[systemId]/[toolId]/page.tsx`.
- `src/server/api/` — predates `routes/`; never repopulated.

Module tool routing is unaffected: `/tools/<systemId>/<toolId>` is served by the `(player)` group's [ToolPageRouter](src/client/ui/pages/ToolPageRouter.tsx), which reads `manifest.tools?.[toolId]` from the UI module registry. Tools are registered via module manifests, not via Next.js route files; the empty directories never participated in routing.

**Deprecated shims.** Five `@deprecated` markers, all post-migration leftovers:

| File | What | Action |
|---|---|---|
| [PrimaryDocumentCacheCoordinator.ts:326,334](src/server/core/documents/primary/PrimaryDocumentCacheCoordinator.ts) | `seedDocumentCache(client)` / `clearDocumentCache(reason)` wrappers | Migrate remaining callers to `primaryDocumentCacheCoordinator.seedAll(client)` / `.clearAll(reason)`, then delete wrappers |
| [ActorRepository.ts:7](src/server/core/documents/primary/actors/ActorRepository.ts) | Round-01 alias | Migrate callers, delete |
| [ActorStore.ts:25](src/server/core/documents/primary/actors/ActorStore.ts) | Round-01 `ChangeAction` alias | Migrate callers, delete |
| [SetupManager.ts:48](src/server/core/world/SetupManager.ts) | Disabled scrape method | Move to script, delete (covered by scrape thread below) |

**Phase 5 test coverage.** ADR-0021 Phase 5 landed two behaviors with no direct test:

- `AppSocketGateway` deferred attach: a browser socket connecting during `startup` must defer world-backed listener attachment until `world:ready` fires. The existing [app-socket-gateway.test.ts](src/tests/unit/sockets/app-socket-gateway.test.ts) predates this work.
- `SessionManager.getOrRestoreSession`: must return `undefined` (not construct a new `ClientSocket`) when called during `startup` with no existing in-memory session. [session-manager-restore.test.ts](src/tests/unit/session/session-manager-restore.test.ts) covers the cache-driven path but not the startup defer.

Both behaviors are load-bearing for ADR-0021's engagement-gate guarantees and need direct tests before drift accumulates.

**Scrape extraction.** The scrape thread lives across three places:

- [SetupManager.ts:48](src/server/core/world/SetupManager.ts) — deprecated method ("Scraping is currently disabled/muted in favor of local import")
- [SetupManager.ts:216](src/server/core/world/SetupManager.ts) — TODO ("Implement authenticated setup page scraping if needed")
- [AdminService.ts:49](src/server/services/admin/AdminService.ts) — TODO ("scraper should be done on the backend, however we will leave the single world scrape to be fixed later") plus the route binding

The right shape: a standalone `src/scripts/tools/admin/scrape-world.ts` CLI that operators can invoke when the use case materializes, paired with an `admin:scrape` entry in `package.json` alongside the existing `admin:import`. The deprecated method, both TODOs, and any admin route that exposes scrape get removed from the production path.

### Phase 2: Boundary Completion

**`SystemService` relocation.** Move `src/server/core/system/SystemService.ts` to `src/server/services/world/SystemService.ts`. The name stays the same; only the path changes. Imports across the codebase update from `@core/system/SystemService` / `@server/core/system` to `@server/services/world` (or a focused re-export).

`SystemService` already pairs naturally with `WorldBootstrapper` and `EngagementService` — same domain (world lifecycle), same import neighborhood after the move. The `core/system/` directory either disappears or, if empty after the move, is removed entirely.

Callers (audit-confirmed list):

- [src/server/index.ts](src/server/index.ts) — bootstrap orchestrator
- [src/server/realtime/AppSocketGateway.ts](src/server/realtime/AppSocketGateway.ts) — readiness checks
- [src/server/core/foundry/sockets/CoreSocket.ts](src/server/core/foundry/sockets/CoreSocket.ts) — referenced via `systemService.getSystemClient()` callers; will be revisited as part of the engagement decoupling below
- [src/server/core/session/SessionManager.ts](src/server/core/session/SessionManager.ts) — `systemService.isReady()` calls
- Various route registers and the admin router

After the move, none of these should change their behavior — only their import path.

**`CoreSocket` engagement decoupling.** Today, `CoreSocket`'s constructor self-registers transport callbacks:

```ts
constructor(config: any) {
    super(config);
    engagementService.setTransportCallbacks({
        resetRetryBackoff: () => { this.retryCount = 0; },
        startHeartbeat: (immediate = false) => { this.startHeartbeat(immediate); },
        getReconnectInputs: () => ({ ... }),
        reconnect: () => this.connect(),
    });
    this.loadInitialCache();
}
```

The runtime direction is correct — `EngagementService` calls into `CoreSocket` — but the import direction is inverted. The fix:

1. `CoreSocket` exposes a `getTransportCallbacks(): EngagementTransportCallbacks` method that returns the same shape as today's inline object. No `engagementService` import.
2. The composition root (or a one-line init in `services/world/SystemService` or `services/world/index.ts`) wires the two together at startup: `engagementService.setTransportCallbacks(coreSocket.getTransportCallbacks())`.
3. The `WorldBootstrapSnapshot` type import stays — types crossing the boundary the "wrong" direction is fine; behavior doesn't.

After Phase 2, `rg "@server/services|services/world|services/system" src/server/core` returns nothing. The layering is finally honored end-to-end.

### Phase 3: Split `registry/core/server.ts`

Today's file mixes six concerns. Proposed decomposition behind the existing `@modules/registry/server` re-export:

```
src/modules/registry/core/
├── server.ts              # initializeRegistry, listModules, getRegisteredModules,
│                          # refreshRegistry, FALLBACK_ADAPTER, __resetRegistryForTests
├── moduleSources.ts       # switchModuleSource, enableModule, disableModule,
│                          # getModuleActiveSources
├── managedModules.ts      # dryRunInstallManagedModule, installManagedModule,
│                          # dryRunUpgradeManagedModule, upgradeManagedModule,
│                          # uninstallManagedModule, validateManagedModule
├── adapterResolution.ts   # getAdapter, getMatchingAdapter, getServerModule,
│                          # unloadSystemModules
├── lifecyclePreflight.ts  # checkCanEnableModule, checkCanDisableModule
└── compendiumConfig.ts    # getModuleCompendiumPackConfig
```

The existing `index.ts` (or `server.ts` as the barrel) re-exports the same symbols, so no consumer changes. Internal cross-references between the new files are explicit imports. Approximate line counts: server.ts ~300, managedModules.ts ~700, adapterResolution.ts ~200, moduleSources.ts ~200, lifecyclePreflight.ts ~150, compendiumConfig.ts ~50.

No behavior change. No public API change. The exit criterion is: `npm run test:unit` and `npx tsc --noEmit` clean, plus `rg "from '@modules/registry/server'"` shows the same import shape as before.

### Phase 4: Split `createAdminRouter.ts`

The codebase's other route domains follow a `registerXxxRoutes.ts` pattern under `src/server/routes/protected/`. Admin is the only exception. Proposed split:

```
src/server/routes/admin/
├── createAdminRouter.ts          # composer: mounts the registers in order (~100 LoC)
├── registerAdminAuthRoutes.ts    # /auth/setup, /auth/login, /auth/reset, /auth/status
├── registerAdminSetupRoutes.ts   # /setup/scrape (may be deleted entirely once scrape moves to script — see Phase 1)
├── registerAdminWorldRoutes.ts   # /world/launch, /world/shutdown, /worlds, /cache
├── registerAdminStatusRoutes.ts  # /status, /audit
└── registerAdminModuleRoutes.ts  # managed module endpoints (install/upgrade/uninstall/validate/list)
```

Each register file receives the same `AdminRouterDeps` shape as today, plus the `adminService` and middleware bindings as needed. Tests for individual handlers can target the smaller files directly.

If Phase 1's scrape extraction removes the admin scrape route entirely, the `registerAdminSetupRoutes.ts` file may be unnecessary — to be decided during Phase 4 implementation. The split itself does not depend on that outcome.

### Composition Root After Phases 2 + 4

After the moves, [src/server/index.ts](src/server/index.ts) becomes the place where:

- `SystemService` is constructed (or imported as a singleton, depending on the final shape) from `services/world`
- `CoreSocket`'s transport callbacks are wired into `EngagementService` (the one-liner that used to live in `CoreSocket`'s constructor)
- The admin router and protected routers are registered with their respective `register*Routes` helpers

The entry point grows by a few lines but stays under ~120 LoC. The readability gain elsewhere is large.

---

## What Stays Out

- ADR-0022 does not touch the SDK. Module-side reach into platform internals (`@core/config`, `@core/cache`, `@core/foundry`) remains as-is and is the explicit scope of the parked SDK alignment work.
- ADR-0022 does not redesign `WorldBootstrapper`, `EngagementService`, or `CoreSocket` behavior. Only their location / wiring changes (Phase 2).
- ADR-0022 does not activate the stub Stores (`SceneStore`, `FogExplorationStore`, `AdventureStore`, `SettingStore`). Stub activation waits for a real workflow.
- ADR-0022 does not add per-type HTTP routes for documents that don't have them today (items, rollTables, macros, playlists, cards, users, folders). Wait for concrete callers.
- ADR-0022 does not implement world scraping. Phase 1 moves the disabled path into a script as preservation; whether the script is ever invoked is a future decision.
- ADR-0022 does not change the `actorChanged` / `actorListInvalidated` realtime wire names or the SDK realtime helpers.

---

## ADR-0022 Phase Staging

### Phase 1: Housekeeping

**Status:** Completed May 26, 2026.

Phase 1 closes the orphan-directory, deprecated-shim, scrape-thread, and Phase 5 test-coverage gaps surfaced by the May 25 audit.

**Action items:**

- [x] Delete the three orphan directories.
  Files: `src/app/actors/[id]/` (rm -r), `src/app/tools/[systemId]/[toolId]/` (rm -r), `src/server/api/` (rm -r).

- [x] Migrate any remaining callers of `seedDocumentCache(client)` / `clearDocumentCache(reason)` to the coordinator instance directly, then delete the wrappers.
  Files: `src/server/core/documents/primary/PrimaryDocumentCacheCoordinator.ts`, `src/server/core/system/SystemService.ts`, `src/server/services/world/WorldBootstrapper.ts`.

- [x] Migrate callers off the `ActorRepository` and `ActorStore` Round-01 aliases, then delete the aliases.
  Files: `src/server/core/documents/primary/actors/ActorRepository.ts`, `src/server/core/documents/primary/actors/ActorStore.ts` (zero remaining callers — aliases removed directly).

- [x] Add a direct unit test for `AppSocketGateway` deferred attach: a browser socket connecting during lifecycle state `startup` attaches world-backed listeners only after `world:ready` fires.
  Files: `src/tests/unit/sockets/app-socket-gateway.test.ts`.

- [x] Add a direct unit test for `SessionManager.getOrRestoreSession` returning `undefined` during lifecycle state `startup` when there is no in-memory session.
  Files: `src/tests/unit/session/session-manager-restore.test.ts`.

- [x] Extract the disabled scrape path from `SetupManager` into a `src/scripts/tools/admin/scrape-world.ts` operator script. Remove the deprecated method, both scrape TODOs, and any admin route exposing scrape. Add an `admin:scrape` entry to `package.json` alongside `admin:import`.
  Files: `src/server/core/world/SetupManager.ts`, `src/server/services/admin/AdminService.ts`, `src/server/routes/admin/createAdminRouter.ts`, `src/server/shared/types/admin.ts`, `src/app/(admin)/lib/adminApi.ts`, `src/app/(admin)/components/WorldManagementPanel.tsx` (comment), `src/scripts/tools/admin/scrape-world.ts` (new), `package.json`.

**Non-goals for Phase 1:**

- No imports moved between `core/` and `services/` (Phase 2).
- No `registry/core/server.ts` split (Phase 3).
- No admin-router split (Phase 4).

**Exit for Phase 1:** orphans gone; no `@deprecated` markers remain except the documented SDK shims (parked); two new tests cover the Phase 5 behaviors; scrape path lives only in `src/scripts/tools/admin/scrape-world.ts`; `npm run test:unit` and `npx tsc --noEmit` clean.

### Phase 2: Boundary Completion

**Status:** Completed May 26, 2026.

Phase 2 finishes the layering ADR-0014 / ADR-0017 began: `core/` never imports from `services/`.

**Action items:**

- [x] Relocate `SystemService` from `src/server/core/system/SystemService.ts` to `src/server/services/world/SystemService.ts`. Update all importers across the codebase to the new path.
  Files: `src/server/core/system/SystemService.ts` (deleted), `src/server/services/world/SystemService.ts` (new), `src/server/services/world/index.ts`, every consumer (`src/server/index.ts`, `src/server/realtime/AppSocketGateway.ts`, `src/server/realtime/SystemStatusBroadcaster.ts`, `src/server/services/admin/AdminService.ts`, `src/server/services/status/StatusService.ts`, `src/server/middleware/authenticateSession.ts`, `src/server/middleware/tryAuthenticateSession.ts`, `src/server/shared/utils/createRouteFoundryClient.ts`, `src/server/routes/admin/createAdminRouter.ts`, `src/server/app/registerRoutes.ts`, and four test files).

- [x] If `src/server/core/system/` is empty after the move, remove the directory.
  Files: `src/server/core/system/` (removed).

- [x] Add `CoreSocket.getTransportCallbacks(): EngagementTransportCallbacks` method that returns the callback set previously assembled inline in the constructor.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts`.

- [x] Remove `import { engagementService } from '@server/services/world'` from `CoreSocket`. The five non-callback engagement-policy queries (`shouldReconnectAfterUnexpectedDisconnect`, `shouldRunHeartbeat`, `getNextHeartbeatDelayMs`, `getInitialHeartbeatDelayMs`, `withHeartbeatPaused`) were also using the same import; refactored into a `CoreSocketEngagementPolicy` interface defined locally in CoreSocket, with a `setEngagementPolicy(policy)` setter so the composition root injects the live policy. `WorldBootstrapSnapshot` is also re-declared locally rather than imported from services.
  Files: `src/server/core/foundry/sockets/CoreSocket.ts`.

- [x] Wire the engagement callbacks and policy from the composition root. `SystemService.initialize(...)` calls `engagementService.setTransportCallbacks(this.systemClient.getTransportCallbacks())` and `this.systemClient.setEngagementPolicy({...engagementService delegates})`.
  Files: `src/server/services/world/SystemService.ts`.

- [x] Decouple `SessionManager` from `SystemService` too — it lived in `core/session/` but imported `systemService.on(...)` and `systemService.isReady()`. Added `setSystemReadinessProbe(probe)` and `handleWorldEnteredSetup()` hooks; the composition root subscribes to `systemService.on('world:connected', ...)` and forwards to SessionManager.
  Files: `src/server/core/session/SessionManager.ts`, `src/server/index.ts`.

- [x] Add a unit test asserting that the wired callback bridge actually forwards `getReconnectInputs` / `reconnect` / `startHeartbeat` / `resetRetryBackoff` between `EngagementService` and the underlying `CoreSocket` callbacks.
  Files: `src/tests/unit/services/engagement-service.test.ts` (added `runTransportCallbackBridge`).

- [x] Audit the boundary with `rg "@server/services|services/world|services/system" src/server/core` and confirm no live imports remain. (Confirmed empty.)

**Non-goals for Phase 2:**

- No behavior change in bootstrap, engagement policy, or socket lifecycle. Only locations / wiring.
- No changes to `WorldBootstrapper` or `EngagementService` themselves.
- No SDK-side changes.

**Exit for Phase 2:** `rg "from '@server/services|from '@server/core/system|from '@core/system'" src/server/core` returns no results; `SystemService` lives in `services/world/`; `CoreSocket` constructs without importing services; `npm run test:unit` and `npx tsc --noEmit` clean.

### Phase 3: Split `registry/core/server.ts`

**Status:** Completed May 26, 2026.

Phase 3 decomposes the 2038-line module registry file into focused modules behind the existing public re-export. Pure reorganization; no behavior change.

**Action items:**

- [x] Decompose `src/modules/registry/core/server.ts` into focused modules. Each new file owns one cohesive concern. Two private helper modules were also extracted (`state.ts` for the `globalThis.__coreRegistry` accessors, `internals.ts` for cross-cutting helpers like `resolveLogicPath` / `getLogicMtime` / `isModuleEnabledForRuntime` / `buildSourceResolutionContext`).
  Files: `src/modules/registry/core/{server.ts, state.ts, internals.ts, moduleSources.ts, managedModules.ts, adapterResolution.ts, lifecyclePreflight.ts, compendiumConfig.ts}`.

- [x] Preserve the public surface — `server.ts` re-exports the same set of symbols the rest of the codebase imports today. Tests and consumers required no changes; all imports of `@modules/registry/server` resolve to the same exports.
  Files: `src/modules/registry/core/server.ts`.

- [x] Add a short comment header on each new file noting which concern it owns and which file the symbols were moved from. ADR-0022 Phase 3 is the citation.
  Files: each new file.

- [x] Run `npx tsc --noEmit` and `npm run test:unit` to confirm no consumer breakage. (Both clean. Final size: `server.ts` 432 LoC, down from 2038; managedModules 1088, adapterResolution 184, lifecyclePreflight 140, moduleSources 162, state 53, internals 201, compendiumConfig 25 — total 2285 LoC across 8 files, roughly the same content distributed by concern.)

**Non-goals for Phase 3:**

- No new public exports.
- No semantic change to registry / lifecycle / managed-module behavior.
- No refactor of `manager.ts`, `lifecycle.ts`, `validation.ts`, or other registry files outside `core/server.ts`.

**Exit for Phase 3:** the 2038-line file no longer exists; the same set of exports is reachable via `@modules/registry/server`; tests and type checks pass.

### Phase 4: Split `createAdminRouter.ts`

**Status:** Completed May 26, 2026.

Phase 4 decomposes the 1082-line admin router into `registerAdmin*Routes.ts` files matching the `protected/` pattern. Pure reorganization; no behavior change.

**Action items:**

- [x] Decompose `src/server/routes/admin/createAdminRouter.ts` into the file layout described in Details §4. Each `registerAdmin*Routes` file takes a `Router`, `deps`, and the middleware/services needed for its domain.
  Files: `src/server/routes/admin/{createAdminRouter.ts (slim composer, 85 LoC), registerAdminAuthRoutes.ts (227), registerAdminWorldRoutes.ts (62), registerAdminStatusRoutes.ts (70), registerAdminModuleRoutes.ts (744)}`.

- [x] Phase 1 removed the admin scrape route, so `registerAdminSetupRoutes.ts` is unnecessary — confirmed and skipped. No setup-only endpoints remain in the admin router.

- [x] Confirm the route surface is identical pre/post split via `rg "adminRouter\.(get|post|put|delete|patch)" src/server/routes/admin` before vs. after. (30 endpoints retained; same paths.)

- [x] Run `npm run test:unit` and `npx tsc --noEmit` to confirm no consumer breakage. (Both clean.)

**Non-goals for Phase 4:**

- No new endpoints.
- No middleware reordering or auth-flow change.
- No change to the `createAdminRouter(deps)` factory shape exported to `registerRoutes`.

**Exit for Phase 4:** `createAdminRouter.ts` is a slim composer (~100 LoC); each domain has its own `register*Routes` file matching the `protected/` convention; tests and type checks pass.

### Phase 5: Verification and close-out

**Status:** Completed May 26, 2026.

Phase 5 closes the loop: doc updates, audit grep, and stamping the ADR accepted.

**Action items:**

- [x] Update `docs/architecture.md` to acknowledge that `SystemService` now lives in `services/world/` and to fix the stale `seedDocumentCache()` reference (now `PrimaryDocumentCacheCoordinator.seedAll()`).
  Files: `docs/architecture.md`.

- [x] Run targeted source audits. `rg "@server/services|services/world|services/system" src/server/core` returns only doc-comment references explaining the boundary — no live imports. `rg "@deprecated" src/server` is empty. `find src/app src/server -type d -empty` is empty.

- [x] Run unit/type checks and a full smoke pass. `npm run test:unit` and `npx tsc --noEmit` both clean.

**Non-goals for Phase 5:**

- No new behavior. Documentation and verification only.

**Exit for Phase 5:** all boundary-completion greps return empty; architecture doc is current; ADR-0022 can be marked accepted.

---

## Alternatives Considered

### Move `WorldBootstrapper` and `EngagementService` into `core/world/` instead

Rejected. These services do orchestration (bootstrap state machine, engagement policy decisions, heartbeat policy) — that's `services/` work. Moving them down would re-pollute `core/` with the very concerns ADR-0017 extracted. The right move is up — promote `SystemService` to where it belongs, not push the orchestration down.

### Leave `SystemService` in `core/system/` and invert via registration

Rejected for `SystemService`. The class genuinely does service-layer work (event emission, bootstrap delegation, ready-state facade). Even with registration plumbing, it would still be the wrong neighborhood. Registration is the right call for the `CoreSocket` ↔ `EngagementService` direction (a transport bridge), but not for `SystemService` (a domain facade).

### Land everything as one big PR

Rejected. The four phases are independent reviewable units. Phase 1 is housekeeping (no risk). Phase 2 is the architectural move (medium risk; small blast radius). Phases 3 and 4 are pure reorganization (low risk, large diff). Landing each phase separately keeps reviews honest and bisection useful if anything regresses.

### Split `registry/core/server.ts` by introducing a new public API

Rejected. The 25 exports the file owns today are the public API; downstream consumers (`SystemService`, route registers, `WorldBootstrapper`, others) import them by name. Adding a new layer or grouping object would force every consumer to migrate for zero behavior benefit. Behind-the-barrel decomposition keeps the change invisible to consumers.

---

## Consequences

- `core/` becomes genuinely upstream of `services/`. The layering rule that ADR-0014 / ADR-0017 declared finally matches what `tsc` and `rg` see.
- `SystemService` joins its neighbors (`WorldBootstrapper`, `EngagementService`) in `services/world/`. Domain cohesion improves; the orphaned `core/system/` directory disappears.
- `CoreSocket` no longer reaches up into services. Composition is owned at the entry point, where it belongs.
- The 2038-line module registry file becomes six readable files. Navigation cost drops; future module-registry work has a clear seam to land in.
- The 1082-line admin router becomes a composer plus five domain-focused register files matching the rest of the codebase.
- ADR-0021 Phase 5 behaviors gain direct test coverage.
- The disabled scrape path leaves the production tree without losing the code; an operator script preserves the use case if it ever returns.
- Three orphan directories and five deprecated shims are gone, removing noise from greps and IDE navigation.

---

## Verification Checklist

- [x] `find src/app src/server -type d -empty` returns no results (orphan directories deleted).
- [x] `rg "@deprecated" src/server` returns nothing (no coordinator wrappers, no `ActorRepository`/`ActorStore` aliases, no `SetupManager` scrape stub).
- [x] `rg "@server/services|services/world|services/system" src/server/core` returns no live imports (only doc-comment references explaining the boundary).
- [x] `SystemService` lives at `src/server/services/world/SystemService.ts`; `src/server/core/system/` no longer exists.
- [x] `CoreSocket`'s constructor does not import `engagementService`. The engagement bridge is wired from the composition root via `getTransportCallbacks()` + `setEngagementPolicy()`.
- [x] `src/modules/registry/core/server.ts` is no longer 2038 lines (now 432); the file layout matches Phase 3 Details. `@modules/registry/server` exports the same symbol set as before.
- [x] `src/server/routes/admin/createAdminRouter.ts` is no longer 1082 lines (now 85); each domain has its own `registerAdmin*Routes.ts` file. The mounted route surface is identical pre/post split (30 endpoints).
- [x] `src/scripts/tools/admin/scrape-world.ts` exists; `package.json` has an `admin:scrape` entry; no scrape references remain in `src/server`.
- [x] `src/tests/unit/sockets/app-socket-gateway.test.ts` and `src/tests/unit/session/session-manager-restore.test.ts` cover the ADR-0021 Phase 5 deferred-attach / startup-undefined behaviors.
- [x] `npm run test:unit` and `npx tsc --noEmit` are clean.
- [x] `docs/architecture.md` reflects the post-Phase-2 location of `SystemService`.
