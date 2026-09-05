# ADR-0001: Admin Authentication Model

**Status:** Accepted
**Date:** April 21, 2026
**Phase:** 19

---

## Context

SheetDelver requires operational admin controls for lifecycle management (enable/disable modules, configuration, world operations). Prior to this decision, the `/admin` route group was protected only by a localhost IP check (`127.0.0.1` / `::1`). No explicit admin principal existed.

Two identity models were already present in the system that could have been repurposed for admin access:

1. **Foundry user sessions** — Created by logging into Foundry as a named user (e.g., GM). These represent gameplay identities, not operational admin identities.
2. **Service token** — A shared bearer token for machine-to-machine calls. Coarse-grained, not scoped per operation, no human attribution.

Neither model is appropriate for privileged admin operations because:
- Foundry GM account != application administrator. A GM controls a game world; they do not necessarily have — or need — control over server lifecycle or module management.
- Service token has no human identity, no session lifecycle, no audit attribution, and a high blast radius if leaked.
- Localhost-only gating is useful as defense-in-depth but is not an identity mechanism. It can be fragile in proxy or container topologies and provides no audit trail.

As lifecycle mutation APIs are introduced, privileged operations need a dedicated, attributable, and revocable identity.

---

## Decision

Introduce a **dedicated local app-admin identity** (Option B), separate from Foundry user sessions and separate from the service token.

This is a single-account local model bootstrapped by the server operator. It does not federate with Foundry and does not use external identity providers.

---

## Details

### Storage

- One admin account record stored in `.data/security/admin-auth.json`.
- File is server-local, never committed, excluded from version control.
- File permissions restricted to owner read/write only where the OS permits.

### Credential Format

- Password hashed with **Argon2id** and a unique random salt per account.
- Optional server-side pepper sourced from env/config and never written to disk.
- Stored fields: `adminId`, `passwordHash`, `createdAt`, `updatedAt`, `passwordChangedAt`, `failedLoginCount`, `lockedUntil`.
- Plaintext passwords are never stored or logged.

### Bootstrap Flow

- No default admin password ships with the application.
- First setup requires local operator action via a localhost-only setup endpoint.
- A **setup token** is read from env/config and required for first successful account creation.
- Once an admin account exists, the setup endpoint is no longer available.
- Until bootstrap is complete, admin mutation routes are unavailable.

### Session Model

- Admin login uses a **dedicated login endpoint** (`POST /admin/auth/login`) separate from Foundry login.
- On success, issue a **short-lived admin session token** (15 minutes) plus a per-session CSRF token.
- Session token claims include `principalType: "app-admin"`.
- Foundry session tokens and service bearer tokens are **not accepted** on admin mutation routes.
- Admin middleware validates principal type, not just token presence.

### Hardening Controls

- Login endpoint is rate-limited.
- Lockout/backoff applied after repeated failed attempts.
- Session tokens are maintained in-memory for the current server process.
- **CSRF protection** required for browser-based admin panel mutations.
- Localhost restriction (`requireLocalhost`) remains on `/admin` as a second gate, not the primary identity check.

**Amendment (September 2, 2026 - deployment and development controls):**
ADR-0033 supersedes the literal loopback-only route requirement with the
configured admin hostname, exact browser origin, and client CIDR allowlist on
the same application shell; admin authentication and CSRF remain mandatory.
`npm start` enforces both the dedicated request limiter and persisted account
lockout. `npm run dev` explicitly sets `NODE_ENV=development` and bypasses those
two failed-attempt controls for owner iteration. An absent or unknown
`NODE_ENV` fails closed by enforcing them. Successful admin sessions remain
15-minute, in-memory, revocable sessions in every mode.

### Recovery and Reset

- Local-only reset command runnable by server operator.
- Reset invalidates all active admin sessions and forces a new password.
- Reset events are logged with actor type `local-operator` for audit.

### Separation Rules

| Principal | Can access admin mutations? |
|---|---|
| Foundry GM user session | No |
| Foundry non-GM user session | No |
| Service token | No |
| App-admin session token | Yes |

---

## Alternatives Considered

### Option A: Localhost + Service Token Hardening

Keep localhost gating and use service token for privileged mutations with stricter scoping.

**Rejected because:**
- Service token cannot attribute actions to a human operator.
- Token leakage blast radius is high and not operationally bounded.
- Provides no identity separation between machine calls and admin actions.
- Poor foundation for audit logging and future RBAC.

### Option C: External Identity Provider / OIDC

Delegate admin identity to an external IdP.

**Rejected because:**
- Excessive operational complexity for current scope.
- Introduces external dependency for a local-operator workflow.
- Can be revisited if multi-operator or enterprise requirements emerge later.

---

## Consequences

**Positive:**
- Admin identity is explicit, attributable, and revocable.
- Clear trust boundary: Foundry identity ≠ app-admin identity.
- Audit trail includes a named admin principal for all privileged actions.
- Foundation for future RBAC without architectural rework.
- Lifecycle mutation APIs have a clear, testable auth requirement.

**Constraints introduced:**
- Bootstrap step is required before admin operations are available.
- Credential and session lifecycle must be maintained (rotation, recovery).
- Admin login surface must be hardened against brute force.

**Future options left open:**
- Multi-admin or role-based admin model can be layered on top of this principal type.
- External IdP delegation (Option C) remains viable as a future upgrade path.

---

## Implementation Target

This model must be in place before any lifecycle mutation routes are exposed.

The implementation must deliver:
1. Local admin account store at `.data/security/admin-auth.json` (excluded from version control, owner-only file permissions).
2. Argon2id password hashing with random salt and optional env-sourced pepper.
3. Bootstrap setup token from env/config required on first admin account creation.
4. Dedicated admin login endpoint (`POST /admin/auth/login`) that issues short-lived admin session tokens with `principalType: "app-admin"` claims and a CSRF token.
5. Admin auth middleware that validates principal type — Foundry session tokens and service bearer tokens are explicitly rejected.
6. Rate limiting and lockout/backoff on the admin login endpoint.
7. CSRF protection for browser-based admin panel mutations.
8. Local-only reset path that invalidates all active admin sessions.
9. Localhost restriction (`requireLocalhost`) retained on `/admin` as a second gate alongside admin auth, not as a replacement for it.

No lifecycle mutation routes (enable/disable/install/upgrade) are to be exposed until items 1–5 above are in place and covered by tests.
