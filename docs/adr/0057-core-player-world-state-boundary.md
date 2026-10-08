# ADR-0057: Core Player World-State Page Boundary

**Status:** Proposed — GM confirmed transient page retention; implementation pending
**Date:** October 2, 2026
**Related:** ADR-0027, ADR-0033, ADR-0034, ADR-0038, ADR-0053, ADR-0056

## Context

Core already decides player session and world readiness through
`SessionProvider`, `FoundryProvider`, `useSystemStatusRealtime`, and
`determineConnectionStep`. Only the `/` page presents all of those states:
`MainPage` renders Core loading, login, setup, world-closed and dashboard views.
`DashboardView` also renders its own “Connection Lost” overlay from
`system.status`, so even the home route has two presentation owners.
The shared `(player)/layout.tsx` mounts providers and route children but does
not gate those children or render the state views. Direct Actor and module-tool
routes can therefore mount before readiness. The Actor route and generic Actor
page redirect to `/` on HTTP 401/503; a separate `ShutdownWatcher` shows a
countdown and reloads `/` after definitive closure away from home. The GM
Combat Manager on its separate branch renders bare “Connecting to the world…”
for every non-dashboard state. These are competing page-level interpretations
of one Core state machine.

The local Shadowdark generator independently calls `/api/session/connect`,
redirects for its own world/session decision, and presents “World Starting”
from SDK `isConnected`; its Actor page redirects on 401/503. Mörk Borg and
D&D 5e local UIs have no comparable global world-state controller. Module-local
Actor, manifest and rule-shard loading are different from world readiness and
remain module-owned. The separate Admin route group has its own auth and
restart boundary; it is not a player-world route.

The broader client audit also found that Actor/Combat and chat data providers
directly clear the session marker on protected-read 401 instead of invoking
the canonical session-invalidation operation. `FoundryProvider`'s status
bootstrap and the status hook's world-change/setup purges also clear the
marker directly, bypassing registered logout cleanup and UI reset. That can
leave route cleanup dependent on a later status/socket event. The host SDK
event bus currently maps every raw `connected` transition to
`world:ready`/`world:teardown`; a brief same-world disconnect therefore emits
`world:teardown` even though ADR-0056 preserves the world, while a confirmed
world replacement that never drops `connected` emits neither signal. None of
the three current local module UIs subscribes to those signals, but their
published meaning is inaccurate in both directions. Roster-only status
refresh and full-stack supervisor restart are distinct Core mechanisms, not
competing page presenters.

Two Core page internals would also discard a mounted page during a transient
outage even if the layout kept the route mounted. `SDKProvider` derives the
SDK document-cache scope from `isConnected` (that is, `step === 'dashboard'`),
so a blip sets the scope to `null` and resets every observed document to an
empty loading snapshot. The host `createActorPage` then replaces the module
Sheet with a loading modal (unmounting it), and a module page using
`useActorSheet` can present an absent actor as deleted. Separately, the Core
Actor route re-runs its resolver whenever `token` changes, clearing and
remounting the module Actor page. Any marker flip, such as a provider 401
followed by status restoration, therefore destroys local page state.
A lost browser-to-SheetDelver connection has no presenter at all: apart from
clearing chat toasts and notifications on socket `disconnect`, nothing changes
the connection step, so the page keeps showing `dashboard` with controls that
will fail. The browser's SheetDelver socket also stops reconnecting after ten
attempts at a 2–5 second delay, so a longer outage never recovers without a
manual refresh. An announced restart (`serverRestarting`) is handled
separately: `RealtimeProvider` polls status every second until restart
readiness and then reloads the page. `ShutdownWatcher` also only recognizes
terminal transitions from
`dashboard`, `login` or `startup`; a terminal state reached through
`initializing` leaves a deep-linked page mounted without its overlay.

A process-manager stop leaves no Core listener; the browser cannot connect
until a new process listens. That does not imply world readiness at listen
time. `SystemService.initialize()` awaits its initial Foundry transport
attempt, but its connection handler starts world bootstrap asynchronously.
`src/server/index.ts` then registers sockets, starts persisted-session store
initialization in the background, and opens the HTTP/socket listener without
awaiting world bootstrap. A browser can therefore reconnect while Core's
world lifecycle is still `startup`. With no restored in-memory session,
`AppSocketGateway` admits that socket to the public status room; it has no
automatic promotion to the authenticated room later. The current `/api/status`
also reports `isAuthenticated: false` when restoration is deferred, which is
not by itself proof that the saved session was revoked.

ADR-0056 preserves server runtime and session authority across a transient
same-world transport loss. A transient gap should not unnecessarily navigate
away from an open page. Foundry remains the source of truth; unsynced local
changes are not guaranteed to survive or replay. ADR-0053 requires Core's
immediate artwork clearing for setup/closed/startup and preserves explicit
module component style overrides and module-authored sheets/tools.

## Decision

1. Core owns one player-world route boundary inside `(player)/layout.tsx`,
   below the persistent player providers and above every player route and
   persistent world-tool presentation. It consumes the existing connection
   state; it adds no independent status polling, Foundry transport, or
   module-facing world-state contract. `/` no longer uniquely owns the global
   state screens.
2. One Core presenter maps transitional states to the shared loading modal and
   login/setup/world-closed to the existing full Core views. The home route
   contributes dashboard content when ready. Module/theme-specific explicit
   `LoadingModal` styling remains authoritative over Core fallback styles;
   the shared Core background hook governs world artwork and its immediate
   retirement outside active-world presentation. The page-owned
   `DashboardView` connection-loss overlay is removed.
3. A deep-linked Actor or tool route does not mount page effects or import a
   module UI until authenticated `dashboard` readiness. Once ready, that
   route may render subject to its normal document/tool/role authorization.
   Actor 404, module-tool lookup failures, and local resource loading retain
   their own page-level presentations. They do not decide world lifecycle.
   Only a confirmed 404 presents an Actor as deleted; 403, 503, network and
   other failures present as unavailable or errored, including in
   `GenericActorPage` and the host `createActorPage`.
4. If an already mounted page enters a *transient same-world* outage, Core
   keeps its URL and mounted page, presents one blocking modal, and makes the
   underlying page inert to pointer and keyboard interaction. It does not
   navigate to `/` or destroy the page; the only page-discarding exceptions
   are the announced restart and module re-resolution in decision 5. On restored
   readiness for the same world/user scope, the overlay clears and host-backed
   data revalidates. Core/SDK must refresh observed document snapshots when
   readiness returns without resetting their authenticated scope; other page
   fetches must treat temporary `not_ready` as temporary rather than
   deleted/unauthorized.
   The SDK document-cache scope is the authenticated world/user identity, not
   momentary connectivity: a transient outage must not reset observed
   snapshots to empty data, and host-backed pages (including
   `createActorPage`) keep their last snapshot mounted behind the overlay,
   then refresh on recovery. Route resolvers must not re-resolve or remount a
   mounted page because the session marker or connection step changed;
   readiness gating belongs to the boundary alone.
   The UI cannot guarantee the outcome of an action submitted *before* the
   outage or preservation of unsynced local edits; it must not silently replay
   ambiguous writes. Foundry data wins on refresh. Page retention is an
   interruption presentation, not a replacement for normal lifecycle
   transitions: a later authoritative terminal event immediately follows
   decision 5. If an outage stays indeterminate for a prolonged interval,
   Core changes the overlay's wording to plain unavailable/check-back-later
   guidance instead of an endless ambiguous spinner. Retry ownership is split
   by link. Core alone retries Foundry (ADR-0056); the browser never drives or
   accelerates those retries. The browser reconnects only its own SheetDelver
   realtime socket: it never stops trying, backs off from a fast initial
   cadence to roughly one jittered attempt every 30 seconds, and makes one
   immediate attempt when the device comes back online or the tab becomes
   visible. Socket reconnection tests only browser-to-Core reachability; it
   does not by itself prove world readiness or session restoration. On connect,
   verify Core status. If a socket is admitted as public while a saved session
   is temporarily unverifiable, keep the page blocked. Use Core's existing
   public `systemStatus` readiness broadcasts to trigger throttled session
   rechecks, not a new fixed polling timer or a check on every 4-second
   broadcast. Once the same-world session is confirmed, re-handshake the
   socket once so it joins the authenticated room before unblocking the page.
   Confirmed invalidation instead follows decision 5. Log once when an outage
   begins and once on recovery. Expected failed connection attempts may remain
   at the configured debug level; avoid repeated warning/error-level output
   for the same outage without hiding unexpected errors. The overlay switches
   to check-back-later wording when the backoff reaches its slow phase (about
   a minute). This is temporary unavailability (HTTP 503 where an HTTP
   response is appropriate), not a missing route or resource (404). Elapsed
   time alone does not prove the world closed and does not retire the session.
   *Transient outage* covers both links, and the player does not need to know
   which failed: Core reporting a temporary loss to Foundry for the same world
   (ADR-0056), and the browser losing its realtime connection to SheetDelver
   without a restart announcement (network loss, sleep, or a Core process
   crash). Core persists Foundry sessions on disk, so a session can survive
   an unannounced Core process loss and resume. Either one denies
   interaction behind the same overlay. When the link returns, Core's status
   decides the outcome: the same world with a still-valid session resumes the
   preserved page; a different world, a closed world or an unauthenticated
   session follows decision 5.
   The boundary is read-only presentation of state that Core reports. It
   never starts world, transport, restart or session actions; recovery
   belongs to Core. Reconnecting the browser's own realtime socket is
   RealtimeProvider plumbing, not a world, Foundry or session action. The
   outage overlay offers no actions: it does not prompt the player to log
   out or to leave.
5. Definitive world close/setup, confirmed world replacement, explicit
   logout, and any same-world session loss are not transient: retire the old
   page and its world/session-bound controls. Session loss includes server
   revocation or expiry, a confirmed protected-read 401, status reporting the
   session unauthenticated on recovery, and a different user signing in. The
   GM chose retirement here, including re-login by the same user: no
   session-bound page state is promised across a new session. A world/user key
   alone cannot detect that transition. Confirmed invalidation must explicitly
   clear the retained page before a subsequent login; an implementation need
   not add a session-generation contract if this reset is reliable. A status
   response that cannot validate a persisted session during startup or restore
   retries is indeterminate, not proof of session loss. Core's
   `sessionInvalidated` realtime event (which already calls
   `invalidateLocalSession`) is the authoritative terminal signal; a
   protected-read 401 must mean the same confirmed loss, so Core must not
   answer 401 for a session it is still restoring (that is 503). Likewise,
   `/api/status` must distinguish temporarily unverifiable restoration from
   a conclusively invalid session; its current public `isAuthenticated: false`
   result during startup must not retire the page. Fold
   `ShutdownWatcher`'s terminal transition and any necessary provider reset
   into the one Core presentation owner, recognizing terminal states
   regardless of the intermediate step that preceded them.
   Do not use its delayed redirect for a same-world blip. Every Core path that
   clears the session marker (data providers, `FoundryProvider` bootstrap,
   and the status hook's world-change/setup purges) goes through one
   session-invalidation operation that runs registered cleanup; a 503 never
   clears identity. A protected-read 401 or unauthenticated status is terminal
   only when Core can distinguish revoked/expired authority from temporarily
   unverifiable restoration; ambiguous results keep the page blocked.
   An *announced* restart (`serverRestarting`) is not a transient outage. It
   is an administrator-initiated runtime replacement: Core resets the world
   bootstrapper and replaces the full stack, usually because module code
   changed, so browser bundles and providers may be stale. Its existing
   "Applying module changes" overlay keeps precedence over ordinary world
   loading and reloads the page once Core reports restart readiness; that
   reload intentionally discards the mounted page. Its recovery poll should
   back off to a low frequency after an initial fast period rather than poll
   every second indefinitely. In-place module re-resolution after a module
   source, state or registry change is likewise outside transient page
   retention. Neither is a world-lifecycle decision.
6. Remove page-owned 401/503-to-home lifecycle redirects in Core Actor
   surfaces, and remove Shadowdark's independent session/world redirect and
   “World Starting” presenter after the Core boundary is in place. Retain
   bounded module-resource retries and local loading UI. The GM Combat
   Manager drops its non-dashboard text fallback when its branch absorbs this
   change; its GM-only authorization remains in page/server policy. The SDK
   `world:ready`/`world:teardown` signals need a separate semantic check
   before declaring this unification complete: temporary connectivity belongs
   to `connection:changed`, world teardown should not imply destruction on
   every blip, and a confirmed world replacement should not pass silently. If
   that published meaning changes, update the SDK contract, tests
   (`sdk-event-bus.test.ts`), `docs/UI.md`, `docs/MODULE_MANIFEST.md` and the
   version authority accordingly; do not silently redefine it in an
   implementation patch.
7. Shadowdark's removal of its own world gate depends on the Core boundary.
   That module release must declare a minimum host version that includes
   this boundary; this is a justified requirement change, not a casual bump.
   Until the managed Shadowdark install is updated, its bundled redirect may
   still compete with Core, so acceptance covers the packaged module too.
   Module-authoring documentation states that module pages do not poll
   status, gate on world readiness or redirect on world lifecycle.

## Implementation and verification plan

1. Extract the existing state view/login composition from `MainPage` into a
   Core client boundary hosted by the player layout. Reuse `LoadingScreen`,
   `LoginView`, `SetupView`, `WorldClosedView`, and `useWorldBackground`; make
   the connection-state presentation exhaustive, including resolution of the
   currently declared but unset `reconnecting` state.
2. Implement separate cold-route and prior-ready-route policies. Cold routes
   wait to mount until ready. Prior-ready same-world routes remain mounted but
   inert during transient startup/offline; terminal transitions remove them.
   Maintain a single authoritative overlay and check focus/accessibility,
   background clearing, and full-stack restart priority. Rekey the SDK
   document-cache scope on world/user identity only, keep last snapshots
   during transient outages, and remove `token` (and any other readiness
   input) from the Core Actor route resolver's remount dependencies. Clear
   the retained page on confirmed session invalidation or a world/user change;
   do not rely on world plus user alone to detect same-user re-login. Drive
   the same overlay from the browser's realtime-socket disconnect as well as
   Core-reported Foundry loss. In `RealtimeProvider`, set unlimited
   reconnection attempts, keep the 2 s initial delay, raise the maximum delay
   to about 30 s with the default jitter, and trigger one immediate attempt on
   the browser `online` event and on `visibilitychange` to visible. Log the
   outage start and recovery once each; keep expected per-attempt diagnostics
   at the configured debug level without repeated warning/error messages.
   Do not touch Core's Foundry retry cadence. On socket reconnect, check Core
   status; if restoration is indeterminate, use existing public status
   broadcasts for throttled follow-up checks, without a separate polling
   timer. After confirmed restoration, re-handshake a socket admitted as
   public before resuming world-backed events. An unavailable or temporarily
   unverifiable response is not a logout decision. Keep the
   announced-restart reload, and back off its recovery poll (for example, to
   about 5 s after the first 30 s).
3. Remove competing Core Actor redirects and terminal `ShutdownWatcher`
   presentation after its reset semantics have been preserved. On the module
   migration, remove Shadowdark's world-state checks; do not require changes
   to Mörk Borg or D&D 5e unless acceptance exposes a host error-projection
   defect. Keep module-specific loading and theme ownership intact.
   Route every direct session-marker clear (data providers, `FoundryProvider`
   bootstrap, status-hook world-change/setup purges) through the existing
   session-invalidation authority, and test that 503 cannot partially log out
   a user. Treat `sessionInvalidated` as the terminal signal, and verify on
   the server that protected routes return 503, not 401, while Core is still
   restoring a persisted session; `/api/status` must also avoid a conclusive
   unauthenticated result in that state. Fix those projections if needed.
   Check the SDK world/connection signals against ADR-0056 before changing their
   published semantics. Set the Shadowdark release's minimum
   host version and update module-authoring documentation.
4. Test direct navigation and refresh of home, Actor, Core tool, and module
   tool URLs through initialization, login, readiness, transient same-world
   loss/recovery, logout, definitive close, world switch, and full-stack
   restart. Assert that the URL and mounted page remain through a transient
   path, underlying controls cannot be used while blocked,
   Foundry-refreshed values remain authoritative, and no stale Actor is
   presented as deleted because of 503. Test a prolonged indeterminate
   outage separately: show unavailable/check-back-later guidance with no
   logout or leave prompt, without classifying time alone as world closure
   or retiring the session. Exercise both outage links: Core reporting
   Foundry loss, and the browser losing its SheetDelver connection
   (including an unannounced Core process crash and an outage longer than
   ten reconnect attempts). On return, same world plus valid session resumes
   the page; anything else follows decision 5. Verify that reconnects back
   off to the slow cadence, that coming back online or making the tab
   visible triggers an immediate attempt, and that a long outage produces no
   repeated console warnings while configured debug diagnostics remain
   available. Test a process-manager-style stop/start: no connection while
   Core is stopped; a socket admitted to the public room after listen but
   before world/session readiness remains blocked, rechecks on later status
   broadcasts, then re-handshakes into the authenticated room before resuming.
   Verify that an announced restart still shows its overlay and reloads on
   readiness.
   Assert that a hosted Sheet (`createActorPage`, e.g. D&D 5e) and a module
   `useActorSheet` page (e.g. Mörk Borg) do not present "deleted" for an
   unavailable Actor. Do not assert preservation of unsynced form changes.
   Assert that confirmed session revocation, expiry, unauthorized status and a
   different-user login each retire the old session page, including re-login
   as the same user. Test temporary inability to validate a persisted session
   separately: it must not cause logout. Test terminal states reached
   through `initializing` and other intermediate steps, and a world
   replacement that never drops `connected`. Record that an announced
   restart and module re-resolution may discard local edits by design. Verify desktop/narrow, dark/light,
   world artwork clearing, explicit module modal styles, and both local-dev
   and packaged module surfaces. Use isolated data/Foundry only; do not probe
   a hosted world merely for this test.
   Add a regression guard against module-side global status polling/redirects
   so future tool pages cannot recreate the same independent handler.

The audit that led to this proposal also found no player route outside `/`,
`/actors/[id]`, and `/tools/[systemId]/[toolId]` on current `main`. The Combat
Manager route exists on an unmerged feature branch. The Admin route group is
separate and remains outside this player boundary.
