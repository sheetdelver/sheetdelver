# ADR-0074: Scope migration checks to relevant settings

**Status:** Completed — isolated regressions pass; user verified startup recovery
**Date:** 2026-10-26

## Problem

Core 0.22.0 can remain in startup when a background Setting changes during its
migration compatibility snapshot. The snapshot and migration-status evidence
both used the mutation revision of the entire Setting store, so an unrelated
clock update invalidated otherwise unchanged migration inputs.

The reported log failed three preparation attempts with “Migration source scope
changed; rerun snapshot.” The logged Setting ID does not identify its key, so the
actual live setting is unconfirmed. An isolated Core reproduction establishes
that `core.time` ingress causes this failure with unchanged declared settings.
This is a Core consistency defect, not a Shadowdark-specific permission or SDK
exception. The user authorized a new Core branch and correction.

## Decision

Track private per-world-setting mutation revisions in SettingStore. The existing
whole-store revision remains unchanged for its other consumers. Migration
snapshots watch active and candidate-declared setting keys, plus native
`core.permissions` and `core.compendiumConfiguration`. Migration-status evidence
uses the active declared keys and the same native configuration dependencies;
its successful-source evidence retains the candidate snapshot's own assertion.

Unrelated world settings and user-scoped rows do not retire these checks.
Relevant creation, update, deletion, key/scope changes and change-and-revert
sequences still retire them. Whole-store replacement, stale state and unscoped
maintenance observations invalidate every setting scope. Publishing a reconciled
snapshot does not count as another mutation of the source already seeded.

Keep transport/world identity, full-GM service authority, user, migration-target
and pack-content guards. No bypass, automatic migration approval, background
retry loop, timer suppression or native document write is added. No SDK or
application version change is needed.

## Verification and limits

The existing integration suite gains a failing-before/passing-after reproduction,
a full compatibility/preparation flow with clock ingress during successive reads,
and refusal checks for active/candidate-only declared settings, permissions, pack
configuration and Actor mutation. The SettingStore suite covers user scope,
change-and-revert, deletion/recreation/rename, replacement/staleness and publication.
Migration-status checks retain current evidence during unrelated clock updates
and retire it on permission changes.

Retained snapshot/context, pack-ingress and final-readiness regressions verify that
relevant changes still block completion. Tests use controlled transport sources
and temporary data directories; no production connection or live Actor write is
made. The user subsequently verified that the correction resolved startup. The
checks do not identify the live Setting key or claim to solve arbitrary Actor,
Item or relevant-setting churn. Prior ADR-0064 acceptance remains intact.

## Operator logging follow-up

The user explicitly rejected suppressing recurring Setting logs as a response to
the new traffic. The temporary log-suppression edits were reverted. Keep the
original diagnostics visible and investigate the source; repetitive messages
alone do not establish that the traffic is expected.

Startup recovery is operator-verified. Recurring Setting traffic remains a
separate diagnostic question. Existing store debug output now includes the
Setting key (never its value), without changing event flow or log volume. Native
Shadowdark 4.0.6 RealTimeSD advances world time every 1000ms when realtime light
tracking is enabled on the primary GM and pause conditions permit; the live
Setting ID has not yet been mapped, so this remains a source hypothesis.
