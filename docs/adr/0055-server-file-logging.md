# ADR-0055: Server File Logging

**Status:** Completed; verified (logging only)
**Date:** September 30, 2026
**Related:** ADR-0005, ADR-0023, ADR-0034, ADR-0053

## Context

An operator observed SheetDelver send logged-in users back to login after an
idle period while Foundry appeared to remain active. There is no retained
timeline proving whether Core/Next restarted, the world was classified as
setup, sessions expired, or restoration failed. The cause is unknown.

`src/shared/utils/logger.ts` sends level-gated, human-readable messages to the
console. Core normally configures level 1 (errors), so many lifecycle INFO
messages are absent, and console history may not be retained. The existing
admin security audit records privileged HTTP actions, not process and world
state. `getLogsDir()` already resolves `<DATA_DIR>/logs`, but no production
writer uses it. The manager, lifecycle store, transport controller and session
service already own the relevant decisions.

## Decision

1. Keep the current `logger` and its levels 0–4. Add a server-only file sink
   to that logger, independently gated by `debug.file-level` (0–4, default 3)
   in `settings.yaml`; `debug.level` remains the console threshold. Preserve
   the logger's simple `[LEVEL] message` presentation in the console; prefix
   each physical file line with an ISO UTC timestamp. Browser logging and
   module SDK contracts are unchanged; the file threshold is not sent to browsers.
2. Append plain text to fixed files under `<DATA_DIR>/logs`:
   `sheetdelver-manager.log` and `sheetdelver-core.log`. Separate names avoid
   two processes writing to one file. Keep stdout/stderr available for a
   service manager's logging system. Do not implement date-named segments,
   retention, or rotation in the application; an operator may use journald,
   Docker logging, logrotate, or equivalent. The file sink reopens the file on
   each write so rename-based external rotation works.
3. Add ordinary logger calls at the existing process/world/session ownership
   points where needed to explain start, exit, restart, world transitions,
   setup-driven session purge counts and restoration failures. Avoid logging
   every heartbeat or status poll. Keep the admin audit as the authority for
   who requested a privileged world action. No second event bus or event
   schema is introduced.
4. Log files can contain the same information as server console messages,
   including potentially sensitive diagnostics at level 4. Restrict their
   directory and files to the owner, reject symlinks, and document careful
   access/retention. A write failure must not abort a world transition or
   recurse through the logger; report it to stderr at most once per minute.
   Do not create a file sink for build/config-only manager commands.

## World/session investigation boundary

File logging is observability, **not** a session-policy change. Current code
can enter `setup` after a single `getWorldStatus()` acknowledgement timeout or
an ambiguous status response. Entering setup clears all restorable world
sessions and signals clients to log in again. These are plausible failure
paths, not a diagnosis of the reported event. Separately characterize them
with deterministic transport/status fixtures and verify what observations
should count as a definitive shutdown. Any debounce/corroboration or changed
session invalidation policy requires its own reviewed reliability decision;
it must not be slipped into this logging change.

## Implementation and verification scope

- Implement the sink using the existing data-directory path/permission helpers
  and unit-test independent level gating, plain-text output, owner-only files,
  symlink refusal and compatibility with external rename-based rotation.
- Instrument the manager and Core ownership points with concise logger calls.
  Verify the setup-to-purge text sequence with a synthetic test. Do not require
  a live Foundry world for normal tests.
- Document the fixed files and external rotation. No admin viewer, browser log
  upload, remote telemetry, or module SDK change is in scope.
- Investigate and test the false-setup paths separately. The observed logout
  remains unexplained until evidence distinguishes them from a genuine world
  shutdown, process restart, cookie expiration, or restore failure.

The implementation retains existing server logger output in files and adds
missing lifecycle and session lines. It does not claim the reported incident's
cause; no hosted world probe was required for implementation.

## Verification and disposition

The full unit and integration suites, lint, TypeScript check, isolated-data
production build, and production/full dependency audits passed on October 1,
2026. File-sink tests cover severity independence, timestamped plain text,
owner-only paths, symlink refusal, and external rename-based rotation. A
setup-transition fixture covers the session-purge log sequence. The operator
ran the service and the resulting manager/Core files captured a transient
Foundry `transport close`, a world-runtime teardown and same-world bootstrap.
This verifies useful field output, not the origin of that disconnect or the
earlier lasting logout. Socket recovery and possible false-setup session
invalidation remain separate reliability work.

## Consequences

Console output remains familiar and level-controlled. The file sink provides
the same readable lines even when the console threshold is lower. Applications
running as services may instead rely on stdout/stderr capture. External
system logging owns rotation. Operators must set retention for
the optional append-only files if they enable file output long-term.
