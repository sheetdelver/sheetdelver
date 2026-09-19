# ADR-0041: SDK Chat Card Roll Contract

**Status:** Accepted - Implemented; live acceptance pending
**Date:** September 18, 2026
**Supersedes:** None
**Related:** ADR-0027, ADR-0039, ADR-0040

## Context

ChatCard.rolls is a display-summary array; RollResult.rolls is serialized
evaluated Roll JSON. The card runtime forwarded summaries into native
ChatMessage.rolls despite the incompatible shapes. Its comments suggested
passing serialized rolls into the summary field, while the testing host
omitted native rolls entirely. The user approved resolving this deferred SDK
contract before considering further dice enhancements.

## Decision

1. Retain ChatCard.rolls as display-only ChatCardRoll[]. Add optional
   evaluatedRolls: string[] with the same representation as RollResult.rolls.
2. Only evaluatedRolls populate native ChatMessage.rolls. Keep the display card
   in flags.sheetDelver.chatCard without duplicating evaluatedRolls there.
3. Validate the recorded envelope before dispatch: class, formula, finite
   total, evaluated:true, and terms array. Invalid cards raise SDK validation
   errors. Preserve system-specific terms without interpreting or evaluating
   them. This is envelope validation, not full native term-schema validation.
4. Share card serialization between production and the SDK testing host.
   parseRollResult normalizes legitimate transport objects/strings to string[].
   Malformed/summary-only input retains display fields but no evaluated rolls.
5. The common chat renderer reads summary-only flags when no native roll is
   available. Native rolls take precedence, without duplicate display totals.
   Hidden content reveals neither summaries nor recorded rolls.
6. Preserve readiness, author/speaker attribution, visibility, authorized DTOs,
   realtime hints and presentation deduplication. No new transport, store,
   HTTP endpoint or module animation implementation is introduced.
7. Advance SDK_VERSION to 1.3.0 and module-api to 1.2.0 in the canonical contract
   file. Adopters require module-api >=1.2.0 <2.0.0. Existing module ranges
   continue working. Roll-engine and UI-extension contracts are unchanged.

## Usage

```ts
const result = await req.runtime.rolls.roll('1d20 + 3', 'Ability check');
await req.runtime.chat.card({
    title: 'Ability check',
    evaluatedRolls: result.rolls,
}, { rollMode: 'publicroll' });
```

Raw chat.send({ rolls: result.rolls }) remains supported. Do not post the same
roll with displayChat:true and a separate card; that creates two messages.
Summary-only cards use ordinary chat visibility, not native-roll placeholders.
Unsupported terms, Self suppression and deferred Blind animation are unchanged.
Existing checked-out modules do not call runtime.chat.card and need no source
changes. The scaffold does not use the new field and keeps its existing minimum.

## Verification

- [x] Serializer, parser, mock/real runtime and malformed-input tests.
- [x] Native card-to-chat-to-dice path and duplicate/history suppression.
- [x] Public, Self, GM and Blind projection/privacy checks.
- [x] Summary display, native precedence and hidden-content checks.
- [x] Full unit suite, TypeScript, lint, module checks and isolated build.
- [x] Existing authoring/API/dice guide updates and manifest requirement guidance.
- [ ] User live acceptance.

No hosted Foundry mutations or new dice features are part of this work.
