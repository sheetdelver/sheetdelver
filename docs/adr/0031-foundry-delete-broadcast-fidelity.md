# ADR-0031: Foundry Delete-Broadcast Fidelity for Primary Document Stores

**Status:** Accepted - Implemented July 4, 2026.
**Date:** July 4, 2026
**Phase:** Primary Documents / cross-cutting
**Supersedes:** None
**Revises:** ADR-0012 delete-event handling across all primary document stores
**Related:** ADR-0011 (primary document model), ADR-0012 (primary document realtime events), ADR-0028 (combat encounter document store alignment — the work that elucidated this defect).

---

## Context

While landing ADR-0028 Phases 1–2, live testing surfaced a stale-cache bug:
ending an encounter in the Foundry UI left the combat in Sheet Delver's
`CombatStore` — and therefore in every client's HUD — indefinitely, surviving
page reloads. Updates propagated correctly; only deletions went missing.

The root cause is a wire-shape asymmetry in Foundry's `modifyDocument` events
that every primary document store had inherited from a shared pattern:

- **Initiator-mirror path** (Sheet Delver dispatched the write): the response
  `operation` carries the explicit `ids` the Repository requested, and stores
  resolved deletions from `operation.ids`.
- **Broadcast path** (another Foundry client performed the delete): the
  broadcast's `result` carries the authoritative deleted ids as **plain id
  strings**, and `operation.ids` is not reliable. Foundry's own client
  re-records `operation.ids = response.result` when handling delete broadcasts
  (foundry.mjs v13, `#handleDeleteDocuments`), precisely because the request
  operation's explicit ids can be empty (`deleteAll: true`) or absent.

Every store's delete path did `toDocumentArray(result)` — which filters out
non-object entries, discarding the id strings — and then fell back to
`operation.ids`. When neither yielded ids, the delete became a **silent
no-op**: no document removal, no `documentChanged`, no list invalidation, and
a permanently stale server cache that no client refetch could correct.

This affected the self-delete path of every store through the shared
`PrimaryDocumentStore.applySelfChange`, and each store's embedded-child delete
handler independently (Actor items/effects, Item effects, JournalEntry pages,
RollTable results, Playlist sounds, Cards cards, Combat combatants/groups).

## Decision

1. **Deleted ids are resolved from the union of both shapes.** A shared
   `getDeletionIds(operation, result, docs)` helper in
   `PrimaryDocumentStore.ts` unions:
   - string entries of `result` (the authoritative broadcast shape),
   - `operation.ids` when present (the initiator-mirror shape),
   - ids of any full documents in `result` (defensive fallback).

   Treating `result` string ids as first-class mirrors Foundry's own client
   behavior and covers `deleteAll` broadcasts, where explicit request ids are
   empty and only `result` names what was removed.

2. **Every delete path uses the helper.** The base `applySelfChange` delete
   branch (covering all parent-document deletes for every store) and every
   embedded-child delete handler (`ActorStore`, `ItemStore`, `JournalStore`,
   `RollTableStore`, `PlaylistStore`, `CardsStore`, `CombatStore`,
   `FolderStore`'s delete-id diffing) resolve ids via `getDeletionIds`. New
   stores must not reintroduce `getOperationIds`-only delete resolution.

3. **`deleteAll` wipes fail open to the full key set.** If a self-delete
   resolves no ids but `operation.deleteAll === true`, the store removes every
   cached document of its type, emitting per-document delete events, rather
   than silently retaining a cache Foundry has emptied.

4. **Deletes must never silently no-op.** A delete event for a cached document
   must either remove it (emitting `documentChanged` + list invalidation per
   ADR-0012) or be a true idempotent re-apply of an already-removed document.
   Shape differences between mirror and broadcast payloads are not an
   acceptable reason to retain a document.

## Consequences

### Positive

- Deletions performed in the Foundry UI propagate to Sheet Delver caches and
  clients for every primary document type, not only combats.
- The ADR-0028 acceptance criterion "an encounter that ends or is deleted
  disappears from every connected client's HUD without a reload" is satisfied
  at the store layer.
- One helper owns delete-id resolution, so the mirror/broadcast asymmetry
  cannot drift per store — the same consolidation ADR-0012's
  `appendCreatedById` performed for embedded creates.

### Tradeoffs

- `getDeletionIds` accepts a slightly broader input surface (string arrays)
  than the strict document-array typing elsewhere; the permissiveness is
  deliberate and documented at the helper.
- The `deleteAll` fallback trusts the operation flag; a malformed broadcast
  with a spurious `deleteAll` would clear a type's cache. Foundry only emits
  the flag on genuine collection wipes, and a wrongly cleared cache self-heals
  on refetch/reseed, whereas the prior failure mode (permanent staleness) did
  not.

## Validation

- `primary-document-base.test.ts` covers `getDeletionIds` shape handling,
  broadcast-shaped self deletes (string ids in `result`, no `operation.ids`),
  and the `deleteAll` fallback.
- `combat-store.test.ts` reproduces the originating bug end to end: a
  broadcast-shaped "End Combat" delete removes the cached combat and emits
  both `documentChanged` and a list invalidation; double-apply stays a no-op.
- Each store test (`actor-store`, `item-store`, `journal-store`,
  `roll-table-store`, `playlist-store`, `cards-store`) exercises a
  broadcast-shaped embedded-child delete.
- Verification gates: `npx tsc --noEmit`, focused lint on changed store files,
  `npm run test:unit`.
---

## ADR-0034 Amendment: Normalized and Audience-Correct Deletes

**Date:** September 2, 2026
**Status:** Accepted decision; implementation tracked by ADR-0034.

ADR-0031's deletion-id union remains authoritative for each normalized delete
entry. ADR-0034 extends the input boundary so generation 14 batch entries,
including side effects, are unwrapped and processed in wire order before the
existing Store delete logic runs. Failed batch entries are diagnostic and do
not mutate Stores.

Pack-scoped deletes invalidate only compendium state. World-document delete
fan-out captures visibility before Store removal and distinguishes an explicit
empty audience from broadcast, preventing unauthorized tombstone identifiers
from being disclosed.
