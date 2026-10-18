<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# SheetDelver Working Agreement

## Start and Handoff

- For Core work, read `temp/AGENT-HANDOFF.md` when present, then the active Core
  tracker it names. For work in `data/local/modules/<id>`, start with that
  repository's own `AGENTS.md`, `CLAUDE.md` and `temp/AGENT-HANDOFF.md`; the Core
  handoff is not a module task queue. These are local snapshots, not substitutes
  for current user instructions or verification of branch, worktree, version
  and process state.
- Keep one current handoff at that stable path within each owning repository.
  Update it at context/model
  switches; retain at most one previous snapshot if useful, not an ever-growing
  transcript. Record verified facts, user reports and unknowns separately.
- `AGENTS.md` and `CLAUDE.md` are tracked project guidance; keep them current.
  `temp/` remains ignored local context. Tracked documentation must be
  self-contained, not depend on ignored reports.

## Git and Remote Operations

- Default to read-only Git operations. Ask for scoped approval before creating,
  switching, deleting or renaming branches; staging; committing; stashing;
  merging; fetching/pulling; or creating/deleting tags. Prior task permission is
  not blanket permission for subsequent work.
- User normally pushes, opens PRs, squash-merges and publishes tags. Never push,
  create/delete a GitHub repository, change remote settings, dispatch workflows
  or make other remote writes without explicit approval for that operation.
- When the user explicitly authorizes a PR merge, use a squash merge with
  branch deletion (`gh pr merge -sd`) after required checks pass. Verify that
  the PR merged and its source branch was removed both remotely and locally;
  do not leave stale module or Core feature branches behind. Historical branch
  cleanup is separate: verify its PR and content before deleting it, and never
  delete parked research or unrelated work by inference.
- Feature work belongs on an approved branch, not main. The user has permitted
  narrow release-tool/housekeeping edits on main; do not extend that exception
  to application features. Never create a branch merely to prepare a release.
- Preserve unrelated changes, module checkouts, stashes and parked research.
  No resets, cleanup/deletion or history rewriting without explicit approval.
- Running the release helper without --dry-run makes commits/tags and can offer
  pushes. Do not run it on the real repository without release authorization.
  Tool/sandbox approval alone is not user authorization for Git or remote writes.
- During feature work and ADR closeout, prepare changelog entries only. Do not
  pre-bump Core package.json/package-lock.json or module release versions unless
  separately authorized for release preparation. Core version changes belong to
  release:tag; a planned CHANGELOG.md heading does not authorize metadata bumps.
  If metadata was already committed, use the helper's tag-only recovery rather
  than reverting versions or inventing another patch release. Record the pending
  release state and required approvals in the handoff.

## Production and Test Safety

- Treat the root .env/settings as production-connected unless verified otherwise.
  Do not start Core, npm run dev/start, user/service-account sockets or live
  probes against hosted Foundry merely to test a change. Prefer isolated data
  directories and the user's explicitly approved local Foundry instance.
- Never print secret values or copy configuration/session credentials into
  reports. Do not mutate actors, users, worlds or permissions on production.
- Playwright/browser tooling is allowed for isolated local development tests
  only. Do not add it to application/backend dependencies or require a running
  Foundry browser (human-operated or headless) for normal app functionality.
- Inspect existing listeners and process ownership before starting/stopping
  services. Do not kill broad sets of Node processes. Record retained test
  services in the handoff; do not start or purge them without a task need.

## Architecture and Ownership

- Use the brand spelling SheetDelver. Read docs/architecture.md,
  docs/CONTRIBUTING.md and relevant ADRs before implementation.
- Keep client UI browser-only; server orchestration and sockets server-only;
  shared code environment-neutral. Modules consume API/SDK/runtime contracts,
  not private host imports or direct Foundry transports. Reuse existing helpers.
- System module repositories live in data/local/modules/<id>. Keep their source,
  documentation and audits inside the module (D&D uses temp/audit-report/).
  Each module owns its agent guidance and handoff. Durable module decisions and
  evidence belong in its docs/adr/ and docs/audits/; keep agent workflow in its
  AGENTS.md and technical reference in docs/architecture.md. Do not use Core
  trackers or developer documents as substitutes for module agent instructions.
  Managed installs belong in the configured data directory's modules/, never
  local/modules/. Do not overwrite development copies or add system-name hacks.
- Foundry source documents, host-prepared models and authorized projections are
  distinct. A prepared host value is not proof of native Foundry browser data.
  Core owns lifecycle/cache/authorization; modules own system rules (ADR-0038).
- The configured Core Foundry service account must be full Gamemaster in every
  served world; Assistant is insufficient. The connection/reconnect/demotion
  gate shipped in Core 0.19.0; complete-maintenance corrections shipped in 0.19.1.
  Do not describe either as shipped in 0.18.1, promote a live account implicitly,
  or apply this service-account restriction to ordinary Assistant/player request permissions.
- Shared chat, notifications and dice presentation belong in Core UI/SDK, not
  duplicated in each module. Preserve visibility, lifecycle and realtime rules.
- Never use native browser `alert()`, `confirm()` or `prompt()` for application
  flows. Reuse Core's shared confirmation/modal components (and the exposed SDK
  components in system modules); create a new modal only if no existing one
  fits. Check current state before asking for a conditional confirmation, and
  keep new tool pages/cards aligned with Core's active theme and world background.
- Application version authority is package.json (with root lock versions kept
  aligned). SDK/API versions come from src/shared/sdk/contractVersions.ts.
  Do not create another version authority or bump module requirements casually.

## Scope and Documentation

- Keep one active Core audit/follow-up report in `temp/audit-reports/`; its README
  indexes that report, and the Core handoff links to it. Modules maintain their
  own active report, selected by their local handoff. Before retiring a report to
  `completed/`, verify its ADR/evidence and carry unresolved content into the
  successor. Distinguish completed fixes, superseded plans and explicit deferrals.
  Module-owned technical evidence stays with the module, not in another root queue.
  Closed ADRs and archived research do not create new obligations because an old
  paragraph says pending.
- ADR-0064's selected October 18 Core corrections (CR64-23–26/R1) are closed
  with independent and native v13/v14 acceptance. Supporting publication and
  module resumption remain separate. CG-5 is shared UI, not a migration blocker.
  Preserve verified evidence; unselected G8 observations remain in the deferred
  ledger. Do not reopen completed gates or edit module repositories by inference.
- Deferred ideas stay deferred until the user chooses them. Do not revive the
  parked native D&D preparation-runtime experiment without explicit direction.
- Record deferred work in `temp/audit-reports/DEFERRED-WORK.md`, with stable IDs,
  status, rationale, source ADR/audit, rejection details when applicable and
  criteria for reconsideration. This standing ledger is separate from the one
  active audit. Update decisions without erasing their history; when selected,
  link the active ADR/report rather than duplicating its implementation checklist.
- New unrelated work gets its own scope/ADR when appropriate, not additions to
  an already-closed ADR. Update architecture/API/SDK/module-authoring docs when
  their contracts change; keep module-only documentation module-owned.
- Changelogs are terse feature snapshots, usually 3-5 words per bullet, not
  commit transcripts. Use docs/RELEASING.md and the existing release helper.
- User's interactive shell is often Fish. Prefer short single-line commands;
  label shell-specific syntax and avoid Bash loops/heredocs as Fish examples.
