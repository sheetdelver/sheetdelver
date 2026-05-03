# ADR-0006: Admin Operations UX and Distribution Readiness

**Status:** Accepted
**Date:** April 29, 2026
**Supersedes:** None
**Related:** ADR-0001, ADR-0002, ADR-0003, ADR-0004, ADR-0005

---

## Context

ADR-0003 and ADR-0004 established a fully operational module manager with lifecycle governance, trust policy, compatibility contracts, source abstraction, and dry-run previews. ADR-0005 added world availability handling and a basic admin system overview card. All backend manager APIs exist and are tested.

However, two significant gaps remain before the platform can support externalized modules:

1. **Admin operations UX is API-only.** The module manager, lifecycle controls, and operational diagnostics have no dedicated frontend. Administrators must use raw HTTP calls to install, upgrade, validate, or dry-run modules. The SystemInfoCard (ADR-0005) is the first admin UI component but covers only world status — not module operations.

2. **Distribution is governance-capable but operationally centralized.** All four modules remain compiled and shipped in-repo. Indexed source resolution depends on configured index-file input, not remote authenticated retrieval. There is no source profile management, no remote index fetch with auth/retry, and no pilot module has been extracted.

Without addressing these gaps, the manager/governance layer built in Phases 22–26 cannot be exercised by real admin users, and the distribution pipeline remains theoretical.

---

## Decision

Adopt a phased implementation that delivers **admin operational UX first**, then **distribution infrastructure readiness**, then **pilot extraction preparation** — in that order.

This sequencing is intentional:
- Admin UX must exist before distribution operations can be used by real operators.
- Distribution infrastructure must be validated with admin UX before committing to module extraction.
- Pilot extraction is preparation work only; actual repo split is a future operational decision.

---

## Scope (This ADR)

### In Scope

1. Admin UX for module lifecycle and manager operations
   - Module list with lifecycle state, trust, compatibility, and health
   - Manager actions: install, uninstall, upgrade, validate, dry-run previews
   - Dependency/conflict impact visualization
   - Permission escalation approval flow
   - Operational diagnostics and error display

2. Admin UX for world and system operations
   - Enhance SystemInfoCard with world management controls
   - World launch/shutdown controls
   - Cache operations visibility
   - Audit log viewer

3. Remote index retrieval baseline
   - Authenticated fetch for remote `index://` sources (token/header auth)
   - Retry, timeout, and deterministic error handling
   - Feature-flagged alongside existing local/file index path

4. Source profile management
   - Admin-configurable source profiles (name, base URL, enabled, priority)
   - Host allowlist enforcement for production
   - Persisted source profile configuration

5. Pilot extraction readiness
   - Define canonical index contract schema (freeze `schemaVersion`, auth model, trust metadata)
   - Define pilot module selection criteria and extraction checklist
   - Validate existing source adapters against a simulated external module flow

### Out of Scope

- Actual module repository split (operational decision, not architectural)
- Public marketplace or community submission workflow
- Full canonical index service deployment
- Runtime sandboxing or per-module process isolation
- Cryptographic key infrastructure beyond current signature verification

---

## Phase Map

### Phase 27: Admin Operations UX

Goals:
- Provide administrators a complete frontend for module and system operations
- Surface all existing manager API capabilities through the admin panel
- Close the admin UX gap identified in the post-Phase 26 audit

Slices:

1. Module lifecycle dashboard
   - List all modules with state, version, trust tier, compatibility status, and health
   - Color-coded status indicators (enabled/disabled/errored/incompatible)
   - Module detail view with manifest metadata and validation diagnostics

2. Manager operations UI
   - Install, uninstall, upgrade, and validate action buttons with confirmation dialogs
   - Dry-run preview panel showing dependency, trust, permission, and compatibility impact
   - Permission escalation approval UI for upgrades that request elevated permissions

3. World and system operations
   - Enhance SystemInfoCard with world launch/shutdown controls
   - Add cache management visibility
   - Add audit log viewer (paginated, newest-first, using existing `GET /admin/audit`)

4. UX polish and error handling
   - Structured error display for policy violations, transition rejections, and operation failures
   - Loading states and optimistic updates for long-running operations
   - Responsive layout for the admin panel

Acceptance criteria:
- All manager operations (install/uninstall/upgrade/validate/dry-run) are accessible from admin UI
- Module lifecycle state and diagnostics are visible without raw API calls
- World operations and audit log are accessible from admin UI
- Error states display actionable, structured messages

**Phase 27 completed: May 2, 2026**

Delivered components:
- `adminApi.ts` — typed API client with `adminFetch<T>()` wrapper, 14 interfaces, 8 typed functions, automatic auth/CSRF headers, 401 session expiry handling
- `ModuleLifecycleControl.tsx` — enhanced module dashboard with color-coded status indicators, version badges, health summaries, expand/collapse per module
- `ModuleDetailPanel.tsx` — expandable detail view showing artifact metadata, validation diagnostics, health data, and manager operations
- `ManagerActionBar.tsx` — contextual action buttons (install/uninstall/upgrade/validate) with confirmation dialogs, dry-run previews, permission escalation approval
- `DryRunPreview.tsx` — dry-run impact preview with trust policy, permissions, compatibility, and dependency analysis
- `SystemInfoCard.tsx` — refactored to use admin API with 10s auto-refresh polling, loading skeletons, themed info cards
- `WorldManagementPanel.tsx` — world list with launch/shutdown/retry controls
- `CacheInfoPanel.tsx` — read-only cache state viewer with active world indicator
- `AuditLogViewer.tsx` — paginated audit log table with action-type filtering, auto-refresh toggle, load-more pagination
- `admin/page.tsx` — restructured dashboard with collapsible sections, responsive layout, and shared `installedModules` state for reactive panel synchronization
- `SourceProfilePanel.tsx` — source management UI with remote index browsing, version-aware action buttons (Install/Update/Re-install), and priority controls
- `createAdminRouter.ts` — expanded `/admin/lifecycle` response with validation diagnostics, health, artifact metadata, and canonical directory paths

Prerequisite (pre-phase-27): Unified data directory (`src/server/core/paths.ts`) — configurable via `--data-dir` / `SHEET_DELVER_DATA` env var. All hardcoded `.data/` and CWD-based `settings.yaml` references removed.

---

### Phase 28: Distribution Infrastructure

Goals:
- Enable remote index retrieval with auth and operational safety
- Add admin source profile management
- Validate distribution pipeline end-to-end with simulated external source

Slices:

1. Remote index retrieval
   - Add authenticated fetch adapter for remote `index://` sources
   - Support token-based auth (configurable per source profile)
   - Add retry (with backoff), timeout, and deterministic error responses
   - Feature-flag remote retrieval; preserve local/file index as default fallback

2. Source profile management
   - Add source profile model (name, base URL, kind, enabled, priority, auth config)
   - Persist source profiles in `data/modules/sources.json`
   - Add admin API endpoints for CRUD on source profiles
   - Enforce host allowlist in production mode

3. Admin UX for source profiles
   - Source profile list and editor in admin panel
   - Test connection / validate index button per source profile
   - Priority ordering controls

4. Integration coverage and hardening
   - Unit tests for remote fetch adapter (success, auth failure, timeout, malformed index)
   - Integration tests for source profile CRUD and host allowlist enforcement
   - Telemetry hooks for remote source resolution outcomes

Acceptance criteria:
- Manager can resolve and install from a remote authenticated index source
- Source profiles are admin-configurable with host governance enforcement
- Remote retrieval failures produce deterministic, structured error payloads
- Local/file index path remains functional and is the default

---

### Phase 29: Pilot Extraction Readiness

Goals:
- Prepare everything needed for the first module to be extracted to an external repository
- Validate distribution pipeline against a simulated external module without actually splitting repos

Slices:

1. Canonical index contract freeze
   - Finalize index schema `schemaVersion` and field contract
   - Finalize source identity and trust metadata schema
   - Document index contract as a versioned specification

2. Pilot module assessment
   - Evaluate each in-repo module (`shadowdark`, `dnd5e`, `morkborg`, `generic`) against extraction readiness criteria
   - Document dependency graph, shared-code coupling, and migration requirements per module
   - Select pilot candidate with clear rationale

3. Simulated external module validation
   - Create a test index document pointing to one in-repo module as if it were external
   - Validate full install/upgrade/dry-run flow through indexed source resolution
   - Validate rollback behavior under simulated fetch/verification failures

4. Extraction checklist and governance policy draft
   - Define repository structure, CI/CD requirements, and release artifact format for extracted modules
   - Draft production source-governance policy (host trust defaults, signature requirements by environment)
   - Draft publication workflow for versioned module releases

Acceptance criteria:
- Index contract schema is frozen and documented
- Pilot candidate is selected with documented rationale
- Full manager flow validated against a simulated external source
- Extraction checklist and governance policy draft exist as actionable documents

---

## Rationale

1. UX-first sequencing
   - Backend APIs without admin frontend create a dead capability. Admin UX must precede distribution infrastructure to ensure operators can actually use the platform.

2. Infrastructure before extraction
   - Remote index retrieval and source profiles must be proven before extracting a module, to avoid extracting into an untested pipeline.

3. Readiness over commitment
   - Phase 29 prepares for extraction without committing to it. The actual repo split is an operational decision that can be made independently after readiness is confirmed.

4. Incremental risk management
   - Each phase can be delivered and validated independently. If priorities shift, Phase 27 alone provides significant operational value.

---

## Consequences

### Positive
- Administrators gain full operational visibility and control over module lifecycle
- Distribution infrastructure is validated before first external module commitment
- Source governance is formalized before external module adoption
- Extraction risk is reduced through simulation and readiness validation

### Costs/Tradeoffs
- Significant frontend development effort for admin UX (Phase 27)
- Source profile model adds configuration surface that must be documented and supported
- Remote index retrieval introduces network dependency and failure modes
- Phase 29 preparation work may not lead to immediate extraction if priorities change

---

## Implementation Tracking

Status board:
- Phase 27: ✅ Completed (May 2, 2026)
- Phase 28: ✅ Completed (May 3, 2026)
- Phase 29: ✅ Completed (May 3, 2026)

This ADR should be updated per-slice as phases advance, mirroring the completion discipline used in ADR-0003 and ADR-0004.

---

## Follow-up ADRs

Expected follow-up decisions (post-Phase 29):
1. Canonical index service architecture (standalone vs admin-configured, if pilot evidence supports it)
2. First-party module repository extraction and operating model
3. Publication governance and signed distribution workflow
4. Runtime isolation and per-module containment model
