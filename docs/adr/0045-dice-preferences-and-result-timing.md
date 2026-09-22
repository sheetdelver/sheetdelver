# ADR-0045: Dice Preferences and Result Timing

**Status:** Accepted - Implemented; user approved for commit
**Date:** September 21, 2026
**Related:** ADR-0039, ADR-0040, ADR-0042, ADR-0044

## Context

Chat previously revealed results while dice were still moving. Independent
preview and animation consumers cannot reliably synchronize first display using
an arbitrary delay. The user requested individual result-timing control and a
broader audit of Dice So Nice options, without adopting its Foundry runtime.

The review compared Dice So Nice 6.3.1 settings and lifecycle with the installed
`@3d-dice/dice-box-threejs@0.0.12` renderer and SheetDelver's chat/dice providers.
Tagged definitions took precedence over newer online guide defaults. It found:

- Result timing needs coordinated first display, not an arbitrary timeout:
  independent chat and animation consumers otherwise reveal results too early.
- Dice So Nice distinguishes world-level immediate-chat policy from user
  preferences. SheetDelver stores these choices per browser; adopting similar
  controls does not imply account/world synchronization.
- The renderer already supports body, label, outline and edge colors. Its
  packaged surface clips cover felt, wood table, wood tray and metal independently
  of visual material, allowing bounded additions without a skin/plugin runtime.
- Speed, fonts and quality are not interchangeable colorset settings. Physics
  timestep is not playback speed; preset fonts, hardcoded antialiasing and shadow
  resolution require separate adapter work before exposing reliable controls.
- Same-message rolls already share one throw. Merging different messages,
  parsing inline HTML rolls or animating newly appended rolls needs additional
  identity, ordering and data handling, not just another preference toggle.
- Preference changes must preserve stable subscriptions; recreating providers
  or callbacks must not revive the earlier menu-triggered reconnect defect.

The selected slice uses supported renderer capabilities and existing authorized
chat delivery. It does not claim full Dice So Nice compatibility or support for
third-party extensions.

## Decision

1. Extend existing browser-local preference records: result timing, fade,
   four custom colors and surface sound. Preserve existing opt-in defaults for
   animation/audio and migrate absent/malformed fields through normalizers.
2. Default **Show results immediately** to false. One bounded queue admits a
   live ID and authorized DTO before ChatContext publishes visible messages.
   Its held IDs filter both the shared log and preview. No Core delivery or
   persistence is delayed, and system notifications remain independent.
3. Mount DicePresentationProvider above ChatProvider. ChatContext retains its
   existing listeners/read ownership and forwards hints and DTOs. The queue
   holds normalized recorded faces and IDs, not a duplicate chat-body store.
4. Release results at settlement, before linger/fade. Turning immediate display
   on releases pending results; turning it off does not re-hide them. Overflow,
   skipped/unsupported rolls and unavailable animation stay immediate. A late
   hint after a visible read skips animation, avoiding retroactive hiding.
5. Keep three throws maximum and a twelve-second loading/rolling timeout.
   Failures, resize, filtering or disabling release current valid messages.
   Updates/deletes cancel stale work before an authorized refresh. Session/world
   changes clear state; sequence IDs reject old completion callbacks. Disconnect
   clears presentation without replaying history. Preview admission allows sixty
   seconds for the bounded queue, versus ten seconds for dice create hints.
6. Preserve privacy: Self and hidden results stay chat-only; authorized blind
   rolls require explicit positive content visibility. Own-only and private
   muting narrow already authorized presentation. All roll sources use this path.
7. Add Custom body/label/edge/optional outline colors, validated as hex values,
   retaining preset choices and saved Custom values. Custom uses plain plastic,
   not arbitrary texture/script loading. Fade is a fixed 200ms disappearance
   after linger, with timer-based cleanup. Neither changes recorded results.
8. Bundle the existing renderer's wood-table, wood-tray and metal surface clips
   alongside felt, with upstream license/provenance. Load only the chosen surface
   and plastic collision clips. Surface is fixed per throw; volume/mute stay live.
9. Add a fixed local Test dice sample in Settings. No API/chat writes or implicit
   enabling; one preview at a time. Real throws take priority. Closing settings,
   reset, reduced motion, hidden tabs or session changes cancel it.

## Consequences

These are per-browser choices, not account/world synchronization or the author's
style pushed to other players. Users may see the same result at different times.
No SDK contract/version, module changes, server runtime, package dependency or
backend browser is introduced. Development-only browser fixtures remain ignored.

### Option Disposition

These boundaries record the reviewed alternatives; deferred ideas are not
unfinished requirements or promises that every option will be implemented.

| Area | Disposition and rationale |
| --- | --- |
| Result timing, fade, four custom colors, surface audio, local test throw | Implemented using the current renderer and a bounded presentation lifecycle. |
| Existing visibility, sound/volume, duration, presets, responsive sizing, low effects and reset | Retained rather than introducing competing controls or new defaults. |
| Playback speed, force, materials, bump mapping and high-DPI rendering | Prototype separately; verify forced faces, framing, resource cleanup and GPU budgets. Physics timestep/force must not be mislabeled as playback speed. |
| Fonts, texture libraries, advanced lighting, antialiasing/shadow quality and extra die models | Separate renderer/asset work; existing colorset support does not establish support for these capabilities. |
| Larger dice, custom regions, spawn position and per-die appearance | Separate framing/adapter work. Regions must follow the visual viewport; current appearance is one choice per throw. |
| Private/category/combat filters, per-actor/damage styling and result-triggered effects | Require documented authorized metadata. Filters may narrow visibility, never grant access or infer game rules from flavor text. |
| Cross-message merging, sequential same-message throws and explicit dismissal | Require queue ownership, completion ordering and keyboard-interaction design. A user preference must not raise the 24-mesh safety limit. |
| Inline HTML rolls, appended-roll updates and linked-card reveal | Require recorded-data and correlation contracts; do not evaluate message HTML, guess associations by timestamp or replay old dice. |
| Named profiles, import/export and account/world synchronization | Separate storage/product scope. Any future import must use bounded versioned data, not arbitrary script-capable packages. |
| Persistent/interactive dice, faceless hidden throws, shared effects, GM-enforced styles and effect macros | Excluded from this slice: they change interaction, privacy or local ownership, or introduce code execution rather than result presentation. |
| Inactive-tab animation, reduced-motion override, Foundry interface-volume coupling and scene-darkness coupling | Not exposed: preserve accessibility/no-replay safeguards and independent browser audio/UI ownership. |

## Verification

- Client and full unit suites, TypeScript and lint; preference normalization,
  queue admission, privacy, expiry, stale callbacks and surface audio resources.
- Isolated real-provider/browser checks: first-commit gating, synchronized
  log/preview reveal, settlement before linger/fade, immediate-setting changes,
  newer-preview ordering, open-chat suppression, delete/permission update,
  disconnect, reduced motion and Self/hidden/unsupported/own-only suppression.
- Fixed preview without chat/API writes or persistent enable changes; stable
  listener counts across settings. Moving/nonblank canvas and narrow mobile
  controls, viewport placement and Escape cleanup.
- User reviewed the result and approved committing on September 21, 2026.
  This is not an independently observed exhaustive live matrix. No hosted
  Foundry was accessed during automated verification.

## Live Acceptance

The user reported "looks good" and authorized the commit on September 21, 2026.
The scenarios below remain the regression checklist for future changes, not a
claim that every scenario was individually reported as tested.

With 3D dice enabled, compare Public tray and sheet rolls with chat open and
closed. Results should reveal on settlement; enabling immediate results should
restore the previous timing. Repeat for another player and Foundry-originated
rolls. Self/hidden results remain chat-only; only authorized recipients animate
GM/Blind results. Test Custom colors, surface audio, fade and the local preview.
Reload should preserve preferences without replaying rolls. Test mobile layout
and disabling/resetting during a throw.

## References

- [Presentation guide](../dice-presentation.md)
- [Notifications and Chat](../NOTIFICATIONS.md)
- [DSN 6.3.1 settings](https://gitlab.com/riccisi/foundryvtt-dice-so-nice/-/blob/6.3.1/module/settings/DsnSettings.js)
- [DSN preferences guide](https://riccisi.gitlab.io/foundryvtt-dice-so-nice/guide/preferences/)
- Installed `@3d-dice/dice-box-threejs@0.0.12` bundle, assets and MIT license.
