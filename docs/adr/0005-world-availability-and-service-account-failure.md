# ADR-0005: World Availability and Service Account Failure Handling

**Status:** Accepted (Implemented)
**Date:** April 27, 2026
**Supersedes:** None
**Related:** ADR-0001, ADR-0002

---

## Context

Previously, if the configured service account was missing from the active Foundry world, the backend would repeatedly attempt to connect, leaving the application in an indefinite "initializing" state. End users would see a stuck or ambiguous startup screen, and only logs would indicate the underlying issue. This approach exposed technical details to users and did not provide a clear operational recovery path for administrators.

---

## Decision

- When the service account is missing, the backend will set the world state to a generic `closed` or `unavailable` state, halting further automatic retries.
- End users will see the standard "World Closed" or "World Not Available" screen, with no mention of service accounts or technical details.
- Admins and logs will surface the specific service account error and available users, with remediation steps.
- A manual retry mechanism will be added to the admin backend and admin UI, allowing administrators to trigger a new connection/bootstrap attempt after resolving the issue (e.g., after adding the service account in Foundry).

---

## Consequences

- End users are shielded from technical errors and see a clear, familiar UI when the world is unavailable.
- Admins have actionable diagnostics and a recovery workflow.
- The system avoids unnecessary retry loops and provides a more robust operational experience.
- This change is tracked for future audits and reference.

---

## Implementation Steps

1. Update backend (CoreSocket) to set a generic `closed` state and halt retries if the service account is missing.
2. Update status payloads and client UI to display the "World Closed" screen for this state.
3. Log the error and available users for admin diagnostics.
4. Add a manual retry endpoint and admin UI button to trigger reconnection/bootstrap after remediation.

---

## Implementation Outcome

Implementation completed in two commits on the `lifecycle-improvements` branch.

### Step 1: Backend Closed State and Retry Halt

- `CoreSocket.ts`: When the configured service account username is not found in the probed world user list, `worldState` is set to `'closed'` and the method returns immediately — no `setTimeout` retry is scheduled.
- `CoreSocket.ts`: Added `probeWorldData` field to cache world metadata (title, description) discovered during the guest probe step, making it available to the status API even when the full socket connection cannot be established.
- Error logging includes the missing username, discovered world title, and a formatted list of all available users with their roles, plus explicit admin remediation instructions.

### Step 2: Status Payload and Client UI

- `StatusService.ts`: When `worldState === 'closed'`, the status payload sets `system.status` to `'closed'`. When no full game data is available but `probeWorldData` exists (service account missing scenario), the payload surfaces `worldTitle`, `worldDescription`, and user count from the probe.
- `FoundryContext.tsx`: The `determineStep()` function maps `status === 'closed'` to the `'world-closed'` connection step, which renders the standard "World Closed" screen for end users with no technical details exposed.

### Step 3: Admin Diagnostic Logging

- `CoreSocket.ts`: On service account not found, emits an `[ERROR]` log with:
  - The missing service account username
  - The world title from probe data
  - All available users formatted as `Name (role: N)`
  - Explicit remediation message directing admin to create the account in Foundry and trigger manual retry

### Step 4: Admin Retry Endpoint and UI

- `createAdminRouter.ts`: Added `POST /admin/world/retry` endpoint, guarded by `requireAdminAccountExists`, `requireAdminAuth`, `requireAdminCsrf`, and `auditAdminAction`. Only allows retry when `client.worldState === 'closed'`. Calls `client.connect()` to re-initiate the full handshake → probe → login flow.
- `SystemInfoCard.tsx`: New admin UI component added to the admin panel. Displays system overview (world name, system ID, status, initialization state, user counts, connection status). When disconnected, renders a "Re-Connect service account" button that calls the retry endpoint with proper auth and CSRF headers.
- `admin/page.tsx`: SystemInfoCard integrated into the admin dashboard layout.

---

Author: GitHub Copilot / Antigravity
Date: 2026-04-27 (proposed), 2026-04-29 (implemented)
