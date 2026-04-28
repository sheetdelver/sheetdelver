# ADR-0005: World Availability and Service Account Failure Handling

## Status
Proposed

## Context

Previously, if the configured service account was missing from the active Foundry world, the backend would repeatedly attempt to connect, leaving the application in an indefinite "initializing" state. End users would see a stuck or ambiguous startup screen, and only logs would indicate the underlying issue. This approach exposed technical details to users and did not provide a clear operational recovery path for administrators.

## Decision

- When the service account is missing, the backend will set the world state to a generic `closed` or `unavailable` state, halting further automatic retries.
- End users will see the standard "World Closed" or "World Not Available" screen, with no mention of service accounts or technical details.
- Admins and logs will surface the specific service account error and available users, with remediation steps.
- A manual retry mechanism will be added to the admin backend, allowing administrators to trigger a new connection/bootstrap attempt after resolving the issue (e.g., after adding the service account in Foundry).

## Consequences

- End users are shielded from technical errors and see a clear, familiar UI when the world is unavailable.
- Admins have actionable diagnostics and a recovery workflow.
- The system avoids unnecessary retry loops and provides a more robust operational experience.
- This change is tracked for future audits and reference.

## Implementation Steps

1. Update backend (CoreSocket) to set a generic `closed` state and halt retries if the service account is missing.
2. Update status payloads and client UI to display the "World Closed" screen for this state.
3. Log the error and available users for admin diagnostics.
4. Add a manual retry endpoint and admin UI button to trigger reconnection/bootstrap after remediation.

---

Author: GitHub Copilot
Date: 2026-04-27
