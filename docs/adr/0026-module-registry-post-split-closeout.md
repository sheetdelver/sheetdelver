# ADR-0026: Module Registry Post-Split Closeout

**Status:** Accepted - Implemented.
**Date:** May 30, 2026
**Phase:** Core/Base Hardening
**Supersedes:** None
**Revises:** ADR-0022 follow-up implementation notes
**Related:** Audit D (module registry post-split sanity check), Audit C route coverage follow-up, ADR-0023 world transport stabilization.

---

## Context

Audit D reviewed the module registry after the ADR-0022 split of the former monolithic registry server file. It found that the split was directionally correct, but several cleanup items still made the new shape harder to trust:

- stale imports in `src/modules/registry/core/server.ts`
- satellite files importing back through `./server`
- `FALLBACK_ADAPTER` owned by `server.ts` even though adapter resolution is the only direct consumer
- the `lifecycleStore` shared-reference mutation rule was correct but undocumented
- `IS_DEV` was captured at module load without a local warning
- the old admin world-control path still pointed at CoreSocket no-op stubs

The SDK boundary remains parked. This ADR only records the core/base registry and world-control closeout needed before SDK content is revisited.

---

## Decision

ADR-0026 records six decisions.

1. **Keep public registry barrels stable.** External callers continue to import from `@modules/registry/server`, `@modules/registry/types`, `@modules/registry/client`, and `@modules/registry/manager`. The internal core files remain private implementation detail.

2. **Own discovery in `bootstrap.ts`.** `initializeRegistry()` and `refreshRegistry()` live in `src/modules/registry/core/bootstrap.ts`, and satellites import discovery from that module rather than from `server.ts`.

3. **Own fallback adapter in `fallbackAdapter.ts`.** `FALLBACK_ADAPTER` lives in `src/modules/registry/core/fallbackAdapter.ts`. `server.ts` re-exports it only for barrel compatibility.

4. **Keep `server.ts` as projection and compatibility surface.** `server.ts` owns `listModules()`, lifecycle projections, reset helper, and re-exports. It does not own discovery internals, fallback construction, managed operations, policy evaluation, or adapter resolution.

5. **Document shared state mutation rules.** `lifecycleStore` remains a stable imported object identity. Refresh/reset paths must mutate its fields in place instead of replacing `registryState.lifecycleStore`.

6. **World control remains service/controller-owned.** Admin world launch/shutdown calls flow through `AdminService` -> `SystemService` -> `WorldTransportController`, not through CoreSocket policy or no-op methods. Route-level admin world smoke tests remain a separate Audit C follow-up.

---

## Implementation Status

- [x] `bootstrap.ts` owns `initializeRegistry()` and `refreshRegistry()`.
- [x] `fallbackAdapter.ts` owns `FALLBACK_ADAPTER`.
- [x] Registry satellites no longer import from `./server` or `../server`.
- [x] `server.ts` stale imports were removed.
- [x] `managedModules.ts` stale imports were cleaned up during this closeout pass.
- [x] `state.ts` documents the lifecycle-store in-place mutation contract.
- [x] `state.ts` documents that `IS_DEV` is captured at module load.
- [x] `WorldTransportController` implements launch/shutdown setup actions.
- [x] `world-transport-controller.test.ts` asserts launch/shutdown setup payloads.
- [ ] Add admin world route smoke tests under the Audit C route coverage track.

---

## Verification

Verified May 30, 2026:

- `rg -n "from './server'|from '../server'" src/modules/registry/core`
- `rg -n "from '@server/services" src/server/core`
- `rg -l "FALLBACK_ADAPTER" src`
- `npm run lint -- src/modules/registry/core`
- `npx tsc --noEmit`
- `npm run test:unit`

Repo-wide `npx tsc --noEmit --noUnusedLocals true` is not enabled as a gate. It still reports many unrelated app/local-module unused symbols outside this ADR's registry closeout scope.
