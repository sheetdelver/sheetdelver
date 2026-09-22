# 3D Dice Presentation

Enable **3D dice** in the dice tray. The preference is off by default and saved
in this browser. Open **Settings > Chat & Rolls** using the gear in the bottom menu for
chat notifications, dice appearance, sound, and behavior preferences. No Foundry plugin or open Foundry
browser is required.

This is presentation only: SheetDelver passes recorded die faces to the renderer,
never its original formula. Animation results are not used for totals, chat,
document mutations, or game rules. By default, a newly animated result appears
in the chat log and preview when its dice settle. **Show results immediately**
restores immediate display. History and messages without an admitted animation
remain immediate; renderer failures release pending results.

The dice tray stays open after Send, Enter and repeated rolls, and does not
close on outside clicks. Use Escape, its close button or an explicit menu close
to dismiss it. Session resets still clear open tools. Formula clearing after a
submission is unchanged. While the tray is open, the shared chat/notification
stack moves above its measured bounds and returns above the HUD when it closes.

## Host Formula Evaluation

Core evaluates SheetDelver-originated rolls through one server-only helper,
shared by chat commands, actor routes and the request-bound roll SDK. It does
not require a connected Foundry browser. Foundry-originated rolls already carry
their evaluated results and are not evaluated again.

Supported input includes standard numeric dice, `kh`/`kl` (default count one),
numbers, `+ - * /`, parentheses, roll pools such as `{1d4,1d6}kh`, two-argument
`min(a,b)`/`max(a,b)`, and single-argument `abs`, `floor`, and `ceil`.
For example, `/r (1d6+2)*2`, `/r {1d4,1d6}kh`, and
`/r max(1d8,1d10)` work in SheetDelver as well as arriving from Foundry.
This is a supported subset, not a complete Foundry formula runtime: custom
functions/dice, data references, rerolls, explosions, and other modifiers are
not accepted.

Inputs are bounded to 256 characters, 16 nesting levels, 128 parsed nodes,
100 dice per term, 1,000 dice overall, and 1,000,000 faces. Numeric literals
are bounded to one billion and final results to finite safe-number magnitude.
The separate 24-physical-dice presentation limit still applies.
Invalid/unsupported formulas return an error, never a successful zero or a
public fallback message. Legitimate zero totals remain valid.

The host uses MIT-licensed `@dice-roller/rpg-dice-roller@5.5.1` for parsing,
rolling and expression evaluation, with a scoped `mathjs@15.2.0` override to
avoid advisories in its declared mathjs 14 dependency. Keep that override until
the upstream dependency range includes a patched version; rerun formula,
serialization, privacy and security tests when changing either pin.
The adapter validates parsed inputs before rolling and serializes recorded
results into Foundry Roll JSON. Arithmetic/function intermediates retain their
dice in serialized `Roll.dice`; ordinary dice and pools retain their term
structure. Nothing is evaluated or re-rolled in the presentation UI.

## Supported Presentation

- Standard d4, d6, d8, d10, d12, d20, and d100 terms from evaluated chat rolls.
- Each d100 result uses a percentile tens/ones pair: 42 shows `40 + 2`,
  10 shows `10 + 0`, and 100 shows `00 + 0`. No additional roll is evaluated.
- Discarded dice are also displayed, including advantage/disadvantage. Chat
  determines which results count and displays the authoritative total.
- New messages received during an authenticated player session only. Loading
  history or reconnecting does not replay old rolls.
- Self rolls remain chat-only, without animation or collision sound.
- Blind results may animate only when Core explicitly marks the DTO's contents
  visible. Non-GM authors and unauthorized viewers receive no dice or sound.
- Recorded PoolTerm, ParentheticalTerm and FunctionTerm children are supported,
  including native legacy DicePool/MathTerm aliases and retained serialized dice.
  Formulas and function names are never evaluated by the presenter.
- Unsupported terms and rolls requiring more than
  24 visible dice stay chat-only (each d100 result counts as two). Mixed unsupported rolls are skipped in
  full rather than animated partially.
- Hidden tabs and reduced-motion preferences suppress animation.
- Up to three throws can be queued. Session/world changes, disconnects, message
  changes/deletions, disabling the preference, and hidden tabs clear applicable
  work. A viewport resize ends the current throw.
- Eleven solid/textured styles, eight multicolor palettes, custom colors, curated textures/materials,
  adjustable size and optional local collision sounds. Foundry's
  Dice So Nice themes and add-ons are not supported.

## Appearance

In Chat & Rolls, choose a **Dice style** swatch: Teal, Crimson, White, Onyx,
Marble, Cobalt, Emerald, Plum, Rose, Amber or Ice. Swatches have named tooltips
and indicate the selected style. Marble uses a bundled
texture from the renderer package; no third-party assets are requested.
**Multicolor palettes** offers Festival, Citrus, Tidal, Twilight, Meadow,
Glacier, Ember and Monochrome. Each chooses coordinated body/label/edge colors per die.
Palette randomness changes appearance only, never a recorded result.

**Dice size** ranges from 75% to 150%, with 100% as the default. Mobile screens
retain a smaller base size. Style and size are saved in this browser separately
from sound settings. Changes apply to the next throw, not one already rolling.
The settings dialog scrolls on shorter screens and supports keyboard navigation,
Escape to close, and focus restoration to the bottom menu.

**Custom colors** adds separate body, label, edge and outline swatches. The
outline can be disabled. First use starts from the selected preset; switching
presets preserves saved custom colors. Low-contrast label choices show a warning.
Only six-digit hex colors are stored; no custom CSS, texture URLs or scripts.

**Texture** selects Style default, None, Marble, Wood, Metal, Speckles or Stars.
**Material** independently selects Plastic (default), Wood or Metal, including
matching dice-collision sounds. These are basic finishes, not advanced glass,
reflective environment maps or Dice So Nice skin-pack/add-on support. Only
allowlisted assets bundled with SheetDelver can load; no texture URLs or scripts.

Alternate shapes, refractive/iridescent finishes and advanced animated effects remain
deferred. Dice So Nice model, shader and effects extensions are not compatible
with this renderer's settings. The investigation and prerequisites are recorded
in [ADR-0047](adr/0047-dice-appearance-and-rolling-regions.md#extension-feasibility).

## Rendering and Regions

**Shadows** offers None, Low (512px maps) or Standard (1024px, default).
Existing low-effects preferences migrate to None. **Engraved labels** controls
label/texture bump mapping and defaults on. **High resolution** defaults off;
when enabled, rendering uses up to 2x device resolution within a four-million-
pixel canvas budget. Very large viewports are capped even at standard resolution.
This does not change hardware antialiasing or enable extra lighting effects.

**Throwing force** offers Soft, Normal (default) and Strong. It affects the launch,
not playback speed, physics rules or recorded faces. **Rolling region** selects
Full viewport (default), Center, Upper, Lower, Upper left, Upper right, Lower left
or Lower right. Regions use relative dimensions
of the visible viewport, including mobile keyboard and zoom offsets. Dice size
also adjusts for a narrow or short region and dense throws above eight physical dice;
all regions remain above widgets and do not
intercept clicks. A change to physics bounds ends the current animation safely.

Appearance, force, region, settlement effect and rendering settings apply to the next throw. Changing
them does not restart an active throw, reconnect sockets or replay prior results.

## Sound

Enable **Dice sounds** in Chat & Rolls and adjust **Dice volume** (0-100%).
Sound is off by default, with a starting volume of 50%. These preferences are
saved in this browser separately from the animation toggle. Muting or setting
volume to zero immediately pauses active clips without restarting the dice.

Choose **Surface**: Felt (default), Wood table, Wood tray, or Metal. Only the
selected surface and chosen material's bundled dice clips load for a throw, from this
application's own `/dice/sounds/` assets. Surface/material changes apply on the next throw.
There are no third-party audio requests.
The clips and upstream license are in `public/dice/`. Collision strength and
user volume both affect loudness. Hidden tabs, stopped animations and logout
release active audio along with the scene.

Audio never delays a throw: unavailable or unready clips are skipped. Browser
playback restrictions are handled silently; interact with the page before
expecting sound from remotely triggered rolls. No audio is played during the
renderer's preliminary physics simulation.

## Behavior

- **Show results immediately** is off by default. Eligible live results wait in
  both the log and preview until settlement, not until linger/fade ends. Turning
  this on releases pending results; turning it off never re-hides visible ones.
  This preference belongs to this browser, not to the world or roll author.
- **Only my rolls** is off by default. When enabled, the chat message's author ID
  must match the current user. Speaker aliases and character ownership do not
  determine authorship. Other users' rolls remain in chat but do not animate.
  Turning the filter off never replays previously consumed rolls.
- **Display duration** controls how long settled dice remain visible, from 0.5
  to 5 seconds (default 1.8 seconds). A separate 12-second safety timeout ends
  loading or rolling that fails to complete.
- **Hide effect** selects None (default) or a short fade after display duration.
  It changes disappearance only, not physics, result values or reveal timing.
- **Settlement effect** selects None (default), Highlight (one 400ms pulse),
  Breathing (smooth repeated pulses across display duration), or Crescendo
  (gradual brightening across display duration, holding the peak through fade-out).
  Breathing fits whole cycles near 1.6 seconds each; short durations get one full
  pulse. Use a longer display duration to see repetition. All patterns brighten
  only the dice canvas after settlement, never hold chat, extend display duration
  or add sound, and do not identify critical successes/failures. Reduced motion
  and hidden tabs suppress them; cancellation removes them. Unavailable browser
  animation support is skipped.
- **Mute private-roll sounds** is on by default. Authorized whispered and GM-only
  rolls, including authorized blind results, may animate silently; disabling this
  setting allows their collision audio. Hidden results never animate or play
  sound. Muting applies immediately to active private throws.
- **Reset dice** resets all dice preferences, including disabling 3D dice
  and sound, and stops active/queued animations.
- **Test dice** plays a fixed local d6/d20/percentile sample. It posts no chat,
  invokes no roll API, and does not enable live dice. Stop test, closing settings,
  session changes or a live throw cancel it. Reduced motion still suppresses it.

Dice preferences are saved automatically in localStorage for the browser profile
and site origin (scheme, hostname and port). Accounts using that browser/site
share the preferences; they are not account-scoped or synchronized to Foundry,
the SheetDelver server or other devices. Preview, development and production
origins have separate settings. Clearing site data resets them; private browsing
storage is temporary. Unified application preferences and account synchronization
are deferred, not requirements of this dice implementation.

The dialog closes on session/world changes. Changing visibility
filters removes excluded active/queued rolls without replaying them later.

## Chat Notifications

The same bottom-menu Settings dialog reserves **General** and **Themes** as
disabled placeholder tabs. **Chat & Rolls** contains the active chat and dice
controls. The shell lives in `components/Settings/`, independently of the dice
panel.

**Chat previews** are enabled by default. A new live message shows the shared,
sanitized chat card near the bottom-right above the menu while chat is closed.
Newer messages replace the previous preview; a delayed older roll cannot replace
a newer preview. The chat log remains the permanent record. History, reconnects,
edits and deletes do not replay previews. Opening chat suppresses pending
previews as well as clearing the visible one. Disabling previews, disconnecting
or leaving the session clears the current preview. Hidden tabs consume silently.

**Preview duration** ranges from 1 to 15 seconds in half-second steps, defaulting
to 5 seconds. Its timer starts when the preview is displayed, after settlement
if held for dice. It does not affect system notices or animation timing, and
pauses on hover, focus and hidden tabs. Both chat settings are saved under
`sheetdelver_chat_toasts`. Reset dice leaves chat preferences unchanged.

ChatContext pairs create hints with authorized reads and coordinates visible
messages with dice admission before publishing a read. Chat previews share the
NotificationSystem viewport, not its system-notice queue. Redacted private
rolls show only the authorized placeholder, never a hidden formula or result.
Errors, warnings and progress notices never wait for dice.

## Private Chat Results

Self rolls show the result to their author in chat only, without 3D dice or
collision sound. Non-blind author-only whisper recipients identify self rolls in both
Foundry-originated and SheetDelver-originated chat documents.
Other viewers, including GMs who
are not recipients, see an author-named "privately rolled dice" placeholder and
`???`, without animation or sound. GM rolls expose results to the author and
listed recipients; blind rolls hide results from a non-GM author.

Core returns a minimal placeholder, not the private content, formula, flavor,
speaker, flags, or recorded faces. Roll create/update/delete notifications
contain only refresh metadata so every viewer can update that placeholder.
Ordinary whispered text remains restricted and has no public placeholder.
Blind animation requires `isContentVisible: true` from the authorized chat DTO;
missing visibility is insufficient. A GM author who is the sole blind recipient
is not treated as a Self roll. Other GMs do not gain access merely through their
role. Existing author filtering and private-roll muting still apply.

## Architecture Boundary

- Core evaluates rolls, authorizes chat reads, and owns persistence. None of
  those operations moved into the UI.
- ChatContext owns the existing app-socket listeners and authorized chat reads.
  It forwards create/invalidation hints and reads to DicePresentationProvider,
  mounted above ChatProvider. The dice coordinator retains IDs and normalized
  recorded faces, not another message-body store. Held IDs filter the shared
  visible messages. No new listener, Foundry connection or API call is added.
- Author filtering and private muting only narrow presentation of data already
  authorized by Core. They are not security or ownership checks.
- The browser renderer simulates trajectories and displays recorded faces.
  Its simulated results never determine chat totals or document writes.
- Node-based preview/test tools stay in `temp/` or `src/tests/`, not in the
  client dependency graph. Static assets remain under `public/dice/`.
- The provider mounts only in `(player)/PlayerProviders`, not admin or the root
  layout. Scoped ESLint rules prevent Node/server imports in the dice UI.

## Implementation

Dice components and their rendering helpers live in `src/client/ui/components/Dice/`.
The provider and consumer hook live in `src/client/ui/context/DicePresentationContext.tsx`.
Static audio/texture assets remain in `public/dice/`, with client tests under
`src/tests/unit/client/`.

`DicePresentationQueue` pairs forwarded create hints with the authorized chat
projection using `LiveChatInbox`. One admission decision controls animation and
visible-chat timing. At most three throws, including the active throw, are held.
Overflow, disabled/filtered/unsupported rolls and unavailable animation display
immediately. A read shown before a late hint stays visible and skips animation;
it is never hidden retroactively. History alone never animates.

Settlement releases the matching sequence before linger/fade. Error, timeout,
resize or disabling releases valid pending chat; update/delete cancels stale
presentation and refreshes authorized content. Logout/world transitions discard
state, and sequence numbers prevent stale renderer callbacks affecting new work.
Disconnect clears presentation without replaying reconnect history. No data
delivery or persistence on Core is delayed. Preview hints allow a bounded minute
for three throws to settle; animation admission hints expire after ten seconds.

The normalizer rejects unsupported or
invalid data rather than evaluating formulas or inventing results. It visits only
known serialized children, never a runtime aggregate or arbitrary nested objects.
It accepts at most 10 root Rolls, 100 terms or retained dice per Roll, 100 child
Rolls per container, 16 child-Roll nesting levels (root depth zero), and 1,000
visited Roll/term/result records across the message. Cycles or any invalid child
reject the entire presentation. The 24 physical-dice limit spans all children.
Fate, Coin and custom die classes remain unsupported; no partial animation occurs.

`DiceAnimation` lazy-loads the MIT-licensed `@3d-dice/dice-box-threejs` renderer,
pinned to `0.0.12`. That library uses Three.js and Cannon physics. Its resize
registration is disabled and its scene resources are explicitly disposed because
it has no destroy API. A small compatibility correction clears its cached
simulated d4 result after forcing the recorded face. Recheck forced face values,
resize/unmount cleanup, and desktop/mobile rendering before changing this pin.

This does not add a general plugin loader. Existing modules that produce
supported chat rolls use the same presentation path.

The decision and deferred work are recorded in
[ADR-0039](adr/0039-client-dice-presentation.md), extended by
[ADR-0042](adr/0042-dice-presentation-followups.md) for authorized blind and nested
recorded rolls. The later
[SDK card alignment](adr/0041-sdk-chat-card-roll-contract.md) adds
`runtime.chat.card({ evaluatedRolls: result.rolls })` (module-api 1.2.0).
Raw `runtime.chat.send({ rolls: result.rolls })` remains supported.
Summary-only `ChatCard.rolls` entries remain chat-only; the host never
reconstructs die faces from totals.

[ADR-0045](adr/0045-dice-preferences-and-result-timing.md) adds local result timing,
custom colors, fade, surface sounds and test throws without changing the SDK.

[ADR-0047](adr/0047-dice-appearance-and-rolling-regions.md) adds curated textures,
materials, palettes, force, bounded quality and viewport-relative regions.
Profiles/import/export, new visibility filters, speed and effects remain deferred.
