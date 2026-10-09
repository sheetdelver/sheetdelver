# ADR-0058: Core Directed Roll Requests

**Status:** Proposed — design review before implementation
**Date:** October 8, 2026
**Related:** ADR-0013, ADR-0028, ADR-0039, ADR-0040, ADR-0049, ADR-0052, ADR-0057

## Context

The GM Combat Manager needs to ask selected players to roll initiative, including
systems whose initiative is chosen by the GM for an encounter. The same action is
useful outside combat. Core already owns chat, dice presentation, user-scoped
realtime delivery and the player world-state boundary. A browser notification
alone is not durable, and the current system-module initiative modals derive
their own formulas from an Actor; they cannot be assumed to honor a formula
selected by the GM. A system module must not import Core's private services or
open a direct Foundry connection to implement this flow.

## Proposed decision

1. Add a Core GM Tools page for **Request Roll** and a reusable Core request
   composer/player response component. The Combat Manager opens the same
   composer with encounter and Combatant context. The standalone tool produces
   a roll result but does not change a Combat; a Combat-linked successful
   response can set initiative through the manager's guarded command path.
   Both entry points require role-4 Gamemaster authority to create or cancel
   requests. Browser card visibility is not authorization.
2. A request selects one or more target users, an optional world Actor, a
   short label and a bounded formula. For a Combat-linked request, targets
   must be visible, unrolled Combatants whose world Actors the receiving
   players own; hidden Combatants are not player targets. One request identity
   per target/Combatant prevents two recipients racing to answer the same
   row. A request has explicit pending, answered and cancelled states;
   duplicate or stale responses are refused. The GM may leave initiative for
   a row to manual entry instead of sending a request.
3. The GM-selected formula is validated and resolved on the server, including
   any permitted Actor references. The player sees that exact formula and may
   invoke Core's shared dice roll or enter a clearly labelled **final total**.
   The player cannot submit a replacement expression, modifier or audience.
   The server rechecks the request, target identity, Actor ownership where
   applicable, and Combat state immediately before accepting a response.
   Existing module `rollModal` implementations remain available for their
   own module-owned flows; a directed Core request does not pass a custom
   formula into a modal that recomputes it.
4. The GM's request and the player's response appear as private Foundry chat
   cards visible to that player and GMs, not to other players. The user
   explicitly accepted this audience. Use the existing ChatMessage Store,
   repository, visibility rules and realtime bridge; do not create a browser-
   local request database or an unscoped socket event. A marked ChatMessage
   is a candidate durable request carrier, subject to isolated v13/v14
   verification of whisper delivery, creation rights, flags and restart
   behavior before fixing the persistence contract. If that probe fails,
   choose another Core-owned durable carrier without weakening audience or
   relying on a connected Foundry GM browser.
5. The player prompt mounts under the shared player-world boundary on any
   page. A transient same-world outage retains the page but disables action;
   after recovery it refetches pending requests. Dismissal hides the modal
   locally but does not cancel the request, and a private chat card or small
   pending-request control reopens it. World replacement, logout, cancelled
   request and an accepted response retire it. Realtime messages are hints to
   refetch server-authorized state, not sources of request authority.
6. The standalone tool and Combat Manager share the request/response contract,
   validation and components. Combat-specific ownership, round state and
   initiative update stay in Combat Manager orchestration. This is a Core
   application capability; no system-module SDK contract is changed merely
   to deliver it. Any later module-facing request API needs separate versioned
   review.

## Verification before acceptance

- Probe private request and response ChatMessages in disposable Foundry v13
  and v14 worlds: only the target and GMs see them through Foundry and
  SheetDelver; unrelated players receive neither payload nor realtime hint.
- Test no-formula/manual and custom-formula dice responses, reconnect and
  dismissal/reopen, multiple target users, duplicate reply, cancellation,
  stale Combatant/ownership changes, hidden row rejection, and Core restart.
- Confirm a Combat-linked result updates exactly one unrolled Combatant while
  a standalone result only posts its private roll card. Test partial failure
  if chat creation succeeds but Combatant update fails; do not claim the
  initiative was applied in that case.
- Keep GM and player components in the Core dark/light palette and under the
  shared world boundary. Do not use native browser alert/confirm/prompt.

## Open implementation details

- Verify whether a flagged private ChatMessage alone is a sound pending-state
  carrier or whether the request needs another durable Core-owned record.
  Private card visibility is settled; carrier selection is not.
- Decide a bounded expiry/cancellation policy and the precise manual-result
  card wording after the carrier probe. An unanswered request must not nag a
  player forever or silently disappear without a visible state transition.
