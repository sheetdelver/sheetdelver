# ADR-0019: Foundry Version Compatibility

**Status:** Accepted - Completed May 21, 2026.
**Status amendment (September 2, 2026):** The supported window now includes
Foundry generations 13 and 14. Generation 13 compatibility is retained, and
generation 14 support is not capped to a particular maintenance build.
**Date:** May 21, 2026
**Phase:** Foundry Version Compatibility (post ADR-0014 arc)
**Supersedes:** None. Follows ADR-0018 socket-boundary closure.
**Related:** ADR-0014 (typed world-state shape), ADR-0017 (WorldBootstrapper insertion point), ADR-0018 (final socket-boundary cleanup).

---

## Context

ADR-0014 through ADR-0018 moved state, routing, bootstrap orchestration, session restore policy, URL projection, and residual socket-facing interfaces out of the socket classes. The remaining compatibility concern was not a socket-boundary problem: Sheet Delver had typed Foundry v13 world-state shapes, but did not yet have an explicit policy for what happens when the connected Foundry server is older or newer than the version those shapes describe.

`WorldStateStore` already models the Foundry release envelope with `FoundryRelease.generation`. `WorldBootstrapper` is now the application-ready insertion point: it fetches the connected-world snapshot, accepts it into Stores, runs compendium discovery, seeds primary documents, initializes the adapter, and only then marks the world `active`.

That makes compatibility a bootstrap policy concern.

---

## Decision

ADR-0019 adds an explicit Foundry-generation compatibility policy:

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

**Status:** Completed May 21, 2026.

Phase 3 makes the compatibility result visible outside logs.

**Action items:**

- [x] Store the most recent compatibility result in a service-owned diagnostic surface.
  Files: `src/server/services/world`, `src/server/core/world` only if a Store is justified.

- [x] Expose compatibility status through system/admin status payloads without making clients parse log text.
  Files: `src/server/services/status/StatusService.ts`, shared status contracts, related route tests.

- [x] Ensure browser/gateway behavior remains readiness-gated. Unsupported worlds should expose status diagnostics but should not become world-backed active sessions.
  Files: `src/server/realtime/AppSocketGateway.ts` if diagnostics affect gateway behavior.

- [x] Add unit coverage for status projection in supported, warning, unknown, and unsupported cases.
  Files: `src/tests/unit/services/*status*.test.ts` or a focused status test.

- [x] Verify Phase 3 with unit/type checks.
  Commands: `npm run test:unit`; `npx tsc --noEmit`; `git diff --check`.

**Non-goals for Phase 3:**

- No UI redesign.
- No automatic upgrade guidance beyond clear diagnostics.
- No module SDK compatibility policy.

**Phase 3 implementation note:** `WorldBootstrapper` now keeps a service-owned last compatibility diagnostic with `checkedAt`; unsupported results are recorded before the typed error is thrown so fail-closed worlds still explain themselves through status. `SystemStatusPayload` now carries `foundryCompatibility` at top level, and the admin status surface inherits it through `AdminService.getStatus()`. This is diagnostic-only: gateway readiness behavior still depends on lifecycle/readiness and does not treat compatibility warnings as active-world permission.

**Exit for Phase 3:** operators can see whether the connected Foundry generation is supported, newer-untested, unknown, or unsupported from status/admin surfaces.

### Phase 4: Documentation closure

**Status:** Completed May 21, 2026.

Phase 4 closes ADR-0019 once the policy, bootstrap gate, and diagnostics are implemented.

**Action items:**

- [x] Update ADR-0014 / ADR-0017 / ADR-0018 references that describe Foundry compatibility as deferred.
  Files: `docs/adr/0014-non-document-world-state-and-socket-boundary.md`, `docs/adr/0017-world-bootstrap-and-lifecycle-orchestration.md`, `docs/adr/0018-socket-boundary-enforcement-completion.md`.

- [x] Document the compatibility policy and supported generation constants.
  Files: this ADR, operator/admin docs if applicable.

- [x] Run final closure checks.
  Commands: `npm run test:unit`; `npx tsc --noEmit`; `git diff --check`; compatibility-policy audit.

- [x] Flip this ADR status to **Accepted** after all phases ship green.
  Files: this ADR.

**Non-goals for Phase 4:**

- No broader Foundry API migration.
- No support-window expansion beyond the constants chosen by this ADR.

**Phase 4 implementation note:** ADR-0019 is accepted. The supported generation constants are `SUPPORTED_FOUNDRY_GENERATION_MIN = 13` and `KNOWN_FOUNDRY_GENERATION_MAX = 13` in `src/server/services/world/foundryVersionCompatibility.ts`. `WorldBootstrapper` evaluates the raw bootstrap snapshot before Store seeding, records the last compatibility diagnostic with `checkedAt`, fails closed for below-min generations, and exposes `foundryCompatibility` through the shared status/admin payload.

**Exit for Phase 4:** ADR-0019 is accepted; unsupported older Foundry generations fail closed at bootstrap; newer/unknown generations are diagnostic warnings; status/admin surfaces expose the compatibility state; validation passes.

---

## Amendment 1: Foundry Generation 14 Compatibility

**Date:** September 2, 2026

### Context

The original decision intentionally anchored world-state types and the known
compatibility maximum to generation 13. Configured validation later exercised
generation 14 across world discovery, service-account login, player login,
encrypted session restoration, lifecycle transitions, requesting-user document
authorization, module loading, and status projection. The configured instance
used build 367; that build number is evidence for the login-contract branch
described below, not an upper bound on generation 14 support.

That validation surfaced one build-level wire change rather than a replacement
of the generation 13 contract. Foundry generation 14 build 366 changed the
world-login form from a selected lowercase `userid` field to username
autocomplete backed by `username` and camel-case `userId`. Sending only the
old field to build 367 returned `401 JOIN.ErrorUserDoesNotExist`.

### Amended Decision

- `SUPPORTED_FOUNDRY_GENERATION_MIN` remains `13`.
- `KNOWN_FOUNDRY_GENERATION_MAX` advances from `13` to `14`.
- Generation 13 remains supported and retains its original login payload.
- Generation 14 is supported without a maintenance-build ceiling. Build 367 is
  retained only as the configured validation point for the build 366+ login
  contract.
- Generation 15 and later remain `newer-untested`: bootstrap warns and
  proceeds, but the project does not claim support.
- Missing or invalid generation data remains `unknown` and warning-only.

`SocketBase` records the version returned by the Foundry `/api/status`
handshake and uses one shared negotiation path for both `CoreSocket` and
`ClientSocket`:

| Foundry version | Upstream `POST /join` identity fields |
| --- | --- |
| Generation 13 | `userid: <resolved-id>` |
| Generation 14 through build 365 | `userid: <resolved-id>` |
| Generation 14 build 366 and later | `username: <configured-name>`, `userId: <resolved-id>` |

The SheetDelver browser contract remains `POST /api/login { username,
password }`. The server resolves the Foundry id and retains the upstream
cookie. Restored sessions continue to reconnect with the previously validated
`{ userId, cookie }` transport credential and do not perform another
`POST /join`.

### Compatibility Scope

This amendment does not erase or deprecate generation 13, does not assume that
generation 15 preserves the generation 14 login form, and does not turn the
service account into a fallback for player requests. The typed generation 13
world-state contracts remain the historical baseline; their exercised shapes
are compatible with the validated generation 14 build, while future shape
drift still requires focused type and fixture updates.

### Verification

- Login-contract tests retain generation 13 and generation 14 build 365
  `userid` fixtures and cover generation 14 builds 366 and 367 with
  `username` plus `userId`.
- Compatibility-policy and bootstrap tests classify generations 13 and 14 as
  supported, generation 12 as unsupported, generation 15 as newer-untested,
  and missing/non-numeric generations as unknown.
- Status tests project the amended minimum/maximum range without changing
  readiness or authorization.
- The owner validated generation 14 against the configured deployment,
  including restart restoration and world lifecycle recovery; build 367
  specifically verified the build 366+ login payload.

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
- **ADR-0018** - closed the socket-boundary arc and provided the clean insertion point for this compatibility policy.

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
- [x] Phase 3: status/admin diagnostics expose compatibility state.
- [x] Phase 4: closure docs and audits pass; ADR-0019 status flips to **Accepted**.
- [x] `git diff --check`, `npx tsc --noEmit`, and `npm run test:unit` pass.
---

## Amendment 2: Document Persistence Transport Compatibility

**Date:** September 2, 2026
**Status:** Accepted decision; implementation tracked by ADR-0034.

Amendment 1's build 366 login branch is login-specific. Document persistence
has a separate compatibility contract:

- generation 13 retains single `modifyDocument`
- generation 14 retains single `modifyDocument` and adds ordered
  `modifyDocumentBatch`
- generations 13 and 14 both use `pm.autosave` for persisted collaborative
  editor content and `manageCompendium` for pack lifecycle

Generation 14 support therefore requires response normalization without
removing generation 13 behavior. Build 367 remains evidence for login
negotiation, not a document-transport ceiling or a latest-validated-build
claim.

### Amendment 2 Implementation Closeout

**Date:** September 3, 2026

The persistence transport contract is implemented without generation sniffing
at Store call sites. One ingress normalizer accepts generation 13 single
responses and generation 14 single or ordered batch responses, preserves batch
side-effect order, rejects failed/malformed entries, and separates pack scope
before world Store routing. Both supported generations also route persisted
`pm.autosave` through an authoritative root read and `manageCompendium` through
catalog/shard invalidation.

Live generation 14 ownership updates exposed a second shape difference:
generation 13 legacy replacement/deletion keys and generation 14 serialized
field-operator objects now materialize at the shared Store merge boundary.
This is response-shape compatibility, not Actor-specific ownership logic.

Live roll acceptance also exposed an outbound compatibility defect. Generation
13 already defines numeric ChatMessage presentation as `style` and accepted
numeric `type` only through a deprecated migration; generation 14 removed that
migration because `type` identifies string document subtypes. Core now emits
`style: 1` for ordinary OOC messages and `style: 0` plus `rolls` for roll
messages. The ChatMessage Repository normalizes legacy numeric caller input
while preserving string subtypes. This works against the shared generation
13/14 schema and is intentionally unrelated to the build-366 login branch.
