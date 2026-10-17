# Maintenance-only runtime (development)

ADR-0064's complete-maintenance correction is implemented on the corrective
branch and undergoing whole-host acceptance. This is not a released Core version
or permission to resume module adoption. The [independent review](adr/0064-module-world-context-and-data-migrations.md#independent-complete-maintenance-review--october-17-2026)
confirms open CR64-14–17 corrections in exact single-write verification,
unproven-drain cancellation, legacy plan storage and final bootstrap fencing.
Correct these before native acceptance; the lifecycle below is the required
contract, not a claim that those paths are complete. Application/module release
metadata is unchanged.

## Lifecycle owners

| Normal producer / owner | Shutdown boundary | Maintenance replacement |
| --- | --- | --- |
| Next request rendering, module UI imports, HMR/build watchers / manager | Stop normal Next process group; confirm all live owned descendants exit | Small Core-owned status/admin shell, no Next or module UI |
| Core HTTP/domain/module/debug routes / index and route composers | Close admission before auth/restoration; terminate normal Core group after drain | Authenticated maintenance/status/recovery routes only |
| User login, cached restore/retries, authorization refresh, shared-content listeners / FoundryUserConnectionService | Suspend and retire authority epoch; detach/disconnect live transports without erasing encrypted credentials; process exit retires late promises | No user connection service is instantiated |
| Gameplay sockets, presence, preference and document listeners / AppSocketGateway | Disconnect sockets; terminate owning Core | Public maintenance status only; no credential restoration/action handlers |
| Status polling/lifecycle broadcasts / registerSockets | Dispose/exit the normal Core | One bounded public maintenance broadcaster |
| Service retry, heartbeat, engagement wakeups and launch/shutdown / WorldTransportController, SystemService, EngagementService | Dispose controller and transport after outstanding native sends settle | One maintenance CoreSocket with sequential retry/identity priming; no normal lifecycle controller |
| Adapter initialization, context hooks, preparation caches, module-created timers / WorldBootstrapper and module registry | No candidate adapter before complete compatibility; normal process/descendants exit | Final fresh preparation in a read-only owned worker over the parent's transport; terminate/await it before replacement |
| Native document/batch/autosave/catalog ingress and queued repairs / FoundryEventIngress | Stop serving repairs, preparation and gameplay publications | Observation-only ingress advances existing Store/pack revisions; User authority updates remain active |
| Pending native writes / WorldWorkGate | Close admission, settle counted sends before supervisor replacement; failed drain persists recovery | Exact approved controller dispatch only; intent and readback remain durable |
| Admin auth/session cleanup, logging / existing security and logging services | Retain restart handoff; credentials remain owner-only | Same admin network/origin/session/CSRF/audit policy and logging |
| Normal manager/Core and their owned descendants / start-server | Exclusive data-directory leases and confirmed process-group exit | Manager supervises maintenance Core only, including crash replacement |

No Foundry or unrelated process is stopped. Process groups are confined to the
manager's own children. On Linux, descendant confirmation excludes dead zombies,
not live workers. A failed stop cannot start a replacement writer. Direct Core
and second-manager launches honor persistent mode and exclusive runtime leases.

## Persistent operation and public workflow

`config/module-upgrades/maintenance.json` is an owner-only, fsynced operation
record. Its stages are entering → isolated → planning → review → executing →
activating → serving; failures remain recovery-required. The existing world/module
lease is reserved before disruption and transferred to the approved job identity.
An environment variable cannot override the durable mode. Existing pending 0.19.0
jobs are routed into this composition without fabricating a new approval.
Disruption records whether ordinary native sends had settled. A failed/unproven
drain blocks new planning/approval; restarting is not evidence that an unknown
ordinary native outcome settled. Preserve the record and reconcile those outcomes
before operator recovery. Diagnostic-only corrupt mode/journals expose admin
recovery without connecting a native writer or overwriting the damaged record.

1. Online source/archive inspection is advisory. Its candidate is retained by
   Core; no candidate adapter is constructed and no writes are authorized.
2. `POST /admin/module-maintenance/enter {planId}` consents to disruption only.
   Mode is durable before admission closes, sends drain and normal workers stop.
3. The maintenance controller builds a fresh complete plan after isolation.
   `GET /admin/module-maintenance` exposes bounded progress and the full review
   when ready. Rebuilding/reviewing uses `POST .../plan`.
4. `POST .../approve {planId,backupAcknowledged:true}` binds the exact authoritative
   plan and administrator. Existing artifact/history/source checks, lease,
   idempotency and backup warning remain required. Promotion and execution occur
   without starting normal services. Entering maintenance alone cannot approve.
5. `POST .../resume` continues approved unchanged work. An expired advisory preview
   or disconnected tab does not cancel an executing approval. Changed inputs
   require a fresh exact recovery review; confirmed operations are not replayed.
6. Complete readback/verification and fresh preparation precede activating. The
   supervisor then replaces maintenance Core with normal Core/Next. Fresh normal
   bootstrap must pass before serving is persisted and admission reopens. Runtime
   tokens retire old browser mutation authority.

Only the restricted admin/status shell, one full-GM service transport, observation,
controller/CPU workers, journal, security and supervisor run in maintenance. Normal
world-changing admin tools, login, module/domain/debug APIs and player actions are
unavailable even with existing credentials. Admin and player responses remain
separate; only administrators see source/step/target failure reasons.

## Computation, source reads and receipts

Production bootstrap/planning/revalidation/final checks run in owned computation
workers, with progress and no global inventory deadline. Each pure hook still has
its one-second VM/input/output bounds. Job-local compiled code is reused; mutable
VM globals are never shared. Plans visit the complete selected inventory.

New bounded relation declarations require module-api **1.6.0** (SDK **3.4.0**).
Existing catalogs retain the 1.5.0 introduction floor. Relations project declared
parent/ancestor/base fields by canonical UUID, including arbitrary writable world
packs and partial ActorDeltas; omitted/null/inherited data is not fabricated.
Selected relation sources are bound in dependency evidence. Mutation simulation
updates affected ancestors rather than rehashing the entire world for each patch.

Complete initial/final inventories remain authoritative. During execution, new
bounded-relation plans refresh exact target/dependency roots via native source
reads. Compatible consecutive operations use native batches of at most 50 updates
and 512 KiB per envelope; these are automatic send bounds, not inventory caps or
additional approval/chunk boundaries. All per-target intents are fsynced before
send. Validate the approved sequential simulation first, then read back every
exact resulting target and run its verify hook. Partial/lost acknowledgements
retain all affected intents for readback, never blind batch replay.
Legacy whole-kind/pack dependencies retain full reads rather than silently
weakening their approval. Observation revisions still fence read/send windows;
this is not native CAS or lockout.

Jobs retain their immutable plan and an append-only, fsynced `.json.receipts`
outcome stream, keyed by approval ID. Existing inline outcomes remain readable;
new saves preserve them before using the stream. Reapproval retains historical
approvals/receipts rather than clearing evidence. An incomplete record stops in
diagnosable recovery. Do not downgrade to 0.19.0 to resume the new journal format;
use a tested supporting Core release. No world backup/restore/undo is provided.

Isolated actual supervisor/API acceptance now covers complete no-op, install,
upgrade, same-version repair, local-to-managed switch, cumulative versions,
restored source despite a completed ledger, uncertain/partial writes, forced
Core termination and preparation replacement. Original 30/900/300 and larger
60/2400/720 inventories complete with independent source oracles. These controlled
upstreams are not native v13/v14 acceptance. Resource costs, limitations and open
native/user gates are recorded in ADR-0064; module work remains held.
