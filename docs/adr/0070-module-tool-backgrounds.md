# ADR-0070: Shared player and module page backgrounds

Status: Complete — implementation verified and operator accepted; publication pending
Date: 2026-10-22

## Problem

On Core0.20.0 (`560f26e0`), ready tool routes had no world-background host.
Shadowdark0.9.6 additionally painted opaque neutral page canvases, so generator,
importer and bestiary gutters differed from the character-sheet surroundings.
This is a presentation correction, separate from the completed ADR0067–0069 work.
Shadowdark's owning record is its ADR0003, finding SD-UI13.

## Decision

Core's `(player)/layout.tsx` hosts one `PlayerPageBackground` around the world
boundary and all route content. It is the sole consumer of `useWorldBackground`;
page navigation does not instantiate another image loader. Dashboard, combat
manager and lifecycle screens no longer load or style world artwork individually.
A future route inherits the canvas without importing a background hook.

Shared `.sd-ui-page` CSS consumes the layout's image and owns sizing, positioning,
repeat, viewport attachment and color fallback. SDK `SurfaceHost` applies that
class to `actorPage` and `tools` roots, inside module scope and outside Suspense.
`ToolPageRouter` includes its registry-loading and missing-tool states there.
Module dialogs/cards keep their existing opaque content styling; they are not
page canvases. Admin retains its separate appearance/lifecycle.

This replaces the initial tool-only wrapper after the user explicitly requested
one universal rule, including SDK-hosted modules. Paper panels, controls and
module-owned artwork remain the module's responsibility.

The canvas precedence is:

1. Successfully loaded current-world background artwork, using Core's existing
   scrim and lifecycle checks in `useWorldBackground`. Every player page canvas uses
   viewport-fixed `cover` sizing, preserving aspect ratio without scaling to the
   height of a long page.
2. Optional module CSS color `--sd-module-page-background`, declared on the
   module's scoped root. This is a CSS color, not an image or Tailwind class.
3. The current player appearance's `--sd-ui-canvas` color.

Player pages omit Foundry's generic setup-image fallback. Missing, broken or
still-loading artwork exposes the selected color. World replacement or teardown
retires old artwork immediately; cancelled image callbacks cannot restore it.
Only the shared layout consumes the hook; no page-specific fallback remains.

Modules leave their outer sheet/tool canvas transparent and retain opaque panels where
readability requires them. Existing `theme.bg` classes are not reinterpreted as
this opt-in color: doing so would change existing module appearance implicitly.
Shadowdark does not declare a custom canvas color, so its default remains the
requested Core theme color. Authors choosing a color also own contrasting tool
content. No new browser request, private module import, server cache, manifest
field, SDK function, dependency or version bump is introduced.

## Verification

`src/tests/acceptance/module-tool-backgrounds.browser.mjs` mounts the actual tool
router, shared player canvas, dashboard, combat access view, SurfaceHost,
background hook and Core CSS with a controlled registry,
world and SDK provider; dashboard data content is a fixture. All browser network requests are blocked. With
`--baseline`, the pre-correction HEAD fails because registry loading has no tool
canvas. Corrected checks cover loading/ready/error, dark/light colors, optional
module color, world artwork, broken artwork, absence of setup-image substitution,
and world retirement. Dashboard, combat, module sheets and a new unstyled route
inherit the same image without another loader. A follow-up user report exposed page-height-based cover
zoom: the nonuniform-image regression failed before viewport anchoring and now
passes for short/5000px/scrolled content at1280px and390px widths. Screenshot
comparison allows minor Chromium edge dithering after scroll. Run with existing
external browser tooling:

```sh
SD_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs SD_CHROME=/path/to/chromium node src/tests/acceptance/module-tool-backgrounds.browser.mjs
```

Final `npm run test:client` and `npx tsc --noEmit` passed. `module:check` passed with the updated Core
and Shadowdark in an isolated copy: types, compatibility, scoped CSS and all three
dry bundles. Shadowdark owns its seven desktop/mobile/error rendered checks.
These are controlled browser results, not live Foundry/operator acceptance.
The user verified the final universal behavior and authorized local checkpoints
on2026-10-22. Push, merge and point-release publication are user-owned; release
metadata remains unchanged. This closes ADR0070 implementation, not the remaining
Shadowdark ADR0003 review.
