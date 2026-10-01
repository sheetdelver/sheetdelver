# ADR-0056: Foundry Transport Recovery Without World Teardown

**Status:** Completed; verified (unit, isolated v14 service-level, operator soak)
**Date:** October 1, 2026
**Revises:** ADR-0034 (Phase 4 disconnect teardown policy)
**Related:** ADR-0023 (transport/controller ownership), ADR-0055 (server file logging)

## Context

At 2026-10-01 15:56:44 UTC, Core and one player Foundry socket reported
`transport close` within milliseconds. The Core process stayed alive and the
same world was detected again, but the world runtime was reset twice and fully
bootstrapped. The player session survived. This event does not identify whether
Foundry, a proxy, or the network closed the connection, and it does not explain
an earlier lasting logout.

The current Core socket emits two disconnect facts for one close. The world
controller immediately treats transport loss as world departure; SystemService
also resets on its `disconnect` event. CoreSocket enables Socket.IO automatic
reconnection while the controller starts a separate manual connection, leaving
callbacks bound to a mutable socket field. `getWorldStatus` maps an acknowledgement
timeout to `false`, and an ambiguous HTTP status can be classified as setup.
Entering setup invalidates world sessions. ADR-0034 tested a real world shutdown
followed by a *different* world, not a brief gap in the *same* world.

Socket.IO calls `transport close` a reconnectable transport interruption, not
a world shutdown. Its default delivery is at most once: events missed while a
client is disconnected are not replayed. [Socket instance lifecycle](https://socket.io/docs/v4/client-socket-instance/#disconnect),
[delivery guarantees](https://socket.io/docs/v4/delivery-guarantees/).

## Decision

1. The world controller remains the sole Core reconnect owner. Disable
   Socket.IO automatic reconnection on the service-account socket. A new
   connection attempt retires its prior socket, and each listener/async
   callback is bound to that socket's generation. Obsolete callbacks cannot
   change transport state or emit Foundry facts. The user-scoped socket pool
   retains its own existing connection policy.
2. A transport interruption moves lifecycle to `offline` and gates world API
   readiness, but preserves the known world ID, adapter/runtime, sessions and
   in-memory source snapshot. It is not a teardown signal. `SystemService`
   must not issue a second reset for the same disconnect.
3. The controller may declare `setup` only from affirmative Foundry setup
   evidence, not a missing/partial status, generic title, failed HTTP request,
   or socket acknowledgement timeout. An active world's unexpected setup
   report must be corroborated by a separate status observation before it
   triggers runtime teardown and session invalidation. Explicit native
   shutdown and accepted admin shutdown remain authoritative immediate paths.
4. On reconnect, compare stable world IDs and the active system identity/version
   from the accepted game-data snapshot, not page titles or ephemeral Socket.IO
   IDs. A changed world/system gets one full teardown and replacement bootstrap.
   For the same compatible world, retain the adapter
   and module runtime but reconcile all active primary-document Stores, user
   presence, and world-dependent snapshot data from Foundry before returning
   to `active`. Emit audience-safe invalidations for changed source documents
   after readiness so browser/SDK caches converge. No world-backed read or
   write is served while offline or reconciling.
5. Reconciliation is a bounded, retryable server operation. A failure leaves
   the world unavailable and preserves the prior snapshot only as internal
   recovery input; it never marks stale Stores authoritative. Epoch/generation
   guards discard results from an obsolete transport or world. Adapter
   initialization is not repeated for same-world recovery.
6. Add low-volume, allowlisted disconnect diagnostics to the existing server
   logger: socket role, local generation, connection age, transport name,
   high-level reason and bounded scalar `details.message`/`description` when
   safe. Do not log raw `details.context`, cookies, IDs, headers, URLs or
   arbitrary error objects. These facts support external Foundry/proxy log
   correlation; they cannot alone assign blame for the upstream close.

## Implementation sequence and acceptance

- Characterize one close and reconnect using fake transports: one offline
  transition, no teardown, one replacement connection, no obsolete callback
  effects, and useful bounded diagnostics.
- Make status observations explicit (`active`, `setup`, `indeterminate`).
  Timeout and malformed/partial responses remain unavailable/retryable, never
  setup. Confirm a previously active world's setup before clearing runtime or
  sessions. Preserve initial setup detection and explicit shutdown behavior.
- Introduce a same-world reconciliation path distinct from bootstrap. Verify
  changed, created, deleted and ownership-changed documents converge for the
  correct audience; no stale API reads are available during the gap. Failure
  stays unavailable and retries. A different world still clears the old
  adapter and Stores exactly once before bootstrap.
- Run focused and full automated suites in isolated data, then an approved
  disposable Foundry v14 test for transient reconnect and genuine shutdown.
  Generation 13 compatibility must remain covered by fixtures; no hosted
  world or production proxy is probed by the automated tests.

## Verification to date

On October 1, the changed-code recovery, status and reconciliation fixtures
passed. The full unit and integration suites passed in a disposable `/tmp`
source copy; lint, TypeScript, and an isolated-data production build passed.
The workspace's retained test data was not touched.

With user approval, a service-level check ran against only the disposable
Foundry v14.367 `sd-combat-probe` world on a private Unix socket. A loopback
test proxy dropped the Core and a user-scoped WebSocket and withheld upstream access
while an independent GM connection created a temporary Actor. Core reported
offline and denied readiness, but kept its runtime epoch, world ID and adapter.
After proxy recovery, Core reconciled that missed Actor and emitted its change
event without adapter reinitialization. The second `ClientSocket` reconnected
using the same authenticated session cookie. The disposable fixture had only
a GM account, so this verified the user-scoped transport but not a distinct
player-role account. The test Actor was deleted.

A genuine Foundry shutdown then delivered its native shutdown signal, moved
Core to setup and retired the runtime exactly once. Foundry v14 can return
HTTP 302 to `/setup` for a successful shutdown, with the signal arriving before
or after the HTTP response. The controller now accepts an observed native
shutdown; the transport accepts this redirect only after a separate status
probe confirms setup. Fixtures cover both confirmation paths and reject an
unrelated redirect. The test server/proxy were stopped and the temporary
license copy removed; the original license and hosted worlds were untouched.

After restarting their server, the user observed more than 20 minutes without
a world brownout or rebuild and accepted the result. This is an operator soak
observation, not a forced-disconnect browser test or proof of the upstream
closer. The isolated check was service-level, not a rendered browser/HTTP-
session smoke test; the disposable world had no distinct player-role account.
It does not prove that the older lasting logout shared the same cause.

The original lasting logout and the origin of the upstream close remain
unproven. External log correlation is operator work and is not a reason to
block the in-process recovery correction.

## Consequences

The world may be unavailable for API operations during a transient disconnect
and reconciliation, but users need not lose their session or pay for a full
module/runtime initialization. Reconciliation performs authoritative reads
because missed Socket.IO events are not replayed. Genuine world departure
continues to invalidate old authority. The new code adds no module or browser
transport contract and no secondary world-state store.
