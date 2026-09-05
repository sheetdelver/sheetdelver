# ADR-0007: Distribution Infrastructure — Remote Index Retrieval and Source Profiles

**Status:** Accepted
**Date:** May 2, 2026
**Supersedes:** None
**Related:** ADR-0003, ADR-0004, ADR-0006

---

**Current-state amendment (August 21, 2026).** References below to the
protected `built-in` source profile describe the implementation at the time of
this ADR. Persisted `built-in` profiles now migrate to the protected
`local-default` profile, and runtime module source categories are `local` and
`managed`. Paths remain rooted in configurable `<DATA_DIR>`. See ADR-0027's
cleanup-drift amendment for the current source terminology.

## Context

ADR-0006 Phase 27 delivered a complete admin operations UX, closing the admin frontend gap. Administrators can now manage module lifecycle, perform manager operations (install/upgrade/uninstall/validate with dry-run previews), manage worlds, and view audit logs — all from the browser.

However, the distribution pipeline remains operationally centralized. Specifically:

1. **Source resolution is local-only in practice.** The `indexedModuleSourceAdapter` exists (ADR-0004) and can resolve modules from an `index://` source ref, but it requires the index document to be pre-loaded into the `SourceResolutionContext`. There is no mechanism to **fetch** an index document from a remote URL — the adapter assumes the index is already available in memory.

2. **No source profile management.** Administrators cannot configure where the system looks for modules. Source refs are hardcoded per operation (e.g., `local://shadowdark`). There is no admin-configurable list of source endpoints with auth, priority, or host governance.

3. **No remote fetch infrastructure.** The system has no authenticated HTTP client for retrieving index documents from external services, no retry/backoff logic, no timeout handling, and no structured error propagation for network failures.

Without these capabilities, the manager/governance layer cannot operate against externalized modules, and the distribution pipeline validated in ADR-0004 remains theoretical.

---

## Decision

Implement distribution infrastructure in three layers:

1. **Remote fetch adapter** — authenticated HTTP client for retrieving index documents from `index://` URLs, with retry/backoff, timeout, and structured error handling.

2. **Source profile model** — admin-configurable source definitions (name, URL, auth, priority, enabled, host allowlist governance) persisted in the data directory.

3. **Admin UX for source management** — CRUD interface for source profiles with connection testing and priority ordering.

This follows ADR-0006's sequencing: admin UX (Phase 27) → distribution infrastructure (Phase 28) → pilot extraction readiness (Phase 29).

---

## Scope

### In Scope

1. Remote index fetch adapter
   - Authenticated HTTP retrieval for `index://` source refs
   - Token-based auth (Bearer header, configurable per source profile)
   - Retry with exponential backoff (max 3 attempts, configurable)
   - Timeout handling (default 10s, configurable per profile)
   - Structured error payloads: network failure, auth failure, timeout, malformed index, schema mismatch
   - Cache layer: fetched indexes cached in memory with TTL (default 5 min)
   - Feature-flagged: local/file index path remains the default; remote fetch is opt-in per source profile

2. Source profile model and persistence
   - Source profile schema: `id`, `name`, `kind` (local/indexed/direct), `baseUrl`, `enabled`, `priority`, `auth` config, `hostAllowlist`, `createdAt`, `updatedAt`
   - Persisted at `<DATA_DIR>/modules/sources.json`
   - Default source profile: `built-in` (local, always present, cannot be deleted)
   - Admin API endpoints:
     - `GET /admin/sources` — list all source profiles
     - `POST /admin/sources` — create source profile
     - `PUT /admin/sources/:id` — update source profile
     - `DELETE /admin/sources/:id` — delete source profile (not built-in)
     - `POST /admin/sources/:id/test` — test connection / validate index

3. Host governance
   - Host allowlist enforcement: production mode rejects remote source URLs not in the allowlist
   - Configurable via `security.source-governance.host-allowlist` in `settings.yaml`
   - Development mode: allowlist not enforced (warning logged)
   - Host allowlist evaluated at source profile creation and at fetch time

4. Admin UX for source profiles
   - Source profile list view in admin dashboard (new collapsible section)
   - Create/edit/delete source profiles
   - "Test Connection" button per profile (calls `/admin/sources/:id/test`)
   - Priority ordering via drag-and-drop or up/down arrows
   - Host allowlist status indicator

5. Integration into existing source resolution
   - Extend `indexedModuleSourceAdapter` to auto-fetch from configured source profiles when index is not in context
   - Source profiles resolved in priority order; first successful fetch wins
   - Fetched indexes injected into `SourceResolutionContext` for downstream resolution

### Out of Scope

- Artifact download pipeline (fetching module code bundles — future Phase 29 concern)
- Public marketplace or submission workflow
- Cryptographic key management infrastructure
- Runtime sandboxing
- Source profile import/export

---

## Slice Breakdown

### Slice 28-A: Remote Index Fetch Adapter

**Goal:** HTTP client for fetching index documents from remote URLs with auth, retry, and structured errors.

**Files:**

| Action | File | Description |
|---|---|---|
| [x] | `src/modules/registry/distribution/remoteIndexFetcher.ts` | Authenticated fetch with retry/backoff/timeout |

**Details:**

1. `fetchRemoteIndex(url, options?)` → `{ ok, index, error, errorCode }`
2. Options: `auth` (bearer token), `timeoutMs` (default 10s), `retries` (default 3), `backoffMs` (default 1000)
3. Error codes: `network-error`, `auth-failed` (401/403), `timeout`, `malformed-index` (JSON parse failure), `schema-mismatch` (invalid schemaVersion), `http-error` (non-2xx)
4. Validates fetched JSON against `ModuleIndexDocument` schema (from `moduleIndex.ts`)
5. In-memory cache with configurable TTL; cache key = URL

### Slice 28-B: Source Profile Model and Persistence

**Goal:** CRUD model for source profiles stored in the data directory.

**Files:**

| Action | File | Description |
|---|---|---|
| [x] | `src/modules/registry/distribution/sourceProfiles.ts` | Source profile model, CRUD, persistence |

**Details:**

1. `SourceProfile` interface: `id`, `name`, `kind`, `baseUrl`, `enabled`, `priority`, `auth` (`{ type: 'bearer', token: string }`), `hostAllowlist`, `createdAt`, `updatedAt`
2. `loadSourceProfiles()` → reads from `<DATA_DIR>/modules/sources.json`
3. `saveSourceProfiles()` → writes atomically
4. `createSourceProfile()`, `updateSourceProfile()`, `deleteSourceProfile()`, `getSourceProfile()`
5. Default `built-in` profile auto-created if missing (local, priority 0, cannot delete)
6. Profiles sorted by `priority` (ascending) at load time

### Slice 28-C: Admin API for Source Profiles

**Goal:** REST endpoints for CRUD on source profiles + connection test.

**Files:**

| Action | File | Description |
|---|---|---|
| [x] | `src/server/routes/admin/createAdminRouter.ts` | Add source profile endpoints |

**Details:**

1. `GET /admin/sources` — list all profiles (sorted by priority)
2. `POST /admin/sources` — create profile (validate host allowlist)
3. `PUT /admin/sources/:id` — update profile
4. `DELETE /admin/sources/:id` — delete profile (reject built-in)
5. `POST /admin/sources/:id/test` — fetch index from profile URL, return summary (module count, schema version, publisher)
6. All mutation endpoints require `requireAdminAuth`, `requireAdminCsrf`, `auditAdminAction`

### Slice 28-D: Host Governance

**Goal:** Host allowlist enforcement for production environments.

**Files:**

| Action | File | Description |
|---|---|---|
| [x] | `src/modules/registry/security/sourceGovernance.ts` | Host allowlist validation |
| [x] | `src/server/core/config.ts` | Add `security.source-governance` config section |

**Details:**

1. `isHostAllowed(url, allowlist, mode)` → boolean
2. Production mode: reject if host not in allowlist
3. Development mode: log warning but allow
4. Applied at profile creation and at fetch time
5. Config path: `security.source-governance.host-allowlist: string[]`

### Slice 28-E: Admin UX for Source Profiles

**Goal:** Source profile management UI in the admin dashboard.

**Files:**

| Action | File | Description |
|---|---|---|
| [x] | `src/app/(admin)/components/SourceProfilePanel.tsx` | Source profile list/create/edit/delete/test |
| [x] | `src/app/(admin)/lib/adminApi.ts` | Add source profile API functions |
| [x] | `src/app/(admin)/admin/page.tsx` | Add source profiles section to dashboard |

**Details:**

1. Source profile list with name, kind, URL, enabled toggle, priority, host status
2. Create/edit form: name, kind, base URL, auth token, priority
3. "Test Connection" button → shows result (success with module count, or structured error)
4. Delete with confirmation (reject built-in)
5. Priority reordering

### Slice 28-F: Source Resolution Integration

**Goal:** Wire remote fetch into the existing source resolution pipeline.

**Files:**

| Action | File | Description |
|---|---|---|
| [x] | `src/modules/registry/core/server.ts` | Extend indexed adapter to auto-fetch from profiles |
| [x] | `src/modules/registry/core/manager.ts` | Inject source profiles into resolution context |

**Details:**

1. When `indexedModuleSourceAdapter` receives an `index://` source ref and the index is not in context:
   - Look up matching source profile by URL prefix
   - If found and enabled, call `fetchRemoteIndex()`
   - Inject result into context and retry resolution
2. Manager operations populate `SourceResolutionContext` with profiles at operation start
3. Fallback chain: context-provided indexes → remote fetch → error

---

## Dependency Order

```
Slice 28-A (Remote fetch) — no dependencies
Slice 28-B (Source profiles) — no dependencies
    ↓
Slice 28-C (Admin API) — depends on B
Slice 28-D (Host governance) — depends on B
    ↓
Slice 28-E (Admin UX) — depends on A, C
    ↓
Slice 28-F (Source resolution integration) — depends on A, B
```

A and B can be worked in parallel. C and D depend on B. E and F are integration work.

---

## Rationale

1. **Adapter-first architecture.** The remote fetch adapter is a standalone, testable unit with no UI dependencies. Building it first establishes the network boundary contract.

2. **Profile-based configuration.** Named source profiles with priority ordering give administrators clear, auditable control over where the system resolves modules — critical for production governance.

3. **Host governance as separate concern.** Decoupling host validation from profile CRUD allows governance policy to be enforced consistently at multiple layers (profile creation, fetch time) without entangling configuration logic.

4. **Feature-flagged rollout.** Local/file index remains the default. Remote fetch is opt-in via source profiles. This prevents disruption for existing deployments.

---

## Consequences

### Positive
- Administrators can configure remote module sources from the admin UI
- Source resolution pipeline gains network capability without breaking local-first default
- Host governance formalizes production security boundary for external sources
- Foundation for Phase 29 pilot extraction and simulated external module flow

### Costs/Tradeoffs
- Network dependency introduced (remote fetch adds failure modes)
- Source profile configuration adds operational surface area
- Host allowlist requires documentation and onboarding guidance
- Auth token storage in `sources.json` requires appropriate file permissions

---

## Acceptance Criteria

- Manager can resolve and install from a remote authenticated index source
- Source profiles are admin-configurable with host governance enforcement
- Remote retrieval failures produce deterministic, structured error payloads
- Local/file index path remains functional and is the default
- Test connection validates index accessibility and schema from admin UI

---

## Follow-up

Phase 29 (Pilot Extraction Readiness) depends on Phase 28 completion:
- Canonical index contract freeze
- Pilot module assessment
- Simulated external module validation
- Extraction checklist and governance policy draft

---

## Implementation Outcome

Implementation completed in six slices.

1. Slice 28-A: Remote Index Fetch Adapter
- Added `remoteIndexFetcher.ts` with authenticated HTTP retrieval (Bearer), exponential backoff, and 10s timeout.
- Implemented in-memory caching for index documents with 5-minute TTL.

2. Slice 28-B: Source Profile Model and Persistence
- Added `sourceProfiles.ts` with CRUD operations and persistence at `<DATA_DIR>/modules/sources.json`.
- Implemented default `built-in` profile logic.

3. Slice 28-C: Admin API for Source Profiles
- Added REST endpoints in `createAdminRouter.ts` for listing, creating, updating, deleting, and testing source profiles.
- Added audit logging and CSRF protection to all mutation endpoints.

4. Slice 28-D: Host Governance
- Added `sourceGovernance.ts` in `security/` with host allowlist validation and wildcard support.
- Implemented "Fail-Open" policy where undefined allowlist allows all hosts.

5. Slice 28-E: Admin UX for Source Profiles
- Added `SourceProfilePanel.tsx` component with connection testing and reactive updates.
- Integrated source profile management into the main Admin Dashboard.

6. Slice 28-F: Source Resolution Integration
- Extended `buildSourceResolutionContext` in `server.ts` to auto-fetch from configured source profiles.
- Wired host governance checks into the retrieval pipeline.

This ADR is now closed as implemented and ready for Phase 29 Pilot Extraction.
