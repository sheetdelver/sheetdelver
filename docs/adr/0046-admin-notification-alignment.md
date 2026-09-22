# ADR-0046: Admin Notification Alignment

**Status:** Accepted - Implemented; user visually verified
**Date:** September 21, 2026
**Related:** ADR-0040, ADR-0043

## Context

Player and SDK notifications already share a bounded browser-owned queue.
Admin retained an independent toast implementation with unbounded entries,
untracked timers, no pause/update/progress lifecycle and a fixed-width top-right
stack. It survived the transition to the login form, allowing old asynchronous
operations to add feedback after logout or a later login.

The deferred admin audit reviewed providers, authentication, maintenance and all
three transient feedback consumers. Detailed validation, dry-run reports and
login/setup errors are contextual and should remain inline. The audit is retained
locally at `temp/audit-reports/admin-notification-alignment-2026-09-21.md`.
This work follows the merged dice PR on a separate branch; dice behavior is not
part of this decision.

## Decision

1. Replace AdminToastContext with the existing NotificationProvider/Container
   and NotificationStore. Admin and player mount separate instances; they share
   implementation, not queues, credentials or session ownership.
2. Use a host-only admin placement option: bottom-right, one-rem safe-area
   gutter, bounded width/height and scrollable long stacks. Preserve player
   placement and dice-tray clearance as the default. Reuse severity styling,
   titles, dismissal, accessible status/alert roles and queue/timer semantics.
3. Keep the stable NotificationSystem host entry point as the only permitted
   admin import from client UI. Architecture tests review its dependency graph
   explicitly. No player session, socket, Foundry, Chat, Dice or SDK providers
   enter the admin route tree; no server imports enter notification rendering.
4. Expose add/update/remove through an admin lifecycle hook. The auth owner
   maintains a local session revision, advanced synchronously on clear or
   replacement, not routine validation. The maintenance owner exposes a
   synchronous restart guard. Captured callbacks check both guards and mounting
   before touching the shared store. Credentials are not notification IDs,
   rendered keys or new persisted data.
5. Clear notices on logout, observed expiry, replacement, maintenance and
   teardown. Callbacks from a retired scope cannot create, update or dismiss
   feedback in a new session, including relogin as the same admin. An ignored
   add returns 0, an ID never issued by the store; ignored updates return false.
   Stable callbacks and valid notices survive unrelated renders/navigation.
6. Migrate catalog source actions, module lock/pin controls and catalog operation
   feedback. Preserve literal server errors. Keep detailed reports and validation
   inline; do not invent progress percentages for simple requests.
7. Runtime-changing module operations show the existing maintenance overlay,
   without first announcing success. Clear transient notices when maintenance
   begins, keep the overlay above the feedback viewport, and do not replay them
   after reload. Process supervision, polling and server operations are unchanged.

## Consequences

Admin gains the existing three-visible/twenty-queued bounds, five-second default
lifetime, hover/focus/hidden-tab pauses, update/progress and dismiss-all behavior
without maintaining another notification system. Titles and severity appearance
are consistent across admin and player; admin light/dark themes retain readable
shared severity colors.

The session guard governs feedback, not cancellation of server operations or a
replacement for authentication. It reacts when existing auth handling observes
expiry. The implementation adds no transport, document store, dependency, SDK
contract/version change or module migration. Browser automation remains an
isolated development check, never part of the application runtime.

## Verification

- Client/full unit suites, TypeScript and lint passed, including shared queue semantics, admin scoped callbacks and
  architecture isolation. Pure guard construction does not invoke its predicate.
- Real admin-provider browser fixture with mocked endpoints: stable callbacks,
  routine validation, logout, expiry, same-admin relogin, session replacement,
  maintenance, teardown and a delayed source-test completion after relogin.
- Source test/CRUD, literal errors, lock/pin feedback, inline dry-run blockers,
  installation success without restart and maintenance without duplicate success.
- Queue bounds, add/update/progress/remove, dismissal, hover/focus/hidden pause;
  desktop, 390px and 320px screenshots in both admin themes, long-message wrapping
  and bottom gutter. Player tray clearance, resize, Send and Escape regressions
  pass in the isolated player fixture.
- No hosted Foundry access or actual authentication, installs or restarts were
  performed by these browser checks. The user confirmed notifications look good
  in both the isolated preview and `npm run dev` on September 22, 2026. This is
  visual acceptance, not a claim that every lifecycle scenario was tested live.

## Live Acceptance

Visual acceptance was reported on September 22, 2026. The following remains the
regression checklist for future changes, not an exhaustive user-reported matrix.

Test a catalog source in admin and inspect success/error feedback in both themes
and a narrow viewport. Dismiss individual notices and a stack. On a disposable
managed module, confirm lock/unlock and pin feedback still matches the operation.
Log out with a notice visible: it must disappear and stay gone after relogin.
At the next planned runtime-changing module operation, confirm that maintenance
is authoritative and no old success notice reappears after reload. Existing form
and dry-run errors must remain inline.

## References

- [Notifications and Chat](../NOTIFICATIONS.md#admin-feedback)
- [Architecture](../architecture.md#41-react-contexts)
- [Player notifications](0040-unified-player-notifications.md)
- [SDK notification lifecycle](0043-sdk-notification-lifecycle.md)
