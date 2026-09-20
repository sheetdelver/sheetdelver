# ADR-0042: Dice Presentation and Formula Follow-ups

**Status:** Accepted - Implemented; user live confirmation received
**Date:** September 19, 2026
**Supersedes:** ADR-0039 blanket blind/nested suppression only
**Related:** ADR-0039, ADR-0040, ADR-0041

## Context

The initial presenter deliberately excluded every blind roll and all nested
terms. Core already projects authorized native chat contents, while Foundry
13.351 and 14.367 serialize recorded child Rolls for pools, parentheses and
functions. Neither gap requires another transport or module animation API.

The user approved an audit-first follow-up, separately from notification SDK
lifecycle work. The audit is retained locally under
`temp/audit-reports/dice-presentation-followups-audit-2026-09-19.md`; this ADR
records the durable decision and acceptance status.

## Decision

1. Admit blind dice only when the authorized ChatMessage DTO explicitly has
   `isContentVisible: true`. Never infer access from a browser role, a raw
   document, a summary total or the absence of a false visibility flag.
   Core authorization and placeholder redaction remain unchanged.
2. Preserve Self as chat-only. Author-only whispers identify Self only when
   non-blind; a GM's sole-recipient blind roll remains eligible. Blind rolls
   are private for sound muting, and Only My Rolls continues to filter by author.
3. Traverse only recorded Roll terms and the known child fields:
   PoolTerm.rolls, ParentheticalTerm.roll and FunctionTerm.rolls. Accept native
   DicePool/MathTerm aliases only with the same recorded-child shape. Require
   evaluated child Rolls and containers; never parse formulas or execute functions.
4. Include serialized Roll.dice as retained inner dice. This field corresponds
   to native `_dice`, not the runtime getter's aggregate of all dice. Do not
   crawl arbitrary object fields or deduplicate by equal recorded values.
5. Retain standard d4/d6/d8/d10/d12/d20 and paired d100 conversion. Display all
   recorded results, including discarded dice/pool branches; chat determines
   which count. Preserve renderer grouping and forced-face ordering.
6. Bound input to 10 root Rolls, 100 terms/retained dice per Roll, 100 child
   Rolls per container, 16 child-Roll nesting levels (root depth zero), 1,000
   visited Roll/term/die-result records, and 24 physical dice across the message.
   Reject cycles, missing/invalid children, unsupported terms or exceeded limits
   as a whole. No partial animation or substitute faces.
7. Keep existing live create-hint admission, authorized reads, queue limits,
   preferences, cleanup and no-history/no-reconnect replay. The renderer remains
   browser-only. This presentation change adds no new endpoint, module hook or
   SDK contract. The separately approved host evaluator follow-up is below.

### Tray Interaction Follow-up (September 20)

The shared tray and compatibility dialog remain open after sending or rolling.
Outside clicks do not dismiss the dice tray; Escape and explicit close controls
do. Existing session reset and explicit tool-switch behavior remains intact.
This changes panel lifetime, not formula clearing. The shared notification/chat
viewport measures either tray variant and moves above it, bounds long stacks to
the remaining height, and restores the ordinary HUD offset after closing.

### Host Formula Follow-up (September 20)

Live testing exposed a pre-existing distinction: the presenter could display
native nested rolls, but the host's flat-expression evaluator silently returned
zero for the same input formulas. The user approved continuing host evaluation.

Dice So Nice's ordinary integration animates already evaluated Foundry Roll
data. Its synchronization API starts animations, not remote evaluation. No
supported browser-free evaluation endpoint was found in the reviewed Foundry
paths. Requiring another open Foundry client or a backend browser remains out
of scope.

Replace the shared flat evaluator with the established
`@dice-roller/rpg-dice-roller@5.5.1` parser/evaluator and a narrow host adapter.
A scoped `mathjs@15.2.0` override avoids its vulnerable declared mathjs 14
range. Production audit and our formula/serialization tests verify this
combination. Remove the override only after a compatible patched upstream range.

The [presentation guide](../dice-presentation.md#host-formula-evaluation) records
the exact supported grammar and resource limits. Validation precedes rolling;
unsupported modifiers cannot run unbounded reroll/explosion loops. Preserve
the existing Roll JSON contract and recorded faces, including native retained
dice for reduced arithmetic/function intermediates. Errors propagate to the
caller without posting any fallback chat message, especially for private rolls.
The public chat endpoint returns HTTP 400 for invalid formulas. No SDK bump
or module implementation is required.

## Consequences

All existing roll sources share the improvement: tray, actor APIs, SDK chat and
Foundry-originated ChatMessages. Modules do not need migration or flattening.
Normal blind rolls target GMs; explicitly addressed messages follow Core's
existing recipient policy, not a new presenter-specific GM rule.

Fate/Coin/custom dice, formula-only containers and unknown terms remain
chat-only. Extensible skins and notification SDK lifecycle APIs stay deferred.
The host input grammar is broadened only by the explicit evaluator follow-up
above; support is not claimed for every native or system-defined formula.

## Verification

- [x] Synthetic fixtures based on reviewed v13/v14 serialization contracts;
  fixtures are not claimed as captured live data or copies of upstream code.
- [x] Nested pools/parentheses/functions, retained dice, legacy aliases,
  discarded results, percentiles and forced-face grouping.
- [x] Invalid children, unsupported classes, cycles, exact depth/node boundaries
  and whole-message physical-dice limits.
- [x] Server projection through presentation for player author, GM, assistant,
  unlisted GM and explicit private recipient. Hidden payloads reveal no secrets.
- [x] Self suppression, private muting, author filter and duplicate/history/
  reconnect behavior.
- [x] Full isolated unit suite, TypeScript no-emit and repository lint.
- [x] Local-only real-provider/renderer checks at 1440x900 and 390x844, 150% size:
  public and authorized blind nested dice settle to 2, 5, 17, 40, 2; moving and
  nonblank canvas, no dice pixels on viewport border, no browser errors or
  external requests. Hidden blind and Self messages produce no canvas.
- [x] Host formulas: deterministic bounds/totals, signed expressions, keep/pool
  results, retained dice, idempotence and RNG restoration; invalid inputs fail
  before chat dispatch through every roll mode.
- [x] Nested formulas through chat, sheet-client and SDK paths; no new transport.
- [x] Local real-component desktop/mobile tray clearance, viewport resizing,
  long feedback, repeated Send, Escape, and restored HUD placement.
- [x] User confirmed the formula and tray follow-up works as expected on
  September 20, 2026, after the requested live retest.

Local visual harnesses stay ignored under `temp/`, using an already-installed
external Playwright tool. Browser automation is not an application dependency
or a backend runtime. No hosted Foundry operations were used for verification.

## Live Acceptance

The user reported "confirmed all working as expected" on September 20, 2026.
The scenarios below remain the regression checklist for subsequent changes;
the report is user confirmation, not an independently observed live test matrix.

With 3D dice enabled, test Public and GM rolls as before; Blind should animate
only for an authorized result recipient and remain hidden from the non-GM
author. Self remains chat-only. Disable Only My Rolls on the receiving client
when testing another author's rolls. Private sounds remain muted by default.

In a local Foundry chat, test `/r {1d6,1d8}kh`, `/r (1d6 + 2) * 2`,
`/r max(1d6,1d8)` and `/r {1d100,1d20}kh`. Compare individual recorded faces
with chat details rather than comparing their sum to a pool/function total.
Reload/reconnect must not replay them. Repeat the formulas from SheetDelver's
tray, leaving it open: the latest chat preview should appear above it. An
invalid formula such as `/r 1 / 0` must show an error rather than a zero roll.

## References

- [Dice So Nice Roll API](https://riccisi.gitlab.io/foundryvtt-dice-so-nice/api/roll/)
- [RPG Dice Roller](https://dice-roller.github.io/documentation/guide/)

- [Foundry PoolTerm](https://foundryvtt.com/api/classes/foundry.dice.terms.PoolTerm.html)
- [Foundry FunctionTerm](https://foundryvtt.com/api/classes/foundry.dice.terms.FunctionTerm.html)
- [Foundry ChatMessage](https://foundryvtt.com/api/classes/foundry.documents.ChatMessage.html)
- [Presentation guide](../dice-presentation.md)
