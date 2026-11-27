# ADR-0077: Native system admission and recovery guidance

**Status:** Completed — automated checks and operator production verification passed; Core publication pending
**Date:** 2026-11-26

---

## Problem

A production Foundry update to generation 14 build 371 and Shadowdark 4.1.2
exposed the module’s `<=4.0.6` data-read cap. The admin notice showed only
“Unsupported native source data-read version,” without versions or recovery.
The existing `nextStep` field was not rendered by the detailed status component.
Other modules also capped native setting defaults or runtime admission.

## Decision

Native-system admission uses a minimum version. A dated verification baseline is
not an expiry date. Modules still validate actual source fields, settings and
operation prerequisites. This does not remove Core/SDK API major compatibility
ranges or expand supported Foundry generations. Core continues to interpret
existing package declarations faithfully, including historical bounded ranges;
it does not silently bypass another package’s requirements.

Version failures distinguish missing/unreadable native metadata, unmatched
module data-read requirements and incompatible required migration chains.
Admin evidence carries actionable recovery text with detected versions and
requirements. Detailed status renders it using the existing theme and disclosure.
Bootstrap diagnostics and explicit source previews share this diagnosis.

Recovery directs operators to install a compatible SheetDelver module, update a
below-minimum system in Foundry after backup, or reconnect missing world metadata.
Retry is useful after correction. Cache deletion, repeated checking, manual edits
to managed packages and bypassing data checks are not remedies for a range cap.
If no compatible module exists, the notice tells the operator what to report.
No universal automatic repair is promised for unknown schemas or real data faults.

Actual data migrations still require a reviewed plan and explicit approval.
History, pending jobs, source digests, authorization and freshness fences remain
unchanged. Passive status reads do not inspect worlds or run hooks. Player
responses receive no additional diagnostics. No SDK/API or release version changes.

## Ownership and verification

Shadowdark ADR-0014, Mörk Borg ADR-0005 and D&D ADR-0002 own their declaration and
runtime changes. Shadowdark retains published migration artifacts and adds new
forward step IDs; existing approvals cannot be repurposed.

Core regression cases cover missing/malformed/below-minimum versions, future
versions with lower-bound declarations, unsupported generations, bootstrap and
preview guidance, evidence retirement and zero-write passive status. The actual
status component has a rendering regression for visible, escaped recovery text.
Production acceptance must be recorded separately from offline verification.

## Validation

Core lint, TypeScript, full unit/client/integration suites and production build
pass in an isolated workspace with controlled upstream fixtures. The actual
recovery component with production CSS was inspected in light/dark themes at
390px and 1100px: recovery text remains visible and contained. Render regression
checks escaping and absent-advice behavior. No production probe or write occurred.
No release or SDK/API version changed during implementation.

## Closeout — November 26, 2026

The operator confirmed production login recovered, then confirmed the Core update
looks good and works after testing commit `9ba619b3` on the PR branch. This closes
the reported startup and compatibility-recovery scope; it does not establish
exhaustive gameplay parity for newer native systems.

[PR #66](https://github.com/sheetdelver/sheetdelver/pull/66) passed
[Core CI and dependency review](https://github.com/sheetdelver/sheetdelver/actions/runs/45922206345)
and [CodeQL](https://github.com/sheetdelver/sheetdelver/actions/runs/45922202985).
The operator owns the merge. Core **0.22.4** is the recommended patch release:
dependency security fixes, Foundry login compatibility and recovery guidance.
Current package metadata remains **0.22.3** until release preparation. SDK 3.8.0,
module API 1.7.0, UI API 3.6.0 and roll API 1.0.0 remain unchanged.

[Shadowdark 1.0.3](https://github.com/sheetdelver/sd-shadowdark/releases/tag/v1.0.3)
and [Mörk Borg 1.0.4](https://github.com/sheetdelver/sd-morkborg/releases/tag/v1.0.4)
are already published with their native admission corrections; tag validation,
publication and downloaded artifact checks passed. They do not require the new
Core guidance to remove their version ceilings. D&D's correction is integrated
locally into its experimental lifecycle branch and remains unpublished. The
separate Shadowdark 4.1.2 mechanics audit and earlier deferrals remain unselected.
