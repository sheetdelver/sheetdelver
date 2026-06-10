# ADR-0028: Combat Encounter Document Store Alignment

**Status:** Proposed - Not implemented.
**Date:** June 5, 2026
**Phase:** Primary Documents / Combat
**Supersedes:** None
**Revises:** ADR-0011 Phase 5 combat follow-up scope
**Related:** ADR-0011 (primary document model), ADR-0012 (primary document realtime events), ADR-0013 (ownership and visibility), ADR-0016 (document resolution and UUID routing), ADR-0024 (client UI state decomposition), ADR-0025 (test truthfulness), ADR-0027 (module SDK standardization, parallel workstream).

---

## Context

ADR-0011 moved Combat into the primary document-store architecture. The current implementation is directionally correct: Combat documents are seeded into `CombatStore`, Combat writes use `CombatRepository`, inbound Foundry `modifyDocument` events flow through the primary document router, and `SystemService` / `AppSocketGateway` fan out `combatChanged` and `combatListInvalidated` events.

The source audit of the current CombatHUD path, combat routes/services, primary document stores, realtime gateway, shared combat contracts, UI documentation, and local Foundry v13 combat implementation found that the remaining staleness is not a reason to put document-store behavior into the browser. It is a sign that the backend Combat document model is only partially aligned with the data and event semantics Foundry provides.

Concrete gaps in the current tree:

- `CombatStore` mirrors Combat and embedded Combatant changes, but it ignores embedded `CombatantGroup` events even though Combat documents can contain `groups`.
- `CombatDocument.turn` is typed as `number`, but real pre-start combats can carry `turn: null`.
- Direct parent Combat updates that replace or change `combatants` or `groups` do not receive Combat-specific visibility-source invalidation beyond the generic base Store behavior.
- Actor-derived tracker rows are not invalidated on ordinary actor document changes, even though the Combat projection uses ActorStore-backed actor data.
- `CombatService` reconstructs simplified ordering and turn progression from raw documents on each request.
- CombatHUD reconstructs sorting, current-turn identity, progression, and permissions again in the browser.
- Foundry's Combat Encounter API derives state that is not transmitted as raw Combat fields: prepared turns, current and next combatant, started state, active/current-scene applicability, tracker settings, combatant display identity, defeated state, group behavior, and command workflows.

The sequencing matters. Modernizing CombatHUD before the backend has a faithful raw document contract and a typed tracker projection would only preserve the current drift in a new shape.

This ADR runs in parallel with ADR-0027. It does not revise the SDK, expose SDK APIs, or define module-facing behavior.

## Decision

Sheet Delver will align Combat with the primary document-store principles before changing CombatHUD behavior.

The decision has eight parts.

### 1. Raw CombatStore Is a Faithful Foundry Document Mirror

`CombatStore` remains a primary document Store. Its job is to mirror raw Foundry Combat document data and Foundry document events. It must not become the CombatHUD view model and must not own browser presentation concerns.

The raw Store is responsible for:

- Full bootstrap seeding from Foundry Combat documents.
- Applying Combat create, update, and delete events.
- Applying embedded Combatant create, update, and delete events.
- Applying embedded CombatantGroup create, update, and delete events.
- Preserving Foundry document fields faithfully, including nullable fields and unknown fields that are part of the raw document mirror.
- Emitting primary document change and list-invalidation events according to ADR-0012.
- Resolving Combat visibility according to ADR-0013's Combat policy.

The raw Store is not responsible for:

- Per-user redaction DTOs.
- HUD row formatting.
- Browser selection state.
- Foundry's `viewed` tracker application state.
- Turn-control command behavior.
- SDK document surfaces.

### 2. Combat Raw Types Must Match Foundry Data

Combat raw document types should be tightened around actual Foundry v13 data while keeping the Store's raw mirror behavior intact.

Required corrections include:

- `CombatDocument.turn` is `number | null`.
- `CombatDocument.groups` is typed as embedded CombatantGroup documents rather than `unknown[]`.
- `CombatantDocument.group` remains nullable and links to a CombatantGroup.
- Combatant display fields such as `name` and `img` are first-class raw fields.
- Hidden, defeated, initiative, token, scene, actor, sort, flags, system, and stats fields remain available on raw documents.
- Unknown/raw fields may remain indexable at the raw document layer, but route projections must not spread them to clients by default.

The shared client contract is separate. `/api/combats` should eventually return a tracker DTO, not raw `CombatDocument`.

### 3. Backend State Updates Are Event-Driven, Not Polled

Combat backend state is constructed and maintained from:

- Bootstrap seed.
- Foundry `modifyDocument` events.
- Sheet Delver repository mirrors of Foundry write results.

There should be no scheduled CombatHUD polling loop and no periodic backend combat poll. Browser clients may perform an initial fetch and refetch after realtime invalidation. That refetch is a projection read, not a source-of-truth poll.

### 4. Derived Combat Encounter State Lives Beside, Not Inside, the Raw Store

Foundry's Combat Encounter behavior is more than raw Combat JSON. Sheet Delver will introduce a backend encounter read model after raw Store fidelity is corrected.

The read model may be named `CombatEncounterReadModel`, `CombatTrackerStore`, or similar. It is keyed by Combat ID and subscribes to relevant primary-store events.

It owns user-invariant prepared state such as:

- Ordered turn rows.
- Stable current combatant ID.
- Started state.
- Active/applicable encounter policy.
- Group-derived row state.
- Display identity derived from combatant, token, and actor data according to the chosen fidelity contract.
- Dependency tracking needed to rebuild affected encounters.

It does not own user-specific redaction or authorization. Those happen in the projection layer.

### 5. Tracker Projection Is Typed, Whitelisted, and Subject-Specific

CombatHUD should consume a typed tracker projection rather than raw documents.

The projection builder accepts:

- A prepared encounter from the backend encounter read model.
- The requesting `DocumentAccessSubject`.
- The selected tracker policy for hidden rows, scene applicability, and unstarted encounters.

It returns a safe contract, for example:

```ts
interface CombatTrackerDto {
    id: string;
    active: boolean;
    started: boolean;
    round: number;
    currentCombatantId: string | null;
    hasHiddenCurrentCombatant: boolean;
    canAdvanceTurn: boolean;
    canRewindTurn: boolean;
    combatants: CombatTrackerCombatantDto[];
}

interface CombatTrackerCombatantDto {
    id: string;
    name: string;
    img: string | null;
    initiative: number | null;
    defeated: boolean;
    hidden?: boolean;
    isCurrent: boolean;
    canRollInitiative: boolean;
}
```

The final contract can differ, but it must be explicit. The route must not spread full raw Combat, Combatant, Actor, Token, or Group documents into the client payload.

### 6. Combat Commands Need a Foundry Encounter Boundary

Document events are results, not commands. They are the correct way to update backend state after Foundry changes a document, but they are not a substitute for invoking Combat Encounter workflows.

For Foundry-fidelity behavior, combat actions should cross a core command boundary that invokes Foundry's public encounter methods in the Foundry runtime where possible, such as:

- `Combat#startCombat()`
- `Combat#nextTurn()`
- `Combat#previousTurn()`
- `Combat#rollInitiative()`

The resulting Foundry document events then update `CombatStore` and the encounter read model.

If a direct Foundry command bridge is not feasible for a given action, the divergence must be explicit, typed, and tested as Sheet Delver behavior. It must not be silently duplicated in CombatHUD.

### 7. CombatHUD Is a Projection Consumer

CombatHUD modernization is intentionally sequenced after the backend work.

The client may own:

- Selected combat ID.
- Minimized/open state.
- Dialog state.
- Loading/error/pending mutation state.

The client must not own:

- Combatant sort order.
- Current-turn identity.
- Turn progression rules.
- Raw ownership or authorization checks.
- Hidden-combatant redaction.
- Derived Combat Encounter semantics.

### 8. SDK Work Is Out of Scope

This ADR does not define module SDK behavior. It should not alter ADR-0027's SDK standardization track.

Any future SDK exposure of combat data must consume the typed projection or a later explicit SDK contract. It must not cause the core CombatHUD migration to import SDK document sources.

## Target Architecture

```text
Foundry bootstrap + modifyDocument events
  -> CombatStore raw Combat documents
  -> CombatEncounterReadModel prepared encounter state
  -> subject-specific CombatTrackerDto projection
  -> CombatHUD render-only view

CombatHUD action
  -> protected route
  -> authorization preflight
  -> Foundry encounter command boundary
  -> Foundry document events
  -> CombatStore
  -> CombatEncounterReadModel
  -> realtime invalidation
  -> client refetches projection
```

## Implementation Plan

### Phase 1: Raw Store Fidelity

- Capture or preserve fixtures for real Foundry Combat bootstrap documents and Combat modifyDocument events.
- Correct raw Combat and Combatant types, including nullable `turn`.
- Add `CombatantGroupDocument`.
- Handle embedded CombatantGroup create, update, and delete events.
- Add Combat-specific direct parent update handling for `combatants` and `groups`.
- Preserve ADR-0012 observable-change-only event behavior.
  - Done early (June 6, 2026): embedded **Combatant create** is now idempotent — `CombatStore` routes it through the shared `appendCreatedById` helper so the mirror + broadcast double-apply can't duplicate a combatant (ADR-0012 addendum). Apply the same pattern to the new `CombatantGroup` create path when it lands.
- Add tests for bootstrap, create, update, delete, embedded Combatant, embedded CombatantGroup, and direct parent update paths.

### Phase 2: Visibility and Dependency Invalidation

- Keep Combat visibility derived from non-hidden combatants and ActorStore visibility.
- Emit list invalidations when a Combat update changes the set of visibility-bearing combatants.
- Bridge actor document changes to affected combats when actor data participates in tracker projection.
- Identify scene/token/setting dependencies that affect tracker projection.
- Either wire those dependencies or explicitly exclude them from the first supported tracker contract.
- Add tests for actor-change invalidation and visibility loss.

### Phase 3: Encounter Read Model

- Add the backend encounter read model keyed by Combat ID.
- Seed all encounters after CombatStore bootstrap.
- Rebuild one encounter after relevant Combat, Combatant, CombatantGroup, Actor, and declared dependency events.
- Remove an encounter on Combat delete.
- Maintain prepared turn rows and stable current combatant identity.
- Add tests for build, reorder, update, group changes, current ID stability, and delete.

### Phase 4: Tracker Projection Contract

- Define `CombatTrackerDto` and `CombatTrackerCombatantDto`.
- Whitelist every field in the response.
- Compute server-side capabilities such as `canRollInitiative`, `canAdvanceTurn`, and `canRewindTurn`.
- Model hidden current-combatant state explicitly.
- Model round-zero/unstarted state explicitly.
- Add tests for GM, assistant GM, player owner, non-owner, hidden combatant, and unreadable actor cases.

### Phase 5: Command Boundary

- Decide which combat actions must invoke Foundry's encounter methods directly.
- Add a core command bridge for those actions, or document and test a narrower Sheet Delver command contract.
- Add authorization preflights before side effects such as initiative rolls or chat messages.
- Let resulting document events update the stores and read model.
- Add command tests for progression, initiative, unauthorized calls, and event-driven read-model refresh.

### Phase 6: CombatHUD Modernization

- Replace raw `CombatDto` consumption with the tracker DTO.
- Remove client sorting, ownership checks, hidden filtering, and progression prediction.
- Select encounters by stable ID.
- Render only from projected state.
- Add focused client tests for projection rendering, invalidation refetch, failed actions, round-zero state, and reconnect/world-closed behavior.

## Non-Goals

- No browser primary document store.
- No CombatHUD logic migration before backend contracts are stable.
- No module SDK surface changes.
- No raw Combat document spreading to the browser as the long-term contract.
- No silent attempt to fully emulate arbitrary Foundry system or module overrides without declaring that fidelity target.

## Alternatives Considered

### Modernize CombatHUD First

Rejected. The HUD would still receive a broad raw document payload and would still need to reconstruct derived encounter semantics. This preserves the current drift behind cleaner React code.

### Put Derived Tracker State Directly Into CombatStore

Rejected. `CombatStore` is the raw document mirror. Mixing projection and tracker semantics into it violates ADR-0011's base/subclass split and makes it harder to reason about which fields came from Foundry versus Sheet Delver.

### Keep Request-Time Projection Only

Rejected as the long-term model. Request-time projection can work for simple fields, but Combat Encounter state has dependencies and event semantics. An event-maintained read model gives tests and subscribers a stable place to verify rebuild, reorder, update, and destroy behavior.

### Reimplement Foundry Combat Commands in Sheet Delver

Rejected as the default. Foundry owns encounter workflows, settings, hooks, Combat subclasses, and system-specific behavior. Sheet Delver can implement a narrower command contract only when the divergence is explicit and tested.

## Consequences

### Positive

- Combat follows the same document-store principles as the rest of the primary document model.
- Raw Foundry document state and derived tracker projection become separate and testable.
- CombatHUD can become a render-only projection consumer.
- Hidden combatant and current-turn bugs are fixed at the projection boundary instead of patched in the UI.
- The migration can happen without blocking ADR-0027.

### Tradeoffs

- More backend code before visible HUD improvements.
- A new read-model layer adds another concept for contributors to learn.
- Exact Foundry tracker fidelity may require a command bridge into the Foundry runtime.
- Scene, token, and setting dependencies need an explicit scope decision.

## Validation

This ADR is complete when:

- `CombatStore` tests prove raw Combat, Combatant, and CombatantGroup fidelity.
- Raw Combat types match captured Foundry v13 fixtures, including nullable `turn`.
- Direct Combat updates that affect visibility emit the right invalidations.
- Actor changes that affect tracker rows refresh affected encounters.
- The encounter read model is event-maintained and has build, rebuild, reorder, update, and delete tests.
- `/api/combats` returns a typed, whitelisted tracker DTO.
- Combat commands either invoke Foundry encounter methods or conform to a documented Sheet Delver command contract.
- CombatHUD no longer computes domain logic that belongs to the backend.

Expected verification gates:

- `npx tsc --noEmit`
- focused lint on changed combat/store/client files
- targeted unit tests for CombatStore, encounter read model, projection, and commands
- targeted client tests for CombatHUD after the backend contract lands
- `npm run test:unit`
