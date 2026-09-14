# ADR-0036: Managed Module Runtime Restart Boundary

**Status:** Accepted - Implemented.
**Date:** September 14, 2026
**Supersedes:** None
**Revises:** ADR-0029 (runtime hot-reload conclusion), ADR-0035 (managed release activation)
**Related:** ADR-0017, ADR-0027, ADR-0030, ADR-0035

---

## Context

Runtime module adapters may build synchronous projections from hydrated
compendiums during `initialize(runtime)`. Registry discovery previously
initialized adapters before world bootstrap hydrated those packs, then
`WorldBootstrapper` initialized the same instance again. A cold managed
install could therefore cache an empty projection while a development checkout
appeared healthy because its persistent cache was already warm.

ADR-0029 concluded that module install and upgrade could hot-reload without a
restart. That is not a safe executable-code boundary. Registry refresh can
replace the adapter instance while requests are active, but only world bootstrap
owns the ordering needed to hydrate packs, seed primary documents, construct the
runtime, and initialize the adapter.

## Decision

`WorldBootstrapper` is the sole owner of adapter runtime initialization.
Registry resolution imports, validates, instantiates, and caches adapters, but
never calls `initialize`.

Runtime-affecting admin operations use a supervised restart boundary:

- enable and disable
- local/managed source switching
- source-targeted enable persists as one operation, including when switching from a disabled source
- managed install, upgrade, and uninstall
- archive, direct-release, and catalog install or upgrade

After a successful mutation, Core marks the active world runtime unready,
notifies clients that a restart is beginning, flushes the success response, and
signals the process manager with `SIGUSR2`. The manager stops and awaits both
Core and the application shell before launching a new pair. Core receives the
manager PID through `SHEET_DELVER_MANAGER_PID`; exit code 75 remains the
fallback for direct Core launches or an unavailable manager.
On platforms with process-group support, each service tree is isolated so
package-runner and watch-wrapper descendants are terminated with their parent.

The explicit signal is required in development because `tsx watch` is the
manager's child while Core is its grandchild. A Core exit does not reliably
propagate through the persistent watch wrapper. Protected world routes return
503 while the old runtime drains and while the new process bootstraps. Dry-runs,
release inspection, validation, and policy edits do not restart the service.

Server adapter mtime hot-reload is removed. Local UI development may continue to
use the application shell's development refresh behavior, but changes to server
adapter logic require a development service restart.

Player clients receiving `serverRestarting` display a maintenance state and poll
the public status endpoint. They hard-reload only after the replacement runtime
reports both connected and initialized, so stale module bundles and partially
initialized adapters cannot survive the boundary.

Admin sessions remain process-bound during ordinary starts, but a successful
supervised restart writes a two-minute, single-use handoff under
`<DATA_DIR>/security`. The handoff contains only one-way opaque-token digests
and server-side claims in an owner-only file; it never stores the browser's
cookie value. The replacement Core consumes and deletes the file, rebinds valid
claims to its instance, and lets the admin shell recover its CSRF token through
`/admin/auth/me`. Malformed, expired, or absent handoffs restore nothing, so a
cold or unplanned restart continues to invalidate every admin session.

Protected player sessions persist across the supervised restart, but Foundry
remains authoritative over their lifetime. Foundry v13 and v14 implement both
Ban and the first half of Kick by assigning the affected User the `NONE` role;
Kick then immediately restores the prior role. When Sheet Delver observes the
`NONE` transition, it retires matching session authority, removes the
protected restore credential, and notifies the browser before awaiting upstream
logout. It must not rebind or restore that session after Kick restores the prior
role. Other role changes continue to rebind the Foundry user socket so
authorization changes take effect without requiring a manual logout and login.
Best-effort upstream teardown uses an authenticated `GET /join`, the v13 and
v14 route that removes the current world assignment; `POST /logout` is not a
Foundry endpoint.

## Required Startup Order

1. Accept the Foundry bootstrap snapshot.
2. Seed world, user, and compendium-pack metadata.
3. Hydrate the active module's declared compendium packs.
4. Seed primary document stores.
5. Create the module runtime and initialize the active adapter once.
6. Mark the world runtime ready and serve protected requests.

## Consequences

- Cold managed installs and warm development checkouts follow the same adapter
  initialization order.
- No request can observe a newly installed but uninitialized adapter.
- Module mutations briefly interrupt player traffic and reload clients after recovery.
- Active admin sessions remain authenticated across a successful supervised
  restart; cold and unplanned restarts still invalidate admin sessions.
- Development and production restart the complete Core/Next generation rather
  than leaving Next proxying indefinitely to a stopped Core process.
- Failed mutations do not restart or drain an otherwise healthy runtime.
- Adapter developers restart `npm run dev` after changing server logic.
- A Foundry Kick or Ban invalidates the corresponding Sheet Delver session and
  cannot be undone by restart restoration or Kick's immediate role restoration.

## Verification

- Registry resolution tests assert that `initialize` is not called.
- World bootstrap tests assert hydration precedes one initialization per epoch.
- Readiness middleware tests assert an unready world runtime returns 503.
- Admin route tests assert restart requests use the injected supervisor boundary.
- Restart contract tests assert managed Core launches signal the supervisor and
  direct or stale-manager launches retain the exit-code fallback.
- Admin-session tests assert the supervised handoff omits opaque credentials,
  is consumed once, expires after two minutes, and does not alter cold-restart
  invalidation.
- Session lifecycle tests assert a `NONE` role transition revokes before the
  prior role can be restored and never reconnects the retired transport.
