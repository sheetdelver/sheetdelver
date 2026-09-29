# ADR-0053: Player Core Appearance and Module Theme Boundaries

**Status:** Implemented and verified
**Date:** September 29, 2026
**Related:** ADR-0024, ADR-0027, ADR-0030, ADR-0039, ADR-0044, ADR-0046, ADR-0047

## Context

Player Core has no coherent appearance owner. The dashboard inherits an active
module's `theme` class strings, while its persistent HUD, chat, dice, settings,
dialogs and error states use unrelated dark defaults. Admin has a separate
light/dark system. Several shared Core components are exposed through the SDK
and accept explicit module styles. A blanket CSS theme would recolor authored
sheets and tools, or break their dashboard theme props and modal overrides.

## Decision

Player Core owns a distinct semantic dark/light palette. Dark is the default;
the choice is browser-local, independent of Admin and of world/module data, and
survives logout and reload. A player-scoped provider owns the preference and
applies uniquely named `data-sd-appearance` and `--sd-ui-*` tokens to Core
surfaces and body-mounted Core portals. It does not change the module-facing
`--background`/`--foreground` tokens or generic `data-theme` attributes.

Core pages, route fallbacks, persistent chrome, settings, shared feedback and
default SDK control styles consume these tokens. The active world artwork
remains the Core page background when present, with a palette-aware scrim;
otherwise dark uses the established blue canvas. Module actor sheets, tools,
rich document content, and their scoped CSS remain module-owned. The current
manifest `theme` object is still forwarded to module `dashboardTools`, but is
no longer the authority for Core page colors. Manifest `componentStyles` and
explicit per-component `theme` props remain authoritative over Core fallback
slots, including callback-valued styles and partial overrides. Existing SDK
components are adapted, not duplicated. Admin retains its own provider, tokens,
session boundary and notification queue.

World artwork is rendered only for an active world's login, authentication,
dashboard or logout presentation. Setup, closed and startup states clear the
background immediately, even if old world metadata remains during cleanup.
The unavailable-world screen does not wait for document/cache teardown to
show its Core canvas.

The Themes tab in player Settings and a toggle on the login card offer the
choice. A saved preference also applies to unauthenticated player routes;
the Settings dialog itself remains an authenticated dashboard control.
Core native select menus use opaque palette colors for readable options.
Cross-tab changes update the same-origin
preference. No server setting, socket message, SDK version bump or system-name
branch is introduced.

Persistent player world tools share a presentation boundary: the toolbar,
chat/dice panels, participant list, combat HUD and journals render only in the
authenticated `dashboard` connection step. Leaving that state closes their
open UI state while session/realtime providers remain mounted. This prevents
stale controls on World Closed, startup and reconnecting screens without
adding a logout or changing restoration policy. The existing server policy
revokes saved world sessions on a definitive return to Foundry setup;
automatic restoration across that transition is a separate session-lifecycle
change, distinct from recovery after a temporary outage.

## Rollout and acceptance

1. Establish the preference, palette, portal scope and reusable Core surface,
   control and state styles, with storage and precedence tests.
2. Move Core entry/dashboard/page frames, HUD/chat/dice, settings, overlays and
   state transitions onto the shared palette. Preserve overlay priority,
   keyboard/focus behavior, realtime subscriptions, chat privacy and roll data.
3. Check dark/light at desktop and narrow widths across login, dashboard,
   actor/tool fallbacks, module failure, chat/notifications/dice, journal,
   settings, shutdown/restart and modal-over-sheet. Verify a saved choice after
   reload/logout and a second tab. Inspect local-dev and packaged module CSS,
   `dashboardTools` props, partial SDK component themes and sheet-local themes.

The Combat Manager is on a separate branch. Its Core frames should adopt these
tokens when that branch is integrated with separate approval; this ADR does not
merge branches. GenericSheet's intentionally light fallback and rich journal
body are reviewed separately, not recolored by descendant selectors. Current
native journal confirmation on this branch is already replaced on the Combat
Manager branch and must be verified at integration, not independently forked.

## Verification

The player-scoped preference, early light bootstrap, Core tokens and settings
control are implemented. Core entry/dashboard chrome, route fallbacks, HUD,
chat/dice defaults, journal chrome, SDK component defaults and interruption
overlays use the shared palette without replacing module theme props. The
login appearance control and readable native select, dashboard-only world
tools, and immediate artwork clearing outside active-world states complete the
follow-up corrections. The user reviewed the rendered result and accepted the
appearance and lifecycle behavior. The full unit suite, client unit suite,
lint, TypeScript and diff whitespace checks pass. No production Foundry world
was used for automated verification.

Combat Manager integration and a separate session-restoration policy change
remain outside this ADR's scope. These do not block the verified Core
appearance rollout.
