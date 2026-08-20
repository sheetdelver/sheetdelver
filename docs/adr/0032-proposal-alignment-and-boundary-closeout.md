# ADR-0032: Proposal Alignment, Authorization Truthfulness, and Transport Boundary Closeout

**Status:** Accepted - Implementation planned.
**Date:** August 20, 2026
**Phase:** Corrective alignment / pre-main closeout
**Supersedes:** None
**Revises:** ADR-0011 (Phase 8 completion record), ADR-0013 (authoritative write-denial propagation), ADR-0023 (transport-only socket boundary), ADR-0027 (runtime module-health amendment precedence)
**Related:** ADR-0004 (completed governance phases), ADR-0008 and ADR-0009 (status metadata), ADR-0017 (world bootstrap ownership), ADR-0031 (authoritative Foundry broadcast fidelity)

---

## Context

The ADR-0001 through ADR-0031 implementation history is substantially
coherent. Module governance and distribution, primary-document ownership,
socket-boundary extraction, compendium architecture, SDK standardization,
admin hardening, combat alignment, and delete-broadcast fidelity all have
corresponding source and test changes.

A pre-main reconciliation audit nevertheless found two corrective gaps between
the accepted architecture and the current source:

1. `DELETE /actors/:id` converts a Foundry permission rejection into HTTP 200
   with `{ success: true, warning: ... }`. The write correctly uses the
   requesting user's Foundry transport and Foundry correctly remains the
   authoritative permission check, but Sheet Delver misreports the result.
2. `CoreSocket.ts` side-effect imports
   `PrimaryDocumentCacheCoordinator`. Loading the transport class therefore
   initializes application Store and `modifyDocumentRouter` registrations even
   though ADR-0023 declares the socket layer transport-only.

The same audit also found record drift:

- ADR-0004 still says `Proposed` although all three implementation phases are
  complete.
- ADR-0011's header says Phase 8 tracks an amendment even though its Phase 8
  checklist and completion notes are complete.
- ADR-0008 and ADR-0009 use status metadata formatting inconsistent with the
  rest of the ADR set.
- ADR-0027's earlier runtime-module-health text says failure reporting remains
  unimplemented, while the immediately following amendment records the
  implemented lifecycle health and `/ui-error` reporting path.
- the primary-document follow-up tracker still labels work open that later
  ADRs completed or deliberately made conditional on a real workflow.
- the July 5 pre-main sweep is a historical snapshot whose branch,
  dependency, worktree, and ADR-status measurements are no longer current.

These record issues matter because closure prose is currently being used to
judge merge readiness. A completed checkbox is not sufficient when the source
still violates the claimed boundary, and an old audit measurement must not be
treated as current evidence.

## Decision

### 1. Foundry mutation outcomes are authoritative and reported truthfully

When a write is dispatched through a requesting user's Foundry transport,
Foundry remains the authoritative authorization boundary. Sheet Delver may
normalize the response for its HTTP or SDK surface, but it must preserve the
success or failure outcome.

No route may convert an upstream authorization rejection into
`success: true`. The actor-delete route will return a failure response for
permission denial, with `success: false` and HTTP 403 for the currently
recognized permission-denial case. Unknown transport errors remain failures
and use a structured upstream status when one exists or the route's normal
server-error fallback otherwise.

The required flow is:

```text
optional local courtesy check
  -> request-scoped Repository
  -> requesting user's Foundry socket
  -> Foundry authoritative authorization
  -> truthful success or failure response
```

This decision does not add a new authorization gate and does not alter
Repository ownership. It corrects the representation of the authoritative
result.

### 2. User-scoped writes never fall back to the service-account transport

ADR-0011 Phase 8 remains in force: user-originated writes are bound to the
requesting user's Foundry socket and fail closed when that transport is not
available. Neither actor-delete correction nor later route error handling may
introduce a CoreSocket/system-client fallback.

System-account writes remain valid only for callers explicitly constructed
with a system-scoped route client. They are not a recovery path for a missing
or rejected user transport.

### 3. Truthful failure propagation is separate from courtesy authorization

Sheet Delver-side `WRITEABLE` checks can reject an obviously unauthorized
request earlier and provide a cleaner error, but they are advisory because
Foundry owns final write authorization. This ADR does not approve a broad
courtesy-gate rollout.

The deferred courtesy-gate item in ADR-0013 remains a product/policy decision.
The actor-delete correction is required independently because authoritative
Foundry denial must propagate whether a courtesy check exists, is stale, or is
bypassed.

### 4. Foundry socket classes are transport-only at import time and runtime

`SocketBase`, `CoreSocket`, and `ClientSocket` may own:

- Socket.io connection, login, cookie, emit, acknowledgement, and timeout
  mechanics
- transport-local retry counters and raw protocol details that remain within
  the accepted controller boundary
- neutral Foundry transport contracts and transport-local utilities

They may not import modules that register or mutate:

- primary-document Stores or Store coordinators
- `modifyDocumentRouter`
- application lifecycle or world Stores
- service-layer orchestration
- module registry application state

The residual `PrimaryDocumentCacheCoordinator` side-effect import will be
removed from `CoreSocket.ts`. Application composition and `WorldBootstrapper`
already own the coordinator dependency and remain responsible for ensuring
Store/router registration is available before seeding and mutation ingress.

### 5. Repeated architecture boundaries receive executable enforcement

ADR-0023's source-audit checklist did not catch the residual side-effect
import. The socket import boundary will therefore be enforced in the active
unit suite.

The check will parse TypeScript import declarations rather than search raw
text. This prevents comments and neutral type names from producing false
positives while allowing the test to reject Store, coordinator, router,
service, and registry-registration dependencies in the three socket files.

ADR status metadata will also receive a lightweight check. Every ADR must
contain a recognized top-level status field, while descriptive status suffixes
remain allowed.

### 6. Historical ADR text is amended rather than overwritten

Existing decision and implementation text remains historical evidence. When a
later implementation supersedes an earlier statement, an amendment will be
placed below or adjacent to the stale statement and will identify the
superseding behavior.

The reconciliation pass will:

- mark ADR-0004 accepted/implemented
- normalize ADR-0008 and ADR-0009 status metadata syntax
- state in ADR-0011's header that Phase 8 is complete
- amend ADR-0013 to distinguish authoritative denial propagation from optional
  courtesy gates
- amend ADR-0023 with the residual import correction and executable boundary
  guard
- amend ADR-0027 to state that runtime UI failure reporting supersedes its
  earlier "not yet implemented" text
- add current-state notes where historical module/path terminology could be
  mistaken for current operational guidance

Concrete module names used as historical implementation evidence need not be
erased. Current module-authoring guidance remains abstract, distinguishes
local and managed sources, and uses configurable `<DATA_DIR>` paths.

### 7. Temporary audit reports are not permanent decision authorities

Any still-relevant constraint from a temporary tracker must be copied into a
tracked ADR before the tracker is retired. Once copied, the tracker moves to
`temp/audit-reports/completed/` and is retained only as historical evidence.

The July 5 pre-main report will be labeled historical/superseded rather than
having its original measurements rewritten. A new dated pre-main report will
be produced only after this ADR's corrections, record reconciliation,
dependency disposition, and current verification gates are complete.

## Consequences

### Positive

- HTTP clients can trust mutation success and failure responses.
- Foundry remains the authoritative write-permission boundary without Sheet
  Delver inventing a parallel authorization model.
- User requests cannot gain service-account behavior through an error path.
- Importing `CoreSocket` no longer initializes application document state.
- The transport-only boundary becomes executable rather than documentary.
- ADR status and amendment precedence become usable for merge review.
- Temporary reports stop competing with tracked ADRs as current truth.

### Tradeoffs

- A client that relied on the incorrect actor-delete HTTP 200 must handle a
  real failure response. This is an intentional bug fix.
- Removing a side-effect import can expose hidden module-evaluation ordering.
  Bootstrap and mutation-routing tests must prove application composition owns
  registration before the change is accepted.
- Source-level architecture tests require a maintained allow/deny boundary.
  The rule must remain narrow enough to permit neutral transport contracts.
- ADR amendments add text to already long historical records, but preserve
  why prior decisions were made and what later changed.

## Implementation Plan

### Phase 0 - Characterization tests

- [ ] Add route-level actor-delete tests for success, Foundry permission
  rejection, and generic transport failure.
- [ ] Assert that no rejection case returns 2xx or `success: true`.
- [ ] Add a parsed-import socket-boundary test and demonstrate that the
  coordinator side-effect import is the current violation.
- [ ] Keep all pre-existing tests green apart from the new assertions that
  characterize the two defects.

### Phase 1 - Actor-delete result correction

- [ ] Replace the successful permission warning with HTTP 403 and
  `success: false`.
- [ ] Preserve successful deletion as HTTP 200 and `success: true`.
- [ ] Preserve generic or structured transport failures as non-2xx responses.
- [ ] Verify the Repository is invoked once through `req.foundryClient` and no
  system transport is invoked.
- [ ] Audit other mutation routes for successful error conversions and record
  any additional instance before broadening this phase. The acceptance audit
  found only actor deletion.

### Phase 2 - Socket import-boundary completion

- [ ] Remove the coordinator side-effect import from `CoreSocket.ts`.
- [ ] Verify `WorldBootstrapper` and application composition own coordinator
  initialization before document seeding or mutation ingress.
- [ ] Add the parsed-import architecture test to the active unit runner.
- [ ] Verify world bootstrap seeding, modify-document routing, and direct
  socket transport tests remain green.
- [ ] Verify
  `rg "PrimaryDocumentCacheCoordinator" src/server/core/foundry/sockets`
  returns no hits.

### Phase 3 - Tracked ADR reconciliation

- [ ] Amend ADR-0004, ADR-0008, ADR-0009, and ADR-0011 status metadata.
- [ ] Add corrective amendments to ADR-0013 and ADR-0023.
- [ ] Add the ADR-0027 superseding runtime-health amendment.
- [ ] Add concise current-state notes for historical module/path terminology
  where needed without deleting original text.
- [ ] Add and run the ADR metadata check.

### Phase 4 - Temporary report reconciliation

- [ ] Reclassify the primary-document tracker's items as completed, partial,
  deliberately deferred, or conditional on a future workflow.
- [ ] Preserve its non-fallback, non-socket-CRUD, and canonical realtime
  constraints in tracked ADRs.
- [ ] Move the tracker to `completed/` after it contains no unique live
  decision.
- [ ] Mark the July 5 pre-main report historical/superseded without changing
  its original measurements.
- [ ] Append implementation results to the alignment audit and move it to
  `completed/` after this ADR closes.

### Phase 5 - Verification and merge baseline

- [ ] Run `git diff --check`.
- [ ] Run `npm run lint`.
- [ ] Run `npx tsc --noEmit`.
- [ ] Run `npm run test:unit`.
- [ ] Run `npm run test:integration`.
- [ ] Run an isolated production build with `<DATA_DIR>` outside the checkout.
- [ ] Run the ADR metadata and socket import-boundary checks.
- [ ] Audit mutation routes for false-success error responses.
- [ ] Run `npm audit --omit=dev` and fix or explicitly disposition each
  remaining vulnerability in the new merge report.
- [ ] Produce a new dated pre-main sweep with exact branch divergence,
  worktree state, Node version, data-directory location, quality gates, and
  dependency counts.

## Non-Goals

- Choosing new `DETAIL_VISIBLE` or `CARD_VISIBLE` thresholds.
- Adding `WRITEABLE` courtesy gates to every core HTTP mutation route.
- Enforcing ownership inside Repositories.
- Falling back from a user transport to the service-account socket.
- Seeding every primary Store directly from `game.data`.
- Activating FogExploration or Adventure Stores.
- Adding routes, SDK methods, or browser consumers without a concrete
  workflow.
- Implementing folder ownership bulk apply.
- Adding a generic global `primaryDocumentChanged` consumer without a
  cross-cutting use case.
- Rewriting historical evidence to conceal the modules used for verification.
- Upgrading dependencies as part of the architecture correction.
- Upgrading managed module artifacts under `<DATA_DIR>/modules`.

## Acceptance Criteria

This ADR can be marked implemented only when:

- [ ] Actor deletion never reports `success: true` after Foundry rejects the
  write.
- [ ] Successful, permission-denied, and generic-failure actor-delete route
  tests pass.
- [ ] User-originated actor deletion remains bound to the requesting user's
  transport.
- [ ] `CoreSocket`, `ClientSocket`, and `SocketBase` contain no application
  Store/coordinator/router/service registration imports.
- [ ] Parsed-import socket-boundary coverage runs in the normal unit suite.
- [ ] World bootstrap seeding and document mutation routing remain green after
  removing the side-effect import.
- [ ] ADR-0004 and ADR-0011 status metadata reflects completed work.
- [ ] ADR-0027 clearly records that runtime UI failure reporting supersedes the
  earlier gap statement.
- [ ] ADR-0013 and ADR-0023 contain the corrective amendments adopted here.
- [ ] The primary-document tracker accurately distinguishes completed,
  partial, deferred, and conditional work.
- [ ] The July 5 pre-main report is labeled historical/superseded.
- [ ] All Phase 5 verification gates pass in an isolated environment.
- [ ] A new dated pre-main sweep records current dependency and branch state.

## Implementation Order

1. Accept this ADR.
