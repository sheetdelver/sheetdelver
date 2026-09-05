# ADR-0025: Test Infrastructure Truthfulness and Coverage Baseline

**Status:** Accepted - Implemented.
**Date:** May 30, 2026
**Phase:** Core/Base Hardening
**Supersedes:** None
**Revises:** None
**Related:** Audit C (test coverage audit), ADR-0024 (client UI state decomposition and test foundation).

---

## Context

The SDK boundary stays parked until the core/base system is hardened. Audit C identified that the current test surface gives some false confidence:

- the only integration test existed but was not wired into `package.json`
- `src/tests/socket/run-all.ts` skipped most root socket test files
- one socket filename had the `compedium` typo
- several files under `src/tests/socket` were not true automated tests, but interactive/debug/operator probes
- `DebugService` and `UtilityService` had no direct smoke coverage
- deprecated tests existed without a written kept-because rationale
- broader coverage instrumentation and route coverage were still thin

The immediate goal is not maximum coverage. The immediate goal is truthful test signals: anything that looks like an automated test should either be run by the relevant runner or moved/documented as manual, deprecated, or future work.

---

## Decision

ADR-0025 makes six decisions.

1. **Make the socket test runner self-auditing.** Root `src/tests/socket/*.test.ts` files are automated socket suites. `run-all.ts` must register all of them and fail fast if a root test file is omitted.

2. **Move exploratory socket probes out of the automated test namespace.** Interactive, world-specific, hard-coded, or debug-dump scripts move under `src/tests/socket/manual/*.manual.ts` with a README. They are still available to operators, but `npm run test:socket` no longer pretends they are part of the automated suite.

3. **Wire integration tests explicitly.** Integration tests get `src/tests/integration/run.ts` and `npm run test:integration` so they are discoverable and scriptable.

4. **Add narrow service smoke tests before route tests.** `DebugService` and `UtilityService` get direct tests first. Route-level tests can then assert wiring around already-tested service behavior.

5. **Document deprecated tests.** Deprecated test directories remain parked for now, but each gets a README that explains why the files are not wired and what would unblock resurrection or deletion.

6. **Keep SDK work out of scope.** This ADR hardens test infrastructure only. It does not define module SDK content, public UI component exports, or module-supplied data contracts.

---

## What Stays Out

- ADR-0025 does not begin SDK boundary/content work.
- ADR-0025 does not migrate the whole test suite to Vitest.
- ADR-0025 does not require live Foundry socket tests to run in normal unit CI.
- ADR-0025 does not provide exhaustive per-endpoint route assertions; it closes the first-pass route smoke gap.
- ADR-0025 does not add an external coverage dependency; the baseline uses Node's native V8 coverage output.

---

## ADR-0025 Phase Staging

### Phase 1: Runner Truthfulness

**Status:** Completed May 30, 2026.

Close the high-signal Audit C issues that cause tests to be invisible or mislabeled.

**Action items:**

- [x] Add `npm run test:integration` and an integration runner.
  Files: `package.json`, `src/tests/integration/run.ts`, `src/tests/integration/module-lifecycle-dependencies.test.ts`.

- [x] Move interactive/debug socket probes to `src/tests/socket/manual/*.manual.ts`.
  Files: `src/tests/socket/manual/*`.

- [x] Rename the compendium manual probe to remove the `compedium` typo.
  Files: `src/tests/socket/manual/04-compendium-fetch.manual.ts`.

- [x] Add `10-batch-operations.test.ts` to the automated socket runner.
  Files: `src/tests/socket/run-all.ts`.

- [x] Add drift detection to the socket runner so every root `*.test.ts` is either registered or moved out of the automated namespace.
  Files: `src/tests/socket/run-all.ts`.

- [x] Document manual socket probes.
  Files: `src/tests/socket/manual/README.md`, `src/tests/socket/README.md`.

- [x] Remove the stale `test:states` package script and missing-script documentation.
  Files: `package.json`, removed `src/scripts/TEST_STATES.md`.

### Phase 2: Service Smoke Coverage

**Status:** Completed May 30, 2026.

Add narrow direct coverage for services Audit C identified as untested.

**Action items:**

- [x] Add `DebugService` unauthorized-session smoke coverage.
  Files: `src/tests/unit/services/debug-service.test.ts`, `src/tests/unit/run.ts`.

- [x] Add `UtilityService` document/shared-content smoke coverage.
  Files: `src/tests/unit/services/utility-service.test.ts`, `src/tests/unit/run.ts`.

- [x] Add a `SystemService` orchestration/wiring test through an explicit dependency seam.
  Files: `src/server/services/world/SystemService.ts`, `src/tests/unit/services/system-service.test.ts`, `src/tests/unit/run.ts`.

### Phase 3: Deprecated Test Disposition

**Status:** Completed May 30, 2026.

Make parked/deprecated tests explicit rather than invisible.

**Action items:**

- [x] Add a README for deprecated socket legacy tests.
  Files: `src/tests/deprecated/socket-legacy/README.md`.

- [x] Add READMEs for deprecated module-specific tests.
  Files: `src/tests/deprecated/module-specific/README.md`, `src/tests/deprecated/module-specific/shadowdark/README.md`.

### Phase 4: Coverage Baseline

**Status:** Completed May 30, 2026.

Add coverage instrumentation only after runner truthfulness is fixed.

**Action items:**

- [x] Add a coverage command around the unit runner using Node V8 coverage output.
  Files: `package.json`, `src/scripts/tools/testing/coverage-unit.ts`.

- [x] Capture and document the first baseline.
  Files: `README.md`, this ADR, Audit C.

**Initial baseline:** `12,369 / 27,217` source lines covered (`45.45%`) under `npm run coverage:unit`.

### Phase 5: Route Coverage

**Status:** Completed May 30, 2026.

Add route-level smoke tests after the service tests settle.

**Action items:**

- [x] Add protected route smoke tests for utility route registration.
  Files: `src/tests/unit/routing/debug-utility-routes.test.ts`, `src/tests/unit/run.ts`.

- [x] Add protected route smoke tests for system route registration.
  Files: `src/tests/unit/routing/admin-system-module-routes.test.ts`, `src/tests/unit/routing/route-test-helpers.ts`, `src/tests/unit/run.ts`.

- [x] Add debug route smoke tests.
  Files: `src/tests/unit/routing/debug-utility-routes.test.ts`, `src/tests/unit/run.ts`.

- [x] Add admin auth/status/world/module route smoke tests in focused slices.
  Files: `src/tests/unit/routing/admin-system-module-routes.test.ts`, `src/tests/unit/routing/route-test-helpers.ts`, `src/tests/unit/run.ts`.

- [x] Add module-router smoke coverage.
  Files: `src/tests/unit/routing/admin-system-module-routes.test.ts`.

- [x] Keep admin world-control tests aligned with the post-ADR-0023 world transport controller behavior.
  Files: `src/tests/unit/routing/admin-system-module-routes.test.ts`, `src/tests/unit/world/world-transport-controller.test.ts`.

### Phase 6: Audit Closeout

**Status:** Completed May 30, 2026.

Update Audit C with the completed runner, service, and deprecated-test disposition work.

**Action items:**

- [x] Update Audit C sections 1-3 for integration/socket runner status.
- [x] Update Audit C section 5 for `DebugService` and `UtilityService`.
- [x] Update Audit C section 6 for debug/utility/system/admin/module route smoke coverage.
- [x] Update Audit C section 7 for deprecated test READMEs.
- [x] Update Audit C for coverage, `SystemService`, and route coverage closeout.

---

## Verification

Verified May 30, 2026:

- `npx tsc --noEmit`
- `npm run lint -- --no-warn-ignored src/tests/socket/run-all.ts src/tests/integration/run.ts src/tests/integration/module-lifecycle-dependencies.test.ts src/tests/unit/services/debug-service.test.ts src/tests/unit/services/utility-service.test.ts src/tests/unit/routing/debug-utility-routes.test.ts src/tests/unit/run.ts`
- `npm run lint -- --no-warn-ignored src/server/services/world/SystemService.ts src/scripts/tools/testing/coverage-unit.ts src/tests/unit/services/system-service.test.ts src/tests/unit/routing/route-test-helpers.ts src/tests/unit/routing/admin-system-module-routes.test.ts src/tests/unit/run.ts`
- `npm run test:unit`
- `npm run test:integration`
- `npm run coverage:unit`

Not run: live Foundry socket tests. They still require a configured Foundry instance and credentials.

Coverage artifacts are written to ignored `coverage/unit/summary.json` and `coverage/unit/summary.md`; the committed baseline is recorded above and in Audit C.

---

## Completion Criteria

ADR-0025 is complete because:

- `npm run test:integration` exists and runs the integration test suite.
- `npm run test:socket` cannot silently skip root socket `*.test.ts` files.
- Manual socket probes are documented and no longer counted as automated socket tests.
- `DebugService` and `UtilityService` have direct smoke coverage.
- `SystemService` has orchestration/wiring smoke coverage through an explicit dependency seam.
- Deprecated tests have written disposition notes.
- `npm run coverage:unit` exists and the first baseline is documented.
- Debug, utility, system, admin, and module route families have focused route smoke coverage.
- Audit C reflects what is closed and what remains open.
- TypeScript, unit tests, integration tests, and relevant lint checks pass.
