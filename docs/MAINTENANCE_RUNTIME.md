# Maintenance-only runtime (development)

ADR-0064's complete-maintenance correction is implemented on the corrective
branch, with passing selected whole-host and native v13/v14 acceptance. This is
not a released Core version or permission to resume module adoption. CR64-14–21
corrections have tracked failing-before/passing-after evidence and public/native
recovery results. The [latest acceptance](adr/0064-module-world-context-and-data-migrations.md#fresh-complete-maintenance-native-v13-acceptance--october-17-2026)
records exact source/write/receipt comparisons, cleanup and measured costs.
C64-H user review, supporting release and explicit hold-release remain open.
Application/module release metadata is unchanged.

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
before operator recovery. Cancellation, planning, approval, resume and transitions
to activating/serving require the durable `drained: true` proof, independently of
failure text. A process exit, missing approval or successful source check is not
that proof. Cold activating/serving records without proof stay restricted. An
unknown-drain cancellation retains recovery, lease and actionable diagnostics,
even before the native transport reconnects. A 202 accepts the request, not its
successful outcome; inspect durable status. Diagnostic-only corrupt mode/journals expose admin
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
exact resulting target and run its verify hook. Single writes (including a
one-operation batch tail) use the same exact-source comparison as batches.
Only native `_stats` metadata normalization is ignored; an unrelated content
change retains intent/recovery, never confirmation, activation, replay or undo.
Recheck snapshot freshness and authority before confirming receipts.
Partial/lost acknowledgements
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

Complete plans use internal `core-migration-plan.v3` references in preview/job
metadata and atomic content-addressed `plan-content/*.bundle` files. Paged lists and exact
dependency deltas avoid repeating whole-world maps in every durable operation;
each block remains bounded to32MiB and SHA-256 verified. The complete logical
plan/digest, dependency membership, patches and approval identity are unchanged.
This is not an inventory cap or a module/catalog rewrite. Review HTTP returns
every target/patch and logical digest, without internal dependency/effect maps.
Existing inline plans remain readable; oversized legacy inline records are
stream-imported, validated against their logical digest and retained verbatim as
`.legacy-inline` before compact replacement. Receipts, prior approvals and old
catalogs are preserved. Missing, incomplete or corrupted blocks stop recovery;
do not prune blocks/backups or downgrade to a release that cannot read them.
Logical plans are still materialized for execution and hashing, so memory/CPU
costs grow with the declared read sets; compression is not a small-host guarantee.

One serialized, process-owned storage worker performs complete plan encoding,
legacy/v2 loading, digest validation, receipt persistence and durable publication,
off the HTTP event loop. A bundle is fully written and file-synced, atomically
renamed, then directory-synced before metadata can confer approval or a native
send can proceed. Reusing an existing bundle validates and re-establishes its
durable publication. This reduces per-record file/fsync fanout, not durability.
Existing v2 loose blocks and inline journals remain readable without changing
logical approvals. Keep all historical content, receipts and retained originals.
Cancellation joins the retired worker before replacement; normal-worker shutdown
drains and terminates it. HTTP disconnect alone does not cancel execution.

First approval has a durable `initialApproval` publication intent in the
maintenance record, binding operation/plan/artifact/catalog/tree/principal and
idempotency identity under that operation's lease. It is not write authority.
The first job must be durable and bound as `jobId` before file promotion begins.
On interrupted save/acknowledgement, Core joins the storage writer, validates the
complete durable result independently of the cancelled computation signal, and
re-syncs visible metadata/receipts/directories before binding authority. A proven
unpublished intent retains its maintenance lease until admin cancellation; it
never fabricates a cancelled job. A published job retains its exact approval and
evidence and can be cancelled before writes or explicitly recovered.

Startup and controller Plan/Resume/Cancel reconcile this provisional state.
Both crash orderings are supported: before job publication, and after publication
but before binding. Cancellation owns controller admission through its final
readback/release and requires the original durable drain proof. Dead-PID takeover
is limited to the same operation; another owner cannot be released. Missing or
corrupt previously bound jobs, orphan receipt evidence, inconsistent identities
or a failed recovery durability barrier remain gated with admin diagnostics.
An arbitrary missing file is never proof that no writes occurred. Existing
legacy/v2/v3 approvals, receipts and history retain their original meaning.
Maintenance polling uses a process-local review/progress snapshot, never an
authoritative shortcut for approval or writes. Small lease/final-send metadata
checks stay synchronous. Brief supervised replacement outages remain possible;
off-thread storage is not a promise of bounded memory or zero-latency HTTP.

Progress counters are process-local diagnostics scoped to the current durable
record, not an fsynced write for every counter update. State transitions still
checkpoint the latest counters while durably recording stage/drain/lease intent.
After a crash, counts are reconstructed from the complete plan and durable
receipts; a counter reset never changes approval or permits replay. A changed
operation/file retires the local progress overlay. Admission, drain, approval,
native intents and receipts remain durable; this is not weaker write recovery.

After final asynchronous compatibility computation, normal bootstrap/reconnect
revalidates source, connection, authority and context before releasing the gate or
publishing prepared data. Final maintenance-to-normal startup uses that same
boundary. A stale final snapshot retains maintenance diagnostics. Admin
`retry-context` uses the existing SystemService recovery facade, including its
readiness event; a successful fresh retry can finish activation but grants no
new repair authority and does not clear unrelated gates.

Isolated actual supervisor/API acceptance now covers complete no-op, install,
upgrade, same-version repair, local-to-managed switch, cumulative versions,
restored source despite a completed ledger, uncertain/partial writes, forced
Core termination and preparation replacement. Original 30/900/300 and larger
60/2400/720 inventories complete with independent source oracles. These controlled
upstreams are not native v13/v14 acceptance. Resource costs, limitations and open
native/user gates are recorded in ADR-0064; module work remains held.


## Native acceptance limitations (unreleased)

Fresh Foundry 14.367 acceptance at checkpoint `140f838`, then its uncommitted
CR64-18–20 correction/repeat, confirms real
1,244- and 3,194-write migrations, lossless source comparison, lost-receipt/crash recovery,
maintenance isolation, activation and fresh approval for externally restored
source. This does not close the full native/operator gate or release module work.
See [ADR-0064 final correction/repeat](adr/0064-module-world-context-and-data-migrations.md#cr64-1820-correction-and-native-v14-repeat--october-17-2026).

The CR64-18 reproduction used synchronous plan encoding,
file writes and fsync on the HTTP thread. A native cold-plan run stalled status
requests even though computation ran in a worker and the migration eventually
completed. The larger advisory had 135 consecutive failed 1.5-second probes,
spanning about 135.53 seconds. The owned-worker/bundle correction above removes
that storage work from HTTP, with cold-load/cancellation regressions and repeat
native measurements recorded in ADR-0064. Capacity remains host-specific.

Ordinary pack index/freshness/hydration now retains authoritative document type
(CR64-19), including arbitrary Actor-pack names, and fails unavailable reads rather
than publishing a false empty index. A successful empty read remains valid.
Caller pack denials remain enforced and use typed HTTP403 through the generic
document route (CR64-20); this does not grant visibility based on raw transport
results. The final repeated3,194-write job completed with exact source/receipt/wire
accounting; planning and execution/resume polling had zero timeouts (max121ms).
A separately timed cold3,197-operation advisory also had zero timeouts. Brief
actual supervised replacement outages remain. Measured Core peak4.128GiB is not
a small-host guarantee. Source baseline cleanup is verified; no test services
remain, and the user's Foundry was not stopped. See ADR-0064 for costs, qualified
failed attempts and user/release gates. The subsequent fresh v13 matrix also
completed 3,194 unique writes and exact source/receipt comparison: peak sampled
Core memory 3.819 GiB, cold advisory 45.705 seconds and full measured workflow
430.969 seconds. Cold advisory, planning and stable execution had zero failed
polls; actual process replacement still interrupts listeners. Both measurements
come from a shared approximately 62 GiB host. Modules remain held.


Independent review subsequently reproduced **CR64-21**, an interrupted first
approval which left an absent job bound. The provisional-publication correction
above preserves the earlier successful v14 evidence. Focused cancellation and
crashes on both sides of first publication, then one unique confirmed write and
baseline cleanup, now pass on both v13 and v14. Current review/release disposition
is recorded in
[ADR-0064](adr/0064-module-world-context-and-data-migrations.md#fresh-complete-maintenance-native-v13-acceptance--october-17-2026).
All module work remains held; no public SDK or release-version change is needed.
