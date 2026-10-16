# API Documentation

The Sheet Delver API exposes Foundry-backed data through the Core Service.
Browser user routes use an HttpOnly player-session cookie. Trusted server-side
callers may use an explicit bearer session credential. Admin routes are
protected by the opaque admin session cookie and CSRF flow.

Examples use abstract ids such as `<moduleId>`, `<actorId>`, and
`example-system`; do not treat them as bundled systems.

---

## Authentication

Player login throttling counts failed requests per IP, not successful logins.
It is bypassed only in explicit development mode. The default window is one
minute with five failures; a 429 response includes `Retry-After`. Explicit
configuration values remain authoritative. See [Configuration](CONFIGURATION.md).

Shared UI themes are a client SDK surface, not a REST payload. SDK 1.5.0 /
`ui-extension-api` 1.3.0 loads `theme` and `componentStyles` from the UI manifest
so executable style callbacks never need serialization. See
[Shared UI Themes](MODULE_AUTHORING.md#shared-ui-themes).
SDK 2.0.0 / `ui-extension-api` 2.0.0 replaces module-rendered dashboard tools
with Core-rendered `dashboardActions`; this is also a client manifest contract,
not a REST response. Module-owned pages and dialogs retain their own styling.

Browser login sets the `sheet-delver-session` HttpOnly, SameSite=Strict cookie;
the reusable session credential is never returned to browser JavaScript.
Trusted non-browser callers can instead present:

```http
Authorization: Bearer <token>
```

Admin mutation routes require the admin session plus CSRF token handled by the
admin UI client.

Every Core response includes a server-generated `X-Request-ID`. Production
JSON 500 responses use:

```json
{
  "error": "Internal server error",
  "code": "internal-error",
  "requestId": "correlation-uuid"
}
```

Malformed JSON uses `invalid-json`; an oversized request uses
`request-body-too-large`. Intentional 4xx, 501, and 503 endpoint contracts are
not converted to internal errors.

---

## Session And Status

### `GET /api/status`

Auth: try-auth.

Unauthenticated callers receive the public availability projection and a
minimum login roster: display name, active state, and server-decided login
eligibility only. It omits user/world identifiers, roles, actor links, avatars,
Foundry URL, private world content, and debug configuration.

Authenticated callers receive connection, world, current-user, and readiness
status. `initialized: true` means world bootstrap has completed, including
module discovery, compendium indexing/hydration, and primary document cache
seeding.
During startup, `isAuthenticated: false` on this status response is not proof
that a persisted player session was revoked. Player session authority is
checked through the protected session read below.

**Unreleased prerequisite (ADR-0064):** Core's configured Foundry service account must
be full Gamemaster for every world connection. The connection/reconnect/
demotion gate holds readiness and world-backed routes unavailable when that
role cannot be verified. The admin status/recovery projection explains the
required role and correction in Foundry; public/player status must omit the account
identity and role error detail. This does not change ordinary Assistant/player
request permissions. See [configuration recovery](CONFIGURATION.md#service-account-role-and-recovery).
Published Core 0.18.1 does not implement this gate.

```json
{
  "connected": true,
  "isAuthenticated": true,
  "currentUserId": "user-id",
  "initialized": true,
  "users": [
    {
      "_id": "user-id",
      "name": "User",
      "role": 4,
      "isGM": true,
      "active": true,
      "img": "path/or/url"
    }
  ],
  "system": {
    "id": "example-system",
    "status": "active",
    "worldTitle": "Example World"
  },
  "url": "http://foundry.example",
  "appVersion": "0.10.0"
}
```

### `GET /api/session/users`

Auth: required player session (or trusted service bearer). The response is
`Cache-Control: no-store` and contains the authorized user roster plus
`currentUserId`, the authenticated Foundry user ID (`null` for a trusted
service bearer). It never returns the opaque session credential. Player clients
use this protected read to validate the current cookie and compare the user ID
before resuming a retained page after a connection interruption.

An absent, expired, revoked or conclusively invalid player session returns
`401`. A pending or temporarily failed restoration returns `503`; the client
must not treat that as logout. A successful read validates the current cookie,
not continuity with a previous same-user cookie in another tab.
The authenticated roster may mark the resolved service account with
`isServiceAccount: true` for human-participant UI filtering. It remains in the
canonical Foundry user store and retains its authorization semantics.

### `POST /api/login`

Body:

```json
{ "username": "User", "password": "password" }
```

Response:

```json
{ "success": true, "userId": "user-id" }
```

The request body is limited to 8 KiB. Usernames are trimmed and bounded to
1-128 characters; passwords are bounded to 1024 characters.

This browser-facing contract is stable across supported Foundry generations.
Core resolves the user id and negotiates Foundry's upstream `/join` payload:
generation 13 and generation 14 through build 365 use `userid`; generation 14
build 366 and later use `username` plus `userId`. The resolved id and
upstream cookie remain server-side.

### `POST /api/logout`

Auth: protected.

Destroys the current user session and closes the user's upstream Foundry
transport.

### `GET /api/system`

Auth: protected.

Returns basic active-system and world information.

### `GET /api/system/data`

Auth: protected.

Returns system data produced by the active adapter. Adapter data is sourced from
the module runtime, not from a broad module-facing client.

---

## GM Combat Manager

All `/api/combat-manager` routes require an authenticated Foundry Gamemaster
or Assistant (roles 4/3); players, trusted users and banned users receive `403`.
Actor/Combat/Folder operation capability includes Assistant, matching native
Foundry. Compendium access uses the native generation and current role ownership;
Actor copies additionally require `ACTOR_CREATE`, and wildcard token images
require `FILES_BROWSE`. v13 permits explicit revocation; v14 mandates these two
permissions for Assistant/GM. Missing permission state fails closed. Every write
uses the caller's transport and rechecks current authority; no service-account
fallback occurs. SheetDelver administration and world-setting writes retain
their separate policies. The manager lists only
SheetDelver-marked, scene-null Combats. Responses are bounded projections, not
raw Combat, Actor, Folder or compendium documents. Errors return `{ "error":
"..." }`; a write rejected because another change to the same encounter is in
progress returns `409` with `"code": "ENCOUNTER_BUSY"`, which clients should
match instead of the message. Foundry remains the final write-permission
authority. Creation leaves Foundry's global `active` bit off; Begin sets it,
warning only if another Combat is currently active (Foundry deactivates that
Combat). The manager's lifecycle status is stored separately in its Combat
flag. Participant projections include a Foundry-style `isNpc` flag: no non-GM
user owns that world Actor, independent of system Actor type. Combat stats use
the shared GM selection for the active world/system module, stored durably
under the Core data directory's `config/`. A saved empty selection suppresses
module defaults. Stat values may be derived from prepared Actors. A GM may opt
a selected `system.*` numeric or resource field into editing, but the control
appears only where its prepared value matches a source Actor number. Module
suggestions and `derived.*` fields never grant edit access on their own. The
separately configured tracker resource also remains editable when
source-backed. Stat, tracked-resource and initiative number edits commit on
blur or Enter without a per-field Save button. Exactly one editable selected
field may be flagged as default health for the roster Damage action. Its modal
shows current and source max when available, supports direct current editing,
and applies Heal/Damage as plain arithmetic without system-specific rules or
automatic clamping. A GM may also select up to 100 eligible rows for one
guarded Damage/Heal batch; all targets are checked for stale values before
writing, while a later write failure reports how many writes completed. A GM
initiative override formula is stored in the same world/module preference.
Resolution is explicit GM override, then module formula, then Core `1d20`.
Clearing it restores module-first resolution; a broken explicit override fails
closed rather than falling back. Before saving, Core validates the bounded
grammar and safe finite numeric prepared-Actor references against every current
participant in active managed encounters, including hidden/scored rows. Actor
source access and user/world/runtime scope are rechecked after dependency reads.
An attribute formula without participants cannot be certified and returns 400;
invalid inputs leave the saved preference unchanged. Validation parses without
rolling or creating chat. New participants/value changes still require execution
revalidation. Module formulas are not passed through the GM reference resolver.
The manager's searchable numeric picker uses the existing observed field catalog,
including resource leaves such as `.value` and `.max`, to insert references into
the draft. It does not save or evaluate them. GM stat selections have no fixed
field-count cap; path/type/label/key/editability checks remain. Module metadata
still permits at most 16 suggestions, and compact HUD presentation is separate.
The existing 256000-byte preference-file limit is checked before replacement;
an oversized save returns 413 without making the prior file unreadable. Ordinary
HTTP body limits also still apply. Advanced custom fields use a read-only exact
path/type check against authorized prepared world Actors, not catalog sampling.
Missing fields return 404, invalid/mismatched kinds 400; no Actor values or IDs,
document writes, chat, dice or persisted permissions are involved. Existence
on one type does not guarantee every Actor supplies it; missing display values
remain hidden and future edits retain their normal source-backed guards.
Preference changes emit an empty
`combatManagerPreferencesChanged` app-socket event to current Gamemaster and
Assistant sockets, causing other manager pages to refetch. An empty
`combatTrackerPreferencesChanged` event prompts authenticated HUD clients to
refetch their own authorized tracker projection; it never exposes the GM
preferences route or descriptor paths. A selected descriptor's optional
`showInRoster` produces a read-only participant pill, in descriptor order;
other stats remain in the detail panel. See
[ADR-0049](adr/0049-core-gm-combat-manager.md) and the Assistant amendment in
[ADR-0062](adr/0062-observed-player-issues.md).

**Managed queue and display refinements (ADR-0061 N1–N6):** null-scored rows
remain after scored rows in the manager list, but never enter the executable
queue/player turn roster. Begin/navigation require an eligible scored row;
otherwise return 409 without advancing a round. Zero and finite fractions are
scored values. Managed navigation/previews require finite initiative and not
explicitly Skip, mapping identities to full native indexes. Defeat/Hidden alone
do not exclude a managed turn; ordinary Combat setting behavior is unchanged.
Late NPC Combatants default
hidden; scoring does not reveal them. Clearing the current score (including
Reset All) first persists a pause anchor on the Combat and clears `turn`.
`awaitingInitiative`/`canNavigateTurns` are manager-only DTO state. GM Next/
Previous or explicit GM restoration of the anchored row releases the pause;
owner rolls and unrelated scores do not. The saved original score/id prevents
pending regrouping from causing an accidental round wrap. A failed score clear
may leave the encounter safely paused with the old score: refresh, then restore
or navigate explicitly. This is not an atomic multi-document transaction.

GM selections accept `kind: "textarea"` in addition to number/text/resource,
with optional `layout: { columnSpan, rowSpan, textRows }`: integers 1–3, 1–6,
and 1–12 respectively. These are supported detail-grid/viewport dimensions,
not selected-stat count limits. Absent layout uses one cell/four visible text
rows. Textarea requires a string (empty is valid), preserves multiline plain
content, and cannot be editable, health or a roster pill. Invalid layout/kinds
return 400; safe exact-path validation also accepts textarea. The same Add/Edit
editor updates a stable selected key/order in the draft; configuration Save
persists it in the shared world/module file. Save/reset recheck current caller/
world/runtime after system lookup, before persistence. SDK 3.2.0/module-api 1.4.0
also supports textarea/layout/format module suggestions. The row Defeated toggle
uses the existing Combatant PATCH and does not remove Actor dead effects.

Textarea accepts optional `contentFormat: "plain" | "html"` (absent means plain).
Module suggestions and GM selections share presentation validation. In HTML
mode the manager's `stats` row has `multiline: true`, `contentFormat: "html"`
and a sanitized string `value`; plain content is unchanged. Actor authorization/
scope validation precedes server sanitization and Core's client safe-HTML
boundary sanitizes again. This is static detail, not text-write authority,
HUD/pill placement or Foundry enrichment/action execution. Manager list/detail
revalidate caller/world/runtime and current documents after preference reads.

Managed encounter configuration includes default-off **Skip defeated enemies
automatically**, plus one durable per-Combatant **Skip** flag on existing
manager update lanes. With the setting on, an explicit NPC Defeated update also
checks Skip; manual Unskip stays unchecked across reads/restarts, and NPC
Restore clears Skip. Players may be explicitly skipped by the GM/authorized
Assistant but never automatically because defeated. Turning the setting off
does not clear existing flags. Assignment applies only to SheetDelver Defeated
actions, with no backfill, external Foundry observer or writes during reads.
Shared managed navigation/previews use
finite initiative plus not Skip, independent of the global defeated setting;
ordinary Combats remain unchanged. Caller-bound document permissions and stale
scope/identity guards remain mandatory. Manager DTOs include participant `skip`,
encounter `autoSkipDefeatedEnemies`, and optional manager-only `pausedForSkip`.
Skipping the current row first persists a score/id pause anchor with `reason:
"skip"` and clears native turn; GM Next/Previous or explicit eligible Unskip/
NPC Restore resumes. A later flag-write failure can leave it safely paused;
refresh/recover explicitly, never auto-replay. Scored skipped rows remain in
authorized rosters, but cannot be current/next or offer owner End turn. Actor
reassignment/policy/scope changes across the pause await reject before updating
the target. Malformed explicit Skip values are excluded until a GM repairs them.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/combat-manager` | List marked encounters, including retained completed history. |
| `POST` | `/api/combat-manager` | Create with `{ "label": "Ambush", "keepHistory": false }`, optional boolean `autoSkipDefeatedEnemies` defaults false; returns the encounter. Its Actor Folder is nested under the shared top-level `SheetDelver` Actor Folder. A normalized name already held by a marked encounter returns 409 before any create write. |
| `GET` | `/api/combat-manager/stat-preferences?catalog=1&actorId=...` | Read shared GM selection and module suggestions. `catalog=1` additionally discovers bounded fields from prepared world Actors; optional authorized Actor ID prioritizes its fields. Catalog `observedActorTypes` is a picker hint, not a saved type restriction. |
| `PUT` | `/api/combat-manager/stat-preferences` | Save `{ "attributes": [...] }` for this world/system module, including an intentional empty list. A selected numeric/resource `system.*` descriptor may have `"editable": true`; exactly one editable descriptor may also have `"health": true`. Module suggestions remain display-only until a GM saves those choices. |
| `POST` | `/api/combat-manager/stat-preferences/validate-path` | GM/Assistant read-only `{ "path": "system.attributes.hp.value", "kind": "number" }` check for custom fields. Returns `{ "attribute": { "path", "kind", "observedActorTypes" } }`; 400 unsafe/type mismatch, 404 absent field, 401 retired session, 403 unauthorized role, 503 retired/unavailable world. No configuration or Foundry write. |
| `DELETE` | `/api/combat-manager/stat-preferences` | Remove saved selection and return to module suggestions. |
| `PATCH` | `/api/combat-manager/:id/turn-policy` | Set `{ "autoSkipDefeatedEnemies": true }` for future SheetDelver NPC Defeated actions only; no bulk/read-side updates. GM/Assistant, native-authorized caller transport. |
| `PUT` | `/api/combat-manager/initiative-fallback` | Legacy URL retained: save a GM override such as `{ "formula": "1d20+@system.attributes.init.value" }` only if that numeric path exists on every current managed participant, or clear with `null`. Validate before persistence; 400 invalid/missing-reference/no-participant evidence, 409 unavailable Actor, 401 retired caller, 503 replaced/unavailable world. GM override takes precedence. |
| `GET` | `/api/combat-manager/:id` | Read one marked tokenless encounter. |
| `PATCH` | `/api/combat-manager/:id` | Rename with `{ "label": "..." }` only while active at round zero. Reject duplicate normalized labels and verify the child Actor Folder marker before renaming it. |
| `PATCH` | `/api/combat-manager/:id/player-actions` | GM/Assistant `{ "initiativeOpen"?: boolean, "endTurnEnabled"?: boolean }`. Phase changes rotate an opaque generation on the Combat; owner End my turn defaults enabled. Begin and rewind to round zero close initiative. The encounter DTO includes policy and manager-only eligible/scored counts. |
| `GET` | `/api/combat-manager/world-actors?q=...&sort=...` | Search linkable world Actors (PCs and NPCs), excluding marked encounter-owned compendium copies. Returns all matching Actors in order and a separate `sortFields` catalog discovered from readable Actor source stats. |
| `GET` | `/api/combat-manager/packs` | List available Actor compendiums. |
| `GET` | `/api/combat-manager/packs/:packId/actors?q=...&sort=...` | Search a GM-bound Actor pack index, projecting `system` server-side for a source-stat sort catalog. Returns all matching Actors in order; no Actor source documents cross to the browser. |
| `POST` | `/api/combat-manager/:id/world-actors` | Add `{ "actorId": "..." }` as a world link. Marked encounter-owned copies are rejected even by direct API request. |
| `POST` | `/api/combat-manager/:id/pack-actors` | Add `{ "packId": "...", "actorId": "...", "quantity": 1 }` as 1–20 independent encounter-owned world Actor copies. Partial failures report how many completed; retry is manual. |
| `POST` | `/api/combat-manager/:id/next-turn` and `/previous-turn` | Run SheetDelver-managed turn progression under the GM/Assistant encounter guard. |
| `POST` | `/api/combat-manager/:id/roll-initiative` | Roll available unrolled combatants with `{ "scope": "all" }` or `{ "scope": "npc" }`; NPC means no non-GM owner. Invalid/unresolved override references remain for manual entry. Returns `rolled` and the refreshed encounter. Partial failures report the count already rolled. |
| `POST` | `/api/combat-manager/:id/combatants/:combatantId/roll-initiative` | Roll or reroll one participant through the guarded, user-bound initiative path. Optional `advantageMode` applies only to leading d20 formulas. Returns `rolled: 1` and the refreshed encounter. |
| `POST` | `/api/combat-manager/:id/reset-initiative` | Clear all scored participants in one embedded-document update. First pause a started current turn on the Combat. Returns `cleared` and the refreshed encounter; pending rows cannot become current. GM action resumes it. |
| `PATCH` | `/api/combat-manager/:id/combatants/:combatantId` | Change `initiative`, `hidden`, `defeated` or boolean `skip`. NPC Restore clears Skip; conflicting `defeated: false, skip: true` is rejected. Manual initiative edits may include `expectedInitiative` (number or `null`); a changed mirrored score returns 409. This is a Store preflight, not an atomic Foundry compare-and-set. |
| `PATCH` | `/api/combat-manager/:id/combatants/:combatantId/resource` | Set a source-backed configured resource with `{ "value": 5, "expected": { "actorId": "...", "path": "system.attributes.hp.value", "value": 7 } }`. Returns 409 if the mirrored Actor, resource path or value changed since observation; refetch before retrying. This is a best-effort Store preflight, not an atomic Foundry compare-and-set. |
| `PATCH` | `/api/combat-manager/:id/combatants/:combatantId/stats/:statKey` | Set a GM-selected editable numeric/resource stat with the same `{ "value", "expected": { "actorId", "path", "value" } }` shape. The server re-resolves the current selection and source Actor field, and rejects unselected, derived, missing, transformed or stale values. This is also a best-effort Store preflight. |
| `POST` | `/api/combat-manager/:id/health-batch` | Apply `{ "operation": "damage", "amount": 3, "targets": [{ "combatantId", "statKey", "expected": { "actorId", "path", "value" } }] }` to 1–100 editable Default-health targets in roster order. `heal` is also accepted. A stale, invalid or duplicated target rejects the whole batch before any write; a later write failure reports `Applied N of M`. No automatic replay or clamping. |
| `DELETE` | `/api/combat-manager/:id/combatants/:combatantId` | Remove a participant; never delete its linked world Actor. |
| `POST` | `/api/combat-manager/:id/complete` | Explicitly complete; retain as read-only history or guard-clean verified copies and Folder. |
| `DELETE` | `/api/combat-manager/:id` | Permanently delete a marked encounter before or after completion, after GM confirmation. Deletion bypasses Keep for history, deactivates the Combat, and verifies encounter copies and child Folder before deleting the Combat last. Interrupted cleanup can be retried; linked world Actors and the shared parent Folder remain. Returns `{ "deleted": true }`. |

The optional `sort` query value is URL-encoded JSON, for example
`{"nameDirection":"asc","fields":[{"path":"system.details.level","direction":"desc"}]}`.
At most three distinct `system.*` fields may be selected in priority order;
each must occur in this source's returned `sortFields` catalog (path, contextual
label, number/text kind). Invalid or unavailable sort keys return 400. Missing
values sort last in either direction, then Name and Actor ID break ties. The
catalog is independent of the saved combat-stat display preference. Without
`sort`, results default to Name ascending.

The ordinary `/api/combats/:id/next-turn` endpoint also accepts an owning
player's End my turn for a managed encounter when the started, active, visible
current Actor is theirs and GM policy permits it. It never starts or rewinds
a managed encounter; GM/Assistant Next/Previous remain manager-only. Managed player
initiative requires an open GM phase and a visible owned unrolled row; score
zero counts as rolled. The manager batch route reuses Core's user-bound,
adapter-formula roll path, whispers hidden combatant rolls to GMs, and
preserves current Combatant identity after sorting.
Progression does not claim native Foundry client-hook, system-override,
world-time or effect parity. Unmarked Combat routes retain their existing
audience policy.

### Player/assistant Combat tracker

`GET /api/combats` returns a viewer-specific `CombatTrackerDto[]` rather than
source documents. Hidden Combatants, even owned ones, are absent from player
rows; hidden-only encounters are absent from the player list. The DTO has no
hidden-current marker or raw positional turn index. `currentCombatantId` and
`nextShownCombatantId` refer only to visible rows, or are `null`; the latter
is a visible-order preview, not a guarantee of the next actual Foundry turn.
Rows include bounded read-only owned stats, Actor-sheet capability and the
server-resolved initiative formula/source/allowed modes where authorized.
Unlinked scene Tokens do not project base Actor stats; textarea detail values
never enter owned HUD chips. An open managed
initiative phase adds `playerInitiative: { open: true, generation }` only to
an authorized player view, including before Begin; pre-Begin rows contain
only that player's visible owned Actors. Managed unrolled rows are in optional
`initiativeCandidates`, not `combatants`: same whitelisted row shape, own
visible targets only and `isCurrent: false`. The compact cue reads this
collection even when the turn roster is empty/collapsed; no other-owner or
hidden pending IDs/counts are projected. Closing the phase removes candidates.
GM/Assistant HUDs retain the full roster, with pending rows excluded from their
next preview. No player pause marker reveals a hidden current row.
This does not activate the Foundry
Combat. Core-generated compendium-copy ordinals are suppressed in player
display when their Combatant provenance marker still matches; GM labels and
authored renames remain unchanged. `canManage` is available to native-authorized
GM/Assistant managers. After asynchronous preference/system/module lookups,
the service rechecks caller/world/runtime scope and projects current,
subject-filtered Combat and Actor data. Removed/banned/replaced callers return
`401`; unavailable or replaced world/transport scope returns `503`, without
an old privileged tracker payload.

The tracker is an authorized projection, not a write grant. Its encounter
fields are `id`, `active`, `started`, `round`, optional `playerInitiative` and
`initiativeCandidates`, visible
`currentCombatantId`/`nextShownCombatantId`, `canAdvanceTurn`,
`canRewindTurn`, `canManage`, and `combatants`. Each visible row carries its
display identity, initiative/defeated/hidden state, `isCurrent`,
`canRollInitiative`, `isOwned`, `canOpenActor`, `statSource`, bounded `stats`,
and optional `initiativeRoll` (`formula`, `source`, `rollAvailable`,
`advantageAvailable`). `statSource: "unlinked-token"` never implies a base
Actor stat read. `initiativeRoll` is `null` when unavailable; the client does
not derive a formula from raw Actor data.

| Viewer | Ordinary Combat HUD | SheetDelver-managed Combat HUD |
| --- | --- | --- |
| Role-4 GM | Full roster; Begin/Next/Previous and eligible initiative | Full roster, view-only; `canManage` links to GM Combat Manager |
| Assistant GM | Full roster; Begin/Next/Previous and eligible initiative | Full roster, view-only HUD controls; `canManage` links to Combat Manager under native document permissions |
| Player | Visible roster; own eligible initiative and End my turn only while active, started and current | Own visible unrolled initiative while GM phase is open, including before Begin; End my turn for current owned Actor by default unless GM disables it; no manager access |

The ordinary action routes independently recheck role, Actor ownership,
visibility and current state. Hidden and missing initiative targets are
indistinguishable (`404`) to a player.

`POST /api/combats/:id/next-turn` and `/previous-turn` require
`{ "observed": { "active": true, "started": true, "round": 2,
"currentCombatantId": "..." } }` using the last tracker view. A changed
state returns `409` before writing; the client refetches and asks for a fresh
action. Player advance additionally requires an active started encounter and
ownership of the visible current Actor; Begin and rewind remain GM/assistant
actions. The initiative endpoint requires an `observed` initiative number or
`null` and effective formula string, plus an optional supported
`advantageMode` or a finite `manualTotal`. Omitting the mode preserves the
displayed resolved formula; explicit `normal` changes a bounded leading
keep-highest/lowest d20 term to `1d20`. Managed player submissions also
require the projected `observed.phaseGeneration`. Client-supplied formulas
are rejected. Hidden and
missing rows are both `404` for a player. These are Core-side preflights and
per-encounter serialization, not atomic native Foundry compare-and-set.
Core chooses public/GM roll audience; the initiative request cannot set it.
Managed owner initiative stays bound to the original Combatant's Actor ID
through reads, rolling, score application and subsequent turn synchronization.
Changing that association rejects a stale request; a change after chat returns
a partial result rather than rerolling or updating the replacement Actor.
Turn-command success is `{ "success": true }`, with no raw turn index.
`ROLL_NOT_APPLIED` means a known post-chat failure; `ROLL_OUTCOME_UNKNOWN`
means a roll or score-write timeout may have applied. Refresh and inspect
chat before any manual recovery, never automatically reroll.

---

## Actors

Actor reads have three stages (ADR-0038):

1. Source Actors authorize the requesting Foundry user.
2. The active adapter prepares one deterministic, user-invariant Actor snapshot per
   source revision.
3. Routes project the authorized prepared revision for the requested surface.

A direct read returns `503` when its prepared revision is unavailable. List reads
omit only the unavailable Actor and retain a bounded server diagnostic. Writes
remain source-shaped and are authorized by Foundry; after Foundry acknowledges a
mutation, Core updates the source Actor and publishes its replacement prepared
revision before notifying realtime clients.

### `GET /api/actors`

Auth: protected.

Returns visible non-NPC Actors partitioned into `ownedActors` and
`readOnlyActors`, with `actors` retained as the owned compatibility alias.
OBSERVER and OWNER entries are authorized from source and projected from the
prepared Store. LIMITED visibility contributes only adapter-produced
`actorCards`. Before world and prepared-state bootstrap completes, the route
returns `503`.

### `GET /api/actors/cards`

Auth: protected.

Returns dashboard card projections for visible Actors. Card hooks receive
the same prepared Actor revision used by detail, roll, and initiative reads.
Core fills omitted `name` and `img` from that revision; adapters may supply
system-specific fields and explicit identity presentation overrides.

### `GET /api/actors/:id/card`

Auth: protected.

Returns one authorization-bounded card projection. The source Actor establishes
visibility; the active adapter receives its matching prepared revision. Core
fills omitted `name` and `img` from that revision, matching the bulk-card response.

### `GET /api/actors/:id`

Auth: protected.

Returns the authorized prepared Actor projection used by module and generic
sheets. The response retains the complete source shape and adds canonical
normalized/derived fields, `foundryUrl`, the active adapter `systemId`, and
the actual `foundrySystemId`. Declared hydrated compendium UUID values are
resolved before projection.

### `POST /api/actors`

Auth: protected.

Creates an Actor through the requesting user's Foundry transport.

### `PATCH /api/actors/:id`

Auth: protected.

Updates Actor-level source data using dot notation through the requesting user's
Foundry transport.

### `DELETE /api/actors/:id`

Auth: protected.

Deletes the Actor through the requesting user's Foundry transport. Foundry is
the authoritative permission check.

### `POST /api/actors/:id/update`

Auth: protected.

Routes hybrid Actor updates, including supported embedded Item and Active Effect
paths.

### `POST /api/actors/:id/items`

### `PUT /api/actors/:id/items`

### `DELETE /api/actors/:id/items?itemId=<itemId>`

Auth: protected.

Creates, updates, or deletes an embedded Item through the requesting user's
Foundry transport. Embedded acknowledgements rebuild the owning Actor's prepared
revision.

Host-evaluated formulas share the bounded [roll grammar](dice-presentation.md#host-formula-evaluation)
across chat commands, actor helpers and the roll SDK. Unsupported formulas fail
without creating fallback chat; invalid `/api/chat/send` formulas return HTTP 400.

### `POST /api/actors/:id/roll`

Auth: protected.

Executes an adapter-supported roll from the current prepared Actor revision.

Example body:

```json
{ "type": "formula", "key": "1d20+5" }
```

---

## Journals And Shared Content

### `GET /api/journals`

Auth: protected.

Returns visible journals and folders.

### `POST /api/journals`

Auth: protected.

Creates a journal entry or folder.

```json
{ "type": "JournalEntry", "data": { "name": "Entry" } }
```

### `GET /api/journals/:id`

Auth: protected.

Returns one visible journal entry with independently authorized pages. Ordinary
HTTP and caller-scoped SDK get/UUID reads exclude unrevealed Secret sections
from non-owner page HTML before transmission. Revealed sections remain; nested
unrevealed Secrets remain excluded. A non-owner receives no alternate Markdown
editor source. Page OWNER (including explicit/inherited ownership) retains raw
source for lossless editing; entry ownership alone does not grant page ownership.
The source Store is never redacted or rewritten by reads. Directory lists remain
metadata-only. Embedded page UUIDs use the same projection, not raw resolver bytes.

### `PATCH /api/journals/:id`

Auth: protected.

Updates a journal entry or folder.

### `DELETE /api/journals/:id`

Auth: protected.

Deletes a journal entry or folder. Pass `type=JournalEntry` or `type=Folder`.

### `GET /api/shared-content`

Auth: protected.

Returns the latest media or journal content shared with the current user.
The snapshot is keyed to the authenticated player session and world, with
`Cache-Control: no-store`; a different user/session or world gets no share.
Trusted service-bearer requests to this player presentation route return `403`.
Selected Foundry shares are received on the recipient's user socket, never
inferred to be public from a service-account receipt. A journal share can carry
`data.pageId` and the native boolean `data.force`; its temporary display uses
the separate read-only view below, not an ordinary journal permission grant.
Image URLs are resolved only for the requesting client.
Image `data.caption` is optional plain text, limited at native ingress to 4096
characters. HTTP and realtime retain the same caption/receipt identity. Missing
or non-string captions are omitted; captions never grant document access.
Receipt listeners live with the authenticated Foundry session, independently of
browser tabs. `streamId` and `sequence` order the latest receipt; HTTP and socket
delivery carry the same values. These are presentation identifiers, not session
credentials. Session/world retirement clears the snapshot. Only the latest
receipt is retained in memory; there is no persistent/offline share history.

### Temporary shared journal views

Auth: protected **player world session only**; all responses are `no-store`.
System/service bearer requests receive `403`.

| Endpoint | Input | Result |
| --- | --- | --- |
| `POST /api/shared-content/journal-view` | JSON `{ streamId, sequence, shareId }` from the latest native journal receipt | `{ viewId, expiresAt }`, a read-only view lease. |
| `GET /api/shared-content/journal-view?viewId=…` | Lease ID plus the same authenticated session | Display-only journal DTO. |
| `DELETE /api/shared-content/journal-view` | JSON `{ viewId }` | Idempotent `{ ok: true }`; no Foundry document mutation. |

The server resolves UUID/page/force exclusively from its recipient-scoped native
receipt. Caller-supplied document/force/recipient fields are rejected. A forced
page returns just that page and its parent display name; a forced entry applies
Observer inheritance without exposing independently restricted pages.
Non-forced shares retain normal read thresholds. Display projections omit
ownership maps, flags and source statistics, and exclude unrevealed Secret
sections unless the requester already owns that page. Revealed sections remain.
Ordinary journal endpoints do not use this lease. Their ownership thresholds
remain independent; ordinary Secret projection is described above (ADR-0063).

Each browser view has an independent lease; the ID alone is not authentication.
Close attempts immediate disposal. Superseding shares or session/world
retirement invalidate old leases; a read renews the 30-minute idle expiry.
There is no periodic polling. At most 16 leases are retained per current receipt;
further opens return `429` until one closes/expires. Malformed receipt input is
`400`, stale/non-recipient/closed/expired/unavailable views are `404`, and an
unready journal cache is `503`. Failed close delivery remains bounded by idle
expiry; already-transmitted content cannot be recalled. Latest-receipt catch-up
allows another authenticated browser to open its own view while that upstream
session remains current. World JournalEntry/Page UUIDs only; no compendium or
privileged live-fetch fallback. See ADR-0062 J1 for native evidence and limits.

---

## Document UUID Resolution

### `GET /api/foundry/document?uuid=<uuid>`

Auth: protected.

Resolves a Foundry UUID through the platform `DocumentResolver`.

- World primary documents resolve from platform stores after bootstrap.
- Compendium UUIDs resolve from declared hydrated compendium pack rows by
  default.
- Undeclared, non-hydrated, or missing compendium rows return `null` with a
  warning.
- Live Foundry compendium fallback is diagnostics-only and must not be required
  by module code.

---

## Module UI Serving

### `GET /api/modules/:id/ui`

Auth: none.

Serves a managed module's compiled UI artifact from `<DATA_DIR>/modules/:id` as
browser-compatible ESM. The server reads the artifact manifest, loads the UI
entry, rewrites bare SDK/React imports to host browser globals, and returns
JavaScript with `Cache-Control: no-store`.

This route is for managed artifacts. Local dev UI source under
`<DATA_DIR>/local/modules` is bundled through the generated
`.managed/module-ui-registry.ts`.

Returns `404` when the module or UI artifact is missing.

Module IDs use one canonical lowercase ASCII slug grammar throughout routing,
registry state, runtime lookup, and admin operations. Module and asset files
must be regular files whose lexical and physical paths remain beneath the exact
configured module directory; path-like IDs and symlink escapes are rejected.

### `POST /api/modules/:id/ui-error`

Auth: valid player session.

Records a browser-side module UI import/evaluation failure into lifecycle health.
This is an operational health signal so the admin can see why a module fell back
to the generic UI.

```json
{
  "source": "managed",
  "message": "Failed to load runtime UI manifest"
}
```

The body is limited to 4 KiB. The module must be known, enabled, and active for
the reported `local` or `managed` source. Messages are flattened, stripped of
control characters, bounded to 500 characters, and limited to five reports per
server-side session/module each minute.

### `GET /api/modules/:id/assets/*`

Auth: none.

Serves files from the enabled module's `assets/` directory. Core resolves the
registry-selected source, so local development and managed packages use the same
URL without mixing files between source versions. Disabled or inactive sources
are not used as fallbacks.

---

## Module Registry

These public endpoints are safe to call before user login.

### `GET /api/registry/modules`

Returns manifest metadata for discovered modules.

```json
[
  {
    "id": "example-system",
    "title": "Example System",
    "version": "1.0.0",
    "experimental": false
  }
]
```

### `GET /api/registry/sources`

Returns the active source for each known module.

Source values:

- `"local"`: local dev source under `<DATA_DIR>/local/modules`.
- `"managed"`: installed artifact under `<DATA_DIR>/modules`.

```json
{
  "example-system": "managed"
}
```

The browser uses this map to choose between local bundled UI source and the
managed runtime ESM route. It is cached until module lifecycle events invalidate
the module source cache.

---

## Module API Routes

Module-authored server routes are mounted under:

```text
/api/modules/:moduleId/*
```

The route table and behavior are defined by the module's `module/server.ts`.
Module handlers receive a `ModuleServerRequest` with `req.runtime` as the only
document, roll, table, and chat surface. `req.runtime.documents` is intentionally
source-shaped and user-authorized; it does not expose the shared prepared Actor
Store. Standard card, detail, roll, and initiative behavior should use the
platform Actor routes and adapter hooks so every consumer receives the same
prepared revision.

Module routes should use SDK response helpers from `@sheet-delver/sdk/server`:

```ts
import { json, error, type ModuleRouteTable } from '@sheet-delver/sdk/server';

export const apiRoutes: ModuleRouteTable = {
    'actors/[id]/action': async (req, params) => {
        const { route } = await params.params;
        const actorId = route[1];
        const actor = await req.runtime.documents.get('Actor', actorId);
        if (!actor) return error('not_found', 'Actor not found');
        return json({ actor });
    },
};
```

Writes through `req.runtime.documents`, `req.runtime.chat`, `req.runtime.rolls`,
and `req.runtime.tables` are bound to the requesting Foundry user.

Structured cards separate display summaries (`ChatCard.rolls`) from native
evaluated Roll JSON strings (`ChatCard.evaluatedRolls`, module-api 1.2.0).
Pass `RollResult.rolls` as `evaluatedRolls` to `req.runtime.chat.card`, or as
`rolls` to raw `req.runtime.chat.send`. Only evaluated rolls become native
ChatMessage rolls; invalid card data fails before dispatch. Author, speaker,
visibility and existing chat delivery remain unchanged. See the
[authoring example](MODULE_AUTHORING.md#shared-dice-presentation).

---

## Admin API

The browser-facing admin UI calls these through the application shell's
`/api/admin/...` proxy. The shell exposes `/admin` and `/api/admin` only when the
request host matches `app.admin-origin`; other hostnames receive `404`. The
backend Core Service mounts the routes at `/admin/...` and independently
requires the configured browser origin and an allowed client network.

Browser login/setup sets the opaque `sheet-delver-admin-session` HttpOnly,
SameSite=Strict cookie scoped to `/api/admin`. Response JSON contains the CSRF
token but never the session credential. Trusted allowed-network CLI clients may
present an opaque active session through `Authorization: Bearer`.

### `GET /admin/auth/status`

Returns whether an admin account exists.

### `POST /admin/auth/setup`

Creates the first admin account using `{ bootstrapToken, password }`. Generate
the single-use, 60-minute bootstrap credential locally with
`npm run admin:bootstrap -- --data-dir=<DATA_DIR>`.

Admin setup, login, and recovery request bodies are limited to 16 KiB.
Passwords are bounded to 1024 characters and one-time credentials to 256
characters.

### `POST /admin/auth/login`

Authenticates with `{ password }`, sets the opaque session cookie, and returns
the admin identity, CSRF token, and expiration interval.

### `POST /admin/auth/reset`

Resets the admin password using `{ recoveryToken, newPassword }` and revokes all
active admin sessions. Generate the single-use, 10-minute recovery credential
locally with `npm run admin:recover -- --data-dir=<DATA_DIR>`.

### `POST /admin/auth/logout`

Requires the active cookie and CSRF header, revokes the server-side session,
and expires the browser cookie.

### `GET /admin/auth/me`

Returns the authenticated admin identity and the current CSRF token. It never
returns the opaque session credential.

### `GET /admin/status`

Returns Core Service and world status for the admin UI.

### `POST /admin/world/launch`

Launches a world from setup.

```json
{ "worldId": "world-id" }
```

### `POST /admin/world/shutdown`

Shuts down the active world.

### `GET /admin/audit`

Returns recent admin audit events.

---

## Module Lifecycle Admin

### `GET /admin/lifecycle`

Returns administrative inventory from local/managed directories, lifecycle
records and managed artifact records. Incompatible packages remain visible
without entering the executable registry. `status` and `reason` report
effective loadability; `sourceStates` reports each present source's health;
`localEnabled` and `managedEnabled` retain operator preferences where known.
`managed` means there is managed installation evidence, while
`managedDirectoryPresent` states whether its package directory currently
exists. A missing directory or artifact record remains visible but blocks
automatic Install and Upgrade with the same missing-component explanation.
The administrator must inspect and repair that installation state separately.

```json
{
  "success": true,
  "modules": [
    {
      "moduleId": "example-system",
      "title": "Example System",
      "enabled": true,
      "status": "validated",
      "experimental": false,
      "managed": true,
      "managedDirectoryPresent": true,
      "activeSource": "managed",
      "localDirectory": "/path/to/<DATA_DIR>/local/modules/example-system",
      "localEnabled": false,
      "managedEnabled": true,
      "sourceStates": {
        "managed": {
          "status": "validated",
          "enabled": true,
          "validation": {
            "manifestValid": true,
            "diagnostics": []
          }
        }
      },
      "health": {
        "errorCount": 0,
        "lastError": "",
        "lastErrorAt": 0
      },
      "artifact": {
        "version": "1.0.0",
        "source": "index://source-id",
        "installedAt": 1746000000000
      }
    }
  ]
}
```

`localEnabled` and `managedEnabled` preserve independent enablement state when a
module has both local dev source and a managed install. `localDirectory` remains
present even when that source's manifest is incompatible; the corresponding
`sourceStates.local` explains why it cannot load.

### `POST /admin/lifecycle/:moduleId/enable`

Enables a module or a specific source card. Requires admin auth and CSRF.

### `POST /admin/lifecycle/:moduleId/disable`

Disables a module or a specific source card. Requires admin auth and CSRF.

### `POST /admin/lifecycle/:moduleId/switch-source`

Switches between local dev source and managed install when both exist.

```json
{ "source": "managed" }
```

`source` must be `"local"` or `"managed"`.

On success, the server updates lifecycle state, refreshes the registry, and
broadcasts `moduleSourceChanged`.

---

## Module Manager Admin

These routes are authenticated, CSRF-protected, and audited.

### Local archive operations

An administrator can preview or apply a packaged `.tgz` through the same
validation and transaction used by managed modules:

```text
POST /admin/manager/:moduleId/archive/dry-run/install
POST /admin/manager/:moduleId/archive/install
POST /admin/manager/:moduleId/archive/dry-run/upgrade
POST /admin/manager/:moduleId/archive/upgrade
```

Send the archive bytes as `application/gzip`, `application/x-gzip`, or
`application/octet-stream`. Uploads are limited to 64 MiB and are removed from
staging after the request. Optional query parameters are:

- `trustTier=first-party|verified-third-party|unverified`
- `approveTrustOverride=true|false`
- `approvePermissionEscalation=true|false`

The default trust tier for an operator-supplied archive is `unverified`.
Production policy therefore requires an explicit lower-trust override unless
the administrator assigns a tier accepted by local policy. Dry runs return
archive limits, computed SHA-256 integrity, compatibility and governance
results, blockers, and whether a same-ID local development source exists.

Every successful operation installs only to
`<DATA_DIR>/modules/<moduleId>`. Archive operations never write, replace, or
delete `<DATA_DIR>/local/modules`, and they do not switch the active source when
a local development copy is selected.

The equivalent host CLI is:

```bash
npm run module:archive -- dry-run-install /path/to/my-system-1.2.0.tgz
npm run module:archive -- install /path/to/my-system-1.2.0.tgz --approve-trust-override
npm run module:archive -- dry-run-upgrade /path/to/my-system-1.3.0.tgz
npm run module:archive -- upgrade /path/to/my-system-1.3.0.tgz --approve-permission-escalation
```

Use `--data-dir <path>`, `--module-id <id>`, `--manifest <path>`, and
`--trust-tier <tier>` as needed. Supplying a release manifest additionally
requires the uploaded bytes and archive `info.json` to match its digest, size,
module identity, compatibility, permissions, dependencies, and conflicts.

### Public release operations

An administrator can preview or apply a public release manifest:

```text
POST /admin/manager/:moduleId/release/dry-run/install
POST /admin/manager/:moduleId/release/install
POST /admin/manager/:moduleId/release/dry-run/upgrade
POST /admin/manager/:moduleId/release/upgrade
```

Send JSON containing exactly one source:

```json
{
  "manifestUrl": "https://example.org/releases/v1.2.0/sheet-delver-manifest.json",
  "approveTrustOverride": true,
  "approvePermissionEscalation": false,
  "approveDowngrade": false
}
```

Or use a public GitHub repository shortcut:

```json
{
  "repository": "https://github.com/example/my-system"
}
```

The shortcut resolves the conventional
`releases/latest/download/sheet-delver-manifest.json` asset. Direct public
releases default to `unverified`; clients cannot assign their own trust tier.
Every source and redirect host must match
`security.source-governance.host-allowlist`. The client permits HTTPS only,
rejects non-public destination addresses, applies bounded redirects, retries,
timeouts, and response sizes, and verifies archive size and SHA-256 before the
local archive transaction runs.

Successful public release operations install only to
`<DATA_DIR>/modules/<moduleId>`. They never write to
`<DATA_DIR>/local/modules` or silently change an active local source.
Replacing an installed release with an earlier version requires
`approveDowngrade: true`; the server enforces this independently of the admin UI.

### `POST /admin/manager/:moduleId/install`

Installs a discovered local module under manager policy. Public catalog,
release-manifest, and archive installs use their dedicated endpoints above.
Arbitrary `index://` and HTTP(S) inputs remain disabled here.

### `POST /admin/manager/:moduleId/upgrade`

Upgrades a managed module under trust, verification, and permission-escalation
policy.

### `POST /admin/manager/:moduleId/uninstall`

Uninstalls a managed module and removes persisted artifact metadata.

### `POST /admin/manager/:moduleId/validate`

Re-runs manifest, compatibility, and managed artifact health checks.

### Module update policy

```text
GET /admin/manager/:moduleId/update-policy
PUT /admin/manager/:moduleId/update-policy
```

The update body accepts `locked` and/or `pinnedVersion`. Set
`pinnedVersion` to `null` to clear a pin. A pin permits only an upgrade whose
target exactly matches that version. A lock prevents both upgrades and
uninstall. Catalog installs record their `sourceProfileId` in local artifact
metadata; a later upgrade still names its selected source explicitly.

Manager policy errors use structured `errorCode` values, including:

- `trust-policy-blocked`
- `artifact-verification-failed`
- `permission-escalation-requires-approval`
- `update-policy-blocked`
- `validation-failed`
- `module-not-found`

---

## Source Profiles

Source profiles configure credential-free public catalogs:

```text
GET    /admin/sources
POST   /admin/sources
PUT    /admin/sources/:id
DELETE /admin/sources/:id
POST   /admin/sources/:id/test
GET    /admin/sources/:id/modules
GET    /admin/catalog?refresh=true
GET    /admin/sources/:sourceId/modules/:moduleId/release?version=1.2.0
```

Custom source creation accepts `name`, `baseUrl`, optional `enabled`, and
optional non-negative `priority`. The URL must use HTTPS, contain no credentials,
and match the configured host allowlist. Authentication, source kind, and trust
tier are not accepted from clients. Custom catalogs are always `unverified`.
The built-in official source is first-party; its identity and URL cannot be
changed or deleted, though it can be disabled or reprioritized.

Catalog results expose `fresh`, `cached`, `stale`, or `error` source states.
Stale data remains available for discovery after a refresh failure. Duplicate
module IDs include the selected source and all lower-priority alternatives;
source priority never silently rewrites an installed module.

Install or upgrade a specific catalog entry with:

```text
POST /admin/sources/:sourceId/modules/:moduleId/dry-run/install
POST /admin/sources/:sourceId/modules/:moduleId/install
POST /admin/sources/:sourceId/modules/:moduleId/dry-run/upgrade
POST /admin/sources/:sourceId/modules/:moduleId/upgrade
```

The JSON body may contain `version`, `approveTrustOverride`,
`approvePermissionEscalation`, and `approveDowngrade`. The release inspection
response lists only versions compatible with the running Sheet Delver core and
SDK contracts. Omitting `version` selects the newest compatible release. The
server resolves the selected immutable manifest from validated module-owned
history; clients cannot substitute an archive URL or trust tier. A missing or
invalid history asset falls back to the compatible latest release only.

The generic manager's `index://` and arbitrary HTTP(S) source references remain
disabled with `remote-module-distribution-disabled`. Public network acquisition
is available only through validated catalogs or the bounded release-manifest
operations above.

---

## Dependencies And Conflicts

Module manifests can declare dependencies and conflicts:

```json
{
  "id": "example-system",
  "title": "Example System",
  "dependencies": ["required-module-id"],
  "conflicts": ["conflicting-module-id"]
}
```

Enable validates dependencies and conflicts before changing lifecycle state.
Disable rejects when another enabled module depends on the target.


## Chat Presentation and Notifications

Ordinary non-roll whispers follow native v13/v14 author/recipient visibility,
including for GM and Assistant viewers. HTTP history, scoped SDK/UUID reads and
realtime refresh audiences share the ChatMessageStore gate. Unrelated viewers
receive neither a message nor a whisper preview hint. Existing public roll
placeholders and blind/self/GM-roll result handling remain separate (ADR-0063).

`POST /api/chat/send` accepts `message`, optional `rollMode` and `speaker`,
and optional `speakerActorId` for an owned Actor. When an Actor is requested,
Core checks effective OWNER access and uses that Actor's canonical name/ID;
the authenticated Foundry user remains the author. An invalid Actor identifier
returns `400`; an Actor for which the caller lacks OWNER access returns `403`. A sheet page's
speaker context does not grant ownership or alter roll visibility.

ChatMessage remains a primary Foundry document mirrored by Core. The existing
chat endpoint supplies permission-filtered DTOs; realtime chat hints cause
authorized reads, not direct rendering of raw document events. Chat logs,
previews and 3D dice must respect this projection, including private-roll
placeholders and omitted private text. Blind dice presentation requires explicit
`isContentVisible: true`; a client role is not an authorization override. Nested
recorded terms are presentation-only and do not introduce a new endpoint or SDK
contract. See [ADR-0042](adr/0042-dice-presentation-followups.md).

System notifications are browser-local application feedback. They have no
document endpoint, secondary store or automatic broadcast. Dismissing a chat
preview does not delete its source ChatMessage. No new transport or API version
is introduced by ADR-0040. ADR-0043 exposes client-only add/update/remove methods
through `useSDK()` in SDK 1.4.0 / `ui-extension-api` 1.2.0; no REST endpoint or
server contract changes. See [Notifications and Chat](NOTIFICATIONS.md).

## Module world-context and maintenance APIs (unreleased)

[Core ADR-0064](adr/0064-module-world-context-and-data-migrations.md) implements
authorized context projections and an **admin-owned upgrade job**. See
[the complete contract](MODULE_MIGRATIONS.md). Existing request writes remain
caller-bound; modules receive no privileged migration execution API.

| Surface | Contract |
| --- | --- |
| `GET /api/module-world-context` | Authenticated, initialized, role-filtered immutable context; no raw Settings. |
| `GET /admin/api/world/service-account` | Admin-only observed/required role and remediation. |
| `GET /admin/api/module-upgrades[/:id]` | Owner-only durable job/target outcomes and compatibility diagnostics; no-store. |
| `POST /admin/api/module-upgrades/source/:moduleId/preview` | `{source: "local" or "managed"}`; read-only world plan. |
| `POST /admin/api/module-upgrades/source/apply` | Exact `planId`, `backupAcknowledged`; current admin principal; 202 accepted. |
| `POST /admin/api/module-upgrades/:id/resume` | Readback/reconcile the persisted approval, not a fresh repair authorization. |
| `POST /admin/api/module-upgrades/:id/cancel` | Pre-write package recovery or post-write scheduling stop, never world undo. |
| `POST /admin/api/module-upgrades/:id/review` | Fresh expiring preview for a stopped job with changed/restored source. |
| `POST /admin/api/module-upgrades/:id/reapprove` | Exact revised `planId`, `backupAcknowledged`; retains prior approvals/outcomes. |
| `POST /admin/api/module-upgrades/:id/cleanup` | Completed jobs only; confined retained staging/package cleanup, not world data. |

All mutations retain existing network/origin/admin-auth/CSRF/audit controls.
Archive/catalog dry-run results include `migration`; apply carries `planId`,
`idempotencyKey` and `backupAcknowledged`. Uploaded archives carry these in query
parameters (the request body remains archive bytes). Conflicts/stale approval return
409; world maintenance/readiness returns 503. Backup acknowledgement is mandatory.
`X-SheetDelver-Context-Revision` rejects stale rule-dependent dialogs; after an
upgrade `X-SheetDelver-Runtime` is required for mutation by the current client build.
Public `maintenance` contains phase/message only; `runtimeToken` is non-secret.

`GET /api/system/data` uses `getSystemDataForUser` and a caller-bound read runtime
for non-GMs. Opaque legacy bootstrap caches are full-GM-only, never inferred safe
from cache presence. Legacy `/api/system/scenes` inspection is also full-GM-only;
this does not introduce a player Scene/canvas SDK. Actor detail preserves source
UUID strings and returns a separate authorized `referenceLabels` map.

Extend the existing admin preview/apply flow to report package checks separately
from world migration checks. A required stopped/wrong/unavailable world blocks
apply before file promotion; an admin may use the existing launch flow and rerun
preview. Apply must bind an expiring plan ID to the exact artifact/world/revisions,
use an idempotency key and return an accepted job identity, not premature upgrade
completion. Add authenticated job status and scoped resume/cancel/recovery actions
under existing network/origin/admin-session/CSRF policy. Endpoint names/payloads
are listed above.

World-backed HTTP and realtime paths need a consistent maintenance response/gate,
including delayed dispatch and stale clients; ordinary status and admin recovery
remain available across restart. Public/player status exposes only a bounded
phase/message; document-level migration details remain admin-only. Raw Setting/
Scene documents remain outside the general module surface. Implementers must
specify revision/conflict/expiry errors, projections and lifecycle invalidation
alongside the world-setting hook and upgrade coordinator.

The proposed migration catalog is a module-owned `migration.json` plus versioned
definitions/hooks, not new migration fields in `info.json` or a privileged SDK API.
Bootstrap/recovery must check fresh data even when the durable ledger says complete;
failed/unknown required compatibility holds world readiness with an unavailable
client message and admin-only maintenance reason. Job apply includes acknowledgement
that SheetDelver provides no world backup/restore or migration undo and recommends
backing up through Foundry first. Native-user lockout is outside this contract.
