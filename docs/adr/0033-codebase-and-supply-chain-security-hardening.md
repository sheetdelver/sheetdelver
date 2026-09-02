# ADR-0033: Codebase Security Hardening and Dormant Distribution Boundaries

**Status:** Accepted - Phases 0-4 implemented with CSP observation pending; Phase 5 proposed.
**Status amendment (September 2, 2026):** Phase 5 implementation and configured
owner validation are substantially complete. Commit/push, CI on that commit,
the final dependency/branch audit, and clean-worktree review remain before
closeout. CSP remains report-only pending observed module font violations.
**Pre-commit status addendum (September 2, 2026):** The final local dependency
audit and candidate-wide verification now pass. The candidate still must be
staged as one coherent change, committed, pushed through CI, and reviewed from
a clean worktree before Phase 5 is closed.
**Date:** August 21, 2026
**Phase:** Pre-main security remediation
**Supersedes:** None
**Revises:** ADR-0004 (distribution scope), ADR-0027 (module permission/runtime assumptions), ADR-0029 Amendment 1 (browser-origin and session-storage assessment)
**Related:** ADR-0001 (admin authentication), ADR-0013 (Foundry authorization), ADR-0018 (socket boundaries), ADR-0032 (authorization and transport closeout)

---

## Context

ADR-0032 established that user-originated writes use the requesting user's
Foundry socket, Foundry remains authoritative for document permissions, the
service account is not a fallback for user writes, and the Core transport does
not own document application state.

A subsequent whole-codebase and npm security audit at commit
`0d274ba2e957607584f5f886a843479a5e4fc97e` found additional browser, local
credential, public API, dependency, and dormant module-distribution risks.

The first audit draft described the distribution findings as though Sheet
Delver already operated a remote module repository with independent publishers
and an adoption process. That is not the current system and is corrected by
this ADR.

## Actual Operating Model

Sheet Delver has one stakeholder, operator, and maintainer. Module development
is centrally controlled by that owner with AI assistance.

The modules were moved outside the main source repository so they can be
developed, packaged, installed, and upgraded independently from the application.
That separation creates a real local-development versus managed-package
boundary, but it does not create an untrusted publisher ecosystem.

Current module sources are:

- `<DATA_DIR>/local/modules/<id>` for owner-controlled development source
- `<DATA_DIR>/modules/<id>` for owner-controlled managed/package installs

There is currently no operated remote module repository, no external publisher,
no third-party module intake, and no multi-stakeholder rollout. Indexed/direct
remote source adapters, source-profile UI, signature fields, fetchers, and
archive installation code exist as implementation scaffolding. They are not an
accepted production capability merely because code exists for them.

This distinction controls severity and sequencing:

- vulnerabilities reachable through the current local application are current
  remediation work
- vulnerabilities reachable only after configuring remote distribution are
  dormant capability defects and activation blockers
- managed packages remain supported; disabling remote fetch must not conflate
  or remove `<DATA_DIR>/modules`
- a future decision to operate a remote source requires a new or amended ADR
  based on the actual repository and ownership model at that time

## Audit Evidence

The August 21 audit reviewed HTTP and Socket.IO authentication and authorization;
admin, player, setup, module, registry, and public-status routes; Foundry
transport selection; module loading; browser credential storage and raw HTML
sinks; configuration/session file handling; tracked-secret signatures;
dependency lifecycle scripts; GitHub Actions; and dormant distribution paths.
It was a static source/configuration audit plus focused local probes, not a
penetration test against a live Foundry deployment or reverse proxy.

| ID | Severity | Applicability | Evidence and affected boundary |
| --- | --- | --- | --- |
| SEC-01 | Critical if activated | Dormant remote capability | `artifactVerification.ts` treats a non-empty signature as verified. `moduleIndex.ts` accepts trust tier, digest, signature, and artifact URL from the same index. This is not a current publisher compromise because no remote repository/publisher exists. |
| SEC-02 | Critical | Current | `ChatTab.tsx`, `JournalModal.tsx`, `NotificationSystem.tsx`, and `LoginView.tsx` render untrusted HTML. `processHtmlContent` only rewrites image URLs. Player and admin tokens are stored in same-origin `localStorage`, while managed UI executes on that origin. |
| SEC-03 | Critical if activated | Dormant remote capability | `artifactFetcher.ts` downloads and extracts without adequate timeout, byte, entry, link, expanded-size, staging, or rollback controls. Direct `tar` and `extract-zip` are vulnerable, but this path requires remote/direct artifact installation. |
| SEC-04 | High if activated | Dormant remote capability | Remote index/artifact fetch lacks mandatory host, redirect, destination-IP, credential-forwarding, timeout, and response-size enforcement. No remote source is currently operated. |
| SEC-05 | High for untrusted code | Current trust-model accuracy | Module permission declarations do not constrain code imported into Core or the browser. Current modules are owner-controlled, so they must be treated honestly as fully trusted code rather than as sandboxed third-party code. |
| SEC-06 | High | Current | On the audited host, `<DATA_DIR>/config/settings.yaml` and `<DATA_DIR>/cache/core/sessions.json` were mode `0664`; their parent directories were `0775`. Settings can hold credentials and reusable Foundry cookies are persisted as plaintext cache data. |
| SEC-07 | Mixed, including Critical/High | Current and dormant paths | Full `npm audit` reported 26 entries across 733 dependencies: 1 critical, 17 high, 5 moderate, and 3 low. The production-only measurement reported 20 entries across 296 production dependencies: 1 critical, 14 high, 4 moderate, and 1 low. Reachability must be assessed package by package. |
| SEC-08 | Medium | Current | REST strips users from unauthenticated status, but guest sockets receive the full status payload through initial emit and `io.emit`. |
| SEC-09 | Medium | Current | `POST /api/modules/:id/ui-error` changes lifecycle health without requiring a user session, known active module, or endpoint-specific rate limit. |
| SEC-10 | Medium | Current | Module route IDs and served paths do not share one canonical validator and realpath-aware confinement rule. A focused Express probe decoded `..%2Fsecret` as `../secret`. |
| SEC-11 | Medium | Current | Setup/reset accepts a reusable static secret from settings; `SetupToken.ts` has no active call site. |
| SEC-12 | Medium | Current | Security headers, endpoint-specific limits, Socket.IO limits, and public production error shaping are incomplete. |
| SEC-13 | Low | Current | CI uses mutable major action tags and lacks dependency-audit, dependency-review, unit, integration, TypeScript, and SBOM gates. |

Existing controls to preserve include loopback Core binding, localhost-gated
admin routes, Argon2id credentials, short-lived revocable admin sessions, CSRF
and audit coverage for privileged mutations, redacted source credentials,
request-scoped Foundry writes, non-disclosure of the service token to the
browser, and default same-origin CORS. A tracked-file signature scan found no
committed private keys or recognizable provider access tokens.

## Decision

Sheet Delver will harden the surfaces it actually operates before merge. Dormant
remote distribution will be made explicitly unavailable rather than designing
a repository, publisher keyring, or adoption process that has no current owner
requirement.

### 1. Remote distribution is disabled, not completed speculatively

The release supports local-development modules and owner-controlled managed
packages. It does not support fetching an index or artifact from HTTP(S),
creating an indexed source profile, browsing a remote source, or installing a
direct remote URL.

Remote source/profile UI and API operations will return a stable
`not-supported` result in release mode. Indexed and direct adapters will fail
closed before network access. Tests will prove that no configuration value or
admin request can activate a remote fetch accidentally.

The scaffolding may remain isolated in source if it does not enter the active
runtime or production dependency graph. Otherwise it should be removed until a
real requirement exists. This decision does not disable scanning, validating,
switching, or loading managed packages already present under
`<DATA_DIR>/modules`.

`extract-zip` is not justified as a production dependency when its only use is
disabled remote artifact extraction, so it and its obsolete types will be
removed. `tar` is also used by the current owner-controlled `module:package`
workflow; it remains but must be upgraded to a fixed version. A future remote
capability cannot reuse the current fetch/verification/extraction code without a
new security review.

### 2. Future remote distribution has activation requirements, not a current design

This ADR does not choose publishers, keys, signing ceremonies, repository
formats, or stakeholder workflows. Those would be imaginary requirements.

If the owner later chooses to operate a remote repository, the enabling ADR
must describe the actual source and ownership model. Before activation, it must
at minimum provide:

- authenticity rooted outside the downloaded index rather than trusting an
  index's self-asserted signature/trust fields
- exact artifact identity and digest verification
- SSRF-safe bounded fetch with redirect and credential rules
- bounded path/link-safe staging extraction and atomic rollback
- adversarial tests and an explicit operator recovery path

Those are acceptance properties, not a commitment to a multi-publisher system
or a specific cryptographic format today.

### 3. Dependency decisions are based on current reachability

`npm audit` counts are evidence, not an automatic architecture. Each finding is
classified as:

- reachable in the current server/browser/build path and updated before merge
- confined to dormant distribution code and removed with that capability
- development/build-only with no release reachability, then updated normally or
  documented with an owner and review date

Current Next.js, Socket.IO/`ws`, Express parser/router, YAML configuration, and
browser/editor advisories receive focused compatibility updates and the full
test/build gates. Vulnerable archive dependencies are removed with the dormant
remote path rather than retained behind an imaginary publisher design.

`npm audit --omit=dev` must be zero or every residual must have a demonstrated
unreachable path, compensating control, owner, and review date. No vulnerable
remote-input parser may remain if remote input is later enabled.

### 4. Modules are fully trusted code in the current model

Owner-controlled module logic/server code runs in the Core process, and module
UI runs in the player browser origin. The `network`, `filesystem`,
`adminRoutes`, and `sensitiveData` fields are declarations for review and change
visibility; they are not runtime capabilities.

Admin UI and documentation must say "declared access" or "requested
permissions," not imply sandbox enforcement. No lower-trust override or
third-party execution model is supported. A sandbox is not required for the
current single-owner model, but untrusted modules cannot be introduced until a
separate isolation design and denial tests exist.

### 5. Rich HTML crosses one sanitizing boundary

Foundry-, module-, and user-controlled rich HTML is untrusted even in a
single-owner deployment. A maintained parser/sanitizer will enforce a documented
allowlist for required Foundry markup. URL rewriting uses parsed nodes, and the
final result is sanitized after enrichment/transformation.

The result receives a branded `SafeHtml` type. One reviewed component may render
that type through `dangerouslySetInnerHTML`; architecture tests reject raw sinks
elsewhere. Script-capable elements, event attributes, dangerous URL schemes,
unsafe CSS, executable SVG/MathML/embedded content, and unapproved attributes
are removed. Positive Foundry fixtures and an adversarial XSS corpus are both
required.

### 6. Admin and player/module browser trust are origin-separated

ADR-0029 Amendment 1 is reopened because `(admin)` and `(player)` route groups
do not create browser origins. Managed UI and player HTML currently share an
origin with browser-readable admin credentials.

The admin shell/API proxy will use a dedicated loopback origin that serves no
player/module scripts or assets. The player origin will not serve/proxy the
admin control plane. Admin authentication moves to an opaque, revocable
HttpOnly cookie scoped to the admin origin with CSRF protection. Player
authentication also leaves `localStorage`; Socket.IO uses the server session or
a single-use short-lived nonce.

Cookie migration alone is insufficient while origins are shared because
same-origin malicious script can still issue authenticated requests. Origin
separation and sanitization are both acceptance requirements.

### 7. Browser security headers are centralized

The shell will emit a nonce-based CSP compatible with the reviewed application,
plus `frame-ancestors`, `X-Content-Type-Options: nosniff`, Referrer-Policy, and a
minimal Permissions-Policy. HSTS is enabled only where HTTPS is actually
terminated. CSP begins in report-only mode and becomes enforced after observed
violations are resolved; it does not replace sanitization.

### 8. Secret files and persisted sessions use dedicated secure storage

Security/config directories and files are created atomically with owner-only
permissions where supported. Startup migrates existing modes and produces an
operator-visible failure when it cannot enforce the configured posture.

Reusable Foundry cookies leave generic `PersistentCache`. Cross-restart
persistence uses authenticated encryption with a key supplied outside
`<DATA_DIR>`; without a key, persistence is disabled rather than stored in
plaintext. External secret references are supported for Foundry/service
credentials. Operators rotate historically exposed credentials and sessions
after migration.

Initial admin setup uses a consumed bootstrap secret. Recovery is a loopback
CLI/console operation producing a short-lived single-use nonce, not a reusable
reset token in ordinary settings.

### 9. Public and authenticated data planes are explicit

REST and Socket.IO use separate public and authenticated status projections.
Guests receive availability and only the minimum login roster. Authenticated
clients receive their authorized projection.

Module UI-health reports require a user session, known active module, bounded
canonical fields, and rate limiting. One module-ID parser and realpath-aware
confinement rule applies across registry state, routes, UI serving, and assets.

Routes use endpoint-specific schemas and limits. Socket.IO receives explicit
message, attachment, connection, and rate limits. Production 5xx responses use
stable public codes and correlation IDs while detailed redacted errors remain
server-side.

### 10. CI gates remain proportional to a single-owner project

The project does not need stakeholder adoption machinery. It does need
repeatable owner-facing gates: pinned GitHub Action SHAs, lint, TypeScript,
unit, integration, isolated build, security characterization, and production
dependency audit. Releases produce an SBOM, and required native install scripts
are documented rather than disabled blindly.

## Implementation Plan

### Phase 0 - Operating-model correction and dormant-path guard

- [x] Add one release-mode guard that rejects indexed/direct remote sources
  before network or artifact handling.
- [x] Hide or disable remote source creation, browse, connection-test, and
  remote install actions while preserving local and managed module controls.
- [x] Add tests proving local development and existing managed packages still
  load, validate, switch, upgrade by the supported local process, and report
  health independently.
- [x] Add tests proving config/admin input cannot activate remote fetch.
- [x] Correct module permission labels to describe fully trusted code and
  declared access.

**Exit:** Current module workflows remain intact and remote distribution is
provably unavailable rather than merely unconfigured.

#### Phase 0 Implementation Amendment - August 21, 2026

The original Phase 0 wording called for a "release-mode" guard. The
implementation is deliberately stronger and has no environment, configuration,
or development-mode bypass. This branch is pre-main rather than a deployed
production release, but indexed and direct remote distribution remain dormant
in every runtime mode until a later ADR explicitly enables and secures them.

The implementation made these concrete changes:

- `remoteDistributionPolicy.ts` owns the non-configurable capability decision,
  stable `remote-module-distribution-disabled` code, and operator-facing reason.
- `index://`, `http://`, and `https://` source references fail before the old
  index-file environment setting, source profiles, dynamic imports, remote
  fetchers, artifact verification, extraction, or lifecycle mutation.
- The active adapter set contains only the local adapter. The dormant indexed
  and direct adapter exports also deny direct invocation so an internal caller
  cannot bypass the default set.
- The low-level install and upgrade transaction functions repeat the denial
  before state mutation, and the active manager no longer imports the dormant
  artifact fetch/extraction implementation.
- All authenticated `/sources` endpoints remain registered but return HTTP 501
  with the stable capability code. Their existing CSRF and audit middleware is
  retained for mutation routes. Remote manager install/upgrade responses and
  dry-run/telemetry results preserve the same code instead of collapsing it
  into a generic source-resolution error.
- The Sources navigation item is removed, and the former Sources page redirects
  old bookmarks to the installed-module view. Local-development and managed
  package controls remain available.
- Dry-run UI copy now describes manifest fields as declared access and asks the
  owner to acknowledge declaration changes. It no longer claims that these
  fields grant, escalate, or sandbox runtime permissions.

Characterization coverage now proves denial for direct URLs, missing indexes,
malformed configured indexes, valid configured indexes, explicit approval
flags, source-profile API requests, and manager API installs. Existing registry,
lifecycle, artifact-health, local permission-review, managed upgrade, source
state, and uninstall tests remain active and passing. Removal of dormant archive
dependencies and deeper dependency remediation remain Phase 1 work; Phase 0 did
not alter those files or the supported `<DATA_DIR>/local/modules` and
`<DATA_DIR>/modules` directory contracts.

### Phase 1 - Reachable dependency and filesystem remediation

- [ ] Remove `extract-zip` and its obsolete types; update `tar` for the current
  `module:package` workflow and verify package output.
- [ ] Update reachable Next.js, Socket.IO/`ws`, Express, YAML, and editor/browser
  dependency paths with focused regression tests.
- [ ] Classify remaining dev/build advisories by reachability and disposition.
- [ ] Enforce/migrate owner-only config and security file modes.
- [ ] Run lint, TypeScript, unit, integration, socket, and isolated build gates.

**Exit:** The dormant ZIP extractor is absent, the supported packager uses a
fixed `tar`, reachable Critical/High advisories are closed, and secret-file mode
tests pass.

#### Phase 1 Implementation Amendment - August 21, 2026

Phase 1 was implemented without enabling remote distribution or changing the
application startup/world lifecycle state machine. The original dependency and
filesystem plan was refined as follows.

Dependency remediation:

- The unreferenced `artifactFetcher.ts` scaffolding was removed together with
  `extract-zip` and `@types/extract-zip`. No active source or package-lock entry
  retains the ZIP extractor.
- The supported `module:package` path remains tar-only. `tar` was upgraded to
  `7.5.22`; a copied owner-controlled development module was validated,
  compiled, archived, listed, and hashed entirely under operating-system
  temporary storage. The source and installed module directories were not
  modified.
- Next.js and its ESLint config moved from `16.1.1` to `16.3.2`; React and
  React DOM moved to `19.2.8`; the Tiptap set moved to `3.30.2`; `js-yaml`
  moved to `4.3.1`; and patched lockfile resolutions now cover the Socket.IO,
  `ws`, Express parser/router, PostCSS, Markdown, and URL/link parsing paths.
- Argon2 moved to `0.45.1`, removing its obsolete archive-tool chain while
  preserving the existing Argon2 authentication contract. The unused and
  deprecated `@next/font` package was removed because the application already
  imports the built-in `next/font` implementation.
- The final full and production-only npm audits both report zero advisories.
  The full graph decreased from 733 to 662 dependencies and the production
  graph from 296 to 226 dependencies.
- Required install scripts are now explicitly approved at exact reviewed
  versions: Argon2 builds password-hashing bindings, Classic Level builds the
  direct Foundry-data reader, esbuild installs the module build binary, and
  `unrs-resolver` installs the Next.js resolver binding. The installed graph has
  no pending unreviewed scripts. Optional platform-only scripts require review
  on a platform where they are actually installed.

Filesystem remediation:

- Startup now migrates `<DATA_DIR>/config`, `<DATA_DIR>/security`, and
  `<DATA_DIR>/cache` to owner-only directory mode `0700` on POSIX hosts before
  configuration or sessions are loaded. It rejects sensitive directory/file
  symlinks and fails with the affected path when enforcement is impossible.
- `settings.yaml`, every current flat security record, managed source-profile
  credentials, and persisted Core sessions are migrated to file mode `0600`.
  Windows retains the same path and atomic-write checks but does not claim POSIX
  mode enforcement.
- Setup settings and admin credentials use private temporary inodes, fsync, and
  atomic rename. Audit events retain append-only behavior but create and
  re-check the audit file at `0600`. `PersistentCache` now creates every cache
  directory at `0700` and every record at `0600`, with exclusive,
  collision-resistant temporary files and atomic replacement.
- The original Phase 1 wording mentioned config and security files but omitted
  generic cache output and source-profile credentials. They were included
  because the current cache persists reusable Foundry sessions and source
  profiles can contain bearer credentials. Authenticated encryption or disabled
  cross-restart session persistence remains Phase 3 work; mode hardening does
  not represent plaintext-session closeout.

Verification and surfaced drift:

- Focused mode tests cover permissive legacy migration, atomic replacement,
  cache creation, cleanup, and sensitive symlink rejection using only
  operating-system temporary directories.
- Lint, TypeScript, unit, integration, production build, module validation, and
  package-output checks pass. Lint retains one pre-existing warning for internal
  navigation in `ShutdownWatcher.tsx`; it is not introduced by this phase.
- The socket harness had drifted after WorldBootstrapper became the owner of
  application-state seeding: direct tests connected a `CoreSocket` and queried
  unseeded Stores. Test-only setup now initializes its data resolver and invokes
  WorldBootstrapper explicitly. Connection, system snapshot, actor-read, and
  user/compendium-read cases pass against Foundry generation 14 build 367.
- The mutation, rolling, and batch socket cases were not run against the
  configured owner world because they create documents or chat records. They
  remain wired through the corrected bootstrap helper and require an explicitly
  disposable Foundry world for the full mutation gate. This is a safety-bounded
  change from the original unqualified "socket" gate, not a claim that those
  stateful cases executed.

### Phase 2 - HTML and browser security

- [x] Introduce the sanitizer, `SafeHtml`, one rendering boundary, and XSS plus
  Foundry-markup fixtures.
- [x] Migrate every raw HTML sink and reject new sinks in the active suite.
- [ ] Add security headers and complete CSP report-only observation before
  enforcement.
- [x] Remove player bearer credentials from `localStorage` and update Socket.IO
  authentication.

**Exit:** XSS fixtures are inert, expected Foundry markup works, and player
credentials are not script-readable.

#### Phase 2 Implementation Amendment - August 21, 2026

Phase 2 implementation is complete, while the original CSP item deliberately
remains unchecked until the owner has exercised representative live worlds and
module UI during the report-only observation period. The policy is not enforced
by this amendment. An isolated production-shell browser pass found no CSP
violations, but it did not load world-backed chat, journals, actor pages, or
module tools and therefore is not treated as sufficient operational evidence
for enforcement.

Rich HTML boundary:

- `sanitize-html` `2.17.7` now parses and sanitizes untrusted rich content.
  `safeHtml.ts` owns the explicit element/attribute/scheme allowlist,
  Foundry-relative link and image resolution, raster-only data images, and the
  branded `SafeHtml` result. The allowlist includes the concrete content-link,
  content-embed, inline-roll, semantic text, and table markup found in the saved
  Foundry generation 14 reference while excluding forms, executable SVG/MathML,
  embedded browsing contexts, event attributes, inline CSS, and dangerous URL
  schemes.
- `SafeHtmlContent.tsx` is the only reviewed React component allowed to use
  `dangerouslySetInnerHTML`. Chat content and flavor, journal display,
  notification HTML, and the login world description now cross that boundary.
  Journal editor input remains raw for lossless editing and is sanitized only
  for display. The registry utility delegates to the SDK sanitizer rather than
  retaining a second regex-based implementation.
- The security suite walks TypeScript/TSX source and rejects any additional raw
  React sink. Positive Foundry fixtures verify content links, embeds, inline
  rolls, images, and tables. Adversarial fixtures cover scripts, event handlers,
  mixed-case and entity-encoded schemes, malformed attributes, executable data
  images, SVG/MathML, iframes, and unsafe CSS.

Player browser authentication:

- `POST /api/login` now returns identity/status only and sets the reusable
  Foundry user-session UUID in the `sheet-delver-session` HttpOnly,
  SameSite=Strict cookie. Its lifetime remains 24 hours and `Secure` follows
  the configured HTTPS application protocol. Logout clears the browser cookie
  even if server-side session teardown fails.
- REST status and protected middleware accept the player cookie. Trusted
  server-side bearer callers remain compatible, but the service credential is
  recognized only from an explicit bearer header and cannot be promoted from a
  browser cookie. Socket.IO restores the same player session from the handshake
  cookie and no longer accepts a browser `handshake.auth.token`.
- Player fetch helpers use same-origin cookie credentials and no longer create
  Authorization headers. Browser state retains only a non-secret
  `cookie-session-active` readiness marker for existing hooks and module SDK
  compatibility. Startup removes the legacy `sheet-delver-token`
  `localStorage` value without reading it. An architecture check rejects new
  player token storage, browser bearer construction, or Socket.IO auth tokens.
  It also rejects broad `localStorage.clear()` calls and proves that session
  migration removes only that exact legacy key. Non-secret roll-mode,
  module-setting, and theme namespaces remain intact; for example, the dnd5e
  theme continues to use the authoritative `flags._sheet_delver.theme` actor
  flag with `_sheet_delver.theme` as its browser fallback.
  Admin credential migration and browser-origin separation remain Phase 3 and
  were not changed here.

Browser response policy:

- Next Proxy creates a fresh nonce for every HTML request, supplies the
  nonce-bearing CSP request header required for Next framework scripts, and
  emits only `Content-Security-Policy-Report-Only` to the browser. Root layout
  rendering is request-bound so generated scripts and styles receive that
  nonce. API, Socket.IO, and static assets avoid unnecessary nonce processing;
  the explicit admin API matcher preserves the existing loopback guard.
- The centralized policy denies objects and framing, constrains scripts,
  connections, workers, forms, base URLs, images, media, and fonts, and emits
  `nosniff`, `DENY` framing compatibility, same-origin referrer policy, and
  a minimal Permissions-Policy. HSTS is emitted only when Next observes HTTPS,
  so local HTTP development is not pinned accidentally.
- Reports post to the public `/api/csp-report` collector with a 16 KiB body
  bound, ten-report summary bound, and 60-request-per-minute limiter when rate
  limiting is enabled. Only bounded directive and query-free location summaries
  reach `logger.warn`; raw attacker-controlled reports are not logged.

Implementation review also surfaced stale Node prerequisites. Next.js
`16.3.2` requires Node `20.9+`, and `sanitize-html` `2.17.7` requires
Node `22.12+`. The package engine and owner documentation now state Node
`22.12+`, matching the existing Node 22 CI line; the implementation workstation
used Node `24.19.0`.

Verification completed:

- the owner confirmed against the configured application that player login,
  refresh, and session restoration persist correctly through the HttpOnly
  cookie migration
- full unit suite, focused auth/socket/security cases, TypeScript, and
  `git diff --check` pass
- lint passes with the one pre-existing `ShutdownWatcher.tsx` internal
  navigation warning recorded in Phase 1
- an isolated Turbopack production build under operating-system temporary
  storage passes and reports every application route as dynamically rendered
- an installed headless Chrome production-shell pass confirmed matching CSP and
  generated-script nonces, a report-only response, and no shell CSP violation;
  the expected status error occurred because Core/world data was intentionally
  not started for that isolated check
- full and production-only npm audits both report zero vulnerabilities across
  682 total and 239 production dependencies

No configured world, module installation, or
`<DATA_DIR>/config/settings.yaml` was modified. Before the CSP checklist item
can close, the owner should run normal player, chat, journal, actor, and module
workflows and review `Browser CSP violation` warnings. Any legitimate
violations update the centralized policy with a focused fixture; only a clean
observation period can justify a later amendment switching from report-only to
enforcement.

### Phase 3 - Admin origin and credential/recovery hardening

- [x] Serve the admin shell/API proxy on its dedicated loopback origin and deny
  player/module resources there.
- [x] Move admin authentication to an opaque HttpOnly cookie while preserving
  revocation and CSRF.
- [x] Prove with browser tests that player/module code cannot reach the control
  plane.
- [x] Encrypt persisted Foundry sessions or disable persistence when no external
  key exists.
- [x] Add external secret references and replace reusable setup/reset behavior.
- [x] Document and test migration, rollback, and credential rotation.

**Exit:** Browser/module code cannot read or invoke an admin session, persisted
Foundry cookies are not plaintext, and reusable recovery secrets are gone.

#### Phase 3 Implementation Amendment - August 21, 2026

Phase 3 is implemented without changing the Foundry world transport lifecycle,
retry policy, or requesting-user mutation path. It changes control-plane
hosting and local credential persistence only.

Admin origin and browser authentication:

- The admin route tree moved into a separately built and separately started
  Next.js shell under `src/admin-shell`. Its host is restricted to
  `localhost`, `127.0.0.1`, or `::1`; its port must differ from the player and
  Core ports and defaults to `api-port + 1`. The process manager starts,
  restarts, and stops the admin shell with the existing Core/player group.
- The player proxy explicitly denies `/admin` and `/api/admin`. The admin proxy
  serves only its route tree, static assets, CSP collector, and `/api/admin`;
  player API, actor, Socket.IO, and module paths return `404`. Core adds an
  exact-admin-origin check after its loopback check. Origin-less loopback CLI
  requests remain permitted only after normal admin authentication.
- Admin sessions are random 32-byte base64url lookup identifiers with no
  serialized claims. Browser setup/login puts the identifier in a 15-minute,
  HttpOnly, SameSite=Strict cookie scoped to `/api/admin`; JSON contains the
  admin ID, CSRF token, and expiry only. The admin client uses same-origin cookie
  credentials, holds CSRF only in module memory, and removes only the two exact
  legacy local-storage keys. Logout expires the cookie before auth handling and
  revokes a valid session server-side. Standard bearer presentation remains for
  trusted loopback CLI use; the unused custom admin-token header was removed.
- The cookie uses `Secure: false` because the hard-coded deployment contract is
  plain HTTP on loopback. Exposing or HTTPS-proxying this shell is outside this
  ADR and requires revisiting the complete origin/proxy/cookie design.

Session persistence and secret handling:

- `FoundryUserConnectionService` now persists through a dedicated store rather
  than generic `PersistentCache`. With an externally resolved key it writes an
  owner-only, atomic AES-256-GCM envelope to
  `<DATA_DIR>/security/foundry-sessions.enc.json`. The envelope authenticates a
  versioned payload and stores no plaintext Foundry cookies.
- Keys require an explicit `base64:` or `hex:` encoding that decodes to exactly
  32 bytes. A current/previous pair supports rotation; a successful previous-key
  load immediately rewrites with the current key. A mismatched or modified
  envelope fails authentication. Without a current key, cross-restart
  persistence is disabled and legacy plaintext cache data is removed; an
  existing encrypted envelope is retained for key restoration.
- Startup migrates the old `<DATA_DIR>/cache/core/sessions.json` once when a key
  exists, then deletes the plaintext file. Configuration supports strict
  `{ env: NAME }` and `{ file: /absolute/path }` references for Foundry password,
  service token, admin pepper, and session keys. Secret files are bounded,
  regular non-symlinks with no group/other access; encryption-key files must be
  outside `<DATA_DIR>`. Inline strings remain warning-producing migration
  compatibility rather than the generated/default form.

Bootstrap, recovery, and operator documentation:

- Reusable `admin-setup-token` configuration is ignored with an operator
  warning, and the dead `SetupToken` helper was removed. `admin:bootstrap`
  issues a purpose-bound 60-minute credential only before account creation;
  `admin:recover` issues a purpose-bound 10-minute credential only after an
  account exists. Only salted digests are written owner-only. Success or expiry
  consumes the credential, and a password recovery revokes all admin sessions.
- The setup wizard writes external secret references and prints the one-time
  bootstrap credential when needed; it no longer collects or stores reusable
  Foundry, service, session-key, or admin-setup secrets in settings.
- `docs/SECURITY_OPERATIONS.md`, the README, API reference, and architecture
  guide now document dedicated-origin access, migration, key rotation, loss of
  key, rollback, bootstrap/recovery, credential rotation, and the deliberate
  no-key loss of cross-restart restoration.

Verification completed:

- Full unit coverage includes encrypted-envelope confidentiality, file mode,
  tamper/wrong-key rejection, plaintext migration, disabled persistence,
  current/previous rotation, external env/file validation, one-time credential
  purpose/expiry/consumption, admin cookie/auth/CSRF/revocation, exact-origin
  policy, and existing Foundry session restoration behavior.
- TypeScript, lint, and an isolated dual-shell Turbopack production build pass.
  The build manifests contain player routes only in the player shell and admin
  routes only in the admin shell.
- An isolated live stack confirmed setup and authenticated identity without a
  JSON session token, expected cookie attributes, consumed bootstrap state,
  exact-origin `403` denial, authoritative logout, cookie expiration, and `401`
  on replay of the revoked identifier.
- Installed headless Chrome confirmed the player origin receives `404` for
  `/admin`, cannot read a credentialed cross-origin admin request, and the admin
  origin receives `404` for player status, actor, Socket.IO, and module UI paths
  while loading no foreign-origin scripts.

All dynamic verification used an isolated operating-system temporary data
directory and disposable local ports. No configured world, module installation,
or `<DATA_DIR>/config/settings.yaml` was modified.

#### Phase 3 Remediation Amendment - August 22, 2026

The preceding implementation amendment is retained as history, but its
third-service topology is superseded. "Dedicated loopback origin" was treated
as permission to add a separately built and started Next.js application on a
new port. That interpretation changed deployment, access, proxy, and process
operations without presenting those consequences for explicit owner approval.
It also established a poor scaling precedent in which application boundaries
could become operating-system services without a demonstrated need.

The remediation is deliberately narrower than a Phase 3 rollback:

- The admin pages and providers return to the existing `(admin)` route group in
  the application Next.js shell. `(player)` remains a separate composition
  boundary, so player sockets, HUDs, and runtime providers do not mount on
  `/admin`. The `src/admin-shell` project, second build, third listener, and
  matching start/stop/restart lifecycle are removed.
- `app.admin-origin` (or `APP_ADMIN_ORIGIN`) identifies the one local browser
  origin permitted to expose `/admin` and proxy `/api/admin`. Requests through
  any other hostname receive `404`. Core repeats the browser-origin check.
- `security.admin.allowed-networks` (or
  `APP_ADMIN_ALLOWED_NETWORKS`) is a validated CIDR allowlist. It defaults to
  IPv4/IPv6 loopback for compatibility and can explicitly admit the owner's
  LAN/VPN subnet. The reverse proxy must preserve `Host`, overwrite forwarded
  client addresses, and avoid publishing the local admin hostname externally.
- Admin cookie `Secure` derives from the configured origin protocol. All
  opaque-session, CSRF, revocation, one-time credential, external-secret, and
  encrypted Foundry-session work remains intact.
- Audit testing found `ModuleLifecycleControl` statically importing the player
  module registry solely to clear its own tab's module-level cache. That could
  not invalidate a different player tab and made the earlier no-module-import
  claim inaccurate. The import is removed; existing Core realtime lifecycle
  broadcasts continue to invalidate each player tab at the actual cache owner.

This amendment replaces the original Phase 3 origin-isolation exit claim with
a deployment-proportionate acceptance statement: reusable admin credentials
remain non-script-readable; the admin route/API is absent on non-admin
hostnames and blocked outside configured networks; admin and player provider
graphs remain composition-isolated; and same-local-origin script authority is
an explicitly accepted residual risk under the owner-controlled module model.
It does not change Foundry transport lifecycle, requesting-user mutation
authority, credential persistence, or recovery behavior.

Remediation verification completed entirely with operating-system temporary
data and synthetic hostnames/networks:

- focused origin/CIDR, route-composition, and HTTP/HTTPS cookie tests pass
- the full unit suite, TypeScript, and lint pass; lint retains only the existing
  `ShutdownWatcher.tsx` navigation warning
- the manager-driven production build runs once and emits one manifest
  containing player and admin routes; no `src/admin-shell` project remains
- a live production stack listens only on the configured application and Core
  ports; the local admin host returns `200`, the external host returns `404`
  for admin UI/API while retaining the player UI, allowed LAN CIDR returns
  `200`, and disallowed network/wrong origin return `403`
- live login returns no JSON session credential, identity restoration succeeds,
  the external host cannot use the cookie, logout expires and revokes it, and
  replay returns `401`

No configured world, module installation, or real
`<DATA_DIR>/config/settings.yaml` was read for mutation or modified.

#### Phase 3 Session Persistence Corrective Amendment - September 1, 2026

The Phase 3 no-key behavior was secure but incomplete for existing
installations. Deployments created before the external session-key setting had
persistent Foundry user sessions, yet after upgrading they silently received a
memory-only store: Core removed the legacy plaintext cache, browser cookies no
longer restored after restart, and no migration supplied the newly required
key. This was an operational regression that configured-world verification had
not exercised across a complete Core process restart.

Explicit `security.foundry-session-key` environment/file references remain
authoritative. When neither an explicit current nor previous key is configured,
Core now creates or reuses an installation key at
`$XDG_CONFIG_HOME/sheet-delver/foundry-session.key`, falling back to
`~/.config/sheet-delver/foundry-session.key`. The host-key directory and file
are owner-only, the key remains outside `<DATA_DIR>`, and `settings.yaml` is not
rewritten. One installation key encrypts the versioned map of independent
browser/Foundry sessions; each browser still holds only its own opaque HttpOnly
session identifier.

Core will not silently generate a replacement if an encrypted session envelope
exists but the automatic host key is missing. Startup reports an actionable
error so the operator can restore the key or provide an explicit current/
previous key. The low-level disabled-store mode remains available to isolated
callers and tests, but the application composition root now defaults existing
installations to encrypted restart persistence. Coverage verifies first-key
creation, owner-only permissions, encrypted save/reload, outside-data
enforcement, missing-key failure, explicit key validation, rotation, and
plaintext migration.

### Phase 4 - Public/realtime/path/request hardening

- [x] Split guest/authenticated status DTOs and socket rooms.
- [x] Authenticate, validate, and rate-limit module UI-health reports.
- [x] Apply canonical module IDs and realpath confinement everywhere.
- [x] Add route and Socket.IO limits, public error envelopes, and correlation
  IDs.

**Exit:** Negative route/socket/path tests pass and guests receive only the
documented public projection.

#### Phase 4 Implementation Amendment - August 22, 2026

Phase 4 is implemented in the existing application and Core processes. It adds
no listener, service, deployment hostname, data migration, or module-directory
topology. It does not change Foundry world discovery/retry state, startup
orchestration, requesting-user document authority, or the service account's
role.

Public and authenticated status:

- `PublicStatusPayload` is now a separate contract shared by REST and
  Socket.IO. It exposes availability, initialization/configuration state,
  compatibility, application version, world title/status, aggregate user
  counts, and a minimum login roster containing only display name, active
  state, and server-decided login eligibility.
- The public projection omits world and user identifiers, Foundry URL, roles,
  actor links, avatars, debug configuration, private world descriptions and
  backgrounds, module configuration, and synchronization values.
- Guest and invalid-session sockets join `status:public`; restored user
  sessions join `authenticated`. Initial emits and recurring lifecycle/status
  broadcasts use the same two projections, derived from one status snapshot.
  Existing world-ready listener attachment and reconnect behavior are
  unchanged.

Module diagnostics and confinement:

- `POST /api/modules/:id/ui-error` now requires a restored requesting-user
  session. It rejects service-only, guest, unknown, disabled, inactive-source,
  and malformed requests with stable 4xx responses. Source and message fields
  are bounded, client text is flattened and stripped of control characters,
  and reports are limited per server-side session and module.
- One ASCII slug parser now owns module identity across manifests, indexes,
  lifecycle state, admin requests, registry/runtime lookup, CLI tools, UI
  serving, assets, compendium configuration, dependencies, and managed
  operations. Existing uppercase lifecycle keys can migrate only when their
  stored record is otherwise valid; mismatched or path-like identifiers fail
  closed.
- Module and asset files resolve as exact descendants of the configured local
  or managed module root. Lexical containment uses `path.relative`, physical
  containment uses `realpath`, and missing files, non-files, sibling-prefix
  paths, encoded/path separators, and directory or asset symlink escapes are
  rejected. Optional missing server artifacts remain warning-only; missing
  required logic/UI artifacts keep their prior admin-visible inert-error
  behavior instead of making the module disappear.
- Managed uninstall resolves the exact managed directory independently of the
  active source, so an active local-development source cannot redirect or
  remove the managed/local counterpart.

Request and Socket.IO boundary:

- Every Core HTTP request receives a server-generated UUID in
  `X-Request-ID`. JSON HTTP 500 responses are replaced with the stable
  `internal-error` envelope and correlation ID. The corresponding server log
  records method, query-free path, ID, and a bounded type/code summary rather
  than the original exception body. Intentional 4xx, 501, and 503 contracts are
  preserved.
- JSON parsers now apply 8 KiB to player login, 16 KiB to admin setup/login/
  recovery, and 4 KiB to module UI-health reports. Other document routes retain
  the configured application body limit. Malformed JSON and oversized bodies
  return stable `invalid-json` and `request-body-too-large` envelopes before
  business handlers. Usernames, passwords, and one-time admin credentials have
  explicit type and length bounds.
- Socket.IO now caps a message/attachment payload at 256 KiB, disables
  per-message compression, and sets explicit connection and heartbeat
  timeouts. A process-local first-stage middleware permits 30 handshakes per
  effective client address per minute before existing session restoration.
  Forwarded client addresses are trusted only from the loopback shell proxy,
  matching the Core admin-network rule.

Focused negative coverage includes public initial and recurring broadcasts,
invalid-session guest degradation, unauthenticated/unknown/rate-limited UI
health, encoded and platform-specific module paths, sibling-prefix and symlink
escapes, oversized and malformed live HTTP requests, server-owned correlation
IDs, 500-body redaction, forwarded-address spoof resistance, isolated socket
rate buckets, and window reset. Full project gate results are recorded after
the implementation verification run; Phase 5 remains the committed
merge-candidate and CI closeout phase.

#### Phase 4 Verification Addendum - August 27, 2026

The deferred full verification run completed against commit `b2fed3b` after
the focused Phase 4 checks:

- the full unit suite passed, including world lifecycle/retry, Foundry session
  restoration, guest/authenticated realtime, admin auth/CSRF, module registry,
  lifecycle/manager, path confinement, SDK, and request security coverage
- the integration suite passed its module lifecycle dependency cases
- TypeScript and `git diff --check` passed
- lint completed with zero errors and the one pre-existing
  `ShutdownWatcher.tsx` internal-navigation warning already recorded in Phase 1
- the manager-driven Next.js 16.3.2 production build passed using
  `/tmp/sheet-delver-phase4-build` as `SHEET_DELVER_DATA`; the fixture contained
  no local-development or managed modules and the generated route manifest
  retained player and admin routes in the one application shell
- a source inventory found no Core `status(500).send/end`, `sendStatus(500)`,
  or direct `statusCode = 500` response paths outside the centralized JSON
  shaping boundary

The run did not execute stateful Foundry mutation/socket tests against the
owner's configured world; Phase 4 changes no Foundry mutation authority and its
negative transport cases use isolated HTTP and Socket.IO fixtures. No configured
world, installed module, or real `<DATA_DIR>/config/settings.yaml` was modified.

#### Phase 4 Status Projection Corrective Amendment - September 1, 2026

The Phase 4 implementation amendment incorrectly classified world description,
backgrounds, and system identity as private authenticated data. Those values
were already part of Sheet Delver's intentional pre-login presentation contract:
the login screen displays the world introduction and next-session information,
the application background uses the world/system image, and system identity
selects the applicable module presentation. Removing them produced a plain login
screen and was a behavioral regression, not a required security property.

The terms `PublicStatusPayload` and `status:public` refer only to the internal
status projection and Socket.IO recipient group used before a Foundry player
session cookie has been restored. They do not create a public service, listener,
port, route namespace, or externally selectable room, and they do not override
any deployment-level access control. The server assigns the group during the
existing socket handshake. `pre-authentication status` is the accurate product
description even though the established source identifiers retain `public` to
avoid unrelated lifecycle churn.

This amendment supersedes only the earlier field classification. The
pre-authentication projection explicitly retains system ID/title/version, world
title/description, world and fallback backgrounds, next-session information,
aggregate user counts, lifecycle status, login theme/component styling, and the
redacted roster of display name, active state, and server-decided eligibility.
It still excludes world and user identifiers, roles, GM flags, actor links,
avatars, Foundry base URL, debug settings, adapter/module configuration,
synchronization tokens, and arbitrary source-system metadata.

The authenticated/pre-authentication delivery split remains because the login
screen must receive status before it can establish a Foundry player session,
while that does not justify sending it the complete authenticated status object.
No client state-machine, socket connection, retry, polling cadence, Core world
discovery, or Foundry mutation-authority behavior changes in this correction.
Projection tests now assert the complete login presentation and private-field
exclusions, the initial socket test asserts presentation delivery, and recurring
broadcast tests cover `closed -> setup -> startup -> active` for the
pre-authentication projection.

The same configured-world validation surfaced a second Phase 4 compatibility
regression in Core's confined module-entry resolver. Existing manifests may
declare an extensionless entry such as `module/server`; the prior runtime loader
resolved `module/server.ts`, while the first confinement implementation checked
only the literal extensionless path and silently omitted the server export. Core
now checks the established `.ts`, `.tsx`, `.js`, and `.mjs` candidates, applying
the full lexical and realpath confinement proof independently to each candidate.
Packaged-artifact diagnostics use the same resolver, missing optional server
entries retain warning-only behavior, and symlink/path escapes remain blocked.
Registry coverage imports an actual extensionless server declaration so adapter
success cannot mask broken module routes again. No module manifest, source, or
pack was modified.

**Configured-world confirmation - September 1, 2026:** The owner confirmed that
the restored pre-authentication projection returns the established login page,
the existing Shadowdark local-development module serves its system-manifest
route without `404`, and a newly established player session survives a complete
`npm run dev` stop/start with the socket restored as authenticated. The module,
its packs, and `<DATA_DIR>/config/settings.yaml` were not changed to obtain those
results. Sessions erased by the earlier memory-only run cannot be recovered and
require one fresh login before subsequent encrypted restart restoration.

### Phase 5 - CI and merge closeout

- [ ] Pin actions and add dependency review/audit/SBOM plus current test gates.
- [ ] Run static, unit, integration, socket, browser, and isolated-build gates on
  the committed merge candidate.
- [ ] Perform focused dynamic validation against the owner's disposable Foundry
  environment.
- [ ] Re-run `npm audit` and this security audit; document any residual with
  reachability, control, owner, and review date.
- [ ] Record the clean-worktree and `origin/main...HEAD` review.

**Exit:** Current Critical/High findings are closed or narrowly dispositioned,
dormant remote paths remain unavailable, and all project gates pass.

#### Phase 5 Implementation Amendment - September 1, 2026

Phase 5 implementation is in progress. Commit `a61d8d5` established the CI
candidate, and the September 1 closeout run added three narrowly scoped fixes
surfaced by dynamic and source validation. The original checklist above is
preserved; it is not complete until the owner tests the configured deployment,
the candidate is committed and pushed, GitHub Actions passes, and the final
clean-worktree branch review is recorded.

**Scope amendment - September 2, 2026:** "Three" described only the initial
closeout pass. Configured testing subsequently required corrective amendments
for pre-authentication presentation, encrypted session persistence,
extensionless module entries, development admin lockout, and module-source
reconciliation/fallback. Those corrections are part of the same uncommitted
candidate and are individually recorded below; no earlier proposal is silently
treated as implemented when it was reverted or superseded.

**CI and reproducible fixture implementation:**

- `.github/workflows/ci.yml` now grants only `contents: read`, disables checkout
  credential persistence, and pins checkout, Node setup, dependency review, and
  artifact upload actions to reviewed commit SHAs with release-version comments.
- The mandatory verification job runs production dependency audit, lint,
  TypeScript, unit tests, integration tests, an isolated build, production
  CycloneDX SBOM generation, and SBOM artifact upload. The invalid job-level
  `runner.temp` expression was replaced with a step-level `GITHUB_ENV` export.
- GitHub dependency review is conditional on the repository variable
  `ENABLE_DEPENDENCY_REVIEW=true` because availability for this private
  repository depends on GitHub Advanced Security. This amends the original
  proposal: production `npm audit` remains mandatory on every CI run, while the
  platform dependency-review service must not make CI fail merely because an
  unconfirmed paid repository capability is unavailable.
- `npm run ci:fixture` invokes
  `src/scripts/tools/testing/create-ci-data.ts`. The generator requires an
  explicit `SHEET_DELVER_DATA` outside the workspace, rejects filesystem root,
  refuses to overwrite settings, uses the production owner-only atomic writer,
  and creates only credential-free setup configuration and synthetic world
  cache data. Unit policy tests audit both the workflow and fixture guardrails.

**Client bootstrap race discovered by the browser gate:**

The first production browser probe could remain at `data-step="init"` when the
Socket.IO connection's initial `systemStatus` arrived before
`FoundryProvider` attached its listener. The successful REST `/api/status`
bootstrap previously restored identity/configuration only, leaving system,
roster, version, world, and connection step dependent on another socket
broadcast that might not occur until the lifecycle changed.

The correction is client-only. `FoundryContext.tsx` now hydrates the same public
status state from REST and applies the existing connection-step policy as the
missed-event recovery path. `foundryConnectionStep.ts` prefers the current
status payload's `isConfigured` value over stale React state, and
`useSystemStatusRealtime.ts` uses that policy for live broadcasts. A synchronized
step ref prevents socket-driven UI transitions from causing extra REST fetches.
No Core startup, Foundry probing/retry, socket room, session authority, or
document mutation behavior changed.

**Rollback amendment - configured lifecycle regression:** The REST hydration
correction described immediately above was reverted before commit after owner
testing against the configured deployment. It caused the reduced public REST
projection to become authoritative over the socket-fed login context, removing
the background/world presentation and preventing the client from following the
established setup-to-world refresh sequence. The affected status API typing,
`FoundryContext`, connection-step helper, realtime hook, and client assertion
now match commit `a61d8d5` exactly. Socket status and its recurring four-second
broadcast remain authoritative; Core retry and lifecycle code was never changed
in this closeout pass. The isolated browser's missed-initial-event observation
remains unresolved and must not be addressed again without configured tests for
login presentation, session restoration, and the complete world lifecycle.

**Stale setup instruction discovered by the browser gate:**

The rendered setup state still instructed the operator to run the retired
`npm run admin` command and choose a removed CLI option. `SetupView.tsx` now
links to `/admin` on the same application shell and notes that setup must use
the configured local admin origin. Existing origin and network middleware
remain authoritative; this adds no route, service, or port.

**Development admin lockout correction - September 1, 2026:**

Dynamic testing showed that the shared 15-minute rate-limit window made local
admin iteration unnecessarily disruptive. The dedicated admin middleware also
halves the configured attempt count, while the credential store independently
persists a five-failure, 15-minute account lockout. Applying both controls to
the repository owner's development process did not improve the deployed
boundary and could leave the local admin UI unavailable during routine testing.

The startup manager now explicitly sets `NODE_ENV=development` for
`npm run dev` and `NODE_ENV=production` for `npm start` and `npm run build`.
Admin setup/login/reset rate limiting and failed-password account lockout are
bypassed only when the process is explicitly development. Production, absent,
and unrecognized modes keep both original protections. Successful admin
sessions still expire after 15 minutes in every mode, and the general
player-login limiter is unchanged. This amends the original Phase 5
implementation detail; it does not weaken admin origin, network, credential,
CSRF, or session controls.

**Configured module-source regression correction - September 1, 2026:**

Owner testing with the same module ID present as both a managed package and a
local-development source exposed contradictory persisted lifecycle fields. The
record identified local as active and `localEnabled: true`, but its shared
`enabled` and local `sourceStates` values were false; managed fields contained
the inverse contradiction. Startup trusted the shared active value while admin
trusted the per-source flag. Core therefore refused the local adapter even
though admin presented it as enabled, and `/api/actors` returned HTTP 500 through
`ActorCombatContext`.

Per-source enabled flags now drive startup reconciliation and classification or
runtime failure synchronizes the shared, per-source, and source-state values.
Source paths and package presence are derived from actual discovery instead of
stale lifecycle/artifact metadata, and an unavailable persisted preference is
relabelled to the source actually selected. Disabled, incompatible, or failed
module code remains blocked, but adapter resolution returns Core's internal
generic adapter so actor/combat reads degrade without executing the module or
returning an avoidable 500. Tests reproduce the observed contradictory record,
verify the local adapter is selected, verify independent managed disablement,
remove the local source to verify accurate package fallback, and cover immediate
generic fallback after an invalid adapter export. No module source, package, or
configured data file is changed by the implementation.

**Configured-owner confirmation - September 2, 2026:** After restarting the
development stack, the owner confirmed that the D&D system's local-development
source is active independently of its disabled managed package, the admin view
no longer conflates those sources, and actor loading no longer returns the
adapter-related HTTP 500. Browser CSP reports for fonts remain in the D&D module
and are explicitly deferred to that module's next maintenance pass; they are
not treated as evidence that Core source reconciliation still fails.

**SEC-14 - bounded local roll evaluation (High availability risk, remediated):**

The closeout source-sink inventory found that authenticated actor owners could
supply a compact initiative formula with an unbounded dice count. The local
`Roll` fallback allocated and looped once per requested die, creating a CPU and
memory exhaustion path. It also used `new Function` over reconstructed numeric
tokens; the token construction prevented an evident code-injection path, but
dynamic evaluation was unnecessary and obscured the boundary.

`src/server/core/foundry/Roll.ts` now limits formula length, arithmetic token
count, dice per term, die faces, keep count, and numeric literals; requires the
tokenizer to consume the complete formula; rejects non-finite arithmetic; and
uses a bounded precedence reducer instead of dynamic code. Invalid or excessive
formulas fail closed at total zero before large allocation. Direct tests retain
normal dice, keep-highest, and arithmetic precedence while covering excessive
dice, skipped unsupported text, and division by zero.

**Verification evidence:**

- TypeScript, full lint, full unit, integration, focused client/roll tests, and
  `git diff --check` passed. Lint retains only the pre-existing documented
  `ShutdownWatcher.tsx` internal-navigation warning.
- Full and production-only `npm audit --audit-level=high` both reported zero
  vulnerabilities on September 1, 2026.
- A fresh credential-free fixture under the operating-system temporary
  directory completed the Next.js 16.3.2 production build. The rebuilt browser
  candidate reached `data-step="setup"` and `Configuration Required` within ten
  seconds instead of remaining at `init`.
- The preceding `data-step="setup"` result belonged to the reverted REST
  hydration candidate and is superseded by the rollback amendment. It is not
  evidence for the current merge candidate. After rollback, focused tests pass
  for initial app-socket status, recurring public/authenticated broadcasts, and
  Core closed/setup/new-world recovery; configured owner validation remains
  required.
- The isolated shell returned player `200`, configured same-port admin `200`,
  external-host admin `404`, nonce-bearing report-only CSP and the expected
  security headers, plus the guest-safe public status projection.
- The candidate-wide `git diff --check origin/main` initially surfaced only
  historical trailing whitespace and extra final blank lines. Those mechanical
  defects were removed without semantic edits, and both candidate-wide and
  worktree-only checks now pass.
- A read-only `GET /api/status` handshake against the owner's Foundry endpoint
  returned Foundry `14.367` and active-world metadata. No cookie was retained;
  no login, Socket.IO user session, world start/stop, roll, or document mutation
  was attempted because no disposable world was designated for this run.

**Pre-commit completeness audit - September 2, 2026:**

- The complete unit and integration suites, TypeScript, lint, an isolated
  Next.js production build, `git diff --check`, full `npm audit`, and
  production-only `npm audit` pass. Lint retains only the previously documented
  `ShutdownWatcher.tsx` navigation warning; both dependency audits report zero
  vulnerabilities. The isolated build used an operating-system temporary data
  directory and did not write `<DATA_DIR>/config/settings.yaml` or module data.
- The configured regressions did not justify reopening Foundry authorization.
  User document writes remain bound to the requesting user's Foundry socket;
  the service account is not a user-write fallback, and no service credential is
  exposed to the browser. The source-reconciliation fallback restores Core
  reads through the internal generic adapter but never executes disabled,
  incompatible, or failed module code.
- Pre-authentication world/system presentation was deliberately restored as a
  narrow product requirement. This is an exception to a minimal availability-
  only guest projection, not an authenticated-data bypass: the allowlist
  excludes identifiers, roles, actor associations, service URLs, debug fields,
  and arbitrary metadata. Recurring socket status remains authoritative for the
  login view and world lifecycle; the reverted REST-hydration experiment is not
  part of the candidate.
- Development admin failed-attempt throttling and persisted credential lockout
  are deliberately exempt only when `NODE_ENV` is exactly `development`.
  Production, absent, and unrecognized modes fail closed. Password verification,
  allowed host/origin/CIDR checks, CSRF, HttpOnly sessions, and session expiry
  remain active in development, so this is not a general admin-auth bypass.
- Automatic host-key creation supersedes the original no-key/no-persistence
  consequence. The generated key is owner-only and physically confined outside
  `<DATA_DIR>`, including when a configured parent path contains symlinks. This
  restores encrypted restart sessions while introducing the explicitly recorded
  host-secret backup, loss, and rotation responsibility.
- Local-development and managed-package sources remain independent. If the
  selected source disappears, another owner-controlled source activates only
  when its own persisted state is enabled and its validation permits loading;
  otherwise Core uses generic degradation. Remote indexes, direct downloads,
  publishers, archive installation, and third-party module trust remain
  unavailable and were not reintroduced by source failover.
- Extensionless module server-entry resolution was restored only inside the
  existing canonical module root and realpath-aware confinement boundary. It
  does not weaken path traversal or arbitrary-import protections.
- CSP remains report-only. The observed D&D module font reports preclude CSP
  enforcement in this candidate unless the module assets are corrected or the
  central policy receives a separately reviewed exception; they do not justify
  weakening HTML sanitization or any other response header.

**Clean-runner CI corrective addendum - September 2, 2026:** GitHub Actions run
`33628586983` confirmed that checkout, dependency installation, production
audit, and lint succeeded, but the standalone TypeScript step failed before the
remaining gates. A clean checkout correctly omits the generated
`.managed/tsconfig.paths.json`; the workflow had not invoked the existing
managed-configuration generator before `tsc`, so application aliases such as
`@shared/*` were unavailable. Local type checking had masked the ordering bug
because development/build had already generated that ignored file.

The manager now exposes `generate-managed` as a no-service command and
`npm run managed:generate` invokes it. It creates the existing TypeScript path
map, empty-or-discovered module UI registry, and PostCSS helper, then exits
without starting Core, Next.js, or the Foundry lifecycle. CI runs it immediately
after `npm ci` and before lint/type checking; a workflow policy assertion
preserves that ordering. Reproduction with a fresh operating-system temporary
data directory passed managed generation, lint, standalone TypeScript, the full
unit suite, credential-free fixture generation, and the production build.

The `ShutdownWatcher.tsx` annotation in that run was a warning from the
successful lint step, not the job failure. Its document reload is intentional:
client-side routing would retain the stale world-scoped providers that shutdown
must discard. A narrowly documented ESLint exception now preserves that hard
reload, removes the warning, and removes the otherwise unused router hook. This
supersedes earlier verification references to the warning as a current lint
residual; those references remain historical results from their respective
runs.

**Residual and pending record:**

| Item | Reachability/control | Owner | Review/exit |
| --- | --- | --- | --- |
| CSP remains report-only | Browser responses enforce all other recorded headers; script policy is observed but not yet blocking. | Repository owner | Review collected violation reports before switching to enforcement. |
| Module font CSP reports | Configured testing observed font-policy violations from the owner-controlled D&D module. Report-only mode records them without breaking the module. | Repository owner | Correct the module asset/font declarations or make an explicit host-policy decision before CSP enforcement. |
| Development admin failed-attempt bypass | Only explicit `NODE_ENV=development` bypasses admin request throttling and persisted lockout; password verification, origin/CIDR policy, CSRF, and session controls remain. | Repository owner | Keep development off untrusted networks; use `npm start` for deployment-like validation. |
| Pre-authentication presentation metadata | Any client that can reach the login surface receives the allowlisted world/system presentation and redacted login roster before a Foundry session. IDs, roles, actor links, URLs, debug data, and arbitrary source metadata remain excluded. | Repository owner | Retain as the login product contract; reassess before intentionally publishing the service to a broader audience. |
| Module generic degradation and source failover | Disabled/blocked module code does not execute. Core actor/combat reads continue through `BaseSystemAdapter`; an independently enabled remaining source may become active if the selected directory disappears. | Repository owner | Monitor admin health/logs; require explicit source disablement when automatic use of the remaining owner-controlled source is not desired. |
| Automatic host session key | Restart persistence is restored by an owner-only key outside `<DATA_DIR>` when no explicit key is supplied. Parent symlinks are resolved before enforcing separation, but host-config loss invalidates persisted sessions. | Repository owner | Back up separately when restoration matters; use an explicit secret for cross-host deployment/rotation. |
| Dependency review job is conditional | Mandatory npm audit and lockfile install run regardless; GitHub's additional service requires confirmed repository support and explicit variable enablement. | Repository owner | Enable when GitHub Advanced Security/dependency review is available; revisit before changing repository visibility or plan. |
| Manifest fail-open compatibility mode | Requires the explicit `SHEET_DELVER_MANIFEST_FAIL_OPEN=true` development environment value and is forced off whenever `NODE_ENV=production`. It is not admin-configurable. | Repository owner | Retain as owner-controlled development compatibility; review if environment/config ownership changes. |
| Remote distribution scaffolding | Indexed/direct refs are denied before source profiles, adapters, fetchers, or dynamic imports; default adapters contain local sources only. | Repository owner | SEC-01/03/04 remain activation blockers under the Deferred Activation Gate. |
| Stateful live Foundry validation | Automated and read-only checks cover contracts and availability, but this run intentionally did not mutate the owner's active world. | Repository owner | Test session restoration and normal world transitions in the configured deployment before Phase 5 closeout. |
| GitHub and branch closeout | Local gates pass, but the client/roll/ADR amendment is not yet committed and therefore has no pushed CI result or clean-worktree review. | Repository owner and implementation agent | Commit/push after owner testing, require CI success, then record `origin/main...HEAD` and clean-worktree results. |

**Residual-status amendment - September 2, 2026:** The stateful live Foundry
validation row above is satisfied for the exercised scope: the owner confirmed
world setup/start/shutdown/retry transitions, Foundry v14.367 login/session
restoration, requesting-user document authorization, pre-login presentation,
extensionless module routes, and local/managed module reconciliation. The
uncommitted candidate still requires pushed CI and final branch/clean-worktree
review. CSP enforcement remains intentionally open because the configured D&D
module produced font-policy reports.

## Deferred Activation Gate

Remote distribution is not an implementation phase in this ADR. If it becomes
a real owner requirement, open a focused ADR that identifies the concrete
repository, who controls it, how packages are produced, how Sheet Delver
authenticates it, and which recovery/rollback behavior is required. The
SEC-01/03/04 acceptance properties then become mandatory before activation.

## Consequences

### Positive

- The security plan matches the actual single-owner project.
- Local development and managed packages remain distinct and supported.
- Dormant remote code cannot silently become a production attack surface.
- Engineering effort goes first to browser, credential, API, and dependency
  risks that exist now.
- A future remote design will be based on a concrete repository rather than an
  imagined publisher ecosystem.

### Tradeoffs

- Remote source/profile UI and operations become unavailable despite existing
  scaffolding.
- Removing archive dependencies may require reintroducing a different audited
  implementation if remote installation is later approved.
- Admin origin/session migration remains substantial even for one operator,
  because same-origin XSS is a technical boundary rather than a stakeholder
  count problem.
- Strict sanitization may require allowlist maintenance for Foundry markup.
- Without an external encryption key, cross-restart Foundry session restoration
  is intentionally lost.

**Consequence amendment - September 2, 2026:** The earlier no-external-key
tradeoff is superseded by the Phase 3 corrective amendment. Application startup
now creates an owner-only host key outside `<DATA_DIR>` when no explicit key is
configured. Explicit secrets remain preferred for cross-host operation and
rotation; the low-level disabled store remains only for isolated callers/tests.
The replacement tradeoff is a small machine-local secret lifecycle outside
`<DATA_DIR>`: losing that host key invalidates encrypted restart sessions, while
backing it up beside the data envelope reduces the intended separation.

## Alternatives Considered

### Build a publisher/signing ecosystem now

Rejected. There is no remote repository, publisher set, or adoption requirement
to design for. Only the security properties required before future activation
are retained.

### Delete managed-module support with remote distribution

Rejected. `<DATA_DIR>/modules` is the owner-controlled packaged-install boundary
and is intentionally different from `<DATA_DIR>/local/modules`. Only remote
fetch/index activation is disabled.

### Assume owner-controlled modules make HTML and credential issues harmless

Rejected. Foundry content remains externally supplied to the browser, and a
single operator can still have an admin session compromised by same-origin XSS.

### Treat every npm advisory as an automatic merge blocker

Rejected. Reachability and use matter. Reachable production vulnerabilities are
fixed; dormant dependencies are removed; dev/build residuals require explicit
disposition rather than imaginary runtime impact.

## Non-Goals

- No module marketplace, public registry, publisher onboarding, third-party
  module policy, or stakeholder adoption process.
- No sandbox for owner-controlled modules in this workstream.
- No replacement of Foundry's authorization model and no service-account
  fallback for user requests.
- No claim that dormant remote-distribution scaffolding is production-ready.
- No security audit of Foundry itself or the owner's reverse proxy/TLS setup.

## Acceptance and Amendment Rule

This ADR is accepted only after review of the corrected operating model,
dormant-path treatment, browser-origin change, and implementation order.
Acceptance authorizes the current phases; it does not authorize remote
distribution.

When a phase completes, append an amendment recording actual files, migrations,
tests, dependency versions/audit counts, operator actions, and remaining risk.
Do not replace historical text in earlier accepted ADRs. ADR-0029 Amendment 1A
already records the corrected browser-origin fact and remains proposed until the
corresponding ADR-0033 phases are implemented.
