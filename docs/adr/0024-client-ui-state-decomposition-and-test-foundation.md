# ADR-0024: Client UI State Decomposition and Test Foundation

**Status:** Completed.
**Date:** May 30, 2026
**Phase:** Client/UI Stabilization
**Supersedes:** None
**Revises:** None
**Related:** ADR-0023 (Foundry socket transport boundary), Audit B (Client/UI), Audit C (test coverage audit).

---

## Context

ADR-0023 completed the server-side socket transport boundary: Foundry sockets now trend toward transport-only ownership, with lifecycle, user connection orchestration, ingress, and store mutation living in services/controllers above transport.

The next comparable boundary issue is on the browser side. The client provider graph is directionally clean and has no `@server` imports, but `FoundryContext` has become the front-end equivalent of an orchestration hub. At the start of this ADR it still owns:

- connection-step projection from status payloads
- realtime socket subscriptions for system status, actor changes, shared content, user roster invalidation, module source changes, module state changes, and registry changes
- world-change contamination cleanup
- active UI module hydration and hot reload
- actor-card patching and actor-list refresh decisions
- user-roster refetch coalescing
- combat refresh debouncing
- chat/session/actor-combat/context composition

This creates a maintainability and testability problem. One realtime `useEffect` rebinds eight socket handlers and has a large dependency list including frequently changing objects such as `system`, `users`, and `sharedContent`. The local equality helper uses `JSON.stringify(...)` for comparisons. That helper is order-sensitive, can throw on circular input, and serializes nested state on every realtime push.

The client audit also found several smaller cleanup items:

- `DiceTrayDialog.tsx` appears app-orphaned, but local modules still import internal `@client/ui/components/*` paths; it is compatibility-sensitive and should be retained until the SDK/public component boundary is explicit.
- `DashboardView` deletes actors with a hand-written `fetch(...)` instead of the existing `foundryApi` / `requestJson(...)` path.
- `JournalProvider` exports `useJournals`, while the rest of the context hooks use names aligned to their provider/context.
- `(player)/layout.tsx` exposes the full provider stack inline instead of using a `PlayerProviders` wrapper like the admin side.
- At audit time, the front end had no direct tests for components, contexts, providers, or browser hooks.

Some Audit B findings are intentionally not solved here. The `@ts-ignore` entries in `DiceTray.tsx` and the `as any` clusters around dynamic module components and module-supplied actor data are SDK typing gaps. Local modules also still import some internal `@client/ui/components/*` modules directly, so deleting apparently orphaned UI components requires a local-module compatibility check and, ideally, an SDK/public component replacement first. These should be handled by SDK alignment work, not by local front-end cleanup.

Audit C also found broader test infrastructure issues: unwired socket tests, a dormant integration test, missing coverage tooling, and route-level coverage gaps. Those are real, but they are wider than this ADR. ADR-0024 only takes the client-side test foundation needed to make the UI state decomposition safe.

---

## Decision

ADR-0024 makes five decisions.

1. **Keep browser transport and browser orchestration separate.** `RealtimeContext` owns the browser socket connection. `FoundryContext` and its extracted hooks may subscribe to browser-facing app events, but they should not become a second transport owner. Socket subscriptions should be narrow, stable, and tied to one piece of client state at a time.

2. **Decompose `FoundryContext` into focused client-state hooks and pure helpers.** `FoundryContext` remains the compatibility facade consumed by existing UI code, but connection-step projection, actor realtime handling, module hot reload, shared-content updates, user roster refresh, and combat refresh scheduling move into focused hooks/helpers.

3. **Replace broad realtime equality checks with shape-aware comparisons.** The `JSON.stringify(...)` equality helper is removed. Comparisons should either be shape-specific helpers or a small shared deep-equality utility, depending on the payload. The goal is to avoid needless state resets without serializing arbitrary objects in hot realtime paths.

4. **Add a front-end test foundation before deeper UI refactors.** Start with pure helper tests that fit the existing test runner. Introduce React/browser test tooling only when hook/component behavior requires it. The initial required targets are the connection-step truth table, runtime-surface warning behavior, and at least one realtime handler/hook.

5. **Close the client quick wins while preserving SDK typing debt as parked work.** Retain compatibility-sensitive internal UI that local modules may depend on, route actor deletion through the API helper, align journal hook naming, and introduce a player provider composer. Do not spend this ADR normalizing module-supplied `any` data, adapter-specific DiceTray theme extensions, or the broader internal-component import boundary.

---

## Details

### Target Client Shape

The target provider stack keeps the current runtime behavior but gives each state owner a smaller job:

| Concern | Target owner |
| --- | --- |
| Browser socket connection lifecycle | `RealtimeContext` |
| Auth token, current user id, login/logout cleanup | `SessionContext` |
| Actor lists, actor cards, combat list fetching | `ActorCombatContext` |
| Chat messages and send behavior | `ChatContext` |
| Journal list/detail/folder behavior | `JournalProvider` |
| Compatibility facade for existing player UI | `FoundryContext` |
| Connection-step projection from status payloads | `useConnectionStep` + pure helper |
| System-status socket handling | `useSystemStatusRealtime` |
| Actor-card realtime invalidation | `useActorRealtime` |
| Shared-content realtime updates | `useSharedContentRealtime` |
| Module source/state/registry hot reload | `useModuleHotReload` |
| User roster invalidation and coalesced refetch | `useUserRosterRealtime` |
| Combat realtime invalidation and debounce | `useCombatRealtime` |
| Player provider composition order | `PlayerProviders` |

The final hook names can settle during implementation, but the ownership should stay clear: each hook subscribes to the smallest event set it needs and exposes a small result or side-effect boundary back to `FoundryContext`.

### `FoundryContext` After Decomposition

`FoundryContext` should become a composer and compatibility facade:

- read state/actions from `SessionContext`, `RealtimeContext`, `ActorCombatContext`, `ChatContext`, and the new hooks
- provide the existing `useFoundry()` shape to avoid a broad UI rewrite
- avoid large inline socket handler blocks
- avoid object-heavy realtime dependency arrays
- avoid direct ad hoc API calls that already belong in `foundryApi`

This is an incremental move. Existing components do not need to stop using `useFoundry()` during this ADR. The important change is that `useFoundry()` stops being where every client realtime concern is implemented.

### Stable Realtime Subscription Rule

Realtime hooks should follow this rule:

```text
One hook owns one small subscription concern.
Handler dependencies are stable.
Frequently changing state needed by handlers is read through refs or passed through narrow setter APIs.
```

This avoids re-subscribing a broad handler set every time `system`, `users`, `sharedContent`, or `appVersion` changes.

### Equality Strategy

The current `JSON.stringify(...)` equality helper is removed. Preferred replacements, in order:

1. Shape-specific comparisons where the payload is simple and known, such as comparing ids, status fields, version fields, and array id/version signatures.
2. A small local utility for plain JSON-like payloads if a shape-specific comparison would be more fragile than useful.
3. A library such as `fast-deep-equal` only if the local comparisons become noisy or multiple payloads require true deep equality.

This ADR does not require adding a dependency if a small helper is enough.

### Front-End Test Foundation

Testing lands in layers:

- Pure helpers first, using the existing TypeScript unit runner where practical.
- Hook/component tests next, using a browser-capable test setup only when pure tests cannot cover the behavior.
- The first React/browser targets are `useRuntimeSurface()` / `assertPlayerSurface()` warning behavior and one extracted realtime hook.

If React Testing Library and Vitest/jsdom are introduced, they should be added as explicit front-end tooling rather than quietly mixed into the current hand-rolled server unit runner.

### SDK Typing Debt Stays Parked

The following remain out of scope:

- `DiceTray.tsx` theme extension `@ts-ignore` comments.
- `GenericSheet`, `GenericActorPage`, `SheetRouter`, `ToolPageRouter`, `SystemTools`, and `CombatHUD` dynamic module/component `any` escapes.
- A complete SDK contract for module-supplied actor, item, combatant, tool, and sheet data.

Those are valid issues, but they require SDK shape decisions. Local UI cleanup should not paper over them with one-off aliases that later become a second unofficial SDK.

---

## What Stays Out

- ADR-0024 does not migrate the whole test suite to Vitest.
- ADR-0024 does not fix the unwired socket test runner, dormant integration test, coverage tooling, or route-level test gaps from Audit C.
- ADR-0024 does not redesign the SDK or type all module-supplied data.
- ADR-0024 does not remove the `useFoundry()` facade or require component call sites to consume the extracted hooks directly.
- ADR-0024 does not change server-side socket, lifecycle, or user-connection ownership settled by ADR-0023.

---

## ADR-0024 Phase Staging

### Phase 1: Client Quick Wins

**Status:** Completed May 30, 2026.

Close the small, verified Audit B items before touching the larger provider shape.

**Action items:**

- [x] Retain `DiceTrayDialog.tsx` as part of the current de facto internal module-facing component surface, after checking `data/local/modules` for direct imports.
  Files: `src/client/ui/components/DiceTrayDialog.tsx`.

- [x] Add a `foundryApi.deleteActor(...)` helper and route `DashboardView` actor deletion through it.
  Files: `src/client/ui/api/foundryApi.ts`, `src/client/ui/main/views/DashboardView.tsx`.

- [x] Align journal hook naming with the provider/context convention.
  Files: `src/client/ui/context/JournalProvider.tsx`, `src/client/ui/components/JournalBrowser.tsx`, `src/client/ui/components/JournalModal.tsx`.

- [x] Introduce `PlayerProviders` and simplify `(player)/layout.tsx` to mirror the admin provider composition style.
  Files: `src/app/(player)/PlayerProviders.tsx`, `src/app/(player)/layout.tsx`.

- [x] Mark the Audit B combat-route TODO note as closed or superseded by ADR-0023 if no stale client-side TODO remains.
  Files: `temp/audit-reports/audit-report-052626-option-b.md`.

### Phase 2: Extract Pure Client State Helpers

**Status:** Completed May 30, 2026.

Create testable units before moving socket subscriptions around.

**Action items:**

- [x] Extract connection-step projection from `FoundryContext` into a pure helper.
  Files: `src/client/ui/context/foundryConnectionStep.ts` or equivalent.

- [x] Add a truth-table unit test for connection-step projection.
  Files: `src/tests/unit/client/foundry-state-helpers.test.ts`, `src/tests/unit/run.ts`.

- [x] Replace `JSON.stringify(...)` equality with shape-aware helpers or a small shared utility.
  Files: `src/client/ui/context/FoundryContext.tsx`, helper file if needed.

- [x] Add unit coverage for the equality/helper behavior that guards realtime state resets.
  Files: `src/tests/unit/client/*`.

### Phase 3: Split Client Realtime Hooks

**Status:** Completed May 30, 2026.

Move socket event ownership out of the `FoundryContext` body while preserving the `useFoundry()` facade.

**Action items:**

- [x] Extract system-status handling into a focused hook that uses the connection-step helper.
  Files: `src/client/ui/context/FoundryContext.tsx`, `src/client/ui/hooks/useSystemStatusRealtime.ts` or equivalent.

- [x] Extract actor-card realtime handling.
  Files: `src/client/ui/context/FoundryContext.tsx`, `src/client/ui/hooks/useActorRealtime.ts` or equivalent.

- [x] Extract module source/state/registry hot reload handling.
  Files: `src/client/ui/context/FoundryContext.tsx`, `src/client/ui/hooks/useModuleHotReload.ts` or equivalent.

- [x] Extract shared-content realtime handling.
  Files: `src/client/ui/context/FoundryContext.tsx`, `src/client/ui/hooks/useSharedContentRealtime.ts` or equivalent.

- [x] Extract user roster invalidation and refetch coalescing.
  Files: `src/client/ui/context/FoundryContext.tsx`, `src/client/ui/hooks/useUserRosterRealtime.ts` or equivalent.

- [x] Extract combat realtime debounce handling or move it to `ActorCombatContext` if that proves to be the cleaner owner.
  Files: `src/client/ui/context/FoundryContext.tsx`, `src/client/ui/context/ActorCombatContext.tsx`, hook file if needed.

### Phase 4: Front-End Browser Test Harness

**Status:** Completed May 30, 2026.

Add React/browser-oriented tests only after there are focused hooks/components worth testing. This phase uses the existing `tsx` runner for a first client slice rather than adding Vitest/RTL before there is enough component coverage to justify a new test stack.

**Action items:**

- [x] Add front-end test tooling and scripts.
  Files: `package.json`, `src/tests/unit/client/run.ts`.

- [x] Add a test for `useRuntimeSurface()` / `assertPlayerSurface()` warning behavior.
  Files: `src/client/hooks/useRuntimeSurface.ts`, `src/tests/unit/client/runtime-surface.test.ts`.

- [x] Add at least one test around an extracted realtime hook using a mocked socket and mocked API helper.
  Files: `src/client/ui/hooks/useSharedContentRealtime.ts`, `src/tests/unit/client/shared-content-realtime.test.ts`.

- [x] Document how to run front-end tests and whether they are included in the default unit command.
  Files: `package.json`, `README.md`.

### Phase 5: Audit Closeout

**Status:** Completed May 30, 2026.

Reflect the completed work back into the audit trail and leave SDK typing debt clearly parked.

**Action items:**

- [x] Update Audit B to mark completed client quick wins, extracted hooks, and front-end test foundation status.
  Files: `temp/audit-reports/audit-report-052626-option-b.md`.

- [x] Cross-reference Audit C's front-end test finding to ADR-0024 and leave the broader runner/coverage issues for a later ADR.
  Files: `temp/audit-reports/audit-report-052626-option-c.md`.

- [x] Add a short parked note for SDK typing debt if no tracker already exists.
  Files: audit report or future SDK ADR tracker.

### Verification

**Status:** Completed May 30, 2026.

- [x] `npx tsc --noEmit`
- [x] Focused ESLint on touched client/source files.
- [x] `npm run test:client`
- [x] `npm run test:unit`

---

## Completion Criteria

ADR-0024 is complete when:

- `FoundryContext` is primarily a composer/facade rather than the implementation home for all client realtime behavior.
- Browser socket subscriptions are split by concern and avoid broad object-driven rebinds.
- `JSON.stringify(...)` equality is gone from realtime hot paths.
- The client quick wins from Audit B are closed.
- At least one pure client helper test and one browser/hook-oriented front-end test exist.
- Audit B and Audit C reflect the resulting status accurately.
- TypeScript, lint for touched files, and the relevant unit/front-end tests pass.
