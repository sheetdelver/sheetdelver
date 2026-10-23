# ADR-0073: Shared, module-themed page headers

**Status:** Completed — operator accepted header/UI correction; supporting publication pending
**Date:** 2026-10-23

## Problem and selected scope

Module tools and sheets independently duplicate dashboard navigation and tool
headings. Shadowdark's new Character Creator introduced a conflicting header,
and Mörk Borg already duplicates the same navigation/tool-heading pattern. The
user selected a universal Core structure with module-controlled theming and
stopped new feature work while the UI is corrected.

Core supplies two parts: a navigation row on sheets and tools, plus an optional
larger tool heading. Sheets omit the tool heading; their Actor identity, portrait,
HP, AC and actions remain sheet content. All Shadowdark dashboard tools and both
sheet layouts adopt this contract. Mörk Borg is a read-only reference; its
migration and D&D implementation remain outside this work.

## Decision

Expose typed `PageHeader` through `useSDKComponents()` using the existing injected
component mechanism. `PageHeaderProps` and `PageHeaderTheme` are public types in
the shared and React SDK entries. The host owns the component, CSS, both rows,
responsive behavior and accessible navigation. Modules render it once at their
page boundary and supply props through a small module wrapper if useful.

- `context` is optional secondary navigation text; narrow screens hide it.
- Back defaults to the public SDK's same-tab navigation to `/`. `onBack` can
  invoke an existing module discard flow instead. It is a client callback, not a
  serialized manifest field. Rendering never navigates or mutates documents.
- Optional `heading` supplies title, subtitle, decorative icon and tool actions.
  Omission produces navigation only and no extra h1. Actions retain their labels,
  permissions and handlers; Core does not invent tool functionality.
- `theme` supplies named color and font tokens. Missing tokens inherit the current
  Core appearance. Tokens stay on that header instance and cannot bleed into
  another module or world. Modules do not replace the header markup/layout.
- No global registration/cache is needed: current props belong to the mounted
  React page and unmount with it. No new manifest loader or transport exists.
  This refines the initial host-rendered/registration proposal into an injected
  host component, reusing the SDK's established ownership and lifecycle.

Existing modules remain compatible and do not acquire duplicate chrome
automatically. New/adopting pages use this component rather than author another
pre-header. It is page chrome, not a replacement for card or dialog headers.
Settings remain Core-themed under ADR-0072, distinct from module page themes.

## Versions and publication

SDK **3.7.0 → 3.8.0**; UI API **3.5.0 → 3.6.0**. Module API1.7/roll1.0 unchanged.
Core package/lock remain0.21.0; planned supporting minor release is0.22.0, owned
by the user/release helper. The user subsequently authorized local commits for
Core and Shadowdark; publication remains separate.

Shadowdark keeps release0.9.6 and Core>=0.20.0 but raises its explicit UI contract
minimum **3.3.0 → 3.6.0**, which rejects released hosts lacking the new header.
Its CI/release toolchain pins target the planned supporting **v0.22.0**. That
publication is a forward dependency: remote module CI/release cannot complete
until the supporting tag exists. Validate now against this working Core; do not
claim released-floor qualification from the older v0.20.0 creator archive.
If the operator chooses another supporting release number, update both workflow
pins and documentation together before pushing the module.

## Implementation and acceptance

1. Add typed component, tokenized CSS, SDK provider/testing exports and versions.
2. Adopt through Shadowdark's `ModulePageHeader`: Generator, Creator, Importer,
   Monster Stats, and the common sheet container. Remove duplicate navigation;
   retain Generator randomization, Importer Back callback and Creator discard flow.
3. Verify navigation-only versus tool headings, keyboard Back, custom Back without
   accidental navigation, action callbacks, default/theme isolation and phone/
   desktop wrapping using the actual renderer. Run bounded existing creator and
   module presentation checks and module typing; package the adoption in isolation.
4. Update API/authoring/architecture/changelogs and handoffs. Operator approval
   was recorded after the Creator Back correction; offline tests alone were not approval.

Core's other navigation surfaces, browser unload/back and general dirty-form
protection are not implemented by this header. Shadowdark CC-04's full shell
navigation guard stays open. Native Character Creator v13/v14 acceptance and
spell-picker findings also remain open; no rules/writer changes are selected.

## Verification checkpoint — October 23

Passed Core client tests, SDK integrity/contract/compatibility checks, explicit
Core and module typing, targeted source lint and ADR metadata validation. The
actual Core header passed isolated browser checks for keyboard navigation,
default/module themes, action callbacks, custom Back and 390/1280 layouts.
Shadowdark's source and packaged Creator each passed all five mounted workflow
groups; packaged checks include cancelling and confirming header Back. Seven
retained Generator/Importer/Monster Stats canvas checks and shared presentation
checks passed. The common sheet container renders navigation before either
layout branch; full native sheet acceptance is not claimed by these fixtures.

An isolated module package passed contract validation. No application or module
release version changed and no live Foundry service or data was used. Operator
acceptance is recorded below.

## Operator closeout — October 23

The user accepted the corrected presentation and then verified the repaired
Creator Back action, requesting closeout. This completes the shared header and
selected UI correction scope. It does not close the separate Character Creator
native acceptance, shell navigation protection or spell-picker findings.

The Creator repair supplies ConfirmationModal's required `isOpen` prop. Earlier
packaged browser tests used an always-visible confirmation substitute and did
not establish the real host modal contract. After replacing that substitute
with Core's actual modal, all five source workflow groups and explicit module
typing pass. The earlier archive predates this repair; its evidence is retained
with that limit in Shadowdark's workflow audit. User acceptance follows the fix.

Supporting publication remains Core **0.22.0** (SDK **3.8.0**, UI **3.6.0**),
followed by module CI/publication against that tag. Closing this ADR records
implementation and acceptance, not publication or approval for Git/remote writes.
