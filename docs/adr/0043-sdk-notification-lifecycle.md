# ADR-0043: SDK Notification Lifecycle

**Status:** Accepted - Implemented; automated verification complete, user approved commit/merge
**Date:** 2026-09-20
**Extends:** [ADR-0040](0040-unified-player-notifications.md)
**Related:** [ADR-0027](0027-module-sdk-standardization.md)

## Context

ADR-0040 intentionally left updates, progress and dismissal host-only. Modules
had an addNotification type returning void with narrower options than the actual
host. Deferred lifecycle support can reuse the existing browser-owned store;
neither a second notification queue nor ChatMessage changes are necessary.

The pre-implementation audit is recorded in
`temp/audit-reports/sdk-notification-lifecycle-2026-09-20.md`.

## Decision

1. Define notification types once in the shared SDK and expose add/update/remove
   through useSDK(). Keep the existing UseNotifications type as an alias, not
   a new public hook. Export types through the shared and React SDK entries.
2. addNotification returns an ephemeral numeric ID. updateNotification returns
   false for a missing ID. removeNotification is harmless for missing IDs.
   Existing add-only calls remain valid.
3. Expose info/success/warning/error and title, html, duration, permanent and
   progress options. The host keeps sanitization, timing, queue limits, pause,
   session cleanup and layout. Permanent notices remain user-dismissible.
4. Keep replacement keys, global clearing, snapshots and viewport controls
   host-only. This is a module API boundary, not isolation of untrusted code.
5. Forward stable host callbacks without adding socket listeners or transports.
   Notifications remain local feedback, not persisted/broadcast documents.
6. Add a state-recording fake to SDK testing. It deliberately does not simulate
   DOM, sanitization, expiry or queue policy; host tests cover those behaviors.
7. Advance SDK 1.3.0 to 1.4.0 and ui-extension-api 1.1.0 to 1.2.0 in the canonical
   contractVersions.ts. Keep module-api 1.2.0 and roll-engine-api 1.0.0.
   Adopters require ui-extension-api >=1.2.0 <2.0.0. Existing modules and
   scaffolds that do not use the addition retain their current minimums.

## Consequences

Modules can complete or dismiss one progress notice without duplicating host
machinery. They must not persist handles or resurrect cleared notices when
asynchronous operations finish after session teardown. Hand-written SDK mocks
must implement the new methods and numeric return; the provided mock does so.

No module repository changes, application version bump or release tag is part
of this implementation. Release Core after acceptance, then update modules
against that release. No backend browser dependency or Foundry connection is
introduced. This extends, rather than reopens, the completed ADR-0040.

## Verification

- Passed: `npm run test:unit`, `npm run test:client`, `npx tsc --noEmit`,
  `npm run lint`, and `git diff --check`.
- Public SDK and actual host-store tests cover lifecycle handles, progress,
  expiry, sanitization, stale IDs, testing helpers and contract compatibility.
- An isolated real-SDKProvider browser fixture passed at 1440x900, 390x844 and
  320x568. It verified add/update/remove, completion, HTML sanitization, expiry,
  disconnect/world/logout cleanup, stable callbacks and socket subscriptions.
  External requests were blocked; no Foundry connection was used.
- Desktop and mobile screenshots were inspected. Browser tooling remains a
  local development tool under `temp/`, not an application dependency.
- User approved commit/merge on 2026-09-21. Core release and module adoption
  follow separately. Admin notification unification remains a separate follow-up.
