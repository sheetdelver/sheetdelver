# ADR-0024: Client UI State Decomposition and Test Foundation

**Status:** Completed.
**Date:** May 30, 2026
**Phase:** Client/UI Stabilization
**Supersedes:** None
**Revises:** None
**Related:** ADR-0023 (Foundry socket transport boundary), ADR-0025 (test infrastructure truthfulness and coverage baseline).

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

The relevant untracked audit findings are summarized below so this ADR stands on its own.

### Audit Input Summary

ADR-0024 was based on two local audit passes that are not part of the tracked documentation set. The client/UI audit found:

- The provider graph was acyclic and directionally healthy, with no `@server` imports from client code.
- `FoundryContext.tsx` had grown into a 412-line orchestration hub with connection-step projection, eight socket event handlers, world-change cleanup, module UI hot reload, actor-card patching, user-roster refresh coalescing, combat refresh scheduling, and several context-composition concerns in one file.
- One realtime effect had a 17-entry dependency array, including frequently changing objects such as `system`, `users`, `sharedContent`, and `appVersion`, causing broad socket unsubscribe/resubscribe churn.
- `FoundryContext` used a `JSON.stringify(...)` equality helper on realtime payloads, making comparisons order-sensitive, expensive for nested data, and unsafe for circular values.
- The front end had no direct tests for React components, contexts, providers, browser hooks, connection-step projection, runtime-surface warnings, or realtime handlers.
- `DashboardView` deleted actors with a hand-written `fetch(...)` instead of the shared `foundryApi` / `requestJson(...)` path.
- `JournalProvider` exported `useJournals`, while the rest of the context hooks followed provider/context naming.
- The player layout manually nested the full provider stack, unlike the admin side's provider composer.
- `DiceTrayDialog.tsx` looked app-orphaned, but a local-module check showed modules directly import other internal `@client/ui/components/*` files. That makes app-orphaned internal UI compatibility-sensitive until a public SDK/component boundary exists.
- `DiceTray.tsx` `@ts-ignore` entries and client-side `as any` clusters around dynamic module UI/component data were SDK typing gaps, not safe one-off front-end cleanup.

ADR-0024 closed the client audit items that were safe without SDK design: `FoundryContext` became a facade over focused realtime hooks, connection-step projection became a pure helper, realtime comparisons moved to shape-aware helpers, `DashboardView` uses `foundryApi.deleteActor(...)`, `useJournal` aligns with provider naming, `PlayerProviders` composes the player provider stack, `DiceTrayDialog.tsx` is retained pending SDK boundary work, and the stale combat-route note was closed after a source check found no remaining combat TODO in `src/client`, `src/app`, or `src/server`.

The test-coverage audit found a broader test infrastructure problem: unwired socket tests, one dormant integration test, no coverage command, near-zero route coverage, parked deprecated tests, and no front-end test baseline. ADR-0024 only closed the client-side slice by adding `npm run test:client` and tests for the connection-step helper, realtime comparison helpers, runtime-surface warning behavior, and shared-content realtime subscription behavior. ADR-0025 later handled the broader runner truthfulness, integration, route smoke, service smoke, deprecated-test disposition, and unit coverage baseline work.

Parked after this ADR: full SDK/public component boundary work, SDK typing for module-supplied data, internal component import migration for local modules, and broader React component/render coverage.

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

If a browser-capable React test stack is introduced later, it should be added as explicit front-end tooling rather than quietly mixed into the current hand-rolled server unit runner.

### SDK Typing Debt Stays Parked

The following remain out of scope:

- `DiceTray.tsx` theme extension `@ts-ignore` comments.
- `GenericSheet`, `GenericActorPage`, `SheetRouter`, `ToolPageRouter`, `SystemTools`, and `CombatHUD` dynamic module/component `any` escapes.
- A complete SDK contract for module-supplied actor, item, combatant, tool, and sheet data.

Those are valid issues, but they require SDK shape decisions. Local UI cleanup should not paper over them with one-off aliases that later become a second unofficial SDK.

---

## What Stays Out

- ADR-0024 does not migrate the whole test suite to a new test runner.
- ADR-0024 does not fix the unwired socket test runner, dormant integration test, coverage tooling, or route-level test gaps from the broader test-coverage audit; ADR-0025 handles those.
- ADR-0024 does not redesign the SDK or type all module-supplied data.
- ADR-0024 does not remove the `useFoundry()` facade or require component call sites to consume the extracted hooks directly.
- ADR-0024 does not change server-side socket, lifecycle, or user-connection ownership settled by ADR-0023.

---

## ADR-0024 Phase Staging

### Phase 1: Client Quick Wins

**Status:** Completed May 30, 2026.

Close the small, verified client/UI audit items before touching the larger provider shape.

**Action items:**

- [x] Retain `DiceTrayDialog.tsx` as part of the current de facto internal module-facing component surface, after checking `data/local/modules` for direct imports.
  Files: `src/client/ui/components/DiceTrayDialog.tsx`.

- [x] Add a `foundryApi.deleteActor(...)` helper and route `DashboardView` actor deletion through it.
  Files: `src/client/ui/api/foundryApi.ts`, `src/client/ui/main/views/DashboardView.tsx`.

- [x] Align journal hook naming with the provider/context convention.
  Files: `src/client/ui/context/JournalProvider.tsx`, `src/client/ui/components/JournalBrowser.tsx`, `src/client/ui/components/JournalModal.tsx`.

- [x] Introduce `PlayerProviders` and simplify `(player)/layout.tsx` to mirror the admin provider composition style.
  Files: `src/app/(player)/PlayerProviders.tsx`, `src/app/(player)/layout.tsx`.

- [x] Mark the client/UI audit combat-route TODO note as closed or superseded by ADR-0023 if no stale client-side TODO remains.
  Result: no stale combat TODO remains in `src/client`, `src/app`, or `src/server`; this ADR records the closeout inline.

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

Add React/browser-oriented tests only after there are focused hooks/components worth testing. This phase uses the existing `tsx` runner for a first client slice rather than adding a new React/browser test stack before there is enough component coverage to justify it.

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

Record the completed audit closeout inline and leave SDK typing debt clearly parked.

**Action items:**

- [x] Summarize the client/UI audit input and ADR-0024 closeout in this ADR.
  Result: client quick wins, extracted hooks, and the front-end test foundation are recorded above.

- [x] Summarize the test-coverage audit's front-end finding in this ADR and leave the broader runner/coverage issues to ADR-0025.
  Result: ADR-0024 records the client test baseline; ADR-0025 records broader runner truthfulness and coverage work.

- [x] Add a short parked note for SDK typing debt if no tracker already exists.
  Result: SDK typing debt and public component boundary work are explicitly parked above.

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
- The client/UI audit quick wins are closed.
- At least one pure client helper test and one browser/hook-oriented front-end test exist.
- This ADR records the audit input, closeout, and parked SDK/test backlog inline without relying on untracked audit reports.
- TypeScript, lint for touched files, and the relevant unit/front-end tests pass.
