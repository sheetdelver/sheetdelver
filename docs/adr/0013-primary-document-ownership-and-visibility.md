# ADR-0013: Primary Document Ownership and Visibility Model

**Status:** Proposed — implementation alongside the per-type Store rollout established in ADR-0011.
**Date:** May 15, 2026
**Phase:** Primary Documents (Phase 1 onward)
**Supersedes:** None. Codifies and extends the ad-hoc visibility checks that exist today across `ActorService`, `CombatService`, `JournalService`, and the per-type sockets.
**Related:** ADR-0011 (primary document model), ADR-0012 (realtime events)

---

## Context

ADR-0011 commits Sheet Delver to a per-type Store + Repository model. ADR-0012 commits to a uniform event contract. Both depend on a third missing piece: **a single, consistent way to decide what each user can see**.

Today's visibility checks are scattered and inconsistent:

- `CoreSocket.getActors(userId)` filters at `ownership >= 2` (OBSERVER).
- `ActorService` (current implementation) mixes `ownership >= 1` (LIMITED) with system-specific NPC filtering.
- `CombatService.isAuthorizedForCombatTurn` computes role + active-combatant ownership inline.
- `JournalService.listJournals` walks folder ancestry per request with inlined visibility logic.
- `ChatMessage` has no per-user filtering at all — every user sees every message regardless of whisper recipients.
- `Folder` visibility is implicit and varies between callers.

The audit dumps confirm the underlying Foundry surface is **not** uniform either. Visibility-relevant fields differ by type:

- **Actor, Item (world), RollTable, Macro, Playlist, Cards, Scene, JournalEntry, JournalEntryPage** — standard `{ default: number, "userId1": number, ... }` ownership map.
- **ChatMessage** — no ownership map; uses `whisper: string[]`, `blind: boolean`, and `author: string`.
- **Combat** — no ownership map; derived from the embedded `combatants` array (each combatant has an `actorId` and a `hidden: boolean` flag).
- **User** — no ownership map; users are subjects of ownership, not targets.
- **Folder** — confirmed absent in Foundry v13 across all six folder types observed (Actor / Compendium / Item / JournalEntry / RollTable / Scene; 32 folders total).

Foundry exposes the document-ownership level constants on `CONST.DOCUMENT_OWNERSHIP_LEVELS`. The numeric values are stable across types that *do* use the map. The asymmetry is what each type *does* with them.

ADR-0011 names `canReadDocument(id, subject, minOwnership)` as the predicate every Store must expose. ADR-0012's fan-out path calls `canReadDocument` per event. Neither ADR specifies what "subject," "minOwnership," or the per-type ownership resolution actually look like. This ADR settles those.

---

## Decision

Sheet Delver adopts Foundry's document ownership levels as the canonical scale, defines a small set of derived visibility thresholds for cross-codebase consistency, and locks down per-type ownership policy via each Store's `resolveOwnership` method.

### Ownership level enum

```ts
export enum DocumentOwnershipLevel {
    INHERIT = -1,
    NONE = 0,
    LIMITED = 1,
    OBSERVER = 2,
    OWNER = 3,
}
```

Matches Foundry's `CONST.DOCUMENT_OWNERSHIP_LEVELS` values. `INHERIT` is the sentinel that defers to parent/folder ownership; the other four are resolved concrete levels.

```ts
export type ResolvedDocumentOwnershipLevel =
    | DocumentOwnershipLevel.NONE
    | DocumentOwnershipLevel.LIMITED
    | DocumentOwnershipLevel.OBSERVER
    | DocumentOwnershipLevel.OWNER;
```

`INHERIT` is **never returned** from ownership resolution and **never accepted** as a `minOwnership` threshold. Resolution always lowers it to a concrete level before any comparison.

### Effective-ownership resolver

```ts
export type UserId = string;
export type DocumentOwnershipMap = Partial<Record<UserId | 'default', DocumentOwnershipLevel>>;

export function getEffectiveOwnership(
    ownership: DocumentOwnershipMap | undefined,
    userId: UserId | undefined,
    resolveInherited?: () => ResolvedDocumentOwnershipLevel,
): ResolvedDocumentOwnershipLevel {
    const level = userId && ownership?.[userId] !== undefined
        ? ownership[userId]!
        : ownership?.default ?? DocumentOwnershipLevel.NONE;
    if (level !== DocumentOwnershipLevel.INHERIT) return level;
    return resolveInherited?.() ?? DocumentOwnershipLevel.NONE;
}
```

Used by the Stores whose policy is "standard ownership map" (Actor, Item, RollTable, Macro, Playlist, Scene, JournalEntry, plus per-page on Journal). The `resolveInherited` callback is optional — when a document carries `INHERIT` and the caller doesn't supply a resolver, the level falls through to `NONE` (Foundry's documented final-fallback semantics).

### Derived visibility thresholds

Different read paths need different minimum-ownership requirements. Defined once, used everywhere:

```ts
export const DOCUMENT_VISIBILITY = {
    LIST_VISIBLE:   DocumentOwnershipLevel.LIMITED,   // appears in the user's list of docs of this type
    CARD_VISIBLE:   DocumentOwnershipLevel.LIMITED,   // dashboard card / restricted preview projection
    DETAIL_VISIBLE: DocumentOwnershipLevel.OBSERVER,  // detail / sheet / full content read
    WRITEABLE:      DocumentOwnershipLevel.OWNER,     // mutations permitted
} as const;
```

Replaces the divergent thresholds in current code. List and card endpoints check `LIST_VISIBLE`; detail endpoints check `DETAIL_VISIBLE`; mutation endpoints check `WRITEABLE` at the Sheet Delver boundary before dispatching (Foundry itself performs the final permission check via the request-scoped socket/session — Sheet Delver's check is the courtesy reject before round-tripping).

`AppSocketGateway`'s realtime fan-out (ADR-0012) calls `store.canReadDocument(id, subject, LIST_VISIBLE)` — if the user can't even see the doc in their list, they don't need a realtime event for it.

### Subject shape

The "subject" of every ownership check is a small bag carrying the requesting user's identity and role:

```ts
export interface DocumentAccessSubject {
    userId: UserId;
    role: number;       // Foundry user role: 1 PLAYER, 2 TRUSTED, 3 ASSISTANT, 4 GAMEMASTER
    isGM: boolean;      // derived from role; convenience
}

export function createDocumentAccessSubject(
    userId: UserId,
    role: number,
): DocumentAccessSubject;
```

Constructed at the request boundary from the authenticated session. Passed into `Store.list({ subject, minOwnership })` / `Store.get(id, { subject, minOwnership })` / `Store.canReadDocument(id, subject, minOwnership)`.

GMs (`isGM: true`) implicitly satisfy any `minOwnership` threshold on every type — the per-type `resolveOwnership` returns `OWNER` for GMs unconditionally, except where a type's policy is explicitly more restrictive. This matches Foundry's own model: GMs see everything.

### Per-type policy matrix

`resolveOwnership(doc, subject) → ResolvedDocumentOwnershipLevel` is the policy hook on every `<Type>Store`. Each subclass implements it according to the type's actual Foundry surface:

| Type | Policy |
|---|---|
| **Actor** | `getEffectiveOwnership(doc.ownership, subject.userId)`. INHERIT falls through to world-default. |
| **Item** (world) | Same as Actor. |
| **RollTable** | Same as Actor. |
| **Macro** | Same as Actor. The `author` field is informational; not used for visibility. |
| **Playlist** | Same as Actor. |
| **Scene** | Same as Actor (stubbed for now; canvas not rendered). |
| **JournalEntry** | Same as Actor at entry level. Plus `canReadPage(entryId, pageId, subject)` for per-page resolution using the page's own ownership map; page-level `INHERIT` falls through to entry ownership. |
| **ChatMessage** | No `ownership` map. GM → `OWNER`. Otherwise: if `whisper.length > 0` and `subject.userId ∈ whisper`, `OBSERVER`; if `whisper.length === 0` and `!blind`, `OBSERVER`; if `subject.userId === author`, `OBSERVER`; else `NONE`. |
| **Combat** | No ownership on the combat doc. Iterate `doc.combatants`. Filter out combatants where `hidden && !subject.isGM`. For each remaining combatant, look up `ActorStore.canReadActor(combatant.actorId, subject, LIST_VISIBLE)` — return the highest concrete level across all visible combatants. If none are visible, `NONE`. |
| **User** | No ownership map. GM → `OWNER`. Non-GM → `OBSERVER` (users are world-visible to authenticated callers). |
| **Folder** | No ownership map in v13. Authenticated subject → `OBSERVER`. GM → `OWNER`. Folder visibility is effectively world-default; container visibility derives from contained-doc Stores. |
| **Cards** | Same as Actor (standard ownership map). |
| **FogExploration** | Stubbed type — GM returns `OWNER`; non-GM returns `OWNER` only for their own fog docs (`doc.user === subject.userId`), otherwise `NONE`. Revisit when FogExploration becomes in-scope. |
| **Setting, Adventure** | Stubbed types — placeholders return `NONE` for non-GM, `OWNER` for GM. Revisit when these become in-scope. |

The matrix above is the durable contract. New types added later either inherit the standard-ownership-map policy or document their own policy explicitly in the subclass with a reference back to this ADR.

### Where ownership lives in the architecture

- **Each Store** holds the `resolveOwnership` implementation and exposes `canReadDocument`, `list({ subject, minOwnership })`, `get(id, { subject, minOwnership })`.
- **Each Repository** does **not** enforce ownership. Repositories are pure transport; they dispatch over the request-scoped session, and Foundry performs the actual permission check based on the authenticated session's user. The repository trusts the route boundary to have applied the courtesy `WRITEABLE` check.
- **HTTP route handlers** apply the appropriate threshold per endpoint: `LIST_VISIBLE` for list endpoints, `CARD_VISIBLE` for card projections, `DETAIL_VISIBLE` for detail/sheet reads, `WRITEABLE` for mutations.
- **Adapters / modules** never receive raw ownership maps. They consume actor/document data through the SDK; user-scoping is applied by the platform-side wrapper before data reaches the adapter.

### What ownership does **not** govern

- **NPC visibility, system-specific reveal rules, gameplay-state filters.** These are module/adapter concerns, computed on top of platform ownership. The Store filters strictly by Foundry ownership; the adapter decides whether to include NPC entries in a list projection or hide a creature pending discovery.
- **Per-page redaction within a doc the user can see.** Once a user passes `DETAIL_VISIBLE` on a journal entry, the JSON delivered to them includes only the pages they can see (per `canReadPage`). The pages themselves aren't redacted; they're filtered out of the embedded array.
- **Foundry's own permission enforcement on writes.** The Sheet Delver `WRITEABLE` check at the route boundary is a courtesy. The authoritative permission check is Foundry's, performed against the authenticated socket/session when the dispatch lands.

---

## Details

### Locked Threshold Mapping

The current codebase has inconsistent thresholds (`CoreSocket.getActors` uses `>= 2`; `ActorService` uses `>= 1` with extra NPC filters). The locked mapping in `DOCUMENT_VISIBILITY` replaces both. Per Foundry's semantics:

- `LIMITED` (1) — "the user knows this actor exists and what it looks like." Right for list and dashboard-card projections.
- `OBSERVER` (2) — "can read full data, cannot modify." Right for actor detail / sheet endpoints.
- `OWNER` (3) — "can read and modify." Right for write operations at the Sheet Delver boundary.

The dashboard card projection lives at `LIMITED` because Foundry intends LIMITED for "the user knows this exists and what it looks like" — which is exactly the dashboard card's purpose (name + portrait + minimal status). Detail views (full sheet) require OBSERVER because they show stat data Foundry wouldn't surface to a LIMITED viewer.

### `INHERIT` Resolution Per Type

Only documents with the standard `ownership` map can carry `INHERIT`. The resolution path differs because v13's folder model carries no ownership:

- **Actor / Item / RollTable / Macro / Playlist / Scene** with `INHERIT` on `default` → falls through to world default (`NONE`).
- **JournalEntry** with `INHERIT` on entry-level → falls through to world default.
- **JournalEntryPage** with `INHERIT` → falls through to **entry-level** ownership (not folder). Pages inherit from their parent journal, not from a folder ancestor.
- **Cards** with `INHERIT` → falls through to world default.

No ownership chain ever walks through folders in v13 because folders don't carry ownership. The Round 01 plan briefly considered `FolderStore.resolveOwnership` as an inherited-resolution source; the data confirmed this isn't needed.

### Combat Visibility Algorithm

Combat is the only type that derives visibility from another Store. Pseudo-code for `CombatStore.resolveOwnership`:

```ts
resolveOwnership(combat, subject): ResolvedDocumentOwnershipLevel {
    if (subject.isGM) return OWNER;
    let highest: ResolvedDocumentOwnershipLevel = NONE;
    for (const combatant of combat.combatants) {
        if (combatant.hidden) continue;          // hidden combatants: GM-only
        const level = actorStore.resolveOwnership(
            actorStore.getRaw(combatant.actorId),
            subject,
        );
        if (level > highest) highest = level;
        if (highest === OWNER) return OWNER;     // short-circuit
    }
    return highest;
}
```

A combat is `LIST_VISIBLE` to a user if any non-hidden combatant's actor is `LIST_VISIBLE` to them. The combat itself doesn't have a separate ownership; it inherits the strongest visibility across its visible combatants.

### Cross-Store Subscription for Combat List Invalidation

When `ActorStore` emits `actorListInvalidated { targetUserIds: [u1, u2] }` (because an actor's ownership changed for those users), `CombatStore` listens and recomputes:

- For each affected user, walk every cached combat and recompute `resolveOwnership` for that user.
- If a user's effective ownership on a combat changed (e.g., was `NONE`, now `LIMITED` because the affected actor is a combatant they can now see), emit `combatListInvalidated { targetUserIds: [...] }`.

This is the cross-store dependency from ADR-0011 made concrete. Without it, ownership transitions on actors don't propagate into combat visibility.

### ChatMessage Visibility Algorithm

```ts
resolveOwnership(message, subject): ResolvedDocumentOwnershipLevel {
    if (subject.isGM) return OWNER;
    if (message.author === subject.userId) return OBSERVER;
    if (message.whisper.length > 0) {
        return message.whisper.includes(subject.userId) ? OBSERVER : NONE;
    }
    if (message.blind) return NONE;
    return OBSERVER;
}
```

The author always sees their own messages (including blind rolls). Whisper recipients see whispered messages. Everyone else sees only non-blind, non-whispered messages.

### Authorization vs. Ownership

This ADR is specifically about **ownership-based visibility** — what data a user can read or modify based on Foundry's ownership model. Separate from:

- **Authentication** (ADR-0001 admin auth, session restoration) — establishes the user's identity.
- **Routing-level authorization** — does this user's session permit calling this endpoint at all? Handled by middleware, not by Store policy.
- **Module-defined access controls** — modules can layer their own filters on top of platform ownership; the platform doesn't enforce them.
- **Foundry-side write enforcement** — the authoritative check on writes happens at Foundry against the authenticated session. Sheet Delver's `WRITEABLE` boundary check is a courtesy reject for clear-cut cases (no need to round-trip to Foundry for a write the user obviously can't make).

---

## Alternatives Considered

### Keep ad-hoc per-service ownership checks

Don't unify. Let `ActorService`, `CombatService`, `JournalService`, etc. keep their inline visibility logic and continue to disagree about thresholds.

Rejected because the disagreement itself is the bug. Two endpoints checking different thresholds for the same logical operation ("list visible Xs") is how Sheet Delver got into the current scatter. The locked mapping in `DOCUMENT_VISIBILITY` makes the cross-codebase semantics explicit and enforceable.

### Use raw numeric levels everywhere

Skip the enum and the visibility predicates; pass `0` / `1` / `2` / `3` directly at every call site.

Rejected because magic numbers obscure intent. `minOwnership: DOCUMENT_VISIBILITY.DETAIL_VISIBLE` is self-documenting; `minOwnership: 2` is not. The current ad-hoc code shows the cost of magic numbers — `>= 2` and `>= 1` checks scattered without clear semantics about why one or the other is right for that path.

### Put ownership on the Repository instead of the Store

Let the Repository enforce ownership before dispatching writes. The Store reads are always raw; ownership filtering happens at the consumer.

Rejected because ownership is fundamentally a read concern as much as a write concern. The realtime fan-out path (ADR-0012) needs `canReadDocument` to decide what to broadcast to each user. List endpoints need ownership to filter results. Centralizing on the Store puts the predicate next to the cached data; consumers (HTTP routes, fan-out, future SDK) all use the same surface.

The Repository remains pure transport — Foundry's own enforcement on writes is authoritative; Sheet Delver's `WRITEABLE` boundary check is a courtesy.

### Walk folders for inherited ownership

Originally the plan was for `JournalStore.resolveOwnership` to walk `FolderStore` ancestry for `INHERIT`-tagged entries. Audit data confirmed Foundry v13 folders carry no ownership map at all.

Discarded as unnecessary. `INHERIT` falls through to world-default, not folder-ancestry. `FolderStore` becomes a tree-traversal and grouping helper rather than an ownership source. If a future Foundry version re-introduces folder ownership, this ADR will be amended.

### Module-specific filters (NPC visibility, etc.) on the Store

System adapters could register per-doc filters with the Store: dnd5e's "hide unidentified items," shadowdark's "GM-only NPC reveal," etc.

Rejected because the Store is platform infrastructure; module concerns don't belong there. The Store filters strictly by Foundry ownership. Modules layer their own filters on top during projection (e.g., the dashboard card builder can skip NPCs the user hasn't discovered yet). Keeps the platform contract uniform and module concerns where they belong.

---

## Consequences

### Positive

- **One ownership vocabulary.** Every part of the codebase that asks "can this user see this?" uses the same enum, the same threshold predicates, and the same subject shape.
- **Compile-time enforcement.** `resolveOwnership` is `abstract` on `PrimaryDocumentStore<T>`; the compiler flags any subclass that forgets. `DOCUMENT_VISIBILITY` constants prevent magic-number drift.
- **Drift prevention.** Future contributors can't introduce a fifth threshold or invent a new ownership scale — there's one mapping table, one resolver, one subject shape.
- **Per-type ownership policies are explicit.** Every type's policy is in this ADR's matrix and in its subclass code. No more ad-hoc inline checks scattered across services.
- **Fan-out filtering trivial.** ADR-0012's `AppSocketGateway` calls `store.canReadDocument(id, subject, LIST_VISIBLE)` per event; no per-type fan-out logic needed.
- **Foundry alignment.** Numeric values match `CONST.DOCUMENT_OWNERSHIP_LEVELS`. When Foundry adds a new level (unlikely but possible), the enum is the single place to update.

### Tradeoffs

- **Locked thresholds are a product decision encoded in code.** If a stakeholder later decides dashboard cards should require OBSERVER rather than LIMITED, that's a single-place change but it's still a product call. Mitigated by the constants being prominently named and centralized.
- **GM short-circuit on every check.** `isGM ? OWNER : computeNormally()` runs on every read. Cheap, but adds a uniform overhead. Tradeoff against the alternative (configurable bypass) is simplicity wins.
- **Cross-store subscription overhead for Combat.** `CombatStore` recomputes per-combat visibility when `actorListInvalidated` fires. For worlds with many combats and frequent actor ownership changes, this could be noticeable. Mitigated by emit-only-on-observable-change (ADR-0012) — recomputation that doesn't change any user's visibility produces no fan-out.
- **`INHERIT` resolution is partial.** Without folder ownership, `INHERIT` essentially always falls to world-default. The plumbing for `resolveInherited` is there for future use (re-introduction of folder ownership, or other Foundry-side hierarchical ownership) but currently has limited utility.

---

## Related Decisions

- **ADR-0011 (primary document model)** — establishes the per-type Store + Repository pattern this ADR's ownership policy plugs into.
- **ADR-0012 (realtime events)** — the per-event ownership filter at fan-out time is defined here (the `canReadDocument` predicate) and applied there.
- **ADR-0002 (runtime boundary enforcement)** — establishes player vs. admin runtime surfaces; the Document Access Subject defined here applies only to the player runtime. Admin operations are separately authorized.

---

## Validation

Validated at the base abstraction and per-type:

- Base-contract unit tests against a mock document type assert `canReadDocument`, `list({ subject, minOwnership })`, and `get(id, { subject, minOwnership })` filter correctly using a mock `resolveOwnership`.
- Per-type unit tests for each Store assert `resolveOwnership` returns the documented level for every combination of (doc state × subject):
  - Standard-ownership types: tests for `default`-only docs, explicit user-level docs, `INHERIT` resolution, GM short-circuit.
  - ChatMessage: tests for whisper subset, blind rolls, author-self-read, GM read.
  - Combat: tests for visible combatant, hidden combatant, all-hidden, cross-store dependency via `actorListInvalidated`.
  - User: tests for self-read, other-user read, GM read.
  - Folder: tests for non-GM read returns OBSERVER, GM read returns OWNER.
- Integration tests at HTTP routes assert the right `DOCUMENT_VISIBILITY` threshold is applied per endpoint (`/api/<type>` uses `LIST_VISIBLE`, `/api/<type>/:id` uses `DETAIL_VISIBLE`, writes use `WRITEABLE`).
- An end-to-end test for the cross-store dependency: change an actor's ownership map, assert `combatListInvalidated` fires for users whose combat-list access changed.

Structural end-state validation:

- `grep` for raw numeric `ownership >= N` comparisons outside the resolution helpers returns no hits.
- `grep` for ad-hoc visibility filtering in services (the current `JournalService.listJournals` pattern) returns no live callers; all filtering goes through `Store.list({ subject, minOwnership })`.
- A reader can trace any visibility decision from HTTP boundary to data layer: route applies `DOCUMENT_VISIBILITY.X`; Store's `list/get/canReadDocument` consumes it; subclass `resolveOwnership` implements per-type policy. Three layers, one path per type.

## ADR-0011 Phase 1 Notes

**May 15, 2026 — ADR-0011 Phase 1 ChatMessage blind visibility ordering.** ADR-0011 Phase 1 tightened the ChatMessage policy implemented by `ChatMessageStore.resolveOwnership`: blind visibility is stricter than whisper visibility. For non-GM subjects, the effective order is:

1. The author can see their own message, including blind rolls.
2. If `blind === true`, non-author, non-GM users get `NONE`, even if their id appears in `whisper`.
3. If the message is not blind and has a non-empty `whisper` list, listed users get `OBSERVER`; unlisted users get `NONE`.
4. If the message is not blind and has no whisper recipients, authenticated users get `OBSERVER`.

This note supersedes any shorthand wording above that could be read as "whisper recipient always sees the message." Blind rolls remain author + GM visible only.

**May 15, 2026 — ADR-0011 Phase 1 fan-out uses Store visibility for chat events.** ADR-0011 Phase 1 routes `chatMessageChanged` fan-out through `ChatMessageStore.canReadDocument(..., LIST_VISIBLE)` in `AppSocketGateway`, so the blind/whisper/author policy above controls realtime delivery as well as `/api/chat` reads. `ChatService` also keeps defensive DTO masking for blind roll fields.

**May 17, 2026 — ADR-0011 Phase 7 stub policy alignment.** Phase 7 added stub Stores for Scene, FogExploration, Adventure, and Setting. Scene keeps the standard ownership-map policy if it is wired later. Adventure and Setting remain GM-only placeholders. FogExploration is a per-user state placeholder instead of a GM-only placeholder: GMs can read all fog docs, while non-GMs can read only docs whose `user` field matches their subject user id. The Store is still not registered with the coordinator or router in Phase 7; this policy only documents the stub's future wiring shape.

---

## Exit Criteria

This ADR is fulfilled when the ownership model is in force across every Store and every read path consumes the shared predicates.

- [ ] `DocumentOwnershipLevel` enum and `ResolvedDocumentOwnershipLevel` type defined in a shared base location consumed by every Store.
- [ ] `getEffectiveOwnership` helper available and used by every standard-ownership-map type.
- [ ] `DOCUMENT_VISIBILITY` constants defined and used by every HTTP route and the realtime fan-out path.
- [ ] `DocumentAccessSubject` constructed at the request boundary; threaded through every Store read API.
- [ ] Every Store implements `resolveOwnership` per the policy matrix above.
- [ ] Cross-store subscription for combat list invalidation in place.
- [ ] No raw `>= 1` / `>= 2` / `>= 3` ownership comparisons remain in services or routes outside the resolution helpers.
- [ ] Each phase's tests cover the per-type ownership policy and the cross-store dependencies where applicable.
- [ ] Status flipped to **Accepted** when the model is in force for every shipped Store.
