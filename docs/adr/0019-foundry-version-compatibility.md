# ADR-0019: Foundry Version Compatibility

**Status:** Proposed.
**Date:** May 21, 2026
**Phase:** Foundry Version Compatibility (post ADR-0014 arc)
**Supersedes:** None. Follows ADR-0018 socket-boundary closure.
**Related:** ADR-0014 (typed world-state shape), ADR-0017 (WorldBootstrapper insertion point), ADR-0018 (final socket-boundary cleanup).

---

## Context

ADR-0014 through ADR-0018 moved state, routing, bootstrap orchestration, session restore policy, URL projection, and residual socket-facing interfaces out of the socket classes. The remaining compatibility concern is not a socket-boundary problem: Sheet Delver now has typed Foundry v13 world-state shapes, but it does not yet have an explicit policy for what happens when the connected Foundry server is older or newer than the version those shapes describe.

`WorldStateStore` already models the Foundry release envelope with `FoundryRelease.generation`. `WorldBootstrapper` is now the application-ready insertion point: it fetches the connected-world snapshot, accepts it into Stores, runs compendium discovery, seeds primary documents, initializes the adapter, and only then marks the world `active`.

That makes compatibility a bootstrap policy concern.

---

## Decision

Add an explicit Foundry-generation compatibility policy:

- supported minimum generation: `13`
- known maximum generation: `13`
- `generation < min`: refuse bootstrap with a typed unsupported-version error
- `generation === min/max`: bootstrap normally
- `generation > max`: warn loudly and proceed
- missing or non-numeric generation: warn as `unknown` and proceed for now

The compatibility check belongs in `WorldBootstrapper` after the raw bootstrap snapshot is fetched and before the snapshot is accepted into Stores. This prevents known-unsupported older shapes from becoming canonical Store state while still allowing newer versions to proceed under warning until we intentionally update the typed contracts.

Compatibility state should be visible to operators through logs and status/admin diagnostics. It should not be inferred from socket failures or hidden in `CoreSocket`.

---

## What Stays Out

ADR-0019 does not add Foundry v14 support. It only creates the policy gate and diagnostics.

ADR-0019 does not change Foundry wire protocol handling, socket.io options, session cookies, `modifyDocument` payloads, or compendium fallback ladders.

ADR-0019 does not rewrite the v13 world-state types. If a future Foundry generation changes the shape, that is a later compatibility-update ADR or implementation slice.

ADR-0019 does not make adapters responsible for core Foundry compatibility. System adapters may declare their own game-system constraints later, but the Foundry core generation gate is platform-owned.

---

## ADR-0019 Phase Staging

This section follows ADR-0011 through ADR-0018: each phase has a named scope, status, action checklist with file touchpoints, non-goals, and a concrete exit statement.

### Phase 1: Compatibility policy shell

**Status:** Completed May 21, 2026.

Phase 1 defines the policy primitives without wiring them into bootstrap.

**Action items:**

- [x] Add compatibility constants, result types, and a typed unsupported-version error.
  Files: `src/server/services/world/foundryVersionCompatibility.ts` or equivalent.

- [x] Implement a pure evaluator over `FoundryRelease | null | undefined`.
  Expected outcomes: `supported`, `newer-untested`, `unknown`, `unsupported`.

- [x] Add unit coverage for generation 12, 13, 14, missing generation, and non-numeric generation.
  Files: `src/tests/unit/world/foundry-version-compatibility.test.ts`, `src/tests/unit/run.ts`.

- [x] Verify Phase 1 with unit/type checks.
  Commands: `npm run test:unit`; `npx tsc --noEmit`; `git diff --check`.

**Non-goals for Phase 1:**

- No bootstrap gate yet.
- No status payload changes yet.
- No Foundry v14 compatibility claims.

**Phase 1 implementation note:** `foundryVersionCompatibility.ts` now exports the supported minimum and known maximum generation constants, a pure evaluator, a discriminated compatibility status, and `UnsupportedFoundryVersionError` for the later bootstrap gate. Runtime JSON is treated defensively: missing, non-finite, non-integer, or non-numeric `release.generation` values resolve to `unknown` and do not get coerced into a support decision.

**Exit for Phase 1:** compatibility policy can be evaluated without sockets, bootstrap, Stores, or network calls.

### Phase 2: Bootstrap compatibility gate

**Status:** Completed May 21, 2026.

Phase 2 makes `WorldBootstrapper` enforce the policy before accepting a connected-world snapshot into Stores.

**Action items:**

- [x] Run the compatibility evaluator immediately after `getBootstrapSnapshot(...)` returns and before `seedWorldSnapshot(...)`.
  Files: `src/server/services/world/WorldBootstrapper.ts`.

- [x] Refuse unsupported older generations with the typed error, leave bootstrap `ready=false`, clear the in-flight bootstrap promise, and transition lifecycle to `closed` with a descriptive reason.
  Files: `src/server/services/world/WorldBootstrapper.ts`, `src/server/core/world/WorldLifecycleStore.ts` only if a helper is needed.

- [x] Warn and proceed for newer untested generations and unknown generation.
  Files: `src/server/services/world/WorldBootstrapper.ts`.

- [x] Add unit coverage for refused older generation, warning-only newer generation, unknown generation, and normal v13 bootstrap.
  Files: `src/tests/unit/world/world-bootstrapper.test.ts`, compatibility policy tests.

- [x] Verify Phase 2 with unit/type checks.
  Commands: `npm run test:unit`; `npx tsc --noEmit`; `git diff --check`.

**Non-goals for Phase 2:**

- No public status/admin surface yet.
- No adapter-level compatibility constraints.
- No changes to `CoreSocket` transport behavior.

**Phase 2 implementation note:** `WorldBootstrapper` now evaluates `snapshot.gameData.release` before Store acceptance. Generation `12` and other below-min generations mark lifecycle `closed` with `unsupported-foundry-generation:<generation>:min-13`, throw `UnsupportedFoundryVersionError`, keep `ready=false`, and leave the bootstrapper retryable. Generation `13` proceeds normally. Newer and unknown generations log warnings and continue through Store seeding, discovery, primary-document seed, adapter initialization, and readiness.

**Exit for Phase 2:** known-unsupported Foundry generations cannot become active Store state; v13 bootstraps normally; newer/unknown generations produce warnings but do not block bootstrap.

### Phase 3: Operator diagnostics and status surface

**Status:** Not started.

Phase 3 makes the compatibility result visible outside logs.

**Action items:**

- [ ] Store the most recent compatibility result in a service-owned diagnostic surface.
  Files: `src/server/services/world`, `src/server/core/world` only if a Store is justified.

- [ ] Expose compatibility status through system/admin status payloads without making clients parse log text.
  Files: `src/server/services/status/StatusService.ts`, shared status contracts, related route tests.

- [ ] Ensure browser/gateway behavior remains readiness-gated. Unsupported worlds should expose status diagnostics but should not become world-backed active sessions.
  Files: `src/server/realtime/AppSocketGateway.ts` if diagnostics affect gateway behavior.

- [ ] Add unit coverage for status projection in supported, warning, unknown, and unsupported cases.
  Files: `src/tests/unit/services/*status*.test.ts` or a focused status test.

- [ ] Verify Phase 3 with unit/type checks.
  Commands: `npm run test:unit`; `npx tsc --noEmit`; `git diff --check`.

**Non-goals for Phase 3:**

- No UI redesign.
- No automatic upgrade guidance beyond clear diagnostics.
- No module SDK compatibility policy.

**Exit for Phase 3:** operators can see whether the connected Foundry generation is supported, newer-untested, unknown, or unsupported from status/admin surfaces.

### Phase 4: Documentation closure

**Status:** Not started.

Phase 4 closes ADR-0019 once the policy, bootstrap gate, and diagnostics are implemented.

**Action items:**

- [ ] Update ADR-0014 / ADR-0017 / ADR-0018 references that describe Foundry compatibility as deferred.
  Files: `docs/adr/0014-non-document-world-state-and-socket-boundary.md`, `docs/adr/0017-world-bootstrap-and-lifecycle-orchestration.md`, `docs/adr/0018-socket-boundary-enforcement-completion.md`, `temp/audit-reports/socket-boundary-audit.md`.

- [ ] Document the compatibility policy and supported generation constants.
  Files: this ADR, operator/admin docs if applicable.

- [ ] Run final closure checks.
  Commands: `npm run test:unit`; `npx tsc --noEmit`; `git diff --check`; compatibility-policy audit.

- [ ] Flip this ADR status to **Accepted** after all phases ship green.
  Files: this ADR.

**Non-goals for Phase 4:**

- No broader Foundry API migration.
- No support-window expansion beyond the constants chosen by this ADR.

**Exit for Phase 4:** ADR-0019 is accepted; unsupported older Foundry generations fail closed at bootstrap; newer/unknown generations are diagnostic warnings; status/admin surfaces expose the compatibility state; validation passes.

---

## Alternatives Considered

### Let shape drift fail naturally

Rejected. Silent undefined fields or downstream runtime errors make version problems look like random Store, adapter, or route bugs. A bootstrap-level diagnostic makes the actual cause visible.

### Block newer generations by default

Rejected for now. The v13 typed contracts may survive minor Foundry changes, and blocking v14+ immediately would create an unnecessary operational outage. Warn-and-proceed keeps the platform usable while making the risk explicit.

### Put the check in `CoreSocket`

Rejected. Sockets fetch bytes and maintain transport state. Compatibility is an application-readiness policy, so `WorldBootstrapper` is the correct owner.

### Make each system adapter decide

Rejected for core Foundry generation compatibility. Adapters can add system/module constraints later, but the platform must decide whether the Foundry core payload shape is supported before adapters run.

---

## Consequences

### Positive

- Operators get a clear reason when Foundry is too old.
- Version drift becomes an explicit bootstrap diagnostic instead of scattered runtime failures.
- ADR-0014's typed v13 world-state contract has an enforcement point.
- `CoreSocket` remains transport-only.

### Tradeoffs

- Older Foundry generations become a hard fail instead of best-effort.
- Newer generations can still hit shape drift at runtime; the policy intentionally warns rather than blocks.
- Status/admin contracts gain a small compatibility diagnostic surface.

---

## Related Decisions

- **ADR-0014** - introduced typed world-state shapes, including `FoundryRelease`.
- **ADR-0017** - introduced `WorldBootstrapper` and delayed `active` until application readiness.
- **ADR-0018** - closed the socket-boundary arc, leaving compatibility as the remaining follow-up.

---

## Validation

- Policy tests cover supported, unsupported, newer-untested, and unknown generations.
- Bootstrapper tests prove unsupported older generations do not seed Stores or mark lifecycle `active`.
- Status tests prove compatibility diagnostics are visible to operators.
- `git diff --check`, `npx tsc --noEmit`, and `npm run test:unit` pass for every phase before moving to the next.

---

## Exit Criteria

ADR-0019 is fulfilled when Foundry generation compatibility is explicit and enforced at bootstrap.

- [x] Phase 1: compatibility policy primitives exist with tests.
- [x] Phase 2: `WorldBootstrapper` gates unsupported older generations before Store seeding.
- [ ] Phase 3: status/admin diagnostics expose compatibility state.
- [ ] Phase 4: closure docs and audits pass; ADR-0019 status flips to **Accepted**.
- [ ] `git diff --check`, `npx tsc --noEmit`, and `npm run test:unit` pass.
