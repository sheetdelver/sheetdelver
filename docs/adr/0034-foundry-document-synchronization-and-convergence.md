# ADR-0034: Foundry Document Synchronization and Convergence

**Status:** Accepted - Phase 1 complete; Phase 2 pending.
**Status amendment (September 3, 2026):** Phase 2 is in progress. The Actor
list bridge, Actor trailing refresh, and shared Store application of Foundry
field operators are complete and live-validated; the remaining Phase 2 items
stay open below.
**Status amendment (September 3, 2026):** Phase 2 is complete. Store-to-client
signal parity, trailing refresh, SDK epoch rejection, and mounted-subscriber
reset behavior are implemented and verified. Phase 3 is pending.
**Status amendment (September 3, 2026):** Phase 3 is in progress. Structured
audiences, deletion-safe Store policy, and multi-user delivery tests are
complete. Server-session invalidation of already-connected app sockets remains
open as the final Phase 3 slice.
**Status amendment (September 3, 2026):** Phase 3 is complete. Server-side
session retirement now immediately removes app-socket authority, listener
access, and session-bound client state. Phase 4 is pending.
**Date:** September 2, 2026
**Phase:** Pre-main synchronization remediation
**Supersedes:** None
**Revises:** ADR-0011 (Store ingress and active scope), ADR-0012 (realtime delivery and client convergence), ADR-0019 (generation 14 document transport compatibility), ADR-0031 (normalized delete handling)
**Related:** ADR-0013 (ownership and visibility), ADR-0015 (compendiums), ADR-0016 (UUID routing), ADR-0017 (world lifecycle), ADR-0018 (socket boundary), ADR-0033 (security closeout)

---

## Context

A live Foundry-side Actor update did not appear in Sheet Delver's document
pool. The Actor was the observed symptom, but the affected architecture is the
shared synchronization path for every active primary-document Store.

The existing model correctly gives each supported document type a Store and
Repository, routes requesting-user writes over that user's Foundry transport,
and treats browser realtime messages as invalidation hints. It does not yet
guarantee that every persisted Foundry mutation reaches the correct Store or
that every affected browser and SDK cache performs a post-change read.

A comparison of the saved Foundry generation 13 and generation 14 clients
identified four persistence surfaces:

| Persistence surface | Generation 13 | Generation 14 | Current coverage |
| --- | --- | --- | --- |
| `modifyDocument` | Yes | Yes | Partial |
| `modifyDocumentBatch` | No | Yes | Missing |
| `pm.autosave` | Yes | Yes | Missing |
| `manageCompendium` | Yes | Yes | Missing |

Generation 14 retains the single `modifyDocument` event and adds
`modifyDocumentBatch`, whose ordered results can include primary results,
side effects, and errors. Both supported generations persist collaborative
editor content through `pm.autosave`; Foundry applies that event directly to
the addressed document source rather than passing it through the ordinary
`modifyDocument` client handler. Both generations use `manageCompendium`
for world compendium pack creation and deletion.

Other core socket events were classified explicitly. `pm.newSteps`,
`pm.resync`, and `pm.usersEditing` are collaborative working state rather
than canonical persistence. Presence, media, shared display, canvas, and pause
events do not mutate primary-document Stores. `resetFog` is relevant only if
the currently unsupported FogExploration Store is promoted in a future
decision.

The ingress gaps combine with downstream gaps:

- incoming pack-scoped document results can reach world-document routing
- `actorListInvalidated` is emitted by the Store but is not forwarded through
  the complete server/browser event path
- several browser consumers suppress an in-flight duplicate request without
  scheduling a trailing refresh
- SDK reset can orphan subscribers or admit completion from a prior world
- delete and list-invalidation audiences cannot distinguish all users from no
  users and do not consistently preserve pre-delete visibility
- runtime teardown does not clear every active Store through one boundary
- update misses mark documents stale without triggering authoritative repair

The result is not Actor-specific. Any active direct or embedded document can
remain stale at ingress, in the server Store, or in a browser/SDK projection.

## Decision

Sheet Delver adopts one end-to-end synchronization invariant:

> For every supported Foundry persistence event or response, Sheet Delver
> updates or invalidates the correct Store, emits an audience-correct signal,
> and guarantees that an observed browser or SDK cache eventually performs a
> post-change read within the same world and session epoch.

### 1. Normalize supported document responses before Store routing

One transport-level normalizer will accept:

- generation 13 single `modifyDocument` responses
- generation 14 legacy/single `modifyDocument` responses
- generation 14 `modifyDocumentBatch` envelopes
- request acknowledgements returned to CoreSocket and ClientSocket dispatches

The normalizer produces an ordered sequence of typed result entries containing
the document type, action, operation, result, side-effect status, and error
status. Successful primary and side-effect entries are routed in wire order.
Malformed or failed entries are logged with structured context and are never
silently applied as successful mutations.

Generation 13's single-response path remains supported unchanged. Generation
14 batching is additive and must not replace or reinterpret the generation 13
contract.

**Implementation amendment - field operators:** Live generation 14 ownership
testing exposed a compatibility layer omitted from the original ingress plan.
A valid document response can contain database field operations inside its
`result`, not only ordinary partial values. Generation 13 ownership updates use
the legacy `"==ownership"` whole-field replacement key, while generation 14
serializes `ForcedReplacement` as an object identified by
`"__$OPERATOR$__"`. Both generations also have corresponding forced-deletion
forms. Treating those values as ordinary nested data preserves removed keys and
can insert operator metadata into the cached document.

Response normalization therefore preserves these field operations until the
shared Store merge boundary. That boundary applies replacement and deletion
semantics for both supported generations before cache comparison and event
emission. This is a generic direct/embedded document rule; it does not infer an
ownership level or special-case Actor documents.

Repository mirroring and later CoreSocket broadcast delivery remain
idempotent. Both paths use the same normalized result semantics so a logical
mutation emits one observable Store change regardless of which path arrives
first.

### 2. Separate world documents from compendium scope

A normalized entry whose operation identifies a compendium pack must never
enter a world primary-document Store.

Pack-scoped document results invalidate or update only the relevant compendium
shard. The `manageCompendium` event invalidates authoritative pack-catalog
metadata for create/delete operations. Compendium pack membership and
compendium document content remain outside the world Store namespace.

The scope decision occurs before `modifyDocumentRouter`, not independently
inside each Store.

### 3. Treat persisted editor autosave as an authoritative invalidation

CoreSocket listens for `pm.autosave(uuid, html)` in generations 13 and 14.
The UUID is parsed by the shared structured document UUID parser.

Sheet Delver does not trust or directly merge the event's partial HTML payload.
Instead, it treats the event as proof that the addressed document has persisted
and schedules an authoritative read of the owning root:

- a direct world UUID refreshes its primary document
- an embedded UUID refreshes its owning primary document
- a compendium UUID invalidates the relevant pack shard
- malformed or unsupported UUIDs produce bounded operator diagnostics

Refreshes are coalesced per root with a trailing-read guarantee. If another
autosave arrives while a read is active, at least one read starts after the
active request settles. Sheet Delver does not consume `pm.newSteps` as
canonical state.

### 4. Apply the contract to every active Store

The synchronization contract covers these active primary-document Stores:

- Actor
- ChatMessage
- Folder
- User
- JournalEntry
- Combat
- Item
- RollTable
- Macro
- Playlist
- Cards
- Scene
- Setting

It also covers their registered embedded routing, including Items,
ActiveEffects, JournalEntryPages, Combatants, RollTableResults,
PlaylistSounds, Cards, Tokens, ActorDelta state, and other embedded children
already owned by those roots.

Adventure and FogExploration remain explicitly unsupported and unwired. They
must not be reported as synchronized merely because placeholder Store classes
exist. Compendium state is covered through its separate catalog and shard
model, not by pretending pack documents are world primary documents.

### 5. Make list and document invalidation complete end to end

Every active Store's document-change and list-invalidation signals must be
represented in typed server and SDK contracts, bridged through SystemService,
forwarded by AppSocketGateway, and consumed by each relevant native or SDK
cache.

Realtime payloads remain invalidation hints. Full document bodies are obtained
through authorized REST or SDK reads. A client may patch an already loaded
projection only when that is equivalent to an authoritative reread; list
membership, ownership transitions, embedded changes, and deletes require the
appropriate list/detail invalidation.

The Actor-specific missing `actorListInvalidated` bridge is repaired as one
instance of this universal rule, not as a special synchronization architecture.

### 6. Coalescing must guarantee a trailing refresh

Suppressing concurrent duplicate reads is allowed only when an invalidation
that arrives during an active request marks the resource dirty. Once the active
request settles, the cache performs a trailing read before considering itself
current.

The same primitive applies to Actor pools and details, Chat, Journal, User
roster, Combat projections, and module-facing SDK document sources. Bursts may
coalesce into fewer reads, but the pre-change response may not become the final
state.

### 7. Audience calculations are explicit and deletion-safe

The realtime audience contract distinguishes:

- all currently authenticated and authorized subjects
- an explicit set of user ids
- no recipients

An empty user-id set never means broadcast. Per-document delivery is evaluated
against the Store's type-specific visibility policy.

Delete handling captures authorized visibility before removing the document so
that only prior viewers receive a document-specific tombstone or invalidation.
ADR-0031's union of result-string ids, operation ids, and defensive document ids
remains the delete-id rule after response normalization.

### 8. World and session epochs bound all synchronization work

One world-runtime teardown operation clears every active Store, compendium
state, derived model, shared world state, and world-bound browser/SDK cache.
Partial bootstrap failure uses the same cleanup boundary.

Asynchronous reads capture the current world/session epoch. A completion from a
prior epoch is discarded and cannot repopulate current state. Reset either
notifies existing subscribers or replaces source identity in a way that causes
mounted consumers to resubscribe.

Invalidating a server-side player session also revokes or reclassifies its
established app socket before further authenticated events are delivered.

These changes do not alter the world lifecycle state machine, disable heartbeat
discovery, or stop retries when Foundry moves through setup, unknown-world, and
active-world states.

### 9. Store misses trigger bounded repair

An update or embedded mutation for a missing cached root is not merely recorded
as stale. It schedules a coalesced authoritative read of that root or emits a
typed unavailable state when repair cannot be performed.

Repair is bounded, observable, and scoped to the current world epoch. It is not
general polling.

### 10. Requesting-user authorization remains unchanged

User-originated creates, updates, and deletes continue through the requesting
user's Foundry socket. A missing user transport fails closed. CoreSocket and
the service account are not fallback write identities.

CoreSocket may perform authoritative reads needed for bootstrap, ingress repair,
or autosave convergence. That read responsibility does not grant it ownership
of user CRUD or bypass Foundry's write authorization.

## Compatibility Contract

| Foundry generation | Document response support | Specialized persistence |
| --- | --- | --- |
| 13 | Single `modifyDocument` | `pm.autosave`, `manageCompendium` |
| 14 | Single `modifyDocument` plus ordered `modifyDocumentBatch` | `pm.autosave`, `manageCompendium` |

ADR-0019's generation 14 build 366 login negotiation remains a login-specific
compatibility branch. It is independent from generation 14 batch document
responses. Supporting the latter must not remove generation 13 or generation
14 single-response handling.

Newer Foundry generations retain ADR-0019's warn-and-proceed policy. Their
document shapes are not silently declared compatible; malformed or unknown
response shapes produce diagnostics and fixture work before they become a
supported transport contract.

## Implementation Plan

### Phase 0: Characterization and contract fixtures

- [x] Add generation 13 single and generation 14 single/batch transport fixtures.
- [x] Cover ordered side effects, per-entry errors, deletes, `parentUuid`, and
  pack scope.
- [x] Add `pm.autosave` fixtures for direct, embedded, malformed, and compendium
  UUIDs in both supported generations.
- [x] Add `manageCompendium` create/delete fixtures.
- [x] Add an in-process vertical harness from Foundry event through Store,
  SystemService, AppSocketGateway, and authorized fake users.
- [x] Add parity tests proving every active Store has complete changed/list
  event wiring and every unsupported Store remains unwired.
- [x] Add deferred-request tests for invalidation-during-fetch and
  reset-during-fetch.

**Phase 0 characterization result:** The vertical harness now exercises the
real ingress, Store, SystemService, and authenticated AppSocketGateway path. It
proves the positive owner delivery and negative non-owner delivery cases while
keeping Adventure and FogExploration explicitly unwired. The parity
characterization records five missing browser-event hops: Actor list
invalidation plus changed/list signals for the active Scene and Setting Stores.
The parity checklist remains open until Phase 2 removes those expected gaps.

**Phase 2 parity amendment:** The characterization now reports no missing
changed/list event families for active Stores. Scene and Setting have joined
the SystemService, authenticated AppSocketGateway, shared payload, and generic
SDK signal paths. Adventure and FogExploration remain absent by design, so the
test cannot accidentally treat their placeholder Stores as supported.

Existing coalesced-fetch coverage proves that invalidation during a request
schedules a trailing read. The added SDK reset race also records the current
defect: reset does not notify mounted subscribers, and an older in-flight read
can repopulate data from the previous world. Phase 2 and Phase 3 must invert
those assertions as the convergence and epoch protections are implemented.

### Phase 1: Persistence ingress normalization

- [x] Implement the shared single/batch result normalizer.
- [x] Register `modifyDocumentBatch` on CoreSocket.
- [x] Normalize inbound broadcasts and outbound dispatch acknowledgements.
- [x] Route successful batch primary and side-effect results in order.
- [x] Reject pack scope before world routing and invalidate compendium shards.
- [x] Wire `pm.autosave` to structured UUID resolution and coalesced root reads.
- [x] Wire `manageCompendium` to authoritative catalog invalidation.
- [x] Add structured malformed/error telemetry.

**Phase 1 implementation result:** CoreSocket retains the generation 13
`modifyDocument` listener and adds the generation 14
`modifyDocumentBatch` listener. Broadcasts and CoreSocket/ClientSocket
acknowledgements now pass through the same ordered normalizer. The initiating
request is fallback context only for a terse primary acknowledgement; batch
side effects must remain self-describing. Failed and malformed entries are
reported with origin, response kind, index, type, action, and side-effect
context and are not routed.

Pack scope is rejected before the world router. Pack mutations clear in-memory
index variants, remove the pack from the persistent freshness manifest, and
delete known persistent shard names. Pack reads remain isolated but do not
invalidate current content. A `manageCompendium` create applies the
authoritative server metadata while invalidating prior content under that id;
a delete removes both catalog metadata and mirrored content.

For both supported generations, CoreSocket now maps `pm.autosave(uuid, html)`
to a structured UUID parse. The HTML is not merged. Direct and embedded world
UUIDs schedule a targeted read of the owning root, and an autosave received
during that read guarantees one trailing read. The full returned root is
applied as an update so normal Store comparison emits downstream invalidation.
Compendium UUIDs invalidate only their pack. Unsupported roots, including
Adventure and FogExploration, remain unwired.

These changes do not alter requesting-user authorization: ClientSocket emits
the successful acknowledgement for cache convergence only after Foundry has
processed the operation on that user's socket. No CoreSocket write fallback,
startup-state change, browser event expansion, or module change is included in
Phase 1.

### Phase 2: Store-to-client convergence

- [x] Complete typed changed/list signal parity for every active Store.
- [x] Repair the Actor list bridge and replace the Actor throttle with trailing
  coalescing.
- [x] Apply generation 13 and generation 14 replacement/deletion field
  operations at the shared Store merge boundary.
- [x] Apply the shared trailing-refresh primitive to native browser and SDK
  document consumers.
- [x] Add SDK world/session epochs and stale-completion rejection.
- [x] Ensure reset reaches mounted subscribers.

**Phase 2 partial implementation result:** The typed
`actorListInvalidated` signal now crosses Store, SystemService,
AppSocketGateway, browser hooks, and the SDK event bus. Actor list reads use
the shared coalesced-fetch primitive, so an invalidation during an active read
schedules a trailing read instead of being discarded.

Live generation 14 testing changed one player through None, Limited, Observer,
and Owner. The Store diagnostics reported the numeric transitions, authorized
`/api/actors` reads changed membership/projection, and the mounted dashboard
updated without reload. That test also exposed serialized
`ForcedReplacement` metadata being recursively merged as ownership entries.
The shared merge correction now materializes v14 operators and the v13 legacy
replacement/deletion keys for every active direct and embedded Store. Unit
coverage verifies exact field replacement, omitted-key removal, nested
deletion, all ownership levels, and operator-metadata exclusion.

This does not close Phase 2. Scene and Setting changed/list browser parity,
non-Actor native and SDK trailing refresh, SDK epoch rejection, and mounted
subscriber reset behavior remain open. Compendium convergence continues to use
pack invalidation and rehydration rather than primary-Store merging.

**Subsequent Phase 2 parity result:** Scene and Setting changed/list parity is
now complete. Scene signals are filtered through its standard ownership policy;
an ownership-targeted list invalidation reaches only the affected player.
Setting signals enforce the Store's GM-only policy for changes, lists, and
deletes, and never include Setting document bodies. The vertical test proves
the Scene owner/non-owner cases and the Setting player-denial case; gateway
coverage proves GM delivery and listener cleanup. The remaining Phase 2 work is
non-Actor native/SDK trailing refresh, SDK world/session epoch rejection, and
mounted-subscriber reset behavior.

**Phase 2 trailing-refresh amendment:** The shared coalescer now distinguishes
ordinary concurrent reads from invalidation reads. Ordinary reads may share the
active request without scheduling another request; an invalidation received
while that request is active marks the resource dirty and guarantees exactly
one trailing authoritative read after the active request settles. Further
invalidations in the same burst coalesce into that trailing read.

That contract now covers the native Actor and Combat lists, Chat list, Journal
and folder list, an open Journal detail, User roster, native Actor detail and
per-Actor cards, and module-facing SDK document sources. Journal changed/list
signals carry only typed invalidation metadata; they increment targeted or
global revisions so an open detail can reread without exposing a document body
through realtime. The implementation does not infer changed field values from
an event payload.

Focused tests prove concurrent-read deduplication, one trailing read for an
in-flight invalidation burst, and SDK convergence when the first request returns
stale data. This amendment still does not close Phase 2: SDK world/session epoch
rejection and reset notification for already mounted subscribers remain open.

**Phase 2 epoch/reset amendment:** The app-level SDK document source now owns a
monotonic private epoch bounded by the authenticated world and user scope. A
read captures both the epoch and cache entry identity before transport work.
After every asynchronous boundary, an older completion is discarded without
recreating an entry, changing a snapshot, or notifying current-world listeners.

Reset no longer destroys mounted subscriptions. It advances the epoch, removes
unobserved entries, replaces observed snapshots with the stable loading
snapshot, and notifies their existing listeners. Entering a new authenticated
dashboard scope then starts one authoritative read for each observed key using
the current transport. Leaving the dashboard, losing authentication, changing
world, or changing user moves to a null or different scope and retires the old
epoch. This is an SDK cache boundary only; it does not alter the established
world lifecycle state machine or Foundry session restoration.

The former reset-race characterization has been inverted. Tests now prove that
mounted listeners observe reset, a previous-world response cannot repopulate
the cache, and the same mounted source converges on the new-world response.
With these assertions and the preceding parity and trailing-refresh amendments,
Phase 2 is complete.

### Phase 3: Audience and socket correctness

- [x] Introduce the structured all/users/none audience contract.
- [x] Capture pre-delete visibility and apply type-specific visibility policy.
- [x] Add multi-user positive and negative delivery tests.
- [x] Revoke or reclassify app sockets when their server session is invalidated.

#### Phase 3 audience implementation amendment - September 3, 2026

Primary Store events now carry a required server-internal `DocumentAudience`
with exactly three states: `all`, a non-empty `users` set, or `none`. The empty
set canonicalizes to `none`; the app gateway rejects missing, malformed, or
empty-user audience envelopes instead of interpreting them as broadcasts. The
gateway evaluates this envelope against the authenticated session identity and
removes it before emitting the existing skinny browser and SDK invalidation
payloads. The former optional `targetUserIds` field has therefore been removed
from those public payload contracts as well as from internal events.

The primary-document coordinator binds every active Store to the current
UserStore subject roster. Each Store calculates recipients through its own
`resolveOwnership` policy, preserving implicit GM access and non-ownership
rules such as ChatMessage author/whisper/blind visibility, Combat derived
visibility, Folder permissions, and GM-only Settings. This deliberately moves
the policy decision to the Store while the document still exists; the gateway
is a delivery boundary and does not reread mutable Store state.

Create events use post-create visibility, delete events retain pre-delete
visibility, and updates use the union of pre- and post-update visibility so a
former viewer receives the invalidation needed to discard stale state. Folder
permission/tree invalidations and Combat visibility-source mutations preserve
the same union despite their type-specific fields and projections. Broad list
invalidations use explicit `all`; a document with no authorized known subject
uses explicit `none`.

Unit characterization now covers all/users/none normalization, gateway
fail-closed behavior, stripping internal audience data, owner/non-owner/GM
delivery, implicit GM access, GM-only Setting delivery, and a private Actor
delete whose identifier reaches its prior owner and GM but not an unrelated
player. Type checking, lint, and the full unit suite pass.

Live acceptance confirmed immediate dashboard and `/api/actors` convergence
while an Actor's default ownership moved through None, Limited, Observer, and
Owner. Backend diagnostics showed explicit `all` delivery for each default
transition, as expected because a default change can affect every subject.
Chat acceptance separately produced author-only, restricted-user/GM, and
world-visible audiences as explicit `users` and `all` states, with immediate
client updates and no delivery observed outside the calculated audience.

This amendment does not complete or alter the remaining server-session
invalidation item: a socket whose server session is revoked still requires
explicit revocation or reclassification work in the next Phase 3 slice.

#### Phase 3 session-authority amendment - September 3, 2026

The Foundry user connection service now publishes a server-internal retirement
signal after deleting session authority from its in-memory map and before
waiting for Foundry logout or protected-store cleanup. A signal targets either
one session or every session and carries a bounded diagnostic reason: explicit
revocation, replacement by another login, expiry, world mismatch, invalid
persisted data, or entry into Foundry setup. Session identifiers remain inside
the server and are not emitted to browsers.

An established authenticated app socket subscribes to that authority signal.
When its session is retired, the gateway cancels deferred world attachment,
detaches every per-user Store listener, leaves the authenticated status room,
joins the public status room, removes its user and Foundry-client references,
and emits only the non-secret invalidation reason. Captured callbacks also
recheck authority and room membership before delivery. The gateway subscribes
before reconciling session validity, which closes the gap between socket
middleware authentication and connection-handler setup.

The browser disconnects the retired authenticated transport, runs the same
session-bound cleanup registered for explicit logout, clears its local session
marker, and creates a fresh public-status transport through the existing React
scope transition. Explicit logout now performs local retirement before its
best-effort server request, so a slow or unavailable Foundry logout cannot
leave the UI authenticated.

Transport and persistence races are bounded independently. Per-session
authority versions prevent a revoked in-flight restore from reinserting its
connection; a world authority epoch prevents any login or restore begun before
setup from becoming current. World-wide protected-session deletion is
serialized with individual saves, and logout removes persisted-only sessions
even when no live ClientSocket has been restored. Remote Foundry logout and
disconnect failures are diagnostic cleanup failures, not reasons to restore
local authority.

Focused tests cover explicit, expired, mismatched, malformed,
middleware-to-handler, deferred-startup, and world-wide invalidation paths,
including late transport completion and listener callbacks. Type checking,
lint, the document vertical characterization, gateway tests, and the full unit
suite pass. This amendment does not alter CoreSocket lifecycle discovery,
heartbeat retries, world state transitions, Foundry write authorization, or
module behavior.

**Live-acceptance correction - explicit logout:** The generic browser
disconnect wording above applies to unsolicited server invalidation. Explicit
logout is a short ordered exception because the login selector consumes
Foundry's public presence roster. It clears private UI state immediately, while
the gateway has already removed authenticated authority and reclassified the
existing socket into the public status room. The browser retains that
non-authoritative transport until `/logout` completes so it can observe the
user becoming inactive; a pending-logout guard prevents public status from
returning the UI to the dashboard during that interval. The cleared cookie then
causes the normal public socket scope to be established. This restores the
pre-amendment roster behavior without extending authenticated access or
changing the world lifecycle state machine.

Repeated live logout testing exposed an additional ordering race: constructing
a public status payload at the instant of authority retirement could capture
the still-active Foundry presence and complete after the later inactive update.
The gateway therefore does not manufacture a status snapshot during
retirement. Public status comes from the authoritative UserStore update or the
fresh post-logout public connection, and gateway coverage rejects any
pre-logout status emission from the retirement path.

**Final live-acceptance correction - bounded logout state:** The browser no
longer renders the normal login form while Foundry logout is unsettled. An
explicit request enters a client-only `logging-out` step that clears private
state and hides dashboard, login, player-list, and floating controls. The
server has already retired authenticated authority, while the reclassified
public socket remains available for authoritative roster updates. Status
events preserve this intermediate step and cannot return the browser to either
dashboard or login early.

The Foundry `/logout` transport is bounded to five seconds with an abort signal.
Success, upstream failure, or timeout all proceed through local disconnect,
protected-session deletion, and HttpOnly cookie clearing before the browser
enters `login` and establishes its fresh public socket. The timeout changes
only best-effort Foundry teardown latency; it does not defer local authority
revocation or alter CoreSocket world lifecycle transitions.

### Phase 4: Repair and lifecycle unification

- [x] Centralize complete world-runtime teardown.
- [x] Clear partial bootstrap state through the same operation.
- [ ] Add bounded primary and embedded Store-miss repair.
- [x] Verify setup -> world A -> shutdown -> setup -> world B transitions
  without stale-world resurrection.

**Phase 4 lifecycle implementation (September 3, 2026):**
`WorldBootstrapper.reset(reason)` is now the single active-world teardown
operation used by both `foundry:runtimeTeardown` ingress and the eventual Core
socket disconnect. It retires adapter/runtime readiness and clears all
registered primary-document Stores (including the combat encounter read
model), in-memory compendium state, shared content, user presence, and
`WorldStateStore` active runtime state. SetupManager's cached world list remains
intact because it is setup-plane state, not state derived from the departed
world. Duplicate teardown calls from an explicit lifecycle event followed by
transport disconnect remain deliberately idempotent.

The bootstrap run now carries a monotonically increasing runtime epoch.
Teardown invalidates that epoch before clearing state; a replacement bootstrap
waits for an invalidated run to unwind, and each asynchronous bootstrap
boundary rejects stale completion. A current-epoch bootstrap failure invokes
the same complete teardown operation, so partially seeded snapshots, users,
packs, documents, adapters, or runtimes cannot remain authoritative. Autosave
root refreshes carry the same epoch and discard late responses from a departed
world; a new epoch may replace an old pending refresh without waiting for its
transport timeout. These guards do not change
`WorldTransportController` heartbeat, reconnect, setup, closed, or active
transition policy.

Focused coverage verifies partial-failure teardown, old/new bootstrap
serialization, stale autosave rejection, ingress teardown delegation, and
disconnect teardown delegation.

**Live lifecycle acceptance (September 3, 2026):** With Sheet Delver kept
running, an active world was shut down to Foundry setup and a different world
was then started. Core reported the runtime teardown, continued lifecycle
monitoring, discovered the replacement world automatically, bootstrapped only
the replacement world's state, and resumed immediate document synchronization.
No stale documents from the departed world appeared in API or dashboard reads.

### Phase 5: Documentation and live acceptance

- [ ] Amend ADR-0011, ADR-0012, ADR-0019, and ADR-0031 with the implemented
  contract and any deviations from this plan.
- [ ] Document operator-facing synchronization diagnostics.
- [ ] Run unit, type, lint, integration, isolated build, CI, and live multi-user
  acceptance.
- [ ] Record residuals explicitly and close this ADR only after all phases pass.

Implementation comments are required where response normalization, UUID/root
resolution, audience calculation, or epoch rejection would otherwise be
difficult to audit. The comments must explain the protocol or invariant, not
narrate obvious assignments.

## Acceptance Matrix

The live matrix uses at least one GM, one owning player, and one non-owning
player. Mutations are initiated from Foundry and Sheet Delver wherever both
surfaces exist.

- ordinary create/update/delete for every active direct Store
- embedded create/update/delete for every registered parent route
- Actor rich-text autosave and another non-Actor rich-text autosave
- ownership transitions across Owner, Observer, Limited, None, and GM
- private ChatMessage creation/deletion with negative-recipient checks
- generation 14 ordered side-effect batches
- compendium document mutation without world Store contamination
- compendium pack create/delete with catalog refresh
- disconnect/reconnect in the same world
- world A -> setup -> world B with no world A state retained
- server session purge while its browser socket remains connected

Generation 13 and generation 14 both run single-response, autosave, and
compendium lifecycle fixtures. Generation 14 additionally runs batch fixtures.

## Alternatives Considered

### Repair only the Actor browser path

Rejected. It would hide the reported symptom while leaving every Store exposed
to missing batch and autosave ingress, stale in-flight reads, and lifecycle
races.

### Listen to every Foundry socket event

Rejected. Collaborative working steps, presence, media, canvas, and display
signals are not canonical document persistence. The complete upstream listener
inventory is classified, but only persistence events enter this contract.

### Poll all documents periodically

Rejected. Polling increases Foundry and browser load, obscures event failures,
and still needs world-epoch correctness. Bounded repair and an optional sync
token may supplement, but never replace, event-driven convergence.

### Apply autosave HTML directly to cached documents

Rejected. The event is a partial field payload addressed by UUID and can target
embedded or compendium documents. An authoritative targeted read preserves
normalization, ownership, parent routing, and version compatibility.

### Replace generation 13 handling with generation 14 batching

Rejected. Generation 13 remains supported. A shared normalizer accepts both
contracts without manufacturing a batch requirement for generation 13.

## Consequences

### Positive

- Every active Store has one auditable persistence and convergence contract.
- Foundry generation 13 remains supported while generation 14 batching is
  handled correctly.
- Rich-text persistence can no longer bypass Store ingress.
- Compendium scope cannot contaminate world Stores.
- Browser and SDK caches cannot settle permanently on a pre-change response.
- Authorization remains Foundry-native for writes and type-specific for reads
  and fan-out.
- World transitions cannot resurrect prior-world data.

### Tradeoffs

- Autosave convergence performs an additional targeted authoritative read.
- Batch ordering, dirty/trailing refresh state, and world epochs add explicit
  state that requires focused tests and diagnostics.
- Accurate delete audiences require retaining pre-delete visibility long enough
  to compute delivery.
- Full parity tests cover many Stores even where no first-party browser view
  currently consumes their events.

## Guardrails

- Do not modify separately managed modules to compensate for Core event loss.
- Do not route user writes through CoreSocket or the service account.
- Do not collapse local-development and managed module sources.
- Do not rewrite startup or world-discovery state transitions.
- Do not make polling the primary synchronization mechanism.
- Do not read or write the real `<DATA_DIR>` during automated verification.
- Do not enable Adventure or FogExploration implicitly.
- Do not expose document bodies in invalidation events.
- Do not remove generation 13 compatibility.

## Exit Criteria

ADR-0034 is complete when all implementation phases are checked, all acceptance
gates pass, live generation 13 and generation 14 verification is recorded, and
no known synchronization residual remains undocumented.
