# ADR-0065: Player startup and current module styles

**Status:** Implemented — operator confirmed startup/style fixes; checkpoint approved
**Date:** October 20, 2026
**Related:** ADR-0027, ADR-0033, ADR-0057

## Observed failure

On Core 0.19.5 (`f195246a`), reloading a player page opened two authenticated
Socket.IO connections, read the user roster twice, and repeated Actor, combat
and chat reads. The browser remained on initializing/authenticating screens
after the initial HTTP page response had already completed.

Separately, a locally edited module could display new UI code against an old
stylesheet. The asset route used `public, max-age=3600` at a URL whose contents
change when local files change or the selected package changes. The initial
module presentation tests disabled browser caching, so they missed that case.
Passing those isolated fixtures did not establish correct operator behavior.

These are separate from the Mörk Borg catalog consumer treating every healthy
connection heartbeat as an invalidation. That module-owned correction and its
visual restoration belong to Mörk Borg ADR-0002. No migration, service-account,
native-rule or release-workflow change is part of this Core correction.

## Decisions and implementation

1. Keep an already authenticated browser transport when protected cookie
   validation restores the client-only session marker. `RealtimeContext`
   distinguishes that restoration from login, logout and revocation. A socket
   admitted to the public audience still requires an authenticated handshake;
   a 401 still retires authority. Explicit logout does not compete with a
   background authentication attempt.
2. `useSystemStatusRealtime` reconciles the last received status immediately
   when cookie verification changes readiness. No subsequent heartbeat is
   required to show the dashboard. The status snapshot remains presentation
   input, never authorization.
3. `FoundryProvider` owns initial/reconnect Actor and combat reads;
   `ChatProvider` owns its chat read. Status and combat subscription hooks do
   not initiate duplicate startup reads. Actual invalidations retain the
   trailing-read behavior needed when a document changes during a request.
4. The module asset route sends `Cache-Control: no-cache`: stable asset URLs
   must revalidate before reuse. Conditional HTTP reads may still return 304.
   Declared and compiled stylesheet links include the selected source in their
   URL. This also bypasses the unqualified URLs cached by earlier releases.
   The query is a cache identity, not source-selection authority; Core still
   serves only the registry-selected, confined asset path.
5. `LoadingScreen` preserves horizontal centering when overriding the spinner
   for world startup and compendium warmup. Both overrides include `mx-auto`;
   module themes with a block container retain their existing appearance.

No public contract, dependency or application/module version is changed. This
does not eliminate the required session check on a real browser reload, nor
does it add polling, persistent player snapshots or a second authentication
system.

## Verification and practical limits

`src/tests/acceptance/player-startup-assets.mjs` mounts the actual Session,
Realtime, ActorCombat, Chat and Foundry providers. It uses real Socket.IO and the
real module asset router on a temporary loopback server, with a synthetic world
and user. Peripheral UI and the module registry contents are fixtures. Browser
HTTP caching stays enabled, without Playwright route interception.

Before correction, the browser failed readiness without another heartbeat,
made duplicate reads, and retained stale CSS. After correction, the run verifies:

- One cold/restored socket, one protected user read and one read per collection.
- Immediate dashboard readiness without another periodic status message.
- Stable healthy heartbeats and one refresh per collection after reconnect.
- Logout/login, public-to-authenticated admission and protected-401 retirement.
- Repeated page reloads without accumulating redundant connections.
- Bypass of previously hour-cached CSS, current local CSS after ordinary
  navigation, and managed/local source switching through the actual UI loader.

The first corrected controlled run reached ready in 132 ms. That number is an
isolated measurement, not a production latency guarantee. The route unit suite
also asserts revalidation for both source categories.

Reproduce using an existing external development Playwright installation:

```sh
SD_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node --import tsx src/tests/acceptance/player-startup-assets.mjs
npm run test:unit
npm run test:integration
npx tsc --noEmit
npm run lint
```

The browser test creates and closes its own server/browser and data directory;
it does not read operator credentials or connect to Foundry. No native rules
acceptance is claimed or needed for these client/cache changes. The user confirmed
that the running-instance startup/style fixes corrected the reported problems
and authorized a local checkpoint. Push and publication remain separate actions.

The subsequent left-aligned startup spinner report reproduced with the actual
`LoadingScreen`, `LoadingModal` and module themes. Replacing the theme spinner
classes had dropped their horizontal auto margins. Before the correction,
Mörk Borg and Shadowdark spinners were 88–140px left of their container center;
the default flex layout was already centered. After restoring `mx-auto`, all
12 combinations of startup/warmup, default/Mörk Borg/Shadowdark and 360/1280px
were centered exactly. Mobile and desktop captures were visually checked.
This isolated component check used compiled CSS and no Foundry connection;
operator confirmation of this final alignment refinement remains separate.
