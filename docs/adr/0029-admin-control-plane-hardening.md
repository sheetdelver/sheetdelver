# ADR-0029: Admin Control Plane Hardening

**Status:** Accepted — Implemented.
**Date:** June 10, 2026
**Phase:** Admin Hardening
**Supersedes:** None
**Revises:** ADR-0001 (admin auth model) session-revocation and reset guarantees; ADR-0006 Phase 27/28 admin operations UX.
**Related:** ADR-0001 (admin authentication model), ADR-0006 (admin operations UX and distribution readiness), ADR-0022 (core cleanup and boundary completion — admin router split), ADR-0023 (post-ADR-0022 stabilization).

---

## Context

ADR-0001 established the app-admin identity model and ADR-0006 Phase 27 delivered the admin operations UX. The admin control plane is now broadly complete: module lifecycle management, world launch/shutdown/retry, source profiles, audit log, and a restart flow are all reachable from the admin panel behind a localhost gate, Argon2id credentials, account lockout, a rate-limited login, and per-session CSRF tokens.

A source audit of the admin auth/security layer, the admin routers, the admin service, and the admin frontend (June 10, 2026) found the surface directionally correct but carrying a set of correctness and hardening gaps. None of them indicate a wrong architecture; they are places where the implementation does not yet meet the guarantees ADR-0001 and ADR-0006 already promised.

Concrete gaps in the current tree:

- **Session revocation is non-functional.** `requireAdminAuth` authenticates by statelessly parsing the token (`parseAndValidateToken`) and never consults `adminSessionManager`. `revokeAllForAdmin` (called on password reset) and `revokeSession` therefore have no effect on whether a token is accepted, and `AdminSessionManager.getSession()` is dead code on the auth path. This directly contradicts ADR-0001's guarantee that *"reset invalidates all active admin sessions."* In-process revocation does not work; only a full server restart (which rotates the per-process `instanceId`) invalidates tokens.
- **No admin logout endpoint exists.** Client `logout()` only clears `localStorage`; the server session is never revoked and, per the above, could not be honored even if it were.
- **One mutation route is missing CSRF and audit.** `POST /lifecycle/:moduleId/switch-source` applies only `requireAdminAccountExists` and `requireAdminAuth` — no `requireAdminCsrf`, no `auditAdminAction` — even though it mutates active-source state and broadcasts to all clients. Every other mutation route uses the full chain.
- **Source-profile bearer tokens leak to the browser.** `GET /admin/sources` returns full profiles including plaintext `auth.token`. `sources.json` is also written without the owner-only permissions that `admin-auth.json` and `admin-audit.ndjson` receive.
- **`/auth/reset` is not rate-limited.** Login is, but reset — which accepts the recovery secret and overwrites the password — is not, permitting brute-force of the setup/reset token across the localhost boundary.
- **Remote-source authentication has no UI.** ADR-0006 Phase 28 specifies per-source token auth, but the panel only collects URL and name on create, only ever toggles `enabled` on update, and offers no edit form. Authenticated registries can only be configured by hand-editing `sources.json`.
- **Source install is not profile-scoped.** `SourceProfilePanel` install always posts `source: 'index://'`, so with multiple indexed sources the artifact resolves by global priority rather than the profile the operator is browsing.
- **World route registration is fragile.** `/world/launch` and `/world/shutdown` are registered twice (a middleware-only registration followed by a handler registration), unlike `/world/retry`, making it easy to drop the auth/CSRF chain in a future edit without an obvious failure.
- **Audit event types drift.** The server emits `timestamp` as an ISO string with no `action`/`details` fields; the client interface declares `timestamp: number` plus fields the server never sends. It renders correctly only by accident.

A further low-severity audit note — that install/upgrade prompt a server restart — appears to predate the module SDK's runtime reload handling. Packaged modules are expected to hot-reload through the SDK without a restart, which would make the restart prompt obsolete. This is treated as a verification task sequenced after the correctness and hardening work.

This ADR runs as an admin-layer workstream. It does not change the document-store architecture, the module SDK contract, or any player-facing surface.

## Decision

Sheet Delver will close the audit gaps as a phased admin-hardening pass that brings the implementation up to the guarantees ADR-0001 and ADR-0006 already state, then verify whether the restart prompt is still warranted.

The decision has six parts, sequenced so that security correctness lands before UX work.

### 1. Admin Authentication Is Session-Store Backed

`requireAdminAuth` must accept a token only if it is both a structurally valid app-admin token *and* present in the active session store. Authentication consults `adminSessionManager.getSession(token)`, which validates expiry/instance and confirms the session has not been revoked. Stateless parsing alone is not sufficient to authorize a request.

This makes `revokeSession` and `revokeAllForAdmin` authoritative: a password reset, an explicit logout, or an administrative revocation immediately stops the affected tokens from authenticating, satisfying ADR-0001's reset guarantee within a running process.

### 2. Logout Is a Server Operation

A dedicated `POST /admin/auth/logout` route revokes the caller's session server-side. The admin client calls it during `logout()` before clearing local state. Logout must revoke the presented session even though it is otherwise an authenticated mutation.

### 3. Every Admin Mutation Uses the Full Protection Chain

All state-changing admin routes apply the same middleware chain in the same order: `requireLocalhost` (router mount) → `requireAdminAccountExists` → `requireAdminAuth` → `requireAdminCsrf` → `auditAdminAction`. `switch-source` is brought into compliance. World-control routes are registered once each with the full chain inline, matching `/world/retry`, removing the split middleware/handler registration. No privileged mutation may execute without CSRF protection for browser callers and an audit record.

### 4. Recovery Secrets Are Rate-Limited and Source Credentials Are Not Browser-Exposed

- `POST /auth/reset` is rate-limited. `POST /auth/setup` is rate-limited as defense-in-depth even though it self-disables after first account creation.
- Source-profile responses redact `auth.token`. List/get responses expose only whether auth is configured (e.g. a boolean or masked value); the cleartext token is accepted on write and never returned. `sources.json` is persisted with the same owner-only permission posture as the other security files where the OS permits.

### 5. Source Profile Management Is Complete and Profile-Scoped

The admin panel can create, edit, enable/disable, and delete source profiles, including configuring per-source bearer auth (write-only field, consistent with the redaction rule). Installing a browsed module targets the specific profile being browsed rather than a generic `index://` resolution, so the artifact comes from the intended source.

### 6. The Restart Prompt Is Verified, Not Assumed

After the above phases land, verify whether packaged-module install/upgrade still requires a server restart given the SDK's runtime reload handling. If hot-reload is confirmed, the restart prompt is removed or downgraded to an explicit, accurate operational note; if a restart is genuinely still required for some path, that path is documented precisely rather than prompting unconditionally.

## Target Behavior

```text
Admin request
  -> requireLocalhost
  -> requireAdminAccountExists
  -> requireAdminAuth  (structural validity AND session-store presence)
  -> requireAdminCsrf  (browser-origin mutations)
  -> auditAdminAction  (recorded for every privileged mutation)
  -> handler

Password reset / logout / revoke
  -> adminSessionManager revokes session(s)
  -> subsequent requests with those tokens fail at requireAdminAuth

Source profile responses
  -> auth.token redacted outbound; accepted inbound only
```

## Implementation Plan

### Phase 1: Session Integrity and Revocation

- Make `requireAdminAuth` authorize via `adminSessionManager.getSession(token)` in addition to structural validation, preserving the existing principal-type and Foundry/service-token rejection behavior.
- Add `POST /admin/auth/logout` that revokes the presented session.
- Wire the admin client `logout()` to call the logout route before clearing local state.
- Add tests: a revoked session (via reset and via logout) is rejected on the next request; a valid session still authenticates; principal-type and non-admin-token rejections still hold.

**Phase 1 completed: June 10, 2026**

Delivered:
- `requireAdminAuth` now authorizes via `adminSessionManager.getSession(token)` after structural validation; revoked/unknown sessions return 401. The raw token is retained on `req.adminSessionToken` for downstream revocation.
- `POST /admin/auth/logout` (full chain: account-exists → auth → csrf → audit) revokes the caller's session server-side.
- Admin client `logout()` calls `postLogout()` (fire-and-forget) before clearing local state.
- Auth middleware tests extended with revocation cases (`revokeSession` and `revokeAllForAdmin` both reject previously-valid tokens). Full `npm run test:unit` passes.

### Phase 2: Mutation Route Protection Parity

- Add `requireAdminCsrf` and `auditAdminAction` to `POST /lifecycle/:moduleId/switch-source`.
- Collapse the `/world/launch` and `/world/shutdown` double-registration into single registrations with the full middleware chain inline.
- Extend the admin route tests to assert the full middleware chain (auth → csrf → audit) is present on every mutation route, not just that the route is registered.

**Phase 2 completed: June 10, 2026**

Delivered:
- `POST /lifecycle/:moduleId/switch-source` now applies `requireAdminCsrf` and `auditAdminAction` alongside the existing auth.
- `/world/launch` and `/world/shutdown` collapsed from the split middleware/handler double-registration into single registrations with the full chain inline, matching `/world/retry`.
- Added an `assertMutationChain` helper to the admin route tests that verifies `requireAdminAuth`, `requireAdminCsrf`, and `auditAdminAction` are all present on every mutation route (auth/logout, world launch/shutdown/retry, lifecycle enable/disable/switch-source, manager install/uninstall/upgrade/validate, sources POST/PUT/DELETE, server/restart). `npm run test:unit` passes.

### Phase 3: Credential and Recovery Hardening

- Apply a rate limiter to `POST /auth/reset` and `POST /auth/setup`.
- Redact `auth.token` from source-profile list/get responses; accept it only on create/update.
- Persist `sources.json` with owner-only permissions where the OS permits, matching the existing security-file posture.
- Add tests: reset is rate-limited; `GET /sources` does not return cleartext tokens; a written token round-trips through resolution without being echoed back.

**Phase 3 completed: June 10, 2026**

Delivered:
- `POST /auth/setup` and `POST /auth/reset` now apply the `adminLoginLimiter`, alongside `POST /auth/login`. The auth route test asserts the limiter is wired on all three by reference.
- Added `redactSourceProfile` / `RedactedSourceProfile` in `sourceProfiles.ts`; `GET /admin/sources`, `POST /admin/sources`, and `PUT /admin/sources/:id` now return the redacted shape (`auth: { type, configured: true }`) so the cleartext `auth.token` never leaves the server. The stored profile is unchanged.
- `saveSourceProfiles` sets `0o600` on `sources.json` where the OS permits, matching the admin-auth/audit security-file posture.
- New `source-profile-redaction.test.ts` proves the token is stripped, presence is preserved, the source object is not mutated, and the serialized output never contains the secret. `npm run test:unit` passes.

### Phase 4: Source Profile Management UX

- Add an edit form to `SourceProfilePanel` for name, URL, priority, enabled, and a write-only bearer auth token field, using `updateSourceProfile`.
- Add the auth token field to the create form.
- Pass the browsed profile's identity through to install so the artifact resolves from that source rather than generic `index://`.
- Verify against the host-allowlist enforcement already present on the write routes.

**Phase 4 completed: June 10, 2026**

Delivered:
- `SourceProfilePanel` create form gains an optional write-only bearer token field; `createSourceProfile` includes `auth` only when a token is entered.
- Per-profile inline edit form (name, URL, priority, write-only token) for non-default profiles, driven by `updateSourceProfile`. A blank token leaves existing auth unchanged; a "🔒 Auth" badge indicates a profile has auth configured (from the redacted `auth.configured` flag).
- Install from the module browser is now profile-scoped: `sourceRefForProfile` builds `index://<host>` for indexed profiles so resolution targets that profile's index rather than the priority-aggregated bare `index://`.
- Client `SourceProfile.auth` updated to the redacted read shape `{ type, configured }`; a separate `SourceProfileWrite` type carries the write-only token. `tsc --noEmit`, lint on the changed files, and `npm run test:unit` all pass.

### Phase 5: Audit Event Contract Cleanup

- Align the client `AdminAuditEvent` interface with the server payload: `timestamp` as an ISO string, drop unused `action`/`details`, keep the path/method/status/ip/adminId fields the viewer actually renders.
- Confirm `AuditLogViewer` formatting is correct under the aligned types.

**Phase 5 completed: June 10, 2026**

Delivered:
- Client `AdminAuditEvent` now mirrors the server payload: `timestamp` is an ISO-8601 string, `statusCode` is required, and the server-emitted `outcome`/`userAgent`/`durationMs` fields are reflected; the fictional `action`/`details` fields were removed.
- `AuditLogViewer.formatTimestamp` is retyped to accept the ISO string. `tsc --noEmit`, lint on the changed files, and `npm run test:unit` pass.

### Phase 6: Restart Requirement Verification

- Exercise a packaged-module install/upgrade and confirm whether the SDK runtime reload makes the running server pick up the change without a restart.
- If confirmed, remove or downgrade the `RestartModal` prompt to an accurate note; if a restart is still required for a specific path (e.g. production Next.js rebuild for new module UI chunks), document that path precisely.
- Update ADR-0006's restart-related notes to match the verified behavior.

**Phase 6 completed: June 10, 2026** (verified from the code path, not runtime)

The restart prompt was confirmed obsolete by reading the module-UI serving path:

- `GET /api/modules/:id/ui` (`createModuleRouter.ts`) serves a managed module's compiled UI artifact by reading it from `<DATA_DIR>/modules/:id/` **at request time**, with `Cache-Control: no-store` ("always serve fresh after install/upgrade"). Its own comment states this endpoint "exists specifically for managed modules installed after the Next.js build." Managed modules — the only kind the admin manager installs — are therefore **not** part of the Next.js bundle and need no rebuild.
- On install/upgrade/uninstall the server calls `refreshRegistry()` to update the in-memory adapter registry and broadcasts `moduleRegistryChanged`; `useModuleHotReload` re-fetches the active UI module on that event, so open clients pick up the change with neither a restart nor a reload. `ManagerActionBar.handleConfirm` already documents this and deliberately triggers no restart.
- Only build-time **local dev** modules load through webpack via the generated `@data-registry/module-ui-registry`; those are not installed through the admin UI, so the manager flow never hits the rebuild path the old modal text warned about.

Action taken: removed the obsolete, install-centric `RestartModal` — which was already dead code (`setRestartOperation` was never invoked, so the prompt never rendered) — and its mount/state in `admin/page.tsx`. The `POST /admin/server/restart` route and its `postServerRestart` client wrapper are retained as a legitimate manual-restart capability, decoupled from the (non-existent) install-restart requirement. No ADR-0006 correction was needed: its restart references describe only the production Next.js rebuild for the local-dev/build path, which remains accurate.

## Non-Goals

- No change to the localhost-only trust boundary or the single-account local admin model (ADR-0001 Option B stays).
- No move to HttpOnly cookie sessions in this ADR. The token-and-CSRF-in-`localStorage` posture is acknowledged as an XSS exposure under the localhost/single-operator model. (Subsequently assessed and resolved as a deliberate won't-do — see Amendment 1.)
- No external identity provider, multi-admin, or RBAC work. (Multi-admin/RBAC subsequently dropped as a tracked concern — see Amendment 2.)
- No distribution/extraction scope beyond the source-profile auth UX gap.
- No module SDK contract changes.

## Alternatives Considered

### Keep Stateless Token Validation, Add a Revocation Denylist

Rejected. The session store already exists and already tracks active sessions; routing authorization through it is simpler and makes revocation authoritative without a parallel denylist to maintain and expire.

### Move to HttpOnly Cookie Sessions Now

Originally deferred (not rejected) to avoid delaying the correctness fixes. Subsequently assessed against the threat model and resolved as a deliberate **won't-do** — see Amendment 1. In short: `requireLocalhost` already confines a stolen token to local-host use, which removes the main payoff HttpOnly defends against, so the migration's marginal benefit does not justify reworking a security-critical auth path.

### Drop the Restart Prompt Immediately

Rejected as premature. The prompt may still be correct for the production Next.js UI-chunk path. The behavior is verified in Phase 6 before changing operator-facing guidance.

## Consequences

### Positive

- Session revocation, password reset, and logout become truthful, satisfying ADR-0001's stated guarantees.
- Every privileged admin mutation is uniformly CSRF-protected and audited.
- Recovery secrets and source credentials stop being brute-forceable / browser-exposed.
- The source-profile UX matches ADR-0006 Phase 28's authenticated-source intent.
- Operator-facing restart guidance reflects actual runtime behavior.

### Tradeoffs

- Authorization now depends on in-memory session state, so a server restart continues to force re-login (already true via `instanceId`; now also the explicit model).
- The redaction rule means the admin UI cannot display existing tokens, only replace them — a deliberate confidentiality/usability trade.
- Additional middleware on `switch-source` adds an audit record per source switch.

## Validation

This ADR is complete when:

- A token that has been revoked (via reset or logout) is rejected by `requireAdminAuth` on the next request, with a test proving it.
- Every admin mutation route carries `requireAdminAuth`, `requireAdminCsrf`, and `auditAdminAction`, asserted by tests.
- `POST /auth/reset` and `POST /auth/setup` are rate-limited.
- `GET /admin/sources` never returns cleartext `auth.token`, and `sources.json` is owner-restricted where supported.
- Source profiles can be created, edited (including auth), toggled, and deleted from the admin UI, and install targets the browsed profile.
- The client audit event type matches the server payload.
- The restart prompt reflects verified runtime behavior.

Expected verification gates:

- `npx tsc --noEmit`
- focused lint on changed admin/security/route/client files
- targeted unit tests for the admin auth middleware, session service, route wiring, source profiles, and rate limiters
- `npm run test:unit`

## Implementation Tracking

Status board:
- Phase 1: ✅ Completed (June 10, 2026)
- Phase 2: ✅ Completed (June 10, 2026)
- Phase 3: ✅ Completed (June 10, 2026)
- Phase 4: ✅ Completed (June 10, 2026)
- Phase 5: ✅ Completed (June 10, 2026)
- Phase 6: ✅ Completed (June 10, 2026)

This ADR should be updated per-phase as work advances, mirroring the completion discipline used in ADR-0006 and ADR-0028.

---

## Amendments

### Amendment 1 — Session storage (HttpOnly cookies) assessment and decision

**Date:** June 10, 2026
**Resolves:** the "Move to HttpOnly Cookie Sessions Now" item left as future work under Non-Goals and Alternatives Considered.

The original ADR deferred moving the admin session token out of `localStorage` and into an HttpOnly cookie as a defense against token exfiltration via XSS. Revisiting that vector against the actual threat model:

**Threat model facts**
- Every admin route is mounted behind `requireLocalhost`; the Core Service rejects any admin request whose effective client address is not loopback. A token is therefore only usable *from the local host* regardless of where it is stored.
- Sessions are short-lived (15 minutes), bound to the per-process `instanceId`, and — as of Phase 1 — revocable server-side via the session store.
- The admin panel is a single-operator surface. It renders only React-escaped strings (module/world/source/audit text); it does **not** execute module UI code (that runs on the player actor pages via `/api/modules/:id/ui`, a different origin context). The admin page's XSS surface is correspondingly small.

**Why HttpOnly's marginal benefit is low here**
The primary thing an HttpOnly cookie buys is preventing a script from *reading* the bearer token and replaying it elsewhere/later. But under `requireLocalhost`, a stolen token cannot be replayed from anywhere except the local host — the same boundary an attacker would already need to cross. The CSRF token must remain JS-readable for the double-submit header, so an XSS that can run on the admin page can already drive same-origin mutations using the auto-sent cookie *and* read the CSRF token; HttpOnly does not stop that in-page abuse. So the realistic residual gain is small.

**Cost and risk**
The migration is invasive in the most security-sensitive path: server `Set-Cookie` on login/setup, cookie extraction in `requireAdminAuth`, cookie clearing on logout, dropping the `Authorization` header in `adminFetch` (and `credentials: 'include'`), and validating cookie forwarding through the Next.js `/api/admin` rewrite proxy — including `SameSite`/`Secure` behavior on plain-`http` localhost. The regression risk (silently breaking auth or locking out the operator) is non-trivial and hard to cover without a running stack.

**Decision: do not migrate.** Given `requireLocalhost` already caps the blast radius of a stolen token to the local host, short-lived revocable sessions, and the admin page's minimal XSS surface, the defense-in-depth gain does not justify reworking the auth path. This is now a deliberate **won't-do**, not pending future work. It can be revisited if either invariant changes — e.g. if the admin surface is ever exposed beyond localhost, or if the admin page begins rendering untrusted HTML or executing module/third-party code. At that point HttpOnly session cookies + a double-submit CSRF cookie become the right model and this decision should be reopened.

The general XSS hygiene that *does* matter regardless — keep the admin panel free of `dangerouslySetInnerHTML` over untrusted content and avoid executing module code in the admin origin — remains an ongoing convention rather than an ADR action item.

### Amendment 2 — Multi-admin / RBAC removed as a tracked concern

**Date:** June 10, 2026

ADR-0001 left "multi-admin or role-based admin model" open as a future option. In practice the probability of multiple distinct administrators accessing this backend is effectively nil for the deployment model (local, single-operator, localhost-gated). Multi-admin and RBAC are therefore dropped as tracked future work for this control plane. The single app-admin principal (ADR-0001 Option B) stands as the intended end state, not a stepping stone. This can be reopened if a genuine multi-operator deployment requirement emerges.
</content>
