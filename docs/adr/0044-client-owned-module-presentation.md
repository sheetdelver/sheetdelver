# ADR-0044: Client-Owned Module Presentation

**Status:** Accepted - Implemented; automated verification and local-dev live acceptance complete
**Date:** 2026-09-21
**Related:** [ADR-0027](0027-module-sdk-standardization.md), [ADR-0040](0040-unified-player-notifications.md)

## Context

Shared chat and dice controls consumed module styles from the JSON status
payload. Function-valued styles were lost during transport, mixing module
colors with Core defaults. These controls also sit outside SurfaceHost, so
managed modules' scoped Tailwind utilities did not apply to them.

## Decision

1. Add optional `theme` and `componentStyles` exports to UIModuleManifest.
   Hydrate them from the selected module UI through the existing registry,
   not by importing server adapters or evaluating code from status JSON.
2. Overlay presentation only for the matching active system. Leave the raw
   status snapshot untouched and retain older modules' existing fallback.
   Expose the same styles at both existing client consumption paths.
3. Apply module CSS scope to host chat, chat preview portals and dice trays.
   Keep notification storage, chat visibility and dice execution Core-owned.
4. Advance SDK to 1.5.0 and ui-extension-api to 1.3.0. Other contracts remain
   unchanged. Modules adopting these exports require ui-extension-api >=1.3.0.
5. Migrate Mork Borg and Shadowdark theme exports. Do not force D&D 5e or the
   scaffold to raise their minimum when they do not use these fields.

## Related Corrections

- Mork Borg must not hide generic roll totals or private-roll placeholders.
- Mork Borg keeps its own chat-card styling, but uses Core's default tray and
  frame until a distinct module design is authored. Remove copied Shadowdark
  tray/frame overrides rather than treating their presence as intentional.
- Shared chat/tray windows are 400px wide, shrinking only to fit small screens.
  A viewport maximum alone must not replace the desktop width cap.
- Dice animation is a click-through, client-owned overlay above widgets. Portal
  it outside page stacking contexts and use the browser's manual popover layer
  where supported, with a fixed-position fallback. Size and position it against
  the visual viewport; follow panning and end a throw if its physics bounds change.
- If world, system and welcome-scene backgrounds are absent, reference the
  Foundry-hosted `ui/backgrounds/setup.webp`. Installed Foundry v13 and v14
  define this in their default page CSS, not in `game.world.background`.
  No Foundry artwork is copied into SheetDelver.
- Player-login throttling bypasses explicit development mode and counts failed
  requests only. New configurations default to five failures per IP per minute.
  Explicit settings, admin account lockout and session expiry remain unchanged.

## Release Order

Release Core first. Then pin adopting modules' CI/release tooling to that Core
tag before publishing their new packages. Their currently pinned v0.12.1 host
does not implement ui-extension-api 1.3.0. Do not publish packages with a lower
minimum or point published tooling at an unmerged feature branch.

## Verification

Focused tests cover preserved callbacks, stale-module rejection, background
precedence, successful login counting, production throttling and development
bypass. Browser checks use isolated local fixtures, never hosted Foundry or
application-runtime browser automation. The user confirmed the Mork Borg
sheet-roll visibility fix, background fallback and development login behavior.
On 2026-09-21 the user accepted the tray and mobile dice follow-ups in local dev.
Managed-package smoke tests remain a post-release check, after the module
tooling pins are updated to the supporting Core tag.

The dice viewport follow-up has client tests for visual-viewport offsets,
resize handling, fallback dimensions and listener cleanup. Isolated Chromium
checks cover real WebGL animation on desktop and an emulated iPhone, scrolling,
zooming, visible dice above a native dialog and click-through interaction.
Direct desktop/phone/tablet transitions pass in the isolated shared-tray fixture;
the reported full-page DevTools transition issue was not reproduced there.
