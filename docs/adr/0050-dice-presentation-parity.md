# ADR-0050: Dice Presentation Parity

**Status:** Proposed — concurrent portion implemented locally; die mechanics under audit
**Date:** September 25, 2026
**Related:** ADR-0039, ADR-0042, ADR-0045, ADR-0047

## Context

This ADR began with concurrent throws. The subsequent d2/d5 reports broadened
the work to recorded-die presentation parity. The concurrent-throw decision
below is implemented but uncommitted; support for additional die denominations
and mechanics remains under audit and is not decided by this text.

The existing dice queue could admit three authorized chat messages, but the
provider mounted only its first throw. A later message waited for the previous
renderer to settle and finish its 0.5–5-second linger/fade before its own dice
started. This made a burst of distinct player or GM rolls look sequential and
delayed their cards when result timing was set to wait for dice. Dice within a
single message already share one renderer throw; they are not this defect.

## Decision

1. Mount every admitted message throw concurrently in the browser. Each keeps
   its own message ID, sequence, renderer, sound, settlement and completion
   callbacks. Settling one throw releases **only its own** held chat result,
   immediately; its linger/fade continues without blocking another throw.
   “Show results immediately” retains its existing override.
2. Bound active presentation to three throws and 24 total physical dice across
   all visible canvases, including settled dice still lingering. A message that
   would exceed either bound remains chat-only immediately; it is not put in a
   waiting line or replayed when capacity opens. Per-message normalization
   still rejects an unsupported or over-24-die message as a whole.
3. Keep create-hint plus authorized DTO admission, Self/private/blind filters,
   recorded-face forcing, no-history replay, and reset/invalidation behavior.
   A renderer-wide failure disables the local presenter and releases every
   held result rather than leaving one hidden. Sequence IDs reject callbacks
   from canceled or previous-session throws.
4. This is a Core browser-presentation correction. It adds no Foundry socket,
   server work, module hook, SDK/API contract, dependency or automatic merge
   into the separate GM Combat Manager branch.

## Consequences and verification

Distinct messages can animate at the same time, potentially with overlapping
transparent canvases and independent collision audio. The combined dice cap
limits GPU/physics pressure; overflow favors immediate, authoritative chat.
Cards appear at each throw's settlement, not after the dice disappear. Client
tests cover concurrent admission, per-message settlement and capacity. The
full unit suite, standalone TypeScript, changed-file lint and Next production
build passed. In an isolated local browser fixture, two distinct-player rolls
showed overlapping moving dice on desktop and 390px mobile, forced their
recorded faces, released both chat cards and disposed their canvases without
external requests or page errors. This fixture is not a Foundry integration or
user acceptance test; cancellation/privacy remain guarded by existing client
regressions and the unchanged admission boundary.
