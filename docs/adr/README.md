# Core decision and completion index

## Current disposition — November 9, 2026

Core 0.22.3 is published. SDK/API version authority remains
[contractVersions.ts](../../src/shared/sdk/contractVersions.ts); current authoring
requirements are explained in [Module Authoring](../MODULE_AUTHORING.md).
The table reconciles the recent release scopes that previously retained pending
publication summaries. It is not a proposal for another release.

| Decision | Release containing the scope | Disposition |
| --- | --- | --- |
| [0064](0064-module-world-context-and-data-migrations.md) | 0.19.7 | Completed — selected maintenance/bootstrap corrections released; W1/W2 remain separate |
| [0065](0065-player-startup-and-module-styles.md) | 0.19.6 | Completed — startup/style fixes operator accepted and released |
| [0066](0066-reuse-release-validation.md) | 0.19.8 | Implemented — published; dedicated hosted reuse observation remains qualified |
| [0067](0067-foundry-package-context-and-artwork.md) | 0.20.0 | Completed — selected package/artwork scope released |
| [0068](0068-optional-compendium-reference-views.md) | 0.20.0 | Completed — selected reference-view scope released |
| [0069](0069-compact-combat-manager.md) | 0.20.0 | Completed — accepted combat-manager scope released |
| [0070](0070-module-tool-backgrounds.md) | 0.20.1 | Completed — operator-accepted page backgrounds released |
| [0071](0071-gm-dashboard-tools.md) | 0.21.0 | Implemented — published; isolated verification retained, full operator review not recorded |
| [0072](0072-module-settings-tabs.md) | 0.21.0 | Implemented — published; isolated verification retained, full operator review not recorded |
| [0073](0073-shared-module-page-header.md) | 0.22.0 | Completed — operator-accepted page header released |
| [0074](0074-migration-setting-dependencies.md) | 0.22.1 | Completed — startup correction verified and released |
| [0075](0075-compendium-content-freshness.md) | 0.22.2 | Completed — compendium freshness correction verified and released |
| [0076](0076-sdk-workspace-event-lifetime.md) | 0.22.3 | Completed — SDK event lifetime verified and released |

GitHub release records and local release tags/changelog were checked. Published
artifacts establish publication, not exhaustive native or operator acceptance.
Each ADR retains its test evidence and exclusions. ADR-0066's dedicated hosted
reuse-path observation and ADR-0071/0072's full operator review are explicitly
qualified rather than silently marked passed.

Older numbered ADRs retain their dated decisions. Superseding amendments take
precedence: for example, ADR-0075 replaces ADR-0017/0021's old ID/name-based warm
cache shortcut. Deferred follow-up dice timing, W1/W2 bootstrap proposals and the
parked D&D experiment are not implementation tasks created by this cleanup.

- [ADR-0077: Native system admission and recovery guidance](0077-native-system-admission-and-recovery.md) — completed with automated and operator production verification; Core publication pending.
