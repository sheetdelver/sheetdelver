# ADR-0008: Pilot Extraction Readiness (Phase 29)

**Date**: 2026-05-02
**Status**: Accepted

## Context
With the core network infrastructure built in Phase 28, the platform can fetch module indices from remote sources. However, the system had not yet been verified to handle the actual extraction, packaging, and isolated installation of a module artifact (a tarball/zip archive). We required a "pilot" module to test this extraction pipeline.

Instead of `shadowdark` (which is large and complex), we elected to use `dnd5e` as the pilot module for extraction readiness. This allowed us to validate the packaging and extraction pipeline with a much smaller API surface area, ensuring that a module can be fully decoupled from the core source code and still operate correctly when distributed via an archive.

## Decisions

1. **Archive Extraction Pipeline**
   We formalized the actual artifact retrieval and decompression pipeline natively in the Node.js backend. 
   - We utilize `extract-zip` for `.zip` files and `tar` for `.tgz`/`.tar.gz`/`.tar` formats.
   - We explicitly decided **against** supporting proprietary formats like `.rar`, matching the standard open-source conventions used by platforms like Foundry VTT.
   - The Module Manager now correctly downloads the archive, enforces the SHA-256 integrity hash, and unpacks the contents into the active `${DATA_DIR}/modules/<moduleId>` folder prior to completing the `install` or `upgrade` state transitions.

2. **Decentralized Local Development**
   By ensuring that boot-time discovery checks `${DATA_DIR}/modules/` recursively for `info.json` manifests, developers do not need to repeatedly package their modules for local development. A module repository can be cloned directly into the data directory, and the system will automatically discover and integrate it.

3. **Packaging Tooling**
   We introduced standard CLI tooling (`npm run package:module`) which packs a module's raw source and its manifest into a distribution-ready tarball and calculates its cryptographic integrity hash, streamlining the release process for module authors.

4. **GitHub Releases as a Primary Source**
   The extraction pipeline explicitly supports following redirects from generic HTTP/HTTPS endpoints, enabling module creators to host their archives directly on GitHub Releases (or similar platforms). The canonical `ModuleIndexDocument` schema's `source` property points directly to these release artifacts.

## Consequences
- The Module Manager is now fully capable of installing third-party modules from the web safely and securely, verifying their integrity before allowing them to integrate into the runtime.
- The `dnd5e` module serves as the blueprint for how external modules must define their API contracts and isolate themselves from internal core imports.
- Developers have a clear, documented path to build, package, and test external modules without needing deep integration into the Sheet Delver monolithic repository.

---

## Implementation Outcome

Implementation completed and verified using `dnd5e` as the pilot module.

1. Archive Extraction Pipeline
- Added `artifactFetcher.ts` in `distribution/` supporting `.zip` (via `extract-zip`) and `.tgz`/`.tar.gz` (via `tar`).
- Implemented SHA-256 integrity verification and local archive caching in `<DATA_DIR>/dist/archives/`.
- Automated version-tagged directory extraction (e.g., `data/modules/[moduleId]-[version]`).

2. Packaging Tooling
- Added `src/scripts/tools/modules/package-module.ts`.
- Integrated `npm run package:module <moduleId>` to generate distribution-ready tarballs with integrity manifests.

3. GitHub Releases Support
- Verified extraction pipeline handles redirects from generic HTTPS endpoints, enabling direct hosting on GitHub.

This ADR is now closed as implemented.
