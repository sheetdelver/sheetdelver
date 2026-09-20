# 3D Dice Presentation

Enable **3D dice** in the dice tray. The preference is off by default and saved
in this browser. Open **Settings > Chat & Rolls** using the gear in the bottom menu for
chat notifications, dice appearance, sound, and behavior preferences. No Foundry plugin or open Foundry
browser is required.

This is presentation only: SheetDelver passes recorded die faces to the renderer,
never its original formula. Animation results are not used for totals, chat,
document mutations, or game rules. Chat remains available immediately, including
when WebGL is unavailable or the animation fails.

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
- Five dice styles, adjustable size, and optional local collision sounds. Foundry's
  Dice So Nice themes and add-ons are not supported.

## Appearance

In Chat & Rolls, choose a **Dice style** swatch: Teal, Crimson, White, Onyx, or Marble. Swatches
have named tooltips and indicate the selected style. Marble uses a bundled
texture from the renderer package; no third-party assets are requested.

**Dice size** ranges from 75% to 150%, with 100% as the default. Mobile screens
retain a smaller base size. Style and size are saved in this browser separately
from sound settings. Changes apply to the next throw, not one already rolling.
The settings dialog scrolls on shorter screens and supports keyboard navigation,
Escape to close, and focus restoration to the bottom menu.

These are appearance presets, not Dice So Nice skin-pack or material add-on
support. All styles retain the existing plastic/felt collision sounds.

## Sound

Enable **Dice sounds** in Chat & Rolls and adjust **Dice volume** (0-100%).
Sound is off by default, with a starting volume of 50%. These preferences are
saved in this browser separately from the animation toggle. Muting or setting
volume to zero immediately pauses active clips without restarting the dice.

Only the bundled plastic-dice and felt-surface clips are loaded, from this
application's own `/dice/sounds/` assets. There are no third-party audio requests.
The clips and upstream license are in `public/dice/`. Collision strength and
user volume both affect loudness. Hidden tabs, stopped animations and logout
release active audio along with the scene.

Audio never delays a throw: unavailable or unready clips are skipped. Browser
playback restrictions are handled silently; interact with the page before
expecting sound from remotely triggered rolls. No audio is played during the
renderer's preliminary physics simulation.

## Behavior

- **Only my rolls** is off by default. When enabled, the chat message's author ID
  must match the current user. Speaker aliases and character ownership do not
  determine authorship. Other users' rolls remain in chat but do not animate.
  Turning the filter off never replays previously consumed rolls.
- **Display duration** controls how long settled dice remain visible, from 0.5
  to 5 seconds (default 1.8 seconds). A separate 12-second safety timeout ends
  loading or rolling that fails to complete.
- **Low effects (no shadows)** disables renderer shadows and is off by default.
  Quality and duration changes apply to the next throw without restarting an
  active one.
- **Mute private-roll sounds** is on by default. Authorized whispered and GM-only
  rolls, including authorized blind results, may animate silently; disabling this
  setting allows their collision audio. Hidden results never animate or play
  sound. Muting applies immediately to active private throws.
- **Reset dice** resets all dice preferences, including disabling 3D dice
  and sound, and stops active/queued animations.

Behavior preferences are also browser-local, not synchronized between accounts
or devices. The dialog closes on session/world changes. Changing visibility
filters removes excluded active/queued rolls without replaying them later.

## Chat Notifications

The same bottom-menu Settings dialog reserves **General** and **Themes** as
disabled placeholder tabs. **Chat & Rolls** contains the active chat and dice
controls. The shell lives in `components/Settings/`, independently of the dice
panel.

**Chat toasts** are enabled by default. A new live chat message shows one
plain-text notification near the bottom-right, above the menu, while chat is
closed. The player name appears in its title bar and the message in its body;
newer messages replace the previous chat toast. The chat log remains the permanent record. Loading history,
reconnecting, edits, and deletes do not replay notifications. Opening chat,
disabling toasts, disconnecting, or leaving the session clears its current toast.
Hidden browser tabs consume new messages silently.

**Toast duration** ranges from 1 to 15 seconds in half-second steps, defaulting
to 5 seconds. It applies to new chat toasts only, not error notifications or
dice animation timing. Both chat settings are saved in this browser under
`sheetdelver_chat_toasts`. Reset dice leaves chat preferences unchanged.

ChatContext pairs live create hints with authorized chat reads, using the same
bounded `LiveChatInbox` helper as dice presentation. It reuses NotificationSystem,
does not subscribe to raw Foundry data, and strips markup before decoding a
plain-text summary. Redacted private rolls show only the author's placeholder,
never a hidden formula or result. No OS notifications or additional messaging
service are introduced.

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
- The provider listens on the existing SheetDelver app socket and consumes
  `ChatContext.messages`; it creates no Foundry connection and makes no new
  API calls.
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

`DicePresentationProvider` pairs realtime create hints with the existing authorized
chat projection; it never consumes raw Foundry socket documents. `LiveDiceInbox`
bounds and deduplicates pending messages. The normalizer rejects unsupported or
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
