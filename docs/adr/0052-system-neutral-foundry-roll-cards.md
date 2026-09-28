# ADR-0052: System-Neutral Foundry Roll Cards

**Status:** Implemented
**Date:** September 28, 2026
**Related:** ADR-0039, ADR-0041, ADR-0051

## Context

Core evaluates SheetDelver-originated rolls on the server and serializes an
evaluated Foundry base `Roll`. Foundry v14 reconstructs the serialized class and
auto-renders a roll only when ChatMessage content contains no HTML element. A
system may replace `CONFIG.Dice.rolls` with its own subclass and style a
different card template. In the isolated Shadowdark setup, a base `Roll` card
and the system's CSS conflict: the formula fills the row and the total is out
of view. The serialized `total` was present, and SheetDelver's own chat showed
it correctly. This is a Foundry-side rendering mismatch, not lost roll data.

The server-only Core evaluator cannot know the active browser's Roll subclass
or execute its client-side template. Naming a system class in Core would be
incorrect for other systems. A native client command bridge remains a separate
architectural investigation, not a prerequisite for showing a result.

## Decision

Core-authored roll messages include a small HTML element containing the escaped
formula and authoritative total, using Foundry's generic `dice-roll`,
`dice-formula`, and `dice-total` classes without the system-specific
`dice-result` layout. Foundry keeps element content rather than replacing it
with the base Roll template. The evaluated Roll JSON remains attached and
unchanged for native roll semantics, integrations, and SheetDelver's own dice
presentation. SheetDelver's chat renderer already hides embedded `dice-roll`
content when it renders the same result from the roll data, preventing a
duplicate card. Private/blind visibility remains governed by the existing
ChatMessage and projection rules.

The generic Foundry card deliberately does not mimic a system's roll-specific
tooltip or action controls. Foundry-originated roll cards are untouched. A
future native-browser bridge could offer exact system card rendering, but no
system-name switch, browser dependency, module contract, or new socket is added
for this correction.

## Verification

Mocked tray, actor, and SDK roll paths assert that the outgoing message has
both visible content and evaluated Roll JSON. Comparison operators are HTML
escaped. Existing private-roll projection tests verify hidden results stay
redacted. The full unit suite, TypeScript and lint checks passed. In a
disposable Foundry v14.367 Shadowdark world, the exact Core-authored payload
was persisted as a public ChatMessage. Its reconstructed roll retained the
numeric total; the rendered chat DOM showed both formula and total, with the
total inside the visible card bounds. The two marked fixture messages were
deleted after inspection, and the isolated server/proxy were stopped. This
does not prove every system stylesheet is compatible. The user subsequently
confirmed that a public SheetDelver roll displays both formula and numeric
total in their Foundry chat.
