# ADR-0003: Module Manager Core Operations

**Status:** Accepted (Implemented)
**Date:** April 22, 2026
**Supersedes:** None
**Related:** ADR-0001, ADR-0002

---

## Context

Phase 22 established core lifecycle controls and policy enforcement:
- Authenticated admin lifecycle APIs
- Dependency/conflict enforcement for enable/disable
- Runtime failure reflection into lifecycle status/health metadata
- Durable audit logging for privileged operations

The current module system is still runtime-discovery centric and lacks full operational lifecycle management for artifact installation, upgrades, and removals.

The project needs a manager-oriented model that is explicit about:
- install/uninstall/upgrade/validate operations
- lifecycle transition constraints beyond enable/disable
- artifact metadata persistence separate from runtime state
- manifest governance as a first-class policy gate

Without this step, module lifecycle remains partially operational and cannot safely support externalized module distribution.

---

## Decision

Adopt a **Module Manager Core Operations phase** as the next implementation phase, with the manager as the source of truth for operational lifecycle transitions.

This phase will add manager-owned APIs and state transitions while preserving current enable/disable behavior and admin security boundaries.

---

## Scope (This ADR)

### In Scope

1. Manager operations (core service layer)
- `installModule(source)`
- `uninstallModule(moduleId)`
- `upgradeModule(moduleId, targetVersion)`
- `validateModule(moduleId)`
- Existing `list/enable/disable` integrated under manager policy

2. Lifecycle state expansion
- Add and enforce states:
  - `installed`
  - `upgrading`
  - `uninstalling`
  - `removed`
- Preserve existing states:
  - `discovered`, `validated`, `enabled`, `disabled`, `incompatible`, `errored`

3. Transition policy enforcement
- Allowed transitions are explicit and validated before mutation
- Failed operations produce deterministic rollback behavior
- Re-entrant operations rejected for same module during in-flight transition

4. Persistence model split
- Runtime lifecycle state remains in module state store
- Installed artifact metadata persisted separately (artifact source/version/integrity metadata)
- Failure reason and timestamp persisted for diagnostics

5. Manifest governance (v1 strict baseline)
- Introduce strict manifest validator entrypoint for install/upgrade validation
- Fail closed in production mode
- Development mode may allow explicit fail-open for local iteration

6. Admin API extension (authenticated only)
- Add manager operations to admin routes with existing admin auth + CSRF + audit controls
- Return structured policy violations and transition errors

### Out of Scope

- Public module registry/index protocol
- Signature verification and trust tier enforcement (tracked for subsequent phase)
- Capability contract package extraction (`@sheetdelver/module-api`, etc.)
- Cross-repo module publishing workflows

---

## Transition Model (Baseline)

Target transitions:
- `discovered -> installed`
- `installed -> validated`
- `validated -> enabled`
- `enabled -> disabled`
- `enabled -> errored`
- `errored -> disabled`
- `disabled -> enabled`
- `enabled|disabled -> upgrading -> validated`
- `disabled -> uninstalling -> removed`
- `any -> incompatible` when compatibility gates fail after core/API change

Failure semantics:
- Install/upgrade validation failure: no partial activation; module remains non-enabled and reason is recorded
- Enable hook failure: revert to `disabled`, set `errored` with health update
- Upgrade failure: restore prior artifact metadata + prior lifecycle state

---

## Rationale

1. Operational safety
- Explicit transition graph reduces undefined behavior and accidental state drift.

2. Future compatibility
- Manager-oriented lifecycle is required before safe external distribution and trust policy.

3. Governance and observability
- Structured operation outcomes plus existing audit logs create traceability for admin actions.

4. Incremental delivery
- This ADR intentionally limits scope to core operations first, avoiding overreach into distribution and contract package extraction.

---

## Consequences

### Positive
- Clear lifecycle ownership and transition semantics
- Safer install/upgrade/uninstall workflows
- Better rollback and diagnostics capability
- Stronger platform foundation for later trust/registry phases

### Costs/Tradeoffs
- Increased implementation complexity in registry/manager code paths
- Additional migration burden for existing module state format
- More test surface (transition matrices, rollback behavior, invalid manifest paths)

---

## Implementation Plan (Tracking)

### Slice A: Manager API and State Foundations
- Add manager service module and operation interfaces
- Extend lifecycle types and persistence for new states
- Add transition validator utility with explicit allowed transitions

### Slice B: Install/Uninstall/Upgrade Workflows
- Implement install/uninstall/upgrade operations with rollback semantics
- Persist artifact metadata and lifecycle state changes atomically where possible
- Add structured error model for transition failures

### Slice C: Manifest Validation Gate + Admin Endpoints
- Add strict manifest validator path for install/upgrade
- Add authenticated admin endpoints for manager operations
- Ensure CSRF and audit logging coverage for all mutation endpoints

### Slice D: Test and Validation Gate
- Unit tests: transition matrix and rollback cases
- Unit tests: manifest gate pass/fail behavior
- Integration tests: admin operation flows and persisted state correctness
- Validation gates: `tsc`, lint on touched files, unit suite

---

## Acceptance Criteria

- Manager operations exist and enforce transition policy
- Lifecycle store supports expanded states and persists transition outcomes
- Install/upgrade/uninstall failures are rollback-safe and diagnosable
- Admin operation routes are authenticated, CSRF-protected, and audited
- Compile/lint/unit gates pass for touched code

---

## Follow-up ADRs

Expected follow-up decisions:
1. Trust tiers and artifact signature policy
2. Capability contract package extraction/version negotiation
3. Registry index/distribution protocol for external modules

---

## Implementation Outcome

Implementation completed in four slices.

1. Slice A: Manager API and State Foundations
- Expanded lifecycle status union to include `installed`, `upgrading`, `uninstalling`, `removed`
- Added explicit transition policy utility and transition assertions
- Added manager operation foundations and precondition checks

2. Slice B: Install/Uninstall/Upgrade Workflows
- Added manager install/uninstall/upgrade operation scaffolding
- Added rollback-safe behavior for failed operations
- Added split persistence model for lifecycle state vs artifact metadata

3. Slice C: Manifest Governance + Admin Endpoints
- Added strict manifest governance path for install/upgrade
- Added explicit development fail-open override path
- Added authenticated/CSRF-protected/audited admin manager operation endpoints

4. Slice D: Test and Validation Gate
- Added manager governance and persistence correctness tests
- Added strict-vs-fail-open manifest gate coverage
- Validation gates run green (`tsc`, lint on touched runtime files, unit suite)

This ADR is now closed as implemented and superseded by follow-up ADR-0004 for trust, contract, and distribution phases.
