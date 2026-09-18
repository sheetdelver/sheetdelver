# ADR-0039: Shared Client Dice Presentation

**Status:** Implemented
**Date:** September 18, 2026
**Supersedes:** None
**Related:** ADR-0011, ADR-0012, ADR-0013, ADR-0027

---

## Context

SheetDelver already evaluates and persists rolls through Core and exposes
authorized chat projections to players. Animated dice should present those
recorded outcomes regardless of whether a roll originated in the dice tray,
an actor sheet, a module SDK call, or Foundry itself. Implementing animation in
each module would duplicate lifecycle, settings, and privacy handling.

The desired experience does not require loading Dice So Nice or other Foundry
plugins. It must not require an open Foundry browser, a backend headless browser,
or moving rules evaluation into the player UI.

## Decision

### Host-Owned Presentation

Mount one `DicePresentationProvider` in the player provider tree, not in admin
or individual modules. Pair existing `chatMessageChanged` create hints with
authorized `ChatContext.messages` reads. Events remain invalidations, not a
transport for raw rolls. No additional Foundry connection or presentation API
is introduced.

Normalize evaluated standard die terms into recorded faces and force those
faces in the renderer. Core and the existing API/SDK remain responsible for
evaluation, totals, permissions, and persistence. Physics controls appearance
only; no simulated result is written back. Chat remains immediately usable
when presentation is disabled, unsupported, or unavailable.

Modules continue using host roll APIs, host SDK components, and server runtime
roll/chat surfaces. A silent `runtime.rolls.roll` result can be posted through
`runtime.chat.send` with its serialized `rolls`. A formula or total alone is
not sufficient to reconstruct an animation. No SDK contract version changes
are needed for this feature.

### Visibility at the Chat Boundary

Core distinguishes message existence from result visibility. Roll changes
may broadcast document ID/action refresh hints, while the chat feed returns
either authorized content or an allowlisted placeholder containing only
identity, author display name, timestamp, roll status, and empty content/rolls.
Hidden formula, flavor, speaker, flags, and recorded faces are not included.
Ordinary private text remains restricted without public placeholders.

This changes the chat projection and event audience, not the raw document
Store ownership contract. Browser filters only narrow already-authorized
presentation; they are not access controls.

Self rolls remain chat-only, including for their author. Other viewers receive
the private-roll placeholder. GM/whisper rolls can animate for authorized
viewers. Blind rolls are deliberately chat-only for everyone in this first
implementation, including authorized GMs. Non-GM blind authors receive no roll
result in the chat write acknowledgement.

### Browser Renderer and Lifecycle

Use the MIT-licensed `@3d-dice/dice-box-threejs` package, pinned to `0.0.12`,
lazy-loaded in the browser. Its Three.js/Cannon simulation is presentation
only. Bundle the selected sound clips, marble texture, and upstream license
under `public/dice/`; no external runtime asset requests are required.

Support d4, d6, d8, d10, d12, d20, and percentile tens/ones pairs for d100.
Display recorded discarded dice too; authoritative chat explains which count.
Reject unsupported or malformed rolls as a whole rather than inventing faces
or presenting a partial result. Cap visible meshes at 24 and queued throws at
three; bound and deduplicate pending live message hints. History reads do not
animate. A 12-second timeout bounds loading/rolling failures.

Session/world changes, disconnects, deletion/update invalidations, disabling,
and hidden/reduced-motion states cancel applicable work. Resize ends the current
throw. Dispose WebGL resources, audio, listeners, and timers on teardown,
including resources allocated after a cancelled asynchronous initialization.
Disable the upstream resize registration and correct its cached d4 result after
forcing a face. These adaptations require regression checks before upgrading
the renderer pin.

### Player Settings and Chat Notifications

Place the bottom-menu Settings shell in `components/Settings/` and dice UI in
`components/Dice/`. Chat & Rolls contains active settings; General and Themes
are disabled placeholders. Preferences are browser-local, not account or
device synchronized. Animation and sound default off. Offer five style presets,
75-150% sizing, volume, own-roll filtering, settled duration, low effects, and
private-roll muting. Reset dice leaves chat preferences unchanged.

Reuse the existing notification provider for one replaceable latest-message
toast while chat is closed. It has an author title, plain-text body, and a
bottom-right position above the menu. Chat remains the permanent log. Duration
is configurable from 1-15 seconds, default five; toasts default on. Sanitize
markup before decoding text, preserve private placeholders, and never replay
history, edits, or reconnect backlog. Dismissal/unmount releases notification
timers. Opening chat, logout, disconnect, and disabling clear the current toast.

## Consequences

- All supported persisted rolls share one UI path; modules do not own 3D dice.
- Presentation failure cannot change gameplay, privacy decisions, or totals.
- WebGL/physics adds an optional lazy client cost, not a server browser service.
- Native-equivalent Dice So Nice plugins, themes, and all roll term types are
  not promised. Browser playback policies can suppress sound until interaction.
- The renderer has no destroy API, so host cleanup and forced-face compatibility
  require targeted tests. Its dependency is deliberately pinned.
- Stable UI cleanup callbacks are necessary to avoid reconnecting the realtime
  provider when menus/settings change; the implementation includes that fix.

## Verification

- Unit coverage: recorded-face normalization and grouping, percentile pairs,
  invalid/unsupported input, bounded queues, deduplication, preferences, audio,
  renderer disposal, and stable UI reset callbacks.
- Server coverage: private chat visibility and redaction, skinny roll event
  audiences, and common tray/actor-client/SDK roll-to-chat presentation paths
  using mocked transports. These are not production HTTP acceptance tests.
- Local-only browser checks: desktop/mobile rendering, movement, forced faces,
  canvas pixel/framing checks, local assets, settings focus/overflow, chat toast
  delivery, privacy, duration, persistence, and session teardown.
- User acceptance: live Foundry and SheetDelver public rolls, another browser's
  public rolls, Shadowdark sheet rolls, sound/preferences, Self suppression,
  and chat notifications. No module implementation changes were required.
- TypeScript, ESLint, and the isolated unit suite are closeout gates. Browser
  test tools remain outside the application dependency/runtime graph.

## Deferred Work

- A cohesive Foundry-style notification system is separate post-merge work;
  this change reuses the existing provider rather than replacing it.
- Blind-roll animations for authorized GMs, nested/unsupported roll terms,
  and extensible skin packs remain future work.
- `ChatCard.rolls` currently describes summary entries, while `RollResult.rolls`
  contains serialized evaluated terms. Aligning that existing SDK contract and
  its documentation is a separate follow-up. Summary-only cards are not treated
  as animatable rolls; use `chat.send` with serialized terms for this path.

See [3D Dice Presentation](../dice-presentation.md) for settings and operational
limits.
