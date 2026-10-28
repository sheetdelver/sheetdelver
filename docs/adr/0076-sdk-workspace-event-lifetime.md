# ADR-0076: SDK events survive module-page navigation

**Status:** Completed — automated verification and operator navigation acceptance passed
**Date:** 2026-10-27

---

## Problem and evidence

Every `SurfaceHost` mounted its own `SDKProvider`, which created, attached and
disposed an SDK event bus. Tool → dashboard → tool therefore replaced the public
`events` object and removed module listeners while the tool was closed. Shadowdark
catalogs keyed to that object could not survive real navigation. The initial module
fixture kept a synthetic event bus alive and did not reproduce this host boundary;
its passing request-count checks were insufficient evidence of a navigation fix.

An isolated reproduction using the actual Core SurfaceHost/SDKProvider observed
zero socket subscriptions and zero delivered invalidations while on the dashboard,
then a different event identity on return. Persistent compendium HIT logs were
server-cache reuse, not proof of browser catalog reuse.

## Decision and boundaries

- `SDKEventsProvider` lives within the persistent `PlayerProviders` layout and
  owns one SDK event bus per authenticated workspace scope. The existing name
  “player” distinguishes the Foundry-facing application from server administration;
  this workspace serves both GMs and ordinary players.
- Page-level SDKProviders consume its stable public `on` facade. Transport binding,
  detachment and disposal stay private to Core's client UI. Modules still use only
  public SDK APIs. No server orchestration, module rules, raw socket exposure or
  UI/server import boundary moves.
- The scope includes authentication presence, the SessionContext epoch, world,
  user identity, role/GM state and system identity. Scope changes create a distinct
  event owner; logout/relogin as the same user is covered by the session epoch.
  Retired socket handlers detach in layout cleanup before paint. Disposing their
  listeners after the synchronous Strict Mode effect replay prevents a development
  replay from deleting subscriptions belonging to the current owner.
- Ordinary navigation preserves bus identity and its one socket subscription,
  including when no module page is mounted. Replacing the socket rebinds that
  owner. Application teardown releases it. No polling or additional handshake.
- Event audiences, server authorization, permission projections, cookies and
  request transports are unchanged. The owner does not broaden event visibility.
  It does not preserve or share catalog data across authenticated scopes; modules
  remain responsible for their own scope-aware cache invalidation.
- Public SDK/API signatures and versions remain unchanged: this repairs the
  lifetime of the existing signal service. Core remains0.22.2, SDK3.8.0,
  module-api1.7.0 and UI API3.6.0. No module minimum is raised. Older Core versions
  can run the module but do not supply this navigation-lifetime correction.

## Verification

`src/tests/acceptance/sdk-event-lifetime.browser.mjs` mounts the real PlayerProviders,
SurfaceHost, SDKProvider and event owner with fixture context/socket boundaries.
It checks navigation reuse, a single socket subscription, invalidation while no
surface is mounted, a public facade exposing only `on`, Strict Mode replay,
user/role/world changes, logout/login, same-user session-epoch replacement and
final cleanup. No live server or Foundry session is involved.

A local composition with Shadowdark's actual `useToolCatalog` confirms zero
additional catalog fetches on revisits and fresh reads after off-page invalidation.
Core client unit tests, typing, targeted lint, ADR metadata validation and whitespace
checks passed. Socket replacement retains the active owner and leaves no listener
on the old socket. The user confirmed that the cache persists across navigation
on 2026-10-27. This closes the navigation acceptance gate; session-security
evidence remains the automated checks described above.

## Release disposition

Include this correction in the next user-prepared Core point release. No SDK/API
version bump or module compatibility change is required. Implementation leaves
Core package metadata at0.22.2 and SDK/API versions unchanged; the normal release
workflow owns the eventual application patch version and publication.
