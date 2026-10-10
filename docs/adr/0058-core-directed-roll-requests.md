# ADR-0058: Core Directed Roll Requests

**Status:** Deferred — second pass after ADR-0049 ships; design review before
implementation
**Date:** October 8, 2026
**Related:** ADR-0013, ADR-0028, ADR-0039, ADR-0040, ADR-0049, ADR-0052,
ADR-0057

## Context

The GM Combat Manager needs to ask selected players to roll initiative,
including systems whose initiative is chosen by the GM for an encounter. The
same action is useful outside combat. Core already owns chat, dice
presentation, user-scoped realtime delivery and the player world-state
boundary. A browser notification alone is not durable, and the current
system-module initiative modals derive their own formulas from an Actor; they
cannot be assumed to honor a formula selected by the GM. A system module must
not import Core's private services or open a direct Foundry connection to
implement this flow.

ADR-0049 ships first with GM-entered and GM-rolled initiative only; its
addendum A1 (players rolling their own characters' initiative) is deferred to
this ADR so that requests, prompts and their UI widgets are designed once.
Until this ADR is accepted, the CombatHUD stays view-only for managed
encounters.

## Proposed decision

1. Add a Core GM Tools page for **Request Roll** and a reusable Core request
   composer/player response component. The Combat Manager opens the same
   composer with encounter and Combatant context, including a "Request
   player rolls" action for eligible rows. The standalone tool produces a
   roll result but does not change a Combat; a Combat-linked successful
   response can set initiative through the manager's guarded command path.
   Both entry points require role-4 Gamemaster authority to create or cancel
   requests. Browser card visibility is not authorization.
2. A request selects one or more target users, an optional world Actor, a
   short label and a formula: by default the one ADR-0049 A8 resolves, or a
   bounded custom formula chosen by the GM. For a Combat-linked request,
   targets must be visible, unrolled Combatants whose world Actors the
   receiving players own; hidden Combatants are not player targets, and
   compendium copies (created with `default: 0` ownership) are not
   player-rollable unless a GM grants ownership. One request exists per
   Combatant. When a character has several player owners, every owner sees
   it and the first valid response wins; the others see it answered. A
   request has explicit pending, answered and cancelled states; duplicate or
   stale responses are refused. The GM may leave initiative for a row to
   manual entry instead of sending a request.
3. The formula is validated and resolved on the server, including any
   permitted Actor references. The player sees that exact formula and may
   invoke Core's shared dice roll or enter a clearly labelled, bounded
   **final total**. The player cannot submit a replacement expression,
   modifier or audience. Advantage/disadvantage is offered only where
   ADR-0049 A8 permits it for that formula. The server rechecks the request,
   target identity, Actor ownership and hidden state where applicable, and
   Combat state immediately before accepting a response, under the
   encounter lock, preserving current-Combatant identity after reordering.
   One shared Core component serves every request; module `rollModal`
   implementations remain available for their own module-owned flows, and a
   directed Core request does not pass a custom formula into a modal that
   recomputes it.
4. SheetDelver owns the request queue: pending state lives in a Core-owned,
   durable record, not in a ChatMessage (a GM clearing the chat log, pruning
   or deleting a card would otherwise silently drop requests, and a player
   cannot update a GM-authored card). Chat receives only the executed roll,
   through the existing roller as a GM ↔ player roll visible to that player
   and GMs, not to other players; a manual final total is marked as manually
   entered. For Combat-linked requests the marked Combat's flag (under its
   own key, written under the encounter lock) is the candidate carrier, with
   the caveat that Foundry lets players read Combat flags, so labels and
   formulas there are not secret. The standalone carrier is open. Do not
   create a browser-local request database or an unscoped socket event.
5. The player prompt mounts under the shared player-world boundary on any
   page. A managed encounter keeps Foundry's `active` bit false until Begin,
   so the prompt is driven by a narrow player-scoped projection containing
   only the request label and the caller's own non-hidden rows, allowing
   rolls before Begin without showing players the roster. A transient
   same-world outage retains the page but disables action; after recovery it
   refetches pending requests. Dismissal ("Later") hides the modal locally
   but does not cancel the request, and a small pending-request control
   reopens it; multiple encounters keep their state distinct by Combat and
   Combatant ID. World replacement, logout, a cancelled request and an
   accepted response retire it. Realtime messages are hints to refetch
   server-authorized state, not sources of request authority.
6. The standalone tool and Combat Manager share the request/response contract,
   validation and components. Combat-specific ownership, round state and
   initiative update stay in Combat Manager orchestration. Reroll, Clear,
   Reset, batch rolls and turn controls stay GM-only; player turn advancement
   ("End turn") needs its own decision. This is a Core application
   capability; no system-module SDK contract is changed merely to deliver it.
   Any later module-facing request API needs separate versioned review.

## Verification before acceptance

- Requests survive Core restart and a cleared Foundry chat log; only the
  target and GMs see the executed roll card through Foundry and SheetDelver,
  and unrelated players receive neither payload nor realtime hint.
- Test default-formula, custom-formula and final-total responses, reconnect
  and dismissal/reopen, multiple target users and multiple owners of one
  character, duplicate reply, cancellation, stale Combatant/ownership
  changes, hidden row rejection, rejected arbitrary formulas and modifiers,
  and pre-Begin visibility limited to the player's own rows.
- Confirm a Combat-linked result updates exactly one unrolled Combatant while
  a standalone result only posts its private roll card. Test partial failure
  if chat creation succeeds but Combatant update fails; do not claim the
  initiative was applied in that case.
- Keep GM and player components in the Core dark/light palette and under the
  shared world boundary. Do not use native browser alert/confirm/prompt.

## Open implementation details

- Choose the standalone request carrier and confirm the Combat-flag carrier
  in disposable v13/v14 worlds.
- Decide expiry: Combat-linked requests end when the row is rolled or
  removed or the encounter completes; standalone requests need GM cancel and
  a bounded lifetime with a visible "Expired" state. An unanswered request
  must not nag a player forever or silently disappear.
- Settle the final-total bounds (range and decimal precision; some systems
  add fractional tie-breakers) and the manual-result card wording.
