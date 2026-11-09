<img src="logo.png" width="25%" alt="SheetDelver Logo">

[Website](https://sheetdelver.com/) · [Releases](https://github.com/sheetdelver/sheetdelver/releases) · [Changelog](CHANGELOG.md)

[![CI](https://github.com/sheetdelver/sheetdelver/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/sheetdelver/sheetdelver/actions/workflows/ci.yml?query=branch%3Amain)

Character sheets and companion tools for [Foundry VTT](https://foundryvtt.com/),
accessible from a desktop, tablet or phone.

## Features

- System-specific character sheets, character creation and GM tools supplied by modules.
- A shared dashboard with owned characters and available tools.
- Realtime chat, dice rolls and optional 3D dice presentation.
- Journals, images and other content shared by the GM, respecting Foundry permissions.
- A combat HUD with initiative and turn controls.
- Module installation, updates and administration through a separate admin interface.

## Systems

- [Shadowdark RPG](https://github.com/sheetdelver/sd-shadowdark): character sheets, creation, advancement and GM treasure tools.
- [Mörk Borg](https://github.com/sheetdelver/sd-morkborg): character sheets, SCVM Factory, combat and resource controls.
- [D&D 5e](https://github.com/sheetdelver/sd-dnd5e): experimental support; see the module's current limitations.

Each module documents its own features and supported native system versions.

## Getting started

Requires **Node.js 22.12+**, **Foundry VTT generation 13 or 14**, and a dedicated
Foundry **Gamemaster** service account. Individual modules may support a narrower
Foundry/system version range. Players use their own Foundry accounts.

Follow the [setup and deployment guide](docs/GETTING_STARTED.md), then install the
module for your system. Configuration and credentials stay in your local deployment.

- [Configuration reference](docs/CONFIGURATION.md)
- [Security and recovery](docs/SECURITY_OPERATIONS.md)
- [Contributing](docs/CONTRIBUTING.md) and [module authoring](docs/MODULE_AUTHORING.md)

## License

This project is licensed under the MIT License.

### Third-Party Licenses

**Shadowdark RPG**
This product is an independent product published under the Shadowdark RPG Third-Party License and is not affiliated with The Arcane Library, LLC. Shadowdark RPG © 2023 The Arcane Library, LLC.

**foundryvtt-shadowdark**
Partial code and data utilized from the [foundryvtt-shadowdark](https://github.com/Muttley/foundryvtt-shadowdark) system, licensed under the MIT License. Copyright (c) 2023 Paul Maskelyne.

**Mörk Borg RPG**
Mörk Borg is copyright Ockult Örtmästare Games and Stockholm Kartell. This product is an independent production by SheetDelver and is not affiliated with Ockult Örtmästare Games or Stockholm Kartell. It is published under the [MÖRK BORG THIRD PARTY LICENSE](https://morkborg.com/license/).

**foundryvtt-morkborg**
Partial code and data reference utilized from the [foundryvtt-morkborg](https://github.com/fvtt-fria-ligan/morkborg-foundry) system, licensed under the MIT License. Copyright (c) fvtt-fria-ligan contributors.
