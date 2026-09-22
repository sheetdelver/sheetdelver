# ADR-0047: Dice Appearance and Rolling Regions

**Status:** Completed - implemented, verified and accepted
**Date:** September 22, 2026
**Related:** ADR-0039, ADR-0042, ADR-0045

## Context

The user approved additional dice customization after reviewing the installed
`@3d-dice/dice-box-threejs@0.0.12` implementation against Dice So Nice's guides.
The existing renderer supports curated textures, aligned color palettes, basic
wood/metal material parameters and throw strength. Its physics timestep is not
playback speed, and its glass preset does not provide refractive glass.

The review also found shared mutable texture definitions, a broken upstream live
updateConfig path, fixed shadow resolution and no host high-DPI budget. Exposing
all upstream options directly would therefore be unreliable. Presentation must
remain browser-only and independent of Foundry's UI/runtime.

## Decision

1. Extend existing browser-local settings, preserving defaults and old records.
   Preferences stay in localStorage for the browser profile and site origin
   (scheme, hostname and port), shared by accounts using that same browser/site.
   They are not stored in Foundry or synchronized across devices.
   Add curated multicolor palettes, allowlisted local textures and Plastic/Wood/
   Metal finishes. Preserve the existing Plastic rendering instead of silently
   changing it to the renderer's different `none` material.
   Provide eleven single-color/textured styles and eight multicolor palettes in
   separate swatch groups, plus custom colors. New presets reuse existing assets
   and keep body/label contrast at least 4.5:1 before lighting and textures.
2. Isolate texture definitions per renderer instance. Construct settings per
   throw; do not mutate shared registries or call upstream updateConfig. Surface
   sound stays independent of material-specific collision audio. Load only the
   selected surface and material clips; mute/volume remain live.
3. Add bounded force presets, shadow quality, engraved labels and pixel-budgeted
   high-DPI rendering. Do not expose timestep, gravity or solver parameters.
   Legacy low-effects records continue to disable shadows.
4. Add Full, Center, Upper, Lower and four corner/quadrant rolling regions
   (Upper left, Upper right, Lower left, Lower right). Apply them within
   visualViewport including mobile keyboard/zoom offsets, always above widgets
   and pointer-through. End a throw safely when physical bounds change. Scale
   dice for the available region rather than clipping a full-screen simulation.
   Reduce scale in regions narrower than 300 CSS pixels so maximum-size mixed
   dice also fit phone quadrants; ordinary full-viewport sizing stays unchanged.
   Carry the normalized physical dice count (including percentile pairs) locally
   to scale dense throws above eight dice without reparsing roll notation. Metal
   uses brighter existing lights for label readability, not an HDRI/shader system.
5. Use existing Settings and Test dice controls. No server/SDK/module contract,
   new dependency, alternative roll evaluator or backend browser is introduced.
6. Preserve authoritative recorded faces, Self/hidden suppression, result reveal
   on settlement, bounded queue/timeout, 24-mesh limit, reduced-motion and hidden-
   tab safeguards. Presentation customization must not change dice outcomes.
7. Add opt-in Settlement effects using the browser Web Animations API on the
   existing canvas. Highlight pulses brightness from 1 to 1.35 and back over
   400ms. Breathing repeats smooth 1-to-1.35-to-1 pulses for display duration:
   round(duration / 1600) whole cycles, at least one, with per-cycle duration
   adjusted to fit exactly. Even a 500ms window gets a complete pulse; longer
   windows make repetition perceptible without extending linger. Crescendo
   rises smoothly from 1 to 1.35 over display duration and holds its peak through
   optional fade-out; cleanup cancels the forward fill. Highlight and Breathing
   return to normal brightness on completion. Default None is omitted from stored data
   for compatibility. Trigger after the existing settlement callback; never
   await the effect or add to display duration. Cancel it before renderer
   disposal, and skip it when hidden, reduced-motion, detached or unsupported.
   No new assets, shaders, scene objects, dependencies or animation loop.

## Deferred

Profiles/import/export, public-only and other new filters, playback speed, advanced effects,
fonts, per-die/per-actor styles, advanced glass/lighting, antialiasing selectors,
larger size limits, custom region editors and persistent/interactive dice are not
part of this scope. They are optional ideas, not unfinished acceptance gates.

A shared application preference layer and possible account-scoped/synchronized
personal preferences are a separate, deferred design task. That work should
distinguish device-specific rendering/audio/framing from portable personal
choices and standardize defaults, validation, migration and reset behavior.
Keeping localStorage for this implementation is an accepted scope decision.

## Extension Feasibility

Reviewed September 22, 2026 against installed renderer 0.0.12 and the current
DSN documentation. These conclusions distinguish upstream capability from a
tested SheetDelver feature; no model loader, general effects engine or new finish
ships as a result of this investigation. A later user-approved follow-up includes
only the bounded settlement patterns described in Decision 7.

### Shapes

The installed `DiceFactory.createGeometry` dispatches to fixed d2/d4/d6/d8/d10/
d12/d20 geometry and Cannon collision bodies. Its face reading uses geometry
groups/normals, and `swapDiceFace` remaps face materials to display recorded
results (with a separate d4 path). Arbitrary model import is not an exposed
configuration option. The built-in d2 is not evidence of host support: the host
currently accepts d4/d6/d8/d10/d12/d20 and paired percentile dice only.

DSN has a separate [model API](https://riccisi.gitlab.io/foundryvtt-dice-so-nice/api/3d-models/)
for glTF assets and animation tracks. Its
[shape API](https://riccisi.gitlab.io/foundryvtt-dice-so-nice/api/customization/#adding-a-custom-physics-shape)
requires aligned colliders, complete face values and valid rotations. These APIs
are not provided by our pinned package.

**Disposition: deferred.** Alternate silhouettes need matched visual/collision
geometry, a recorded-result mapping for every face, all-face tests (especially
d4/d100), bounded assets and resource disposal. Cosmetic pip/label variants on
existing shapes would be a smaller separate proposal, not a shape selector.
Do not stretch only the visual mesh or claim arbitrary DSN model compatibility.

### Special Finishes

Installed material definitions include `glass` and `perfectmetal`, but the
factory creates MeshStandardMaterial and sets environment intensity to zero.
Its glass preset is low-roughness opaque material, not transmission/refraction;
perfectmetal is zero-roughness metal, not a complete reflective environment.
Static glitter-like textures are possible, but are not animated sparkle effects.
Bundled Three.js shader support alone does not make those features available
through the dice configuration.

DSN exposes dedicated
[material/shader callbacks](https://riccisi.gitlab.io/foundryvtt-dice-so-nice/api/shaders/).
**Disposition: deferred** for true glass, chrome/environment reflections,
iridescence, glow and similar advanced finishes. A later isolated prototype
must establish material creation hooks, label readability on light/dark pages,
GPU/asset budgets and cleanup before exposing presets. Current basic finishes
and added color palettes do not require that machinery.

### Animated Effects

Our package supplies roll-completion callbacks and internal render loops, not
DSN's [SFX manager](https://riccisi.gitlab.io/foundryvtt-dice-so-nice/api/sfx/).
The small browser-local settlement patterns use the existing presentation
lifecycle; trails, particles, bloom and animated model
tracks need additional renderer integration. DSN effects are not portable
configuration values, and Foundry macros are outside this integration's scope.

**Disposition: Highlight, Breathing and Crescendo included; advanced effects deferred.** Native
[Element.animate](https://developer.mozilla.org/en-US/docs/Web/API/Element/animate)
returns an animation that can be explicitly
[cancelled](https://developer.mozilla.org/en-US/docs/Web/API/Animation/cancel).
Applying a brightness-only keyframe to the canvas avoids mesh/material mutation,
outline clipping and a second render loop. It is a whole-throw settlement cue,
not DSN add-on support or a per-die conditional effect. It does incur a
compositor filter pass over the existing bounded canvas, up to the selected
display duration (maximum five seconds) plus optional fade; it is not cost-free.

A future effect must consume already-authorized
recorded results, honor reduced motion and hidden tabs, stop on cancellation,
dispose timers/GPU resources and never extend chat's settlement wait. Numeric
maximum is not universally a critical success; system-specific meaning must not
be inferred in a generic presentation layer. No SFX URLs, macros or code from
chat payloads should be executed.

## Verification Plan

- Unit coverage for normalization, default compatibility, palette alignment,
  allowlisted assets, audio lifecycle, region geometry, pixel budgets and disposal.
- Isolated local browser tests: recorded faces including d4/d100, materials,
  force/quality combinations, dense rolls, moving/nonblank canvas, desktop/mobile
  framing, asset failures and repeated cleanup. No live Foundry connection.
- Existing queue/privacy/result-timing regression checks and user visual review.

## Verification Results

- Full unit suite, client suite, TypeScript and repository lint passed.
- Isolated Chromium checks passed sixteen desktop/mobile combinations of styles,
  materials, textures, force, regions and quality. Recorded and physical settled
  faces matched, including d4, percentile boundaries and 24-die throws. Canvas
  pixel checks confirmed visible, unclipped dice and texture disposal after throws.
- Five additional strong/dense tests passed on 320px portrait, phone landscape
  and 3840x2160 viewports. These caught and corrected region-edge clipping with
  dense-roll scaling and a small region camera margin. Metal lighting was also
  adjusted after screenshot review to keep labels readable.
- Four quadrant choices passed twelve additional desktop, phone portrait and
  phone landscape checks with 24 dice, maximum size and strong force. Settled
  faces matched and canvas pixel checks found no edge clipping. Client tests
  also cover quadrant boundaries, persistence and visual-viewport offsets.
- The six added styles and six added palettes passed desktop and 320px mobile
  render/selection checks (24 cases), including percentile faces, persistence,
  canvas visibility, framing and disposal. Mixed-die maximum-size tests exposed
  narrow-quadrant clipping and prompted width-aware scaling. The final mobile
  matrix and four repeated targeted checks passed, as did the twelve dense
  quadrant checks. Unit, type and lint checks passed; no additional assets or
  dependencies were needed for these presets.
- Existing isolated privacy, first-display timing, immediate-result changes,
  cancellation, no-replay, reduced-motion, viewport and preview-priority checks
  passed. New settings persisted without socket/subscription churn.
- Highlight passed desktop/320px mobile center/quadrant pixel comparisons,
  saved selection and unchanged recorded-face checks. Pausing the effect in
  tests neither held chat nor extended the minimum display duration. Disable,
  hidden tab, reduced motion, disconnect and resize cancelled it; normal finish
  restored the canvas filter and disposal released textures. Unsupported/failed
  animation paths stayed chat-safe. Existing privacy, timing, no-replay, local
  preview and logout checks also passed with Highlight enabled, along with the
  full unit suite, TypeScript and lint.
- Breathing and Crescendo passed desktop/320px mobile persisted-control and
  canvas-pixel checks, with unchanged faces and settlement ordering. Tests
  sampled their brightness envelopes at 500, 1800 and 5000ms, verified finite
  cycles and crescendo peak retention, and confirmed fade cleanup even when
  animations were paused. Disable, hidden tab, reduced motion, disconnect and
  resize cancelled both patterns; Self/hidden suppression and compositor-error
  fallback passed. Client/full unit suites, TypeScript and lint passed.
- Tests used local fixtures and development-only browser tooling, with no Core
  service or Foundry connection. Emulated mobile/software-rendered checks are
  not a physical-device performance certification.
- User accepted the expanded appearance/region controls and settlement patterns
  on September 22, 2026 and approved closing and committing this work. No
  implementation or visual-acceptance gate remains. PR/merge and release are
  separate delivery steps; no release or SDK version change is needed here.

## References

- [Dice presentation](../dice-presentation.md)
- [Renderer configuration and source](https://github.com/3d-dice/dice-box-threejs)
- [DSN appearance](https://riccisi.gitlab.io/foundryvtt-dice-so-nice/guide/appearance/)
- [DSN preferences](https://riccisi.gitlab.io/foundryvtt-dice-so-nice/guide/preferences/)
- [DSN display](https://riccisi.gitlab.io/foundryvtt-dice-so-nice/guide/performance/)

DSN guides describe comparison features, not compatibility guarantees for the
pinned renderer. This decision records its own requirements without depending on
untracked audit reports.
