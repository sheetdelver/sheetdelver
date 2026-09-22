# ADR-0045: Dice Preferences and Result Timing

**Status:** Accepted - Implemented; user approved for commit
**Date:** September 21, 2026
**Related:** ADR-0039, ADR-0040, ADR-0042, ADR-0044

## Context

Chat previously revealed results while dice were still moving. Independent
preview and animation consumers cannot reliably synchronize first display using
an arbitrary delay. The user requested individual result-timing control and a
broader audit of Dice So Nice options, without adopting its Foundry runtime.

The detailed local audit is retained in
`temp/audit-reports/dice-preferences-requirements-2026-09-21.md`. It distinguishes
timing, appearance, surface audio, rendering quality, profiles, filters and
interactive-tabletop features. The selected slice uses supported capabilities
of the existing renderer; this is not full Dice So Nice compatibility.

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

Speed, materials, advanced lighting, inline/newly-appended rolls, profiles,
custom regions, per-die styling, shared effects and interactive tabletop dice
remain separately scoped. The audit records why each is deferred or excluded;
this implementation does not imply they are impossible or all desirable.

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
