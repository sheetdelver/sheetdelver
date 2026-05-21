# ADR-0018: Socket Boundary Enforcement Completion

**Status:** Proposed - Phases 1-3 completed May 21, 2026.
**Date:** May 20, 2026
**Phase:** Socket Boundary Completion (Phase 5 of the ADR-0014 arc)
**Supersedes:** None. Consumes ADR-0014 world/lifecycle Stores, ADR-0015 compendium services, ADR-0016 document resolution, and ADR-0017 bootstrap orchestration.
**Related:** ADR-0011 (primary document model), ADR-0014 (non-document world state and socket boundary), ADR-0015 (compendium architecture), ADR-0016 (document resolution), ADR-0017 (world bootstrap), ADR-0019 (deferred Foundry version compatibility).

---

## Part of the ADR-0014 arc

This ADR is the fifth active decision in the ADR-0014 arc. ADR-0014 moved non-document world state out of sockets. ADR-0015 moved compendium reads out of sockets. ADR-0016 moved UUID routing out of sockets. ADR-0017 moved bootstrap orchestration, adapter ownership, engagement policy, and sync-token ownership out of sockets.

ADR-0018 is the closure pass. It removes residual utility/session concerns from socket classes, tightens socket-facing interfaces, and proves the remaining socket surface is transport only.

| ADR | Scope | Depends on |
|---|---|---|
| ADR-0014 - Non-Document World State and the Socket Boundary Principle | `WorldStateStore`, `WorldLifecycleStore`, `SharedContentStore`, file-layout convention, and removal of world-state readers from sockets. | none |
| ADR-0015 - Compendium Architecture and the Pathway B Read Gap | `CompendiumStore`, `CompendiumService`, `DiscoveryShardStore` / shard reader. Fixes SDK discovery shard reads, de-duplicates Pathway A/B index work, and removes compendium readers from sockets. | ADR-0014 |
| ADR-0016 - Document Resolution and UUID Routing | `DocumentResolver`; removes `fetchByUuid` from `CoreSocket` and `ClientSocket`; parses world, embedded, and compendium UUIDs; delegates compendium lookup to ADR-0015 shard/fallback primitives. | ADR-0015 |
| ADR-0017 - World Bootstrap and Lifecycle Orchestration | `WorldBootstrapper`, delayed `active`, adapter ownership, `EngagementService`, and `SyncTokenService`. Removes adapter, heartbeat-policy, bootstrap-orchestration, and sync-token leftovers from sockets. | ADR-0014 through ADR-0016 |
| **ADR-0018 (this ADR)** - Socket Boundary Enforcement Completion | URL utility extraction, `ClientSocket` session-restore ownership split, socket-facing interface cleanup, stale-comment cleanup, and final socket-surface verification. | ADR-0014 through ADR-0017 |
| ADR-0019 - Foundry Version Compatibility | Deferred compatibility policy using the typed `release` shape and the `WorldBootstrapper` insertion point. | ADR-0017 |

**Reading order if you land here cold:** read ADR-0014 first, then ADR-0017. ADR-0018 assumes the named state/service extractions are already complete.

---

## Context

After ADR-0017, the major socket-boundary violations are gone:

- `CoreSocket` no longer exposes world-state readers or world-snapshot mirror fields.
- `CoreSocket` no longer owns compendium aggregation, UUID routing, adapter lifecycle, engagement policy, sync-token state, or application bootstrap readiness.
- `ClientSocket` no longer has the old delegation methods to `CoreSocket`.
- `SocketBase` no longer owns shared-content state; it only listens to Foundry shared-content events and writes to `SharedContentStore`.

The remaining issues are smaller but still worth closing before the arc ends:

- `SocketBase.resolveUrl(...)` and `SocketBase.resolveHtml(...)` are pure path-rewriting utilities. They use the Foundry base URL, but no socket state or wire behavior.
- Several services and route/module facades still get URL projection behavior through a socket-shaped client method.
- `ClientSocket.restoreSession(cookie, userId)` mixes session restoration policy with transport reconnect. The cookie/session record belongs to `SessionManager`; the user socket should only reconnect with an already validated transport credential.
- Concurrent HTTP/API and Socket.IO auth can call `SessionManager.getOrRestoreSession(token)` at the same time. Without a per-session in-flight restore guard, both callers can create their own restored `ClientSocket` / presence anchor before the first restore lands in memory.
- `ClientSocket.validateSession(expectedWorldId)` reads `WorldStateStore` and performs session/world validation. That is session policy, not transport.
- Realtime session logs currently read identity from a socket-shaped client. Restored-session identity should come from the `UserSessionLike` record (or another narrow session context), not from an incidental `ClientSocket.username` property.
- `src/server/core/foundry/interfaces.ts` still documents historical broad socket contracts that no longer match the slim transport classes.
- Comments and docs still need one final pass so future contributors do not chase removed socket helpers.

---

## Decision

Complete the socket-boundary cleanup by extracting the remaining non-transport helpers and making the allowed socket surface explicit.

### URL Projection

Add a standalone Foundry URL utility:

- `resolveFoundryUrl(path, foundryBaseUrl): string`
- `resolveFoundryHtml(html, foundryBaseUrl): string`
- optional base-url normalization helper if needed by the implementation

Canonical path:

- `src/server/shared/utils/foundryUrl.ts`

Route/module public facades may continue exposing `resolveUrl(...)` as a stable API, but their implementation must call the utility. They should not rely on `SocketBase` owning URL projection.

`SocketBase.resolveUrl(...)` and `SocketBase.resolveHtml(...)` are removed after callers migrate.

### Session Restore

`SessionManager` owns cached session records, world-id validation, restore retry/backoff, and deciding whether a cached Foundry session is eligible to restore.

`ClientSocket` owns only the wire operation: connect a user-scoped socket using a supplied Foundry credential and fail closed when unavailable.

`SessionManager` also owns restore concurrency. Concurrent callers for the same session token must share one in-flight restore attempt and one resulting user transport; duplicate browser/API/socket auth paths must not create duplicate presence anchors.

This means:

- remove or replace `ClientSocket.restoreSession(cookie, userId)` with a narrow transport method that does not own persistent session policy
- remove `ClientSocket.validateSession(...)`; `SessionManager` already has the world/session context needed for that check
- keep user-scoped document writes fail-closed; never fall back to `CoreSocket`

### Final Socket Surface

After ADR-0018, the expected live socket surface is:

`SocketBase`:

- base transport connection helpers (`getBaseUrl`, handshake, login, cookie/session-id mechanics)
- socket disconnect/logout mechanics
- shared-content event listener registration as a wire-event source

`CoreSocket`:

- service-account transport connect/disconnect
- raw `emitSocketEvent(...)`
- generic `dispatchDocument(...)` / `dispatchDocumentSocket(...)`
- inbound `modifyDocument` capture that hands off to `modifyDocumentRouter`
- raw bootstrap snapshot fetch for `WorldBootstrapper`
- raw heartbeat probe/reconnect mechanics requested by `EngagementService`
- active-world runtime clears on transport teardown

`ClientSocket`:

- user-scoped transport connect/login/reconnect
- user-scoped generic document dispatch, fail-closed
- shutdown/reload wire relays

Everything else should be a Store, service, repository, route client, module client, or utility.

---

## What Stays Out

ADR-0018 does not change the Foundry wire protocol, socket.io options, login endpoint shape, `modifyDocument` payload shape, or session cookie format.

ADR-0018 does not unify `CoreSocket` and `ClientSocket`. They remain distinct identity bindings: service account vs. user session.

ADR-0018 does not remove route/module public facades such as `RouteFoundryClient.resolveUrl(...)` or `ModuleFoundryClient.resolveUrl(...)`. It only changes their implementation so URL projection is utility-owned.

ADR-0018 does not redesign session persistence or auth semantics. It only moves restore policy out of `ClientSocket` and into `SessionManager`.

ADR-0018 does not implement Foundry version compatibility checks. ADR-0019 owns that.

---

## ADR-0018 Phase Staging

This section follows ADR-0011 through ADR-0017: each phase has a named scope, status, action checklist with file touchpoints, non-goals, and a concrete exit statement.

### Phase 1: Foundry URL utility shell

**Status:** Completed May 21, 2026.

Phase 1 introduces the standalone URL helper and keeps behavior unchanged by having `SocketBase` delegate to it.

**Action items:**

- [x] Add `foundryUrl` helpers for URL and HTML projection.
  Files: `src/server/shared/utils/foundryUrl.ts`.

- [x] Add unit coverage for empty paths, absolute URLs, data URIs, hash anchors, leading slashes, trailing slash base URLs, image `src`, and anchor `href`.
  Files: `src/tests/unit/utils/foundry-url.test.ts`, `src/tests/unit/run.ts`.

- [x] Change `SocketBase.resolveUrl(...)` and `resolveHtml(...)` to call the new helpers without moving call sites yet.
  Files: `src/server/core/foundry/sockets/SocketBase.ts`.

- [x] Verify Phase 1 with unit/type checks.
  Commands: `npm run test:unit`; `npx tsc --noEmit`; `git diff --check`.

**Phase 1 implementation note:** `foundryUrl.ts` now owns the exact URL/HTML projection behavior that previously lived inline on `SocketBase`: empty strings pass through, `http*` and `data:` URLs stay untouched, relative and leading-slash paths are projected against the normalized Foundry base URL, and HTML projection rewrites double-quoted image `src` and anchor `href` attributes while preserving local hash anchors. `SocketBase.resolveUrl(...)` and `resolveHtml(...)` remain only as compatibility wrappers until Phase 2 migrates callers.

**Non-goals for Phase 1:**

- No caller migration yet.
- No socket method deletion yet.
- No session restore changes.

**Exit for Phase 1:** URL projection behavior is covered by utility tests and `SocketBase` is only a compatibility wrapper around the helper.

### Phase 2: URL caller migration and SocketBase wrapper deletion

**Status:** Completed May 21, 2026.

Phase 2 removes URL projection from socket classes.

**Action items:**

- [x] Migrate server status, utility, actor, combat, route-client, and module-client URL projections to call `foundryUrl` helpers directly or through a service/route facade backed by those helpers.
  Files: `src/server/services/status/StatusService.ts`, `src/server/services/utility/UtilityService.ts`, `src/server/services/actors/ActorNormalizationService.ts`, `src/server/services/actors/ActorService.ts`, `src/server/services/combats/CombatService.ts`, `src/server/shared/utils/createRouteFoundryClient.ts`, `src/server/shared/utils/createModuleFoundryClient.ts`.

- [x] Preserve route/module public `resolveUrl(...)` API shapes where they are service contracts, but remove their dependency on `SocketBase.resolveUrl(...)`.
  Files: `src/server/shared/types/requestContext.ts`, `src/server/shared/types/actors.ts`, `src/server/shared/types/utility.ts`, SDK-facing types if needed.

- [x] Remove `SocketBase.resolveUrl(...)` and `SocketBase.resolveHtml(...)` once no direct callers remain.
  Files: `src/server/core/foundry/sockets/SocketBase.ts`.

- [x] Tighten status/client-like types that required `resolveUrl(...)` only because the socket owned the utility.
  Files: `src/server/shared/types/foundry.ts`, affected service test mocks.

- [x] Verify Phase 2 with unit/type checks and URL audits.
  Commands: `npm run test:unit`; `npx tsc --noEmit`; `git diff --check`; `rg -n "resolveHtml|\\.resolveUrl\\(" src/server src/tests/unit`; `rg -n "public resolveUrl|public resolveHtml" src/server/core/foundry/sockets`.

**Phase 2 implementation note:** `SocketBase` no longer exposes `resolveUrl(...)` or `resolveHtml(...)`. `createRouteFoundryClient` preserves the route-facing `resolveUrl(...)` contract by calling `resolveFoundryUrl(path, client.url)`, and `createModuleFoundryClient` continues to expose the SDK `resolveUrl(...)` contract through that route facade. `StatusService` now projects status/user image URLs directly through `foundryUrl.ts` using the system client's base `url`; `FoundrySystemClientLike` no longer carries a `resolveUrl(...)` method. Remaining `.resolveUrl(...)` hits are service/module facade calls, not socket-class methods.

**Non-goals for Phase 2:**

- No change to generated URLs.
- No route/module API break for public facades.
- No session restore changes.

**Exit for Phase 2:** `SocketBase` no longer owns URL projection; socket classes have no `resolveUrl` / `resolveHtml` methods; public facades preserve URL behavior through utility-backed projection; tests and audits pass.

### Phase 3: ClientSocket session restore ownership split

**Status:** Completed May 21, 2026.

Phase 3 moves session restore policy out of `ClientSocket` and removes socket-side session validation.

**Action items:**

- [x] Define a narrow restored-session credential shape for reconnecting a user socket.
  Files: `src/server/core/session/SessionManager.ts`, `src/server/shared/types/foundry.ts` or a focused session type file if useful.

- [x] Move cached-session record interpretation, world-id validation, and restore retry policy fully into `SessionManager`.
  Files: `src/server/core/session/SessionManager.ts`.

- [x] Add per-session in-flight restore de-duplication to `SessionManager.getOrRestoreSession(...)`. Concurrent calls for the same token must share one restore promise and return the same in-memory session instead of creating multiple `ClientSocket` / presence-anchor connections.
  Files: `src/server/core/session/SessionManager.ts`.

- [x] Replace `ClientSocket.restoreSession(cookie, userId)` with a transport-shaped method that accepts an already validated credential and reconnects. It may still hydrate socket cookie state internally because cookie headers are transport mechanics; it must not own cache/session policy.
  Files: `src/server/core/foundry/sockets/ClientSocket.ts`, `src/server/core/foundry/sockets/SocketBase.ts` if a cookie-hydration helper is useful.

- [x] Ensure failed restore attempts clear any in-flight restore entry and disconnect any partially connected client before returning `undefined`.
  Files: `src/server/core/session/SessionManager.ts`, `src/server/core/foundry/sockets/ClientSocket.ts`.

- [x] Remove `ClientSocket.validateSession(...)`; world/session validation belongs to `SessionManager`.
  Files: `src/server/core/foundry/sockets/ClientSocket.ts`, `src/server/core/session/SessionManager.ts`.

- [x] Add or update unit coverage for restored-session reconnect, concurrent restore de-duplication, world-id mismatch purge, startup restore deferral, and fail-closed user dispatch.
  Files: `src/tests/unit/session/session-manager-restore.test.ts` or existing session tests, `src/tests/unit/sockets/client-socket-transport.test.ts`, `src/tests/unit/run.ts`.

- [x] Verify Phase 3 with unit/type checks and session-surface audits.
  Commands: `npm run test:unit`; `npx tsc --noEmit`; `git diff --check`; `rg -n "restoreSession\\(|validateSession\\(" src/server src/tests`.

**Phase 3 implementation note:** `SessionManager` now converts cached records into a narrow `RestoredFoundrySessionCredential`, validates the cached world id before creating a user transport, owns restore retries, and stores one in-flight restore promise per session token so parallel HTTP/API/socket auth paths share the same restored session. `ClientSocket.connectWithRestoredCredential(...)` only hydrates cookie transport state and connects; `SocketBase.hydrateCookieHeader(...)` owns restored Cookie-header parsing because that state is transport mechanics. Failed restore attempts disconnect any partially created client and clear the in-flight guard before returning `undefined`.

**Non-goals for Phase 3:**

- No auth model redesign.
- No session cache format migration unless required for a narrow type.
- No change to user-scoped dispatch fail-closed behavior.
- No `CoreSocket`/`ClientSocket` unification.

**Exit for Phase 3:** `SessionManager` owns restore policy, validation, and restore concurrency; `ClientSocket` owns only user-socket reconnect mechanics; duplicate auth paths share one restore attempt; `validateSession` is gone from the socket; tests and audits pass.

### Phase 4: Socket-facing interface and residual boundary audit

**Status:** Not started.

Phase 4 aligns types, debug services, and comments with the final socket shape.

**Action items:**

- [ ] Tighten or remove stale broad socket interfaces that still advertise historical helpers.
  Files: `src/server/core/foundry/interfaces.ts`, `src/server/shared/types/foundry.ts`.

- [ ] Verify `ClientSocket` has no residual zero-value delegations to `CoreSocket` / `systemService.getSystemClient()`.
  Files: `src/server/core/foundry/sockets/ClientSocket.ts`, tests.

- [ ] Replace concrete `ClientSocket` type dependencies in debug/session-facing services with the narrow route-client or transport shape where practical.
  Files: `src/server/services/debug/DebugService.ts`, `src/server/routes/debug/registerDebugRoutes.ts`, `src/server/shared/types/foundry.ts`.

- [ ] Update realtime/session logs and narrow types so restored-session usernames come from `UserSessionLike.username` or a session context, not from the transport client.
  Files: `src/server/realtime/AppSocketGateway.ts`, `src/server/shared/types/foundry.ts`, related tests.

- [ ] Remove stale ADR-phase comments from live code after the final ownership model is obvious from names/types.
  Files: touched socket, session, utility, and route-client files.

- [ ] Verify Phase 4 with type checks and socket-surface audits.
  Commands: `npx tsc --noEmit`; `git diff --check`; `rg -n "getSystemAdapter|loadSystemAdapter|fetchByUuid\\(|getAllCompendiumIndices|getGameData|getSceneData|getSystemConfig|updateActiveBrowserCount|lastActorChange|resolveHtml|public resolveUrl|validateSession|restoreSession" src/server/core/foundry/sockets src/server/core/foundry/interfaces.ts src/server/shared/types`.

**Non-goals for Phase 4:**

- No route/module facade removal just because a facade has a socket-adjacent name.
- No primary-document repository changes.
- No Foundry protocol changes.

**Exit for Phase 4:** socket-facing interfaces match the real classes; `ClientSocket` has no residual CoreSocket delegations; debug/session touchpoints depend on narrow types where practical; stale comments are removed; audits pass.

### Phase 5: Documentation closure and final arc handoff

**Status:** Not started.

Phase 5 closes ADR-0018 and hands the arc to ADR-0019.

**Action items:**

- [ ] Update ADR-0014 / ADR-0017 / socket-boundary audit references that describe ADR-0018 leftovers as pending.
  Files: `docs/adr/0014-non-document-world-state-and-socket-boundary.md`, `docs/adr/0017-world-bootstrap-and-lifecycle-orchestration.md`, `temp/audit-reports/socket-boundary-audit.md`.

- [ ] Document the final allowed socket surface and the expected service/Store homes for all removed concerns.
  Files: `docs/adr/0018-socket-boundary-enforcement-completion.md`, `temp/audit-reports/socket-boundary-audit.md`.

- [ ] Run final closure checks.
  Commands: `npm run test:unit`; `npx tsc --noEmit`; `git diff --check`; Phase 4 socket-surface audit; URL audit; session restore audit.

- [ ] Flip this ADR status to **Accepted** after all phases ship green.
  Files: `docs/adr/0018-socket-boundary-enforcement-completion.md`.

**Non-goals for Phase 5:**

- No ADR-0019 compatibility policy.
- No opportunistic refactors outside socket-boundary closure.
- No tracked real world or compendium dump fixtures.

**Exit for Phase 5:** ADR-0018 is accepted; documentation matches the final socket boundary; unit/type checks and targeted audits pass; ADR-0019 is the only remaining ADR in the arc.

---

## Alternatives Considered

### Keep URL helpers on `SocketBase`

Rejected because URL projection is pure string transformation. Keeping it on a socket makes services and route clients depend on a transport-shaped object when they only need a base URL.

### Remove route/module `resolveUrl(...)` facades

Rejected for scope. Those facades are public service/module contracts. The boundary problem is the implementation depending on `SocketBase`, not the facade method existing.

### Leave `ClientSocket.restoreSession(...)` alone

Viable but leaky. The method is small, but its name and call shape make the socket look like the owner of cached session restoration. `SessionManager` already owns session records, world validation, retries, and cache clearing; ADR-0018 should make that ownership explicit.

### Make `ClientSocket` and `CoreSocket` one class

Rejected. They bind different identities and have different safety semantics. `ClientSocket` writes must fail closed for user permissions; `CoreSocket` is the service-account transport.

---

## Consequences

### Positive

- Socket classes stop being the place contributors look for URL, session, state, resolver, adapter, engagement, or bootstrap policy.
- URL projection becomes unit-testable without socket instances.
- Session restoration ownership matches where persistent session records already live.
- Final audits become smaller and sharper: socket methods should either move bytes or register wire events.
- ADR-0019 can focus on Foundry compatibility rather than cleanup from prior phases.

### Tradeoffs

- URL migration touches many small call sites and mocks.
- Session restore split may rename a method that is conceptually working today.
- Tightening interfaces can surface old test/deprecated assumptions that need narrow replacements.

---

## Related Decisions

- **ADR-0011** - established primary-document Stores and fail-closed user transport writes.
- **ADR-0014** - established non-document Store ownership and the socket-boundary principle.
- **ADR-0015** - moved compendium aggregation out of sockets.
- **ADR-0016** - moved UUID routing out of sockets.
- **ADR-0017** - moved bootstrap orchestration, adapter lifecycle, engagement policy, and sync tokens out of sockets.
- **ADR-0019** - follows this closure with Foundry version compatibility policy.

---

## Validation

Each phase validates both behavior and boundary shrinkage.

- URL utility tests cover URL/HTML projection without sockets.
- URL migration audits prove `SocketBase` no longer exposes `resolveUrl` / `resolveHtml`.
- Session tests prove restore policy lives in `SessionManager` and user dispatch remains fail-closed.
- Session restore concurrency tests prove parallel auth paths share one restore attempt and do not create duplicate user transports.
- Interface audits prove socket-facing types do not advertise removed state/service helpers.
- Final socket-surface audits prove `CoreSocket`, `ClientSocket`, and `SocketBase` expose only transport or wire-event concerns.
- `git diff --check`, `npx tsc --noEmit`, and `npm run test:unit` pass for every phase before moving to the next.

---

## Exit Criteria

This ADR is fulfilled when residual utility/session concerns are removed from sockets and the final socket boundary is documented.

- [x] Phase 1: Foundry URL utilities exist with tests; `SocketBase` wrappers delegate to them.
- [x] Phase 2: URL projection callers migrate; `SocketBase.resolveUrl` / `resolveHtml` are gone.
- [x] Phase 3: `SessionManager` owns session restore policy, validation, and restore concurrency; `ClientSocket` owns only restored-session reconnect mechanics; `validateSession` is gone.
- [ ] Phase 4: socket-facing interfaces and debug/session touchpoints match the final socket shape.
- [ ] Phase 5: closure docs and audits pass; ADR-0018 status flips to **Accepted**.
- [ ] No tracked tests use real world or compendium dumps as fixtures.
- [ ] `git diff --check`, `npx tsc --noEmit`, and `npm run test:unit` pass.

ADR-0019 owns the next step: Foundry version compatibility.
