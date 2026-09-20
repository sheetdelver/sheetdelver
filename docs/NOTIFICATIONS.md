# Notifications and Chat

## Ownership

Foundry ChatMessage documents are persisted world data. Core's existing
ChatMessageStore mirrors them; ChatService produces an authorized per-user DTO.
Do not bypass that projection to show chat previews or dice.

ChatContext owns the latest live preview and the closed-chat new-message
indicator. ChatMessageCard is shared with the chronological chat log. Preview
dismissal/expiry affects UI only. Edits/deletes retire stale previews immediately
and refresh the log. Initial history and reconnect reads do not replay previews.
Opening chat clears the closed-chat indicator; the log independently indicates
new messages when the reader is scrolled away from the latest entry.

NotificationProvider owns a separate transient queue for errors, warnings,
success, information and progress. It is not a Foundry document collection.
Both surfaces share a bounded bottom-right viewport above the HUD to avoid
overlap. When a dice tray is open, its measured bounds reserve clearance above
the panel for this shared viewport. Resize and close update the clearance;
long stacks scroll within the remaining space. This is internal UI layout, not
an SDK contract or a change to message visibility. Inline form/admin feedback
stays inline.

## Host Usage

Import from `@client/ui/components/NotificationSystem` inside client components:

```tsx
const { addNotification, updateNotification, removeNotification } = useNotifications();
const id = addNotification('Preparing export', 'info', { progress: 0 });
updateNotification(id, { content: 'Export ready', type: 'success', progress: 1 });
// removeNotification(id) explicitly dismisses the notice.
```

Options: title, html, duration (milliseconds), permanent, progress (0-1), key.
Text is literal unless html is explicitly true; HTML is sanitized on add/update.
A replacement key reuses a notice ID; replacement does not inherit old options.
Updating an ID preserves unspecified options and restarts its lifetime.
Updates to removed IDs are ignored.

Three system notices are visible, with twenty waiting. Overflow removes the
oldest waiting notice, never an active one. Timers start on display and pause
while hovered, keyboard-focused or the browser tab is hidden. Default duration
is five seconds, bounded to 1-60 seconds. Permanent notices and unfinished
progress do not expire; completed progress expires unless permanent is set.
Dismiss-all clears the queue. Logout, session/world transitions and disconnect
clear notices. All callbacks remain stable to avoid reconnecting app sockets.

Chat preview settings remain under Chat & Rolls: enabled and 1-15-second
duration. A preview pauses for hover/focus/hidden tabs. Its own dismissal does
not clear unrelated system feedback. Only a new live create with an authorized
read can produce a preview; no second document store is introduced.

## Modules and Boundaries

The existing SDK addNotification(message, type, {html}) contract is unchanged.
Additional host options are not exported as public SDK guarantees. A module
posts chat via the existing runtime/API and lets the host render it. Avoid
duplicating a posted roll with a separate success toast. Core's sheet helpers
suppress success notices only for identifiable persisted chat acknowledgements.

Everything here is browser presentation or pure shared formatting. No server
imports, Foundry execution environment, headless browser, new runtime dependency,
or module repository changes are needed.

## Verification

Run `npm run test:client`, `npm run test:unit`, TypeScript and lint. The focused
tests cover notification timers, queue overflow, progress, replacement and
sanitization, shared chat rendering, multi-roll totals, redaction and live-event
deduplication. Browser tests are local development tools only, not application
dependencies. Live acceptance must cover player/GM/private messages, sheet rolls,
reconnection and world/session changes before ADR-0040 is closed.
