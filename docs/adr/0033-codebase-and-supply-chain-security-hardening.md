# ADR-0033: Codebase Security Hardening and Dormant Distribution Boundaries

**Status:** Accepted - Phase 0 implemented; Phases 1-5 proposed.
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

### Phase 2 - HTML and browser security

- [ ] Introduce the sanitizer, `SafeHtml`, one rendering boundary, and XSS plus
  Foundry-markup fixtures.
- [ ] Migrate every raw HTML sink and reject new sinks in the active suite.
- [ ] Add security headers and complete CSP report-only observation before
  enforcement.
- [ ] Remove player bearer credentials from `localStorage` and update Socket.IO
  authentication.

**Exit:** XSS fixtures are inert, expected Foundry markup works, and player
credentials are not script-readable.

### Phase 3 - Admin origin and credential/recovery hardening

- [ ] Serve the admin shell/API proxy on its dedicated loopback origin and deny
  player/module resources there.
- [ ] Move admin authentication to an opaque HttpOnly cookie while preserving
  revocation and CSRF.
- [ ] Prove with browser tests that player/module code cannot reach the control
  plane.
- [ ] Encrypt persisted Foundry sessions or disable persistence when no external
  key exists.
- [ ] Add external secret references and replace reusable setup/reset behavior.
- [ ] Document and test migration, rollback, and credential rotation.

**Exit:** Browser/module code cannot read or invoke an admin session, persisted
Foundry cookies are not plaintext, and reusable recovery secrets are gone.

### Phase 4 - Public/realtime/path/request hardening

- [ ] Split guest/authenticated status DTOs and socket rooms.
- [ ] Authenticate, validate, and rate-limit module UI-health reports.
- [ ] Apply canonical module IDs and realpath confinement everywhere.
- [ ] Add route and Socket.IO limits, public error envelopes, and correlation
  IDs.

**Exit:** Negative route/socket/path tests pass and guests receive only the
documented public projection.

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
