# Public Module Catalogs

Sheet Delver discovers distributable modules from static, credential-free JSON
catalogs. The official catalog is served from GitHub Pages; administrators may
add other public HTTPS catalogs whose hosts are explicitly allowed by local
configuration.

## Catalog Schema

The current schema identifier is `sheet-delver-catalog.v1`:

```json
{
  "schemaVersion": "sheet-delver-catalog.v1",
  "generatedAt": 1788800000000,
  "publisher": "sheetdelver",
  "modules": {
    "shadowdark": {
      "moduleId": "shadowdark",
      "title": "Shadowdark RPG",
      "repository": "https://github.com/sheetdelver/sd-shadowdark",
      "manifest": "https://github.com/sheetdelver/sd-shadowdark/releases/latest/download/sheet-delver-manifest.json",
      "description": "Shadowdark support for Sheet Delver",
      "tags": ["fantasy", "old-school"]
    }
  }
}
```

`moduleId`, `title`, `repository`, and `manifest` are required for every entry.
The object key and `moduleId` must be the same canonical module identifier.
Repository and manifest locations must be public HTTPS URLs without embedded
credentials. Tags must be unique non-empty strings.

A catalog does not declare a release version, digest, permissions,
compatibility, or trust tier. Those release facts come from the generated
release manifest and archive `info.json`. Trust is assigned by the local source
profile, never by catalog content.

The stable manifest URL also anchors module-owned release history. Sheet Delver
looks for `sheet-delver-releases.json` beside `sheet-delver-manifest.json` and
uses it to discover immutable manifests for earlier releases. The central
catalog does not list or copy those versions.

Only releases whose declared Sheet Delver core and SDK contract constraints
match the running application are offered. A catalog module is omitted from the
Available view when none of its published releases are compatible. Missing or
invalid history is a supported legacy state: the module remains latest-only if
its latest release is compatible, and the admin review displays a warning.

## Source Policy

Sheet Delver creates two protected profiles:

- `local-default` represents the scan-only developer source.
- `official-catalog` points to the Sheet Delver GitHub Pages catalog.

The official catalog is first-party. Custom catalogs are always unverified and
cannot include authentication. Administrators can disable or reprioritize the
official catalog but cannot change its identity or URL. Custom catalogs can be
created, edited, disabled, reprioritized, or deleted.

Lower numeric priority wins. If enabled catalogs publish the same module ID,
the aggregate response reports the selected source and all alternatives. An
install or upgrade request always names its source explicitly.

Successful catalog installs retain the selected source profile ID in local
artifact metadata. This provenance does not silently select a duplicate from
another catalog. Operators may lock an installed module, which prevents update
and uninstall, or pin an exact allowed update version. See
[API.md](API.md#module-update-policy).

Successful install and upgrade operations schedule a supervised application
restart. Player requests briefly return an initializing response while Core
rehydrates compendiums, reseeds world documents, and initializes the selected
adapter. Dry-run and release inspection do not interrupt the running application.

When more than one compatible release is published, the admin review allows an
operator to select a version. Moving to an earlier version uses the existing
upgrade transaction but is labeled as a downgrade and requires explicit
acknowledgement. Version selection does not create a pin; existing locks and
exact-version pins remain authoritative.

## Refresh Behavior

Catalog responses are cached for five minutes under
`<DATA_DIR>/cache/module-catalogs`. A successful forced refresh reports `fresh`;
an unexpired result reports `cached`. If refresh fails and a prior valid result
exists, discovery reports `stale` with the refresh error. A source with no valid
cached result reports `error`.

Catalog and release requests use the same HTTPS-only network policy. Every URL,
redirect host, and resolved address is revalidated. Private, loopback, link-local,
documentation, and other non-public address ranges are rejected. Development
mode does not bypass these controls.

## Publishing

Catalog changes should be schema-validated in CI before GitHub Pages publishes
`catalog.json`. Module repositories publish their own archive and generated
`sheet-delver-manifest.json` and `sheet-delver-releases.json`; updating a module
release therefore does not require editing the catalog. The reusable release
workflow rebuilds history from up to 100 existing non-draft, non-prerelease
releases that contain a Sheet Delver release manifest.

See [MODULE_MANIFEST.md](MODULE_MANIFEST.md) for release-manifest fields,
[RELEASING.md](RELEASING.md) for release assets, [CONFIGURATION.md](CONFIGURATION.md)
for host policy, and [API.md](API.md#source-profiles) for administrator routes.
