# ADR-0059: Setup Recovery and Managed-Module Inventory

**Status:** Completed; verified (offline regressions and operator production soak)
**Date:** October 11, 2026
**Closed:** October 12, 2026
**Related:** ADR-0023, ADR-0030, ADR-0056, ADR-0057

## Context

After roughly a day in Foundry Setup, the deployed Core continued its
one-minute status attempts. When a world was launched, `/api/status` began
returning HTTP 500. Core changed `setup -> offline` and logged 4,430 failed
handshakes at five-second intervals over more than six hours. A browser
refresh did not help; a physical SheetDelver restart detected and bootstrapped
the world within seconds. The logs establish retries and responses, not why
the old process received 500. A loopback simulation confirms that Core retains
its service-account status cookie across Setup and disconnect and cannot recover
if only cookie-bearing status requests fail. A disposable Foundry v14.367
instance returned 200 for a synthetic invalid cookie in both Setup and an
active world; that test does not identify the production 500 cause.

Before this change, the controller turned any connection failure into `offline`, even
after explicit Setup evidence. Status then supplies a synthetic
`worldTitle: "Reconnecting..."`; the player connection-step mapper treats an
offline status with a title as `startup` and renders “World Starting.” This
misstates a confirmed no-world Setup state while the next handshake is
temporarily failing. An ambiguous failure must not imply a world launch or
undo confirmed Setup evidence. Conversely, an outage of a previously active
world remains offline until authoritative Setup evidence is corroborated,
per ADR-0056.

The same Core upgrade classified three managed modules incompatible because
they require `ui-extension-api <2.0.0` while Core provides `2.1.0`. A
disposable fixture reproduced their administrative contradiction: the
incompatible package remained on disk with an artifact, but was omitted from
the runtime-backed `listModules` inventory; catalog install dry-run said
“already installed,” upgrade dry-run said it would proceed, and apply
rejected `incompatible -> upgrading`. Classification also overwrote the
persisted enabled preference with the effective disabled state.

## Decision

1. Core's controller retains a **confirmed** Setup lifecycle across
   indeterminate status/connection failures, continuing bounded retries.
   Such errors do not declare a world active, invalidate extra sessions, or
   trigger bootstrap. A previously active world's ambiguous outage stays
   offline; affirmative Setup still requires ADR-0056 confirmation. Status
   presentation does not use a synthetic world title as evidence of startup.
   A confirmed Setup displays the existing “No World Available” view on all
   player routes; a real detected world moves through startup and readiness.
2. The service-account transport may make one bounded, rate-limited
   **anonymous diagnostic** `/api/status` request after a cookie-bearing 500.
   A valid anonymous status alongside a cookie-specific 500 permits retiring
   only the Core transport cookie and continuing normal discovery/login.
   If both fail, keep the last authoritative world lifecycle (Setup or
   offline), back off, and report a concise operator error. Never use a 500
   as Setup evidence, clear player cookies/sessions, or auto-restart Core.
   Bound status, discovery and login HTTP waits so one hung request cannot
   defeat the controller's single retry owner. This is a defensive recovery
   rule; it does not assert a stale cookie caused the observed production 500.
3. Admin module inventory is distinct from executable module registration.
   Discover installed directories and lifecycle records without importing
   incompatible code. Show incompatible managed packages and diagnostics in
   Installed/Updates. Catalog operation choice follows physical managed
   installation and artifact state, not runtime loadability. Missing artifact
   or directory is surfaced explicitly; it is not silently relabelled as a
   fresh install or an eligible upgrade.
4. Allow a guarded `incompatible -> upgrading` transition **only** for an
   installed managed package with a compatible replacement and all existing
   trust, permission, integrity, dependency, lock/pin and archive checks.
   Dry-run and apply enforce the same lifecycle precondition. An incompatible
   package remains unexecutable until the replacement passes validation.
   Compatibility classification does not overwrite operator enablement
   intent; effective runtime eligibility remains false. Already-overwritten
   historical preferences cannot be inferred, so those packages remain
   disabled until explicitly enabled or upgraded under an authorized policy.

## Boundaries and security

The player UI consumes the existing Core status contract; modules gain no
direct Foundry transport or new SDK capability. Only Core's server transport
may probe status anonymously. The diagnostic response must contain an explicit
boolean `active`; a malformed response is indeterminate. Never log cookies,
headers, response bodies, credentials or session IDs. Admin inventory reads
only confined, valid module IDs beneath configured module roots, treats
manifests as data, and does not import code to display a blocked package.
Runtime registry and world API authorization remain unchanged.

## Implementation and verification

- Add focused controller/status/client tests for confirmed Setup followed by
  500/timeout, later world detection, and a previously active world's
  ambiguous outage. Exercise both cookie-specific and upstream-wide 500s,
  hung HTTP, one bounded recovery owner, and low-volume logging.
- Add disposable managed-module fixtures for incompatible visibility,
  install-vs-upgrade selection, dry-run/apply agreement, compatible-target
  replacement, preserved enablement intent, malformed/missing artifacts,
  source collisions and existing policy gates. Keep all fixture writes under
  an isolated data root.
- Run focused suites, type-check, lint and relevant integration tests. Use
  only an approved disposable Foundry instance for any live lifecycle test;
  no hosted probes. Operator acceptance follows before this ADR is closed.

## Consequences

Confirmed Setup remains honestly visible through a temporary upstream error,
while a later real world can still be discovered. Core may make one additional
diagnostic request per cooldown during persistent status failures, but does
not multiply retry owners or disclose session state. Installed incompatible
modules remain visible and recoverable without making them executable.

## Verification to date

The isolated Setup and cookie-specific/upstream-wide 500 regressions, full
offline unit suite, type-check, and lint pass. A disposable managed-package
fixture confirms admin visibility, duplicate-install rejection, compatible
upgrade preview, and successful replacement. The production HTTP 500 cause
remains unproven. These are the checks reported during initial implementation,
not proof of all failure-path requirements above. The integrity review below
identified additional corrections and missing coverage. A live Setup-to-world
and admin catalog acceptance pass is still required before closing this ADR.

## Addendum — explicit Setup heartbeat classification

A development shutdown trace showed one misleading “Heartbeat detected world
lifecycle change (Title="Setup")” message before the normal Setup retry
sequence. The heartbeat title check accepted any non-generic title while the
controller was in Setup; Foundry's explicit Setup response has that title too.
Require `isSetupMatch === false` before a heartbeat can begin world discovery.
An explicit Setup response instead follows the existing Setup-evidence path
and scheduled retry. A controller regression covers repeated Setup heartbeats
followed by a real world title. This removes an unnecessary connection attempt;
it does not change the bounded retry policy or diagnose the later HTTP 503.

## Addendum — integrity review, October 11, 2026

This is a read-only source and test-coverage review of the current branch,
not another production reproduction. No application or test code was changed
for this review. The following corrections are proposed for review before
implementation; none establishes the cause of the production HTTP 500.

### R1 — incomplete discovery must not permanently close a world (high)

`SocketBase.probeWorldState()` can return the HTTP fallback's world metadata
without a `users` array when the guest socket fails or times out.
`CoreSocket.connect()` substitutes an empty array and emits
`serviceAccountMissing`. The controller then enters `closed`, cancels retries,
and only retries discovery after Setup or a changed world title. A temporary
discovery failure can therefore strand an otherwise valid, unchanged world.
The socket status fallback also disconnects before waiting for its final
acknowledgement; a world-only fallback is not evidence about account presence.

Distinguish incomplete discovery from an authoritative user-list response.
Missing/malformed user data must use bounded discovery retries, not account
absence classification. Preserve the existing `closed` policy for a genuinely
missing account. Require affirmative status evidence from HTTP fallbacks and
settle socket fallbacks before retiring their transport. Test API-only success
with a failed guest probe, then complete discovery of the same world.

### R2 — heartbeat lifetime and resumption are not fully owned (high)

`WorldTransportController.runHeartbeat()` clears its timer and returns when
`EngagementService.shouldRunHeartbeat()` rejects a paused probe.
`withHeartbeatPaused()` only decrements a counter afterward: it does not
rearm monitoring. A compendium operation spanning the scheduled heartbeat can
leave an active world's heartbeat stopped until another event restarts it.

Separately, `stopHeartbeat()` cancels a timer, not a pending `checkStatus()`.
The callback uses lifecycle state captured before the await and has no
generation check afterward. A stale Setup result can disconnect a newer
connection; an old callback can also reschedule after monitoring was replaced.
Handshake cookie updates occur before the caller's connection-generation
check, so ignoring a stale lifecycle result alone is insufficient.

Keep ownership in the existing controller: explicitly resume after the last
pause, invalidate obsolete probes on stop/replacement/disposal, and prevent
obsolete HTTP results from changing cookies or lifecycle state. Coordinate
heartbeat and retry scheduling rather than adding another recovery loop.
Cover nested pauses, failure during a pause, delayed status across a world
transition, disposal, and return-to-engagement with a retry already pending.

### R3 — a rejected socket attempt can still report success (high)

The main-socket deadline in `CoreSocket.connect()` rejects its promise without
retiring the socket or invalidating that attempt's generation. `connect_error`
also rejects without immediate retirement. Until a replacement starts, a late
`connect`/world-status acknowledgement can still emit `worldActive` and
`connect` after failure scheduled a retry. The existing obsolete-socket test
only checks callbacks *after* a replacement was created.

Make attempt completion single-settlement: failure/timeout must retire its
transport and invalidate late callbacks before scheduling recovery. Test a
late connect and a late status acknowledgement both before and after the next
attempt; neither may bootstrap, reclassify state, or change session state.

### R4 — existing login diagnostics violate the security boundary (high)

`SocketBase.performLogin()` logs raw `Set-Cookie` headers at DEBUG and includes
the upstream error body in both a log and the thrown error. `CoreSocket` also
logs a session-ID prefix in `emitSocketEvent()`. The shared logger and file
sink do not redact these strings; DEBUG console/file output can expose
authentication material. These are existing paths, not a new anonymous-probe
permission.

Remove credential-bearing diagnostics at their source, including error text
that callers may log. Retain safe phase/status/generation and cookie-presence
or count diagnostics, never values. Test login success/failure and status
recovery with synthetic secrets through console and file logging. Do not
copy real credentials into fixtures or reports. Authentication/session IDs
are distinct from non-secret Foundry document/user IDs.

### M1 — incomplete installations still have contradictory recovery advice (high)

`listModuleInventory()` skips lifecycle entries when neither package directory
exists and does not enumerate artifact-only IDs. A retained artifact can thus
remain invisible. In `archiveOperations.prepareOperation()`, artifact-without-
directory and directory-without-artifact both produce a loop: Install says
“use upgrade,” while Upgrade says “use install.” The catalog's new missing-
artifact warning covers only one presentation path, not this operation error.

Reconcile valid directory, lifecycle, and artifact identities into explicit
administrative facts, including incomplete installations. Do not treat absent
files as executable or automatically recreate/delete them. Dry-run and apply
must report the same concrete missing component and a safe operator recovery
instruction, not direct the operator to an equally blocked action. A new
automatic repair/reinstall facility is not approved by this addendum.

### M2 — manifest identity is applied before it is validated (high)

`bootstrap.initializeRegistry()` calls `upsertDiscoveredModule()` using the
manifest's inferred ID before confirming it matches the validated directory
ID. A package in directory A declaring ID B can update B's title/directory;
the subsequent error classification targets A, whose record might not exist.
Invalid packages do not become executable on this path, but inventory and
lifecycle diagnostics can be attached to the wrong module or disappear.

Use the confined directory's validated ID as discovery identity. Validate
manifest identity before modifying any other record, and attach mismatch or
parse diagnostics only to that directory's entry. Test A declaring B with B
both present and absent; B's metadata, intent and runtime selection must remain
unchanged, while A remains visible and blocked.

### M3 — source presence and source health still diverge in the UI (medium)

The scanner clears `localDirectory` at each scan but restores it only after
compatibility succeeds. With an incompatible local checkout beside a managed
package, `ModuleLifecycleControl` loses its two-source cards despite both
directories existing. Conversely, when local is active and the managed copy
is incompatible, `CatalogModulePanel` reads the top-level local status/reason
for a managed upgrade row, hiding that managed copy's incompatibility.

Record physical source presence independently of loadability. Installed cards
must show each present source and its own diagnostics; managed update rows
must use managed health/intent rather than the active local source's state.
Do not alter local checkouts, switch sources, or infer enabled intent merely
to repair inventory. Cover both mixed-compatibility directions and explicitly
disabled managed intent across upgrade and rescan.

### Verification and closeout boundary

The current focused tests cover ordinary replacement-socket invalidation,
Setup classification, synthetic cookie-specific/global 500s, and one successful
incompatible managed upgrade. They do not demonstrate the timing/partial-
discovery failures above, an actually stalled HTTP/body read, artifact-only
inventory, manifest-ID collisions, or mixed-source incompatible presentation.
Existing generic module policy tests remain valuable but do not replace these
targeted regressions. Add bounded offline timing/fixture coverage during the
corrective implementation, then rerun unit/type/lint checks and isolated
Setup-to-world/admin acceptance. Keep all existing archive, authorization,
trust, permission, integrity, lock/pin and local-source protections.

The operator's latest development trace confirms Setup followed by 1-second
retries, then 5/10/20/40/60-second delays. It does not yet demonstrate a world
launch after extended idle or recovery from persistent 500/503 responses.
Two initial `(1/30)` entries within that same process are consistent with
`handleReturnToEngagement()` resetting backoff when the first browser attaches;
they are not evidence of another process restart. Retries have no elapsed-time
cutoff; the 60-second value caps scheduled retry delay, not total detection
time, which also includes bounded requests and discovery/bootstrap.

No change to ADR-0057's finite browser reconnect policy or confirmed-Setup
session invalidation is proposed. Session-store `clear()` awaits initialization,
and the user-connection service retires its authority epoch before asynchronous
cleanup; this review found no startup-initialization race in that specific
path. The original upstream 500 origin remains an unknown, not a prerequisite
for fixing the independently identified failure modes. Leave this ADR open
until the above corrections are resolved or explicitly dispositioned and the
operator acceptance is recorded.

## Follow-up — integrity corrections implemented, October 11, 2026

The R1–R4 and M1–M3 corrections above are implemented on
`fix/world-recovery-module-upgrades`. This report describes the resulting
behavior; it does not replace operator acceptance or identify the cause of
the original production 500.

- **R1:** The guest probe now waits for its final socket acknowledgement and
  selects that completed result ahead of the HTTP status fallback. The HTTP
  fallback accepts only an explicitly active world. A world result without a
  user list is treated as incomplete discovery with a bounded retry; only an
  authoritative user list can declare the configured service account missing.
- **R2:** The controller invalidates and aborts older heartbeat requests when
  monitoring is replaced, paused or disposed. Status results check that epoch
  before changing Core cookies or lifecycle state. The last nested pause
  resumes monitoring, while a pending retry remains the sole recovery owner.
- **R3:** A main socket timeout or connection error immediately retires the
  socket and its generation. Late callbacks cannot announce a ready world or
  bootstrap before the next attempt.
- **R4:** Login errors now contain status only. Raw login `Set-Cookie` values,
  response bodies and socket session-ID fragments are absent from diagnostics;
  synthetic-secret tests cover console and file-sink paths.
- **M1:** Admin inventory includes lifecycle and artifact-only entries and
  exposes physical managed-directory presence separately. An incomplete
  installation reports its missing directory or artifact record consistently
  in Install and Upgrade preview and apply; neither operation repairs or
  deletes it automatically.
- **M2:** Registry scanning now uses the validated directory identity before
  updating lifecycle records. A mismatched manifest is blocked and reported
  under its own directory without altering the declared target's record.
- **M3:** Local-directory presence survives incompatible or invalid manifest
  classification. Admin source cards and catalog update rows use their own
  source health; an active local checkout cannot mask a managed incompatibility.
  Blocked source cards show their effective status separately from a retained
  enabled preference, which cannot block activation of a healthy other source.

Focused regressions passed for a stalled HTTP body, incomplete versus empty
user lists, socket fallback acknowledgement, late socket success/error,
cookie/log secrecy, nested and failed heartbeat pauses, stale Setup responses,
retry ownership, incomplete installation preview/apply, mismatched IDs, both
mixed-source compatibility directions, and disabled intent across upgrade.
The full offline unit suite, TypeScript check and lint passed after the
implementation and documentation follow-up. The normal
integration runner would remove retained `temp/integration-test-data`, so it
was not run in this pass. No hosted Foundry instance was contacted.

The original production HTTP 500 remained unexplained at implementation.
An operator-run Setup-to-world check after extended idle, plus an admin catalog
check with an incompatible managed package, was the closeout gate. If the
operator sees a 500 or 503 during that check, capture the Foundry-side status
and Core transition sequence; do not infer cookie failure from HTTP status
alone.

## Closeout — October 12, 2026

The GM reports that the deployed fixes remained reliable after more than
24 hours and caused no breakage. This is operator acceptance of the recovery
and module-management changes after the offline regressions recorded above.
No separate catalog action log was supplied with that acceptance. The report
also does not identify the cause of the original production HTTP 500; that
historical cause remains unknown. ADR-0059 is complete for its approved scope.
Investigate any newly observed failure as a separate incident with fresh Core
and Foundry evidence.
