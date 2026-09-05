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
**Status amendment (September 3, 2026):** Phase 4 is complete. Unified runtime
teardown, epoch rejection, bounded Store-miss repair, and live lifecycle and
document convergence checks are complete. A ChatMessage compatibility defect
found during live acceptance is corrected below. Phase 5 is pending.
**Status amendment (September 3, 2026):** Phase 5 is in progress. Related ADR
and operator documentation is complete; local automated gates and CI for the
Phase 4 implementation pass. Final CI for this documentation change and the
remaining live acceptance items recorded below are still open.
**Status amendment (September 3, 2026):** Targeted live generation 13
acceptance now passes. The isolated run also exposed and corrected world-import
initialization, embedded journal-page writes, canonical Folder ancestry, and
journal ordering defects. Phase 5 remains open for the residual live matrix and
green CI on these corrections.
**Status amendment (September 4, 2026):** The remaining generation 14 direct,
embedded, audience, and session-retirement live matrix now passes. All local
Phase 5 gates pass and the external dependency residual is remediated below.
Phase 5 awaits only green CI on the final closeout commit before this ADR is
marked complete.
**Final status amendment (September 4, 2026):** Phase 5 and this ADR are
complete. Closeout commit `49bb089` passed both the Node 22 verification and
dependency-review jobs in
[GitHub Actions run 33898769671](https://github.com/sheetdelver/sheetdelver/actions/runs/33898769671).
The automated gates,
generation 13 and generation 14 live acceptance matrix, dependency remediation,
and editor regression checks recorded below all pass. No unrecorded
synchronization residual remains; this ADR is accepted and implemented.
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
- [x] Add bounded primary and embedded Store-miss repair.
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

**Connected-Setup launch correction (September 4, 2026):** Follow-up testing
exposed a narrower reconnect defect when Foundry reported
`launchWorld`/`complete` over a still-connected Setup socket. The controller
reset its retry delay and called the existing connection flow, but
`CoreSocket.connect()` correctly treated the live Setup transport as already
connected and returned without probing the launched world. The progress
handler now disconnects that obsolete Setup transport before starting the same
connection flow. This preserves the established setup/active/closed state
machine, service-account authentication, retry policy, and fallback heartbeat;
it only ensures that the explicit launch-complete signal cannot be stranded by
the transport's connected guard. A focused controller test fixes the ordering
contract by requiring one disconnect followed by one connection attempt.

An isolated upgrade from generation 14 build 359 to build 367 additionally
confirmed that the fallback lifecycle path still discovers an active world,
authenticates the service account, seeds all primary Stores, and reaches
`ready`. That upgrade was detected on the scheduled Setup probe because no
live Setup progress socket was attached at launch; it is fallback-path evidence,
not a substitute for the focused connected-Setup test above.

**Phase 4 Store-miss repair implementation (September 3, 2026):** The shared
`PrimaryDocumentStore.applyModifyDocument` boundary now returns typed repair
targets for direct partial updates whose root is absent and for any embedded
mutation whose registered primary parent is absent. Direct update ids are
resolved from normalized results, `operation.updates`, and `operation.ids`;
embedded roots are resolved from the registered parent UUID. Individual Store
handlers continue to own normal type-specific mutation semantics and are not
given partial synthetic parents.

`ModifyDocumentRouter` preserves repair targets in its dispatched outcome,
and `FoundryEventIngress` coalesces those targets with its authoritative root
refresh machinery. Repair reads use CoreSocket only for a targeted,
non-broadcast `get`; the requesting user's write path remains unchanged. A
successful full-root response is applied as a create to restore list
membership, while same-root misses arriving during the read guarantee a
trailing authoritative refresh. Repair bursts are capped at three reads.
Missing transport, transport failure, an empty/mismatched response, or cap
exhaustion produces a typed `unavailable` diagnostic through `logger.warn`.
All repair work carries the current world epoch, so teardown discards late
responses instead of repopulating the replacement world. Autosave-only
coalescing retains its existing trailing-refresh behavior and is not subject
to the repair-attempt cap.

**Phase 4 live-acceptance compatibility correction (September 3, 2026):** An
actor roll reached Foundry over the correct requesting-user transport but was
rejected by generation 14 because Core still created the ChatMessage with
numeric `type: 5`. This was not an ingress or Store-repair failure. Generation
13 already defines the numeric presentation field as `style` and only accepted
numeric `type` through a deprecated migration; generation 14 removed that
migration because `type` is now reserved for string document subtypes.

Core-owned text payloads now use `style: 1`. Roll payloads use `style: 0` and
the populated `rolls` array, which is the supported roll discriminator in both
generations 13 and 14. The chat read projection likewise recognizes populated
`rolls`, while retaining `type: 5` only as an inbound compatibility fallback
for stale cache data.

The ChatMessage Repository also converts numeric legacy `type` values to the
equivalent valid `style` before create dispatch. Values outside the supported
0-3 style range become `style: 0`, matching generation 13's former migration
for removed ROLL and WHISPER enum values. String `type` values remain unchanged
so system-defined ChatMessage subtypes continue to work. This boundary applies
equally to route and SDK callers and does not branch on a particular generation
14 build.

### Phase 5: Documentation and live acceptance

- [x] Amend ADR-0011, ADR-0012, ADR-0019, and ADR-0031 with the implemented
  contract and any deviations from this plan.
- [x] Document operator-facing synchronization diagnostics.
- [ ] Run unit, type, lint, integration, isolated build, CI, and live multi-user
  acceptance.
- [ ] Record residuals explicitly and close this ADR only after all phases pass.

**Phase 5 checklist disposition (September 4, 2026):** The two historically
open entries above are satisfied by the subsequent automated, live, residual,
and dependency evidence in this ADR.
[GitHub Actions run 33898769671](https://github.com/sheetdelver/sheetdelver/actions/runs/33898769671) passed for
closeout commit `49bb089`, completing the final external gate.

**Phase 5 documentation result (September 3, 2026):** ADR-0011 now records
field-operator materialization, Store-miss repair, epoch teardown, active Store
scope, and ChatMessage Repository normalization. ADR-0012 records the final
all/users/none audience envelope, pre/post visibility rules, trailing reads,
SDK epochs, missing-root event behavior, and immediate app-socket authority
retirement. ADR-0019 records the implemented single/batch/autosave/compendium
contract and the generation-neutral ChatMessage `style` correction. ADR-0031
records the final ordered delete and deletion-safe audience behavior.

`docs/foundry-socket.md` now maps the exact server-side ingress, autosave,
repair, and compendium warning classes to operator actions. Browser console
output is not an operational failure surface, and no guidance suggests
rerouting a failed user write through the service account.

**Automated acceptance evidence (September 3, 2026):** Full lint, TypeScript,
unit, and isolated integration suites pass. The production build passes with
`SHEET_DELVER_DATA` set to `/tmp/sheet-delver-lifecycle-build`; no real
`<DATA_DIR>` content was read or written. A CycloneDX 1.5 production SBOM was
generated in `/tmp` with 199 components. The configured production dependency
gate (`npm audit --omit=dev --audit-level=high`) passes. GitHub CI run 277 passed
for implementation commit `fe7d1c0`, including dependency review in
[GitHub CI run 277](https://github.com/sheetdelver/sheetdelver/actions/runs/33799430718).
The eventual Phase 5 documentation commit still requires its own green CI run.

**Recorded live acceptance:** Generation 14 testing confirmed immediate Actor
list/detail convergence through None, Limited, Observer, and Owner ownership
transitions; default-ownership broadcast behavior; ordinary document updates
and mutations; audience-correct private and world-visible ChatMessage delivery;
repeated login/logout; restart restoration; setup/world lifecycle recovery;
world replacement without stale state; and actor roll creation with the
canonical ChatMessage `style`/`rolls` shape.


**Generation 13 live acceptance amendment (September 3, 2026):** The current
branch was run against Foundry generation 13 build 351 with a Daggerheart world,
an Assistant-role service account, and a separate player account. Sheet Delver
used an isolated source copy, data directory, configuration directory, and
ports; neither the normal Sheet Delver data directory nor the generation 14
instance participated in the test.

Core completed the generation 13 login contract, bootstrap, player login,
session restoration, and single `modifyDocument` ingress. Live mutations
covered User creation/update, Actor creation and field changes, embedded Actor
Item creation, player-specific Actor ownership transitions through visible and
hidden states, JournalEntry and JournalEntryPage creation/update, and loss plus
restoration of Actor visibility. Dashboard and authorized API projections
updated without a Sheet Delver restart.

**Isolated acceptance tooling correction:** The live setup exposed that
`admin:import` resolved paths before initializing Core's managed data-directory
state. It could scrape a world and print success while `PersistentCache` failed
to write the discovered metadata. The importer now initializes the resolved
`SHEET_DELVER_DATA` or `--data-dir` path before constructing SetupManager,
reads the saved cache back before reporting success, and selects the imported
world when exactly one world was discovered. A child-process test invokes the
real command against temporary Foundry and Sheet Delver directories and verifies
the persisted metadata and current world id.

**Journal live-acceptance correction:** The pre-correction editor updated page
text by replacing the parent JournalEntry's complete `pages` array. Foundry
accepted the write, but a partial parent update result could replace hydrated
page fields in the Store; page visibility projection then omitted the damaged
cached page and Sheet Delver displayed blank content. Page edits now dispatch a
version-neutral embedded `JournalEntryPage` update with the parent
`JournalEntry.<id>`. The existing embedded Store path merges only the returned
page delta and preserves ownership, identity, and other page metadata.

The same live run exposed a separate directory projection mismatch. Foundry
generation 13 and 14 both persist a Folder's parent id in `folder`, while the
Sheet Delver tree expected `parent`. FolderStore now normalizes canonical
`folder` values and both generations' serialized replacement/deletion forms
into the established internal parent projection. New folder creates send the
canonical field. The journal browser sorts nested siblings according to each
parent Folder's persisted alphabetical/manual mode, uses persisted numeric sort
at the root where Foundry's own mode is browser-local, and orders
JournalEntryPages by their numeric `sort` value. Focused tests cover canonical
ancestry, service projection, non-mutating sibling ordering, and page order.

These corrections use contracts shared by generations 13 and 14. They do not
branch on a specific Foundry build, change requesting-user authorization, alter
the world lifecycle state machine, or modify a system module.

**Generation 13 correction-batch verification:** Live generation 13 acceptance
confirmed immediate JournalEntryPage text persistence, canonical folder and
subfolder projection, sibling ordering, and numeric page ordering. TypeScript,
lint, the full unit suite, the isolated integration suite, and a Turbopack
production build all pass. The build used a credential-free generated fixture
and an isolated source tree outside the repository; it did not read or write the
normal Sheet Delver `<DATA_DIR>`. CI evidence remains pending until this batch is
committed and pushed.

**Embedded autosave acceptance correction:** A generation 13 ProseMirror
autosave was exercised while the journal modal displayed a noninitial page.
The persisted page content converged immediately, but the revision-triggered
detail refresh also reused the journal-open initialization path, displayed its
loading state, and reset navigation to the first page. The modal now keys its
selection by JournalEntryPage id, resets only when journal identity changes,
retains the same page across refreshed or reordered payloads, and falls back to
the first sorted page only when the selected page was removed. The repeated
live autosave converged without a modal reload or page-selection change.

**Generic field-editor acceptance correction:** Live generation 13 testing of
direct Actor biography fields exposed a client-side stale-draft hazard in the
generic fallback sheet. A primitive field captured its value only when the
component first mounted. After a realtime refresh, merely focusing and blurring
the field could compare that stale draft with the current prop and overwrite
Foundry even though the user had made no edit. The generic editor now snapshots
the latest value when editing begins and requires both explicit user input and
a value difference before dispatching a mutation. Long, multiline, HTML, and
known narrative fields use a resizable multiline text control while short
scalar fields retain the compact control. Live acceptance confirmed that
inspecting a narrative field performs no write and that an actual edit produces
one user-scoped update.

**Direct-root autosave acceptance:** Live generation 13 testing edited an
Actor biography field through Foundry's ProseMirror control while the same
Actor remained open in Sheet Delver. Foundry's generation 13 authority emits
`pm.autosave` before saving the owning root, so the later
`modifyDocument` broadcast is an expected second persistence signal rather
than a distinct user mutation. Sheet Delver converged to the persisted text
without a browser reload or a write from its generic sheet. This closes the
generation 13 direct-root Actor autosave acceptance item while retaining both
ingress paths.


**Generation 13 compendium acceptance:** A temporary world Item compendium was
created through Foundry, populated with an Item, updated, emptied, and deleted.
Sheet Delver applied both `manageCompendium` catalog transitions immediately.
Each pack-scoped `modifyDocument` create, update, and delete invalidated only
that pack's content shard and never entered the world Item Store. Debug
completion telemetry now records the operation, pack id, and outcome without
logging document rows or pack metadata, making the catalog and shard boundaries
auditable in live environments. The isolated test had no preexisting hydrated
shard, so persistent deletion correctly resolved as a cache miss; fixture and
store tests retain coverage for removal of populated manifests and historical
and stable shard keys.

**Open synchronization acceptance:** Targeted live generation 13
single-response, direct/embedded mutation, ownership, session, and journal
coverage now passes. The full manual matrix for every active direct Store and
every registered embedded route and live generation 14 side-effect batching
still lack complete recorded evidence. These are acceptance gaps, not known
failing behavior.

**Generation 14 build-367 batch acceptance amendment (September 4, 2026):**
The final clause above is now satisfied for the build boundary that introduced
observer-facing `modifyDocumentBatch`. This is feature-specific evidence for
the batch transport contract, not a claim that build 367 is the latest or
maximum supported generation 14 build. Generation 13 and pre-batch generation
14 single-response handling remain intact.

An isolated build-367 Daggerheart world issued a two-operation Macro/RollTable
create batch and a corresponding delete batch. CoreSocket received one batch
envelope for each request; ingress retained wire indices zero and one and
routed both entries to their correct primary Stores without duplication. A
second probe activated a replacement Combat. Foundry emitted the implicit
deactivation of the prior Combat first with `sideEffect: true`, followed by the
explicit Combat creation with `sideEffect: false`. Sheet Delver applied both
entries to CombatStore in that order, while Foundry's initiating-client result
correctly returned only the explicit operation. The temporary Macro,
RollTable, and Combat documents were removed after verification.

The remaining open acceptance scope is the exhaustive manual matrix for every
active direct Store and every registered embedded route. No generation 14
batch or side-effect transport defect remains open from this item.

**TableResult contract correction and live acceptance (September 4, 2026):**
The original `RollTableResults` wording above was descriptive, but the first
remaining-matrix audit found that it had also become an incorrect wire-type
literal in RollTableStore and RollTableRepository. Foundry generation 13 and
generation 14 both define the embedded document as `TableResult`; no
`RollTableResult` socket document type exists. The Store therefore ignored
real Foundry result-row broadcasts, while Repository result mutations would
have dispatched an invalid document name.

The ingress guard, Repository dispatches, router fixtures, Store fixtures,
resolver fixture, and live/manual documentation now use canonical
`TableResult`. The internal `RollTableResultDocument` TypeScript interface
retains its semantic name because it describes a result row and is not exposed
as a transport literal. A metadata comparison of every registered embedded
handler against the installed generation 13 and generation 14 document sources
found no other name mismatch.

Live generation 14 build-367 verification created a temporary RollTable,
created and updated its embedded TableResult, deleted the result, and deleted
the table. Core received all five single responses in order. The three
TableResult operations carried `parentUuid: RollTable.<id>`, routed through
the embedded handler, and each applied a parent RollTable update without a
repair or dropped-event warning. The temporary documents were removed after
verification.

**Playlist synchronization acceptance (September 4, 2026):** Playlist and
PlaylistSound remain active document-cache types so module document reads and
SDK change signals can observe Foundry playlist metadata. This is not an audio
transport or playback feature: Sheet Delver does not stream media, expose
playback controls, or publish a dedicated PlaylistSound mutation API.

Live generation 14 build-367 verification created and updated a temporary
Playlist, created and updated one embedded PlaylistSound with an empty media
path, deleted the sound, and deleted the playlist. Core received all six
single responses. Playlist operations routed directly to PlaylistStore;
PlaylistSound operations routed through the Playlist embedded handler and
applied updates to the correct parent. No audio was played, and no dropped
event or repair warning occurred. The temporary documents were removed during
the probe. Foundry generation 13 and generation 14 expose the same Playlist
and PlaylistSound metadata names and schemas for this tested contract.

**Cards synchronization acceptance (September 4, 2026):** The source audit
corrected an imprecise transfer description and fixture without changing
runtime behavior. Foundry generation 13 and generation 14 both implement a
home-deck pass as a destination Card create plus a home Card `drawn` update;
returning that card updates the home Card and deletes the destination copy.
The focused Store and router fixtures now model both parent legs rather than a
generic delete/create pair.

Live generation 14 build-367 verification created a temporary deck and hand,
updated the deck, created and updated its embedded Card, passed the Card to the
hand, returned it to the deck, and deleted both Cards documents. Every direct
and embedded response routed to the correct Store and parent without a dropped
event or repair warning. Deleting the two Cards documents caused Foundry to
create its standard return/recall ChatMessages independently of the pass
notification option. Those two messages were then deleted in one operation;
Core applied both deletion results and the probe left no temporary documents.
As with Playlist, Cards data remains synchronized for generic module reads and
future support; Sheet Delver has no current in-tree Cards UI consumer.

**World Item ActiveEffect acceptance (September 4, 2026):** Foundry
generation 13 and generation 14 retain the same `Item` and `ActiveEffect`
document names and `Item.<id>` parent UUID contract. Generation 14 substantially
changed the ActiveEffect data schema, but ItemStore intentionally treats effect
rows as opaque documents and deep-merges the fields Foundry emits. No
generation-specific effect-field translation is required for synchronization.
Actor-owned Item effects remain a separate path rooted at
`Actor.<id>.Item.<id>` and continue to route to ActorStore.

Live generation 14 build-367 verification created a valid system-specific
world Item, updated a nested system description, created and updated a disabled
embedded ActiveEffect with no changes, deleted the effect, and deleted the
Item. Core received all six single responses. Item operations routed directly
to ItemStore, while each ActiveEffect operation routed through the Item
embedded handler and updated the correct parent. No dropped event, repair
warning, or temporary document remained after the probe.

**Actor ActiveEffect acceptance (September 4, 2026):** Focused ActorStore
characterization now covers create, update, and broadcast-shaped delete for
both effect parent forms. `Actor.<id>` mutates the Actor's top-level effects;
`Actor.<id>.Item.<id>` mutates only that embedded Item's effects. The nested
path is also asserted not to leak data into the Actor-level effect collection.

Live generation 14 build-367 verification created a disposable
system-specific Actor and embedded Item, then performed create, update, and
delete for an Actor ActiveEffect and for an ActiveEffect on the embedded Item.
Both disabled effects contained no changes. Every response routed through the
Actor embedded handler and applied an update to the correct cached Actor. The
embedded Item and Actor were then deleted, with no dropped event, repair
warning, or temporary document remaining.

**Combatant and CombatantGroup audit correction (September 4, 2026):** Local
generation 13 and generation 14 document sources both define `Combatant` and
`CombatantGroup` as embedded collections of `Combat`, with the same
`Combat.<id>` parent UUID contract. CombatStore and inbound router coverage
already applied both child types correctly. The audit found one outbound
ownership omission: the route facade selected CombatRepository for Combatant
but allowed CombatantGroup to fall through to the request transport. That path
still used the requesting user's authenticated socket and did not bypass
Foundry authorization, but it omitted the Repository's explicit initiator-side
mirror contract.

The route facade now selects CombatRepository for every `Combat` parent and
for direct type discrimination of both embedded child names. CombatRepository
also exposes symmetric CombatantGroup create, update, and delete helpers.
Focused tests cover the three Repository mutations, parent UUID construction,
route-facade mirroring, and inbound router selection. The shared group shape
now includes Foundry's `type` field and no longer describes the document as
generation-13-only. This correction does not expose a new UI or SDK helper and
does not broaden write authorization; Foundry remains the mutation authority.

Live generation 14 build-367 verification created a disposable Actor and
Combat, created and updated an embedded CombatantGroup, and created and updated
an embedded Combatant linked to both the Actor and group. Core routed all four
embedded responses through CombatStore using `Combat.<id>` and applied each as
an update to the correct cached parent. Adding the visible combatant and then
hiding it each emitted the expected combat-list visibility invalidation. The
Combatant, CombatantGroup, Combat, and Actor were then deleted in that order;
all four deletes converged without a dropped event or repair warning, and no
temporary document remained.

**Scene, Token, and ActorDelta audit correction (September 4, 2026):** Scene
remains an internal Store used by combat projection; it is not exposed through
module document APIs or a public route, so this amendment does not add a
SceneRepository or broaden canvas/scene access. Foundry generation 13 and
generation 14 both root supported synthetic actor persistence at
`Scene.<sceneId>.Token.<tokenId>`: ActorDelta is the Token's singleton child,
and its Item and ActiveEffect collections are deltas against the base Actor.

The audit found that SceneStore treated every ActiveEffect below ActorDelta as
a top-level delta effect. A deeper effect whose parent was
`...ActorDelta.<deltaId>.Item.<itemId>` could therefore enter the wrong
collection. It also treated ActorDelta Item/ActiveEffect arrays as ordinary
embedded collections, which cannot represent Foundry's adoption, inherited
delete tombstone, or `restoreDelta` semantics. SceneStore now routes by the
complete parent UUID depth, adopts an inherited Item before applying its nested
effect, upserts first updates to inherited delta children, preserves tombstones
for inherited deletes using the bound ActorStore, removes overrides on
`restoreDelta`, and resets a deleted ActorDelta to its empty token-owned form.

Focused coverage now includes direct Scene CRUD, Token CRUD, ActorDelta merge
and reset, direct delta Item/ActiveEffect mutation, inherited-child adoption,
tombstone and restore behavior, nested Item ActiveEffect CRUD with a non-leak
assertion, and Scene-rooted router selection. Direct ActorDelta and
ActorDelta-rooted child events remain deliberately dropped because they lack
the owning Scene/Token identity; parented routing still cannot fall through
into a world Item Store.

Live generation 14 acceptance was completed against Foundry build 367 with
Daggerheart 2.9.2 using an inactive disposable Scene and unlinked Token. Direct
Scene and Token updates, synthetic ActorDelta update, delta Item and
ActiveEffect create/update, nested Item ActiveEffect create/update, inherited
Item adoption, and inherited ActiveEffect deletion all arrived as SceneStore
mutations. Foundry's resulting delta kept the nested effect under its Item,
stored the inherited Item override, and represented the inherited effect
deletion as an `_tombstone` row. A follow-up restored that tombstone, deleted
the nested and delta-only children, reset the ActorDelta, and deleted the Token,
Scene, and base Actor. Core routing reported every synthetic child operation
as an embedded Scene dispatch, and all temporary documents were removed.

**Setting scope audit correction (September 4, 2026):** Foundry generations
13 and 14 use the same Setting schema and store user- and world-scoped rows in
one collection. Foundry's own world lookup matches both the setting key and a
null user id. Sheet Delver's privileged `getValueByKey` accessor previously
matched only the key, so collection order could allow a user-scoped row to
stand in for world configuration consumed by Core. The accessor now mirrors
Foundry's null-user lookup, the shared Setting shape records the user field,
and regression coverage places a same-key user row before the world row. This
does not expose Setting documents, broaden their GM-only Sheet Delver audience,
or alter Foundry's native mutation authorization.

Live generation 14 build-367 verification created an unregistered disposable
world Setting with `user: null`, updated its JSON-serialized value, and deleted
it. Core received the create, sparse update, and delete responses in order,
routed all three directly to SettingStore, and calculated the expected GM-only
audience. The key had no registered configuration or change callback, no
existing Foundry or system setting was modified, and no temporary row remained.

**User authority audit correction (September 4, 2026):** Foundry generations
13 and 14 retain the same persisted User schema and native create, update, and
delete permission rules. Sheet Delver accepts both the dedicated User
compatibility events retained by Foundry and normalized `modifyDocument`
responses; UserStore remains the canonical roster for either path. User role
changes are read from that Store when each request, module access context, or
document audience is evaluated, so an existing browser connection does not
cache its former role. Browser status and session-user routes continue to use
explicit allowlists and do not expose password fields, password salts,
permissions, hotbars, flags, or document statistics from the synchronized
User row.

The audit found two delete-only gaps. Presence removal was attached only to the
compatibility ingress branch, so a normalized User delete could remove the
document while leaving subordinate presence state behind. More importantly,
deleting a Foundry User did not retire live or encrypted Sheet Delver sessions
belonging to that user. UserStore now removes presence from its canonical
delete event regardless of wire origin. The composition root observes that
same event and asks FoundryUserConnectionService to revoke every live and
persisted session matching the deleted Foundry user id. Revocation reaches
connected app sockets through the existing `sessionInvalidated` path, removes
protected credentials before best-effort upstream logout, leaves other users'
sessions intact, and blocks a concurrent login or restore from reintroducing
the deleted identity. The user-id tombstone is scoped to the current world and
is cleared with the existing all-session teardown on entry to setup.

Focused coverage now proves canonical presence cleanup, immediate role
resolution, selective live and persisted session retirement, preservation of
unrelated users' sessions, browser-authority invalidation signaling, and stale
credential rejection. Live generation 14 create/update/delete and connected-
session retirement remain the acceptance step for this User slice; equivalent
generation 13 User CRUD was exercised earlier in this ADR's live matrix.

**Subsequent User live-acceptance result (September 4, 2026):** Live
generation 14 build-367 verification created a disposable User, applied a
name and role update, and deleted it. Core received all three operations as
normalized `modifyDocument` responses, routed them directly through
UserStore, and reflected the current roster without a restart. The temporary
User was removed after the probe.

A separate disposable player then logged into the isolated Sheet Delver test
runtime before its Foundry User document was deleted. The canonical UserStore
delete immediately removed the roster entry, reclassified the connected app
socket with the `user-deleted` reason, cleared the protected session record,
and disconnected the live Foundry transport. The browser returned to login
and no longer listed the deleted user. The best-effort upstream logout returned
404 because Foundry had already deleted the account; local revocation had
completed first and did not depend on that response. This closes the live
generation 14 User CRUD and connected-session retirement acceptance step while
retaining the earlier generation 13 CRUD evidence.

**External merge residual:** The high-severity production audit gate passes,
but npm currently reports moderate advisories for the directly declared Tiptap
3.30.2 family and transitive `qs` 6.15.3. They are not synchronization defects
and do not change this ADR's architecture, but dependency upgrades and their
editor/request regression checks should be resolved or explicitly accepted
before merging to main. The registry currently offers Tiptap 3.31.2 and `qs`
6.16.0 as upgrade targets.

**Subsequent dependency and editor closeout (September 4, 2026):** The Tiptap
family was upgraded together to 3.31.3, transitive `qs` was upgraded to 6.16.0,
and ESLint's development-only `@humanfs/node` was upgraded to 0.16.8. The final
peer graph is valid, and both full and production-only npm audits report zero
vulnerabilities. TypeScript, lint, the full unit suite, the isolated integration
suite, and a production build against an operating-system temporary data
directory pass.

The editor smoke test confirmed Sheet Delver-to-Foundry rich-text persistence
and formatting after the Tiptap upgrade. It also exposed an existing display
gap: Tailwind preflight removed semantic heading sizes and list markers while
the editor referenced `prose` classes without the typography plugin that
defines them. RichTextEditor now applies a stable, scoped content class, and
Core CSS explicitly restores H1/H2 hierarchy and ordered/unordered list
markers without changing persisted HTML or adding another dependency. Live
retesting confirmed headings, lists, inline formatting, save, reopen, and
Foundry round-trip behavior.

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
