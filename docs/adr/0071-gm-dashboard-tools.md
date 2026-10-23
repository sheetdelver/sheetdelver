# ADR-0071: Module dashboard placement and HUD consistency

**Status:** Implemented — isolated verification passed; operator review pending
**Date:** 2026-10-23

## Problem and scope

Shadowdark's Bestiary belongs beside Combat Manager in GM Tools, but the public
UI manifest puts every module action in the general Tools section. The same
review identified a black die icon in the floating HUD and a misaligned Combat
Manager link beside Show roster. These are Core-owned presentation surfaces.
Settings-tab extension planning is separate in ADR0072; it is not implemented here.

## Decision

Add optional `section: 'tools' | 'gm'` to ModuleDashboardAction (tool and dialog).
Omitted means Tools, preserving existing manifests. Invalid values are rejected,
not silently shown to players. Existing ID, label, count and target validation
still applies. Core keeps ownership of headings, cards and theme styling.

The existing GM/Assistant role gate (role >=3) hosts GM module cards in the same
grid as Combat Manager. The general Tools section excludes them. Dialogs stay
lazy and under SurfaceHost, with the SDK context/error boundary/module scope.
Role loss removes the GM section and any open GM dialog. Tool route and server
permissions remain independent: section placement is not an authorization rule.
No new API permission or hardcoded Shadowdark routing is introduced.

SDK3.6.0 and ui-extension-api3.4.0 identify this additive contract; other API
versions and application release metadata stay unchanged. A module requiring
placement must require UI>=3.4.0. A module using placement as an enhancement can
retain an older compatible floor: old Core ignores the new field and continues
showing the action under Tools. Shadowdark deliberately uses this fallback and
a structurally compatible action declaration so its released-Core CI still
compiles; it moves into GM Tools when hosted by this updated Core. Its existing
caller-bound Bestiary data access rules are unchanged on either host.

The floating D20 uses the existing SVG as a CSS mask with currentColor, so active,
inactive, dark and light states follow the same button palette as adjacent icons.
The Combat HUD uses inline-flex centering for its shared button/link class; native
anchor baseline layout no longer differs from the neighboring roster button.

## Verification

Action-contract tests pass for old/default and explicit placement, malformed
values, GM tool/dialog support and cards without nested headings. Client suite,
SDK integrity, root TypeScript, targeted application lint and ADR metadata checks
pass. Shadowdark presentation and explicit module typing pass.

An isolated browser mounts the actual DashboardView, SystemTools, FloatingHUD and
CombatHUDView with controlled providers/registry and the real compiled CSS. It
verifies GM/Assistant placement, player exclusion, role demotion removing an open
lazy GM dialog, dark/light active/inactive icon color, and equal combat link/button
height and text centering. Dark/light screenshots were inspected. The fixture
retains a Suspense boundary but does not test the full live SurfaceHost transport.
No live Foundry connection, hosted session acceptance or installed archive test
is claimed. No user/world data changed; operator review remains pending.

## Release and review

Changelog entries only; no application/module release version bump. User owns
commit/push/merge/publication unless separately authorized. Operator review pending.
