# ADR-0050: Dice Presentation Parity

**Status:** Implemented
**Date:** September 25, 2026
**Related:** ADR-0039, ADR-0042, ADR-0045, ADR-0047

## Context

This ADR began with concurrent throws. The subsequent d2/d5 reports broadened
the work to recorded-die presentation parity. Numeric roll-rule evaluation is
addressed separately by ADR-0051; additional die geometry and visual staging
remain deferred.

The original queue admitted three authorized chat messages but mounted only its
first throw, waiting through settle and linger before the next began. A
checkpoint changed that to three independent transparent WebGL canvases. That
made short bursts overlap, but its three-renderer cap skipped later messages
and paid a separate renderer/scene cost per message. The user rejected that
architecture. Dice within one message had always shared one throw; the defect
concerns *distinct* messages.

Dice So Nice keeps a shared board renderer. Its simultaneous-roll setting
coalesces arrivals within a 400 ms window, then serializes later batches. This
is a useful resource model but does not meet the requirement that a later roll
arriving mid-flight also start without waiting. The pinned
`@3d-dice/dice-box-threejs@0.0.12` has an `add()` method, but calling it while
rolling clears the active dice and strands its completion promise. The client
must not treat that method as a safe in-flight append API.

## Decision

1. Keep one browser DiceBox, Three scene, physics world and canvas for live
   dashboard rolls. Lazily initialize it, append each admitted message's dice
   to the running world, and reuse it after the visible dice leave. Do not wait
   for an earlier throw to settle or linger before starting a later one. The
   settings preview may use its separate renderer only when no live throw is
   active; the live scene is disposed before preview begins.
2. Track each message's physical dice as a group. Pre-simulate that group,
   assign its **recorded** faces, then reset the dice before their first visible
   frame. Only dice from the same message collide with one another; separate
   messages still share the scene and tray but cannot invalidate each other's
   predicted landings. At settlement, verify the visible faces and release
   **only that group's** held chat card. Never swap a landed face. If replay
   diverges, discard that visual group and release its authoritative chat
   result. Its configured linger/fade and cleanup are otherwise group-local.
   The 3D scene never calculates an authoritative chat outcome. “Show results
   immediately” retains its override.
3. Remove the three-message cap. Bound the shared scene to 96 visible physical
   dice, including lingering dice; per-message normalization still rejects an
   unsupported or over-24-die message as a whole. A message exceeding the
   scene budget stays chat-only immediately, without a waiting line or replay.
   The 96-die bound is a browser resource guard, not a Foundry roll limit.
4. Keep create-hint plus authorized DTO admission, Self/private/blind filters,
   pre-throw recorded-face assignment, no-history replay, and reset/invalidation behavior.
   Invalidation removes only that message's dice. A renderer-wide failure
   disables the local presenter and releases every held result rather than
   leaving one hidden. Sequence IDs reject callbacks from canceled or
   previous-session throws.
5. This is a Core browser-presentation correction. It adds no Foundry socket,
   server work, module hook, SDK/API contract, dependency or automatic merge
   into the separate GM Combat Manager branch. The in-flight append adapter
   uses pinned renderer internals; its version and browser regressions must be
   reviewed before upgrading the renderer.

## Consequences and verification

One canvas replaces the checkpoint's per-message canvases. Cards appear when
their own dice settle, not after visual linger; overflow favors immediate,
authoritative chat. The adapter depends on undocumented vector, spawn and
physics state in the pinned renderer, so upgrades require explicit regression
testing or a maintained fork. Isolated browser work has confirmed four
messages sharing one renderer, including two appended mid-flight, correct
recorded faces, renderer reuse and cancellation. A 96-die burst settled in
under four seconds in that fixture with no presentation timeout. The full unit
suite, TypeScript, client lint and production build passed. The user then
reported that new dice render promptly and each chat card appears when its own
dice settle while other rolls remain in motion. The isolated fixture is not a
Foundry integration or device-performance guarantee; the user report is manual
acceptance, not an independently captured integration trace.

A later user screenshot exposed a canvas mismatch: the recorded face and chat
card agreed, but the stopped canvas could still display the pre-swap face.
Repainting revealed a second UX defect: the die visibly changed numbers after
landing. The pinned library's own predetermined-roll path pre-simulates, swaps
face labels, resets, then animates. The shared-scene adapter now does this per
message; its label-swap clone also needs the original Cannon collision shape
retained for replay. Isolated browser fixtures verify fixed d20 and mixed
d10/d20 landings, mobile overlap and a 96-die burst without late face swaps or
skipped visual groups. These are browser fixtures, not a guarantee across all
devices or future renderer versions. The user subsequently confirmed in their
own session that the dice land on the recorded values without a post-landing
number change.
