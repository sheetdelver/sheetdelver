<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# SheetDelver Working Agreement

## Start and Handoff

- Read `temp/AGENT-HANDOFF.md` when present, then the active tracker it names.
  These are local snapshots, not substitutes for current user instructions or
  verification of branch, worktree, version and process state.
- Keep one current handoff at that stable path. Update it at context/model
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
  Managed installs belong in the configured data directory's modules/, never
  local/modules/. Do not overwrite development copies or add system-name hacks.
- Foundry source documents, host-prepared models and authorized projections are
  distinct. A prepared host value is not proof of native Foundry browser data.
  Core owns lifecycle/cache/authorization; modules own system rules (ADR-0038).
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

- Keep one active follow-up list. Completed audits move to completed/ only after
  checking disposition/evidence. Closed ADRs and archived research do not create
  new obligations because an old paragraph says pending.
- Deferred ideas stay deferred until the user chooses them. Do not revive the
  parked native D&D preparation-runtime experiment without explicit direction.
- New unrelated work gets its own scope/ADR when appropriate, not additions to
  an already-closed ADR. Update architecture/API/SDK/module-authoring docs when
  their contracts change; keep module-only documentation module-owned.
- Changelogs are terse feature snapshots, usually 3-5 words per bullet, not
  commit transcripts. Use docs/RELEASING.md and the existing release helper.
- User's interactive shell is often Fish. Prefer short single-line commands;
  label shell-specific syntax and avoid Bash loops/heredocs as Fish examples.
