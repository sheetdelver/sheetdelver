# ADR-0051: Bounded Foundry Numeric Roll Rules

**Status:** Implemented
**Date:** September 25, 2026
**Amended:** September 28, 2026
**Related:** ADR-0039, ADR-0042, ADR-0050

## Context

SheetDelver's server-only evaluator accepted arithmetic, pools/functions and
keep-high/keep-low but rejected common built-in Foundry `Die` modifiers. A GM
could use `/r 4d6dl1`, `/r 1d6r1`, `/r 2d6x6` or `/r 4d6cs>=5` in Foundry,
yet those formulas failed through SheetDelver's tray, actor and SDK roll paths.
Foundry-originated rolls already arrive evaluated and must not be re-evaluated.
The 3D UI animates authorized recorded faces only; it is not a rules engine.

The existing `@dice-roller/rpg-dice-roller` expression library has similarly
named modifiers, but some have different meanings: its `cs` marks a critical
face, whereas Foundry's `cs` counts successes toward the total. Translating
modifier text directly to library syntax would risk incorrect totals and
serialization. [Foundry's modifier guide](https://foundryvtt.com/article/dice-modifiers/)
and [DiceTermResult interface](https://foundryvtt.com/api/interfaces/foundry.dice.DiceTermResult.html)
are the public behavior/data references; isolated native results are required
to confirm edge cases before completion.

## Decision

1. Extend the existing bounded server-only `Roll` adapter for **standard
   numeric Die** modifiers: keep/drop high/low; min/max contribution; reroll
   once/recursive; explode recursive/once/capped; success/failure and even/odd
   counts; deduct/subtract failures; and margin of success/failure. Preserve
   modifier order and original recorded face values, with Foundry-style
   `active`, `discarded`, `rerolled`, `exploded`, `count`, `success` and `failure`
   fields. Apply Foundry-style keep/drop and success/failure counts to supported
   roll pools too, preserving source modifier order and per-entry flags. Native
   v14.367 counts zero successes/failures when `cs`/`cf` omit the target,
   despite the prose guide describing defaults. SheetDelver-originated rolls
   reject these ambiguous targetless forms with an explicit-threshold error;
   Foundry-originated evaluated results remain untouched. The
   authoritative total uses contributions, not a second 3D roll.
2. Continue using the library for bounded arithmetic, groups and functions,
   but parse/execute numeric Die modifiers independently. Do not rely on
   similarly named library modifiers where their semantics differ. Preserve
   nested Roll/Pool serialization and retained dice so chat presentation and
   SDK consumers receive the recorded outcomes they already expect.
3. Keep the 256-character, 16-level, 128-term, 100-initial-dice-per-term,
   1,000,000-face and numeric bounds. Cap **all physical results**, including
   rerolls/explosions, at 1,000 per formula. A bound hit is a rejected roll:
   no successful zero and no chat write. Keep the existing 24-die browser
   animation cap separate; an over-limit animation remains a normal chat roll.
4. Scope this to Foundry's built-in numeric dice and the existing bounded pool
   grammar; nested pools are not accepted by the current expression parser.
   Coin, Fate, arbitrary system terms, data references, interactive/manual dice and custom modifiers remain
   unsupported by SheetDelver-originated `/r`; Foundry-originated evaluated
   messages are unaffected. No open Foundry browser, backend browser, new
   socket, system-name special case, module hook or SDK contract is introduced.
5. Defer visual staging of rerolls/explosions and additional geometry/labels
   to the separate presentation follow-up. The browser may show all recorded
   faces together but must never calculate or replace the authoritative total.

## Verification gate

Use deterministic result-sequence tests for each modifier family, combinations,
ties, nested pools/functions, serialization and result-budget failure. Test the
shared tray/actor/SDK/chat paths and private-roll behavior. Compare a bounded
matrix with native Foundry v14 in the approved disposable local world. Run the
full unit suite, TypeScript, changed-file lint and build; no hosted Foundry probe.

## Verification result

The approved isolated Foundry v14.367 browser evaluated 33 deterministic
formulas in memory with controlled die faces. Before the September 28
target-required decision, Core matched native totals, per-die result flags and
pool-result flags for all 33. The matrix covers d2/d5,
keep/drop and ties, min/max, bounded and recursive rerolls/explosions,
success/failure/even/odd counts, deductions, margins, ordered pool modifiers,
and a function expression. It exposed the omitted-`cs`/`cf` target behavior.
The user subsequently chose not to enshrine that version-specific zero as a
SheetDelver rule: the 29 explicit/supported fixtures retain their evaluated
behavior; four targetless fixtures are intentionally rejected by SheetDelver.
New local tests verify targetless Die and Pool formulas fail before rolling or
creating chat, with a clear error across tray, actor and SDK paths. No second
native instance run was needed for this validation-only boundary change.
The read-only browser fixture is local under ignored `temp/audit-tests/`.
The full unit suite, TypeScript, changed-file lint and production build passed
again after the September 28 target-required correction. No Foundry service was
started for that follow-up. The earlier disposable server and loopback proxy
were stopped, and the temporary license copy was removed. No world or chat
documents were written;
no hosted instance was contacted. This verifies the selected bounded subset,
not every formula or system-defined term Foundry can evaluate.

## Consequences

This broadens the Core host formula subset but does not make it a complete
Foundry runtime. More formulas can now post correct recorded dice through the
same visibility and chat boundary. A rule/serialization mismatch must fail
closed or remain explicitly unsupported; visual parity is a separate concern.
