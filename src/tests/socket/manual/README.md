# Manual Socket Probes

These scripts require operator judgement, prompts, hard-coded world/module data, or debug inspection. They are intentionally not part of `npm run test:socket`.

Run them directly with `npx tsx src/tests/socket/manual/<script>.manual.ts` when investigating a live Foundry instance. If a script becomes deterministic and assertion-driven, move it back to `src/tests/socket/*.test.ts` and register it in `run-all.ts`.

Use a full **Gamemaster** account for the configured Core service identity in an
explicitly approved test world. Human Assistant/player subjects may still be used
for caller permission probes. ADR-0064's connection-wide role enforcement is pending;
see [configuration recovery](../../../../docs/CONFIGURATION.md#service-account-role-and-recovery).

Current manual probes:

- `03-world-transition.manual.ts` — interactive setup/startup/shutdown observation.
- `04-compendium-fetch.manual.ts` — live compendium document dump into `temp/<systemId>`.
- `07-user-status.manual.ts` — exploratory user presence report.
- `08-session-persistence.manual.ts` — prompts for Foundry credentials and exercises disk session restoration.
- `09-execute-macro.manual.ts` — placeholder macro/connection probe; not a reliable automated assertion.
- `12-query-table-results.manual.ts` — hard-coded Shadowdark table-result investigation.
- `debug-scene-data.manual.ts` — scene snapshot debug dump with world-specific expectations.
- `list-tables.manual.ts` — hard-coded Shadowdark roll-table lookup.
