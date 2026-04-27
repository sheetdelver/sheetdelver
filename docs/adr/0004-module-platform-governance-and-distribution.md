# ADR-0004: Module Platform Governance and Distribution

**Status:** Proposed
**Date:** April 22, 2026
**Supersedes:** None
**Related:** ADR-0001, ADR-0002, ADR-0003

---

## Context

ADR-0003 established manager-driven lifecycle operations, transition policy enforcement, split lifecycle/artifact persistence, manifest governance gates, and authenticated admin manager endpoints.

The next risks and gaps are now concentrated in three areas:
- trust and permission governance for externalized artifacts
- stable capability contracts and version negotiation between core and modules
- distribution/index workflows for multi-repo module delivery

Without these, module operations exist but cannot be safely expanded to broader distribution and third-party adoption.

---

## Decision

Adopt a follow-on phase set that incrementally enables secure, contract-stable, externally distributable module operations.

This ADR defines the next implementation phases and acceptance criteria after ADR-0003 completion.

---

## Scope (This ADR)

### In Scope

1. Trust and policy enforcement baseline
- Trust tiers (`first-party`, `verified-third-party`, `unverified`)
- Artifact integrity verification at install/upgrade
- Policy gate for permission escalation during upgrade
- Explicit production-default allow policy with admin override path

2. Capability contracts and compatibility negotiation
- Define and version capability contracts (`module-api`, `ui-extension-api`, `roll-engine-api`)
- Require module-declared contract ranges in manifest
- Add compatibility resolver that blocks enable/install on incompatible contract ranges

3. Distribution and index baseline
- Introduce module source abstraction for local bundle and indexed artifact source
- Add index metadata format and retrieval flow
- Add manager dry-run mode for install/upgrade impact analysis

4. Observability and operational UX data contracts
- Add structured operation telemetry fields for trust, policy, and contract decisions
- Expose dependency/conflict impact previews for lifecycle actions
- Preserve auditable decision trail for policy denials and overrides

### Out of Scope

- Full sandboxed runtime/container isolation for module execution
- Public marketplace/community submission workflow
- Cryptographic key infrastructure beyond initial signature verification policy

---

## Phase Map

### Phase 24: Trust and Permission Governance

Goals:
- enforce trust-tier policy at install/upgrade
- verify artifact integrity/signature metadata
- guard permission increases behind explicit admin confirmation

Slices:
1. Trust model and policy schema
- Add trust tier model to manifest/runtime metadata
- Add production/development policy defaults and override model

2. Artifact verification path
- Validate digest/signature metadata on install/upgrade
- Persist verification outcome and reasoned denial payloads

3. Permission governance gate
- Compare requested permission deltas on upgrade
- Require explicit approval for elevated permissions

4. Tests and operational docs
- Unit/integration tests for deny/allow flows
- API/docs updates for trust/policy errors and override semantics

Acceptance criteria:
- Install/upgrade can be blocked by trust/policy violations with structured error payloads
- Integrity verification outcomes are persisted and auditable
- Permission escalation requires explicit approval in mutation flow

### Phase 25: Capability Contracts and Version Negotiation

Goals:
- stabilize core-module contracts with explicit versioned packages
- block incompatible modules before enable/install

Slices:
1. Contract package baselines
- Introduce versioned contract surfaces and manifest declarations

2. Compatibility resolver
- Compare required vs provided contract ranges
- Produce deterministic compatibility diagnostics

3. Lifecycle integration
- Enforce contract compatibility in validate/install/upgrade
- Persist incompatibility reasons into lifecycle state

4. Tests and migration guidance
- Add compatibility matrix tests
- Provide migration path for existing modules to contract declarations

Acceptance criteria:
- Contract incompatibility blocks module operations with actionable diagnostics
- Compatibility matrix is test-covered for pass/fail edge cases
- Existing first-party modules have explicit declared contract ranges

### Phase 26: Distribution Index and External Module Flow

Goals:
- support indexed external module sources with safe preview and rollback behavior

Slices:
1. Index model and source abstraction
- Define index JSON schema and source adapters (local, indexed)

2. Manager install/upgrade source pipeline
- Resolve module/version from index, fetch artifact metadata, validate trust/policy

3. Dry-run and impact analysis
- Add dry-run endpoints/results for dependency, trust, and permission impact

4. Tests, telemetry, and hardening
- Integration coverage for fetch/resolve/failure paths
- Observability hooks for source resolution and policy outcomes

Acceptance criteria:
- Manager can resolve and install from indexed source in addition to local source
- Dry-run previews operation impact without mutation
- Rollback behavior remains deterministic under source or validation failures

---

## Rationale

1. Risk-first sequencing
- Trust and policy controls must precede broader distribution to reduce supply-chain and privilege risks.

2. Contract stability before scale
- Explicit compatibility contracts reduce breakage as module repositories decouple from core.

3. Operational clarity
- Structured diagnostics and dry-run previews reduce unsafe admin actions and improve supportability.

---

## Consequences

### Positive
- Safer external module adoption path
- Clear compatibility governance between core and modules
- Better administrative confidence through explicit policy decisions and previews

### Costs/Tradeoffs
- Additional manifest/schema complexity
- Broader test matrix and migration overhead for module maintainers
- More policy surface to document and support

---

## Implementation Tracking

Status board:
- Phase 24: Completed
- Phase 25: Completed
- Phase 26: In Progress

This ADR should be updated per-slice as phases advance, mirroring the completion discipline used in ADR-0003.

---

## Phase 24 Outcome

Phase 24 completed in four slices.

1. Slice 1: Trust Model and Policy Schema
- Added trust tier manifest metadata
- Added environment-aware module policy defaults and override config
- Added trust gate enforcement for install/upgrade flows

2. Slice 2: Artifact Verification Path
- Added install/upgrade artifact verification metadata checks for integrity/signature inputs
- Persisted verification outcomes and denial reasons in artifact state
- Added structured artifact verification failure responses

3. Slice 3: Permission Governance Gate
- Added manifest permission declarations and validation
- Added permission delta detection for upgrades
- Required explicit approval for permission escalation before upgrade mutation

4. Slice 4: Tests and Operational Docs
- Added unit coverage for trust policy, artifact verification, and permission delta behavior
- Updated API and manifest documentation to reflect manager policy flows

## Phase 25 Outcome

Phase 25 completed in four slices.

1. Slice 1: Contract package baselines
- Added core contract registry baselines for `module-api`, `ui-extension-api`, and `roll-engine-api`
- Extended manifest compatibility schema to support explicit `apiContracts` declarations

2. Slice 2: Compatibility resolver
- Added deterministic resolver diagnostics for both core version and contract-range checks
- Added resolver-focused unit coverage for ordering, malformed ranges, and missing contracts

3. Slice 3: Lifecycle integration
- Enforced compatibility in validate/install/upgrade manager paths
- Persisted incompatibility context (required/provided contracts and diagnostics) into lifecycle validation metadata

4. Slice 4: Tests and migration guidance
- Added compatibility matrix unit coverage for pass/fail edge cases
- Migrated first-party in-repo module manifests to explicit `apiContracts` declarations
- Updated module manifest guidance with migration checklist and supported contract-range patterns

## Phase 26 Progress

In progress.

1. Slice 1: Index Model and Source Abstraction (Completed)
- Added module index schema/model types with validation and deterministic version resolution.
- Added module source adapter abstraction with local and indexed adapters.
- Added initial unit coverage for index model and source adapter behavior.

2. Slice 2: Manager Install/Upgrade Source Pipeline (Completed)
- Wired manager install/upgrade flows to resolve sources via source adapters before verification/mutation.
- Added indexed source context loading from configured index document and deterministic source-resolution failures.
- Preserved existing local/direct source behavior while enabling indexed metadata-driven permissions and artifact verification inputs.
- Extended governance tests to cover indexed source resolution and policy enforcement paths.

Remaining slices:
- Slice 3: Dry-run and impact analysis.
- Slice 4: Tests, telemetry, and hardening.
