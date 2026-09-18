# ADR-0040: Unified Player Notifications

**Status:** Accepted - Implemented
**Date:** September 18, 2026
**Supersedes:** None
**Related:** ADR-0027, ADR-0039

## Context

Host and module notifications already share a player-side provider, but its
unbounded rendering, limited severity model, and inconsistent callers make
feedback unpredictable. ADR-0039 added chat notices without attempting the
broader notification redesign. This decision addresses that deferred work.

Foundry's [notification API](https://foundryvtt.com/api/v14/classes/foundry.applications.ui.Notifications.html)
provides a useful reference for queued, severity-styled, persistent and progress
feedback. SheetDelver will implement its own browser-only model, not import
Foundry UI code or require a connected Foundry browser.

## Decision

1. Keep one player notification provider and organize its model and view under
   `components/Notifications/`. Preserve `NotificationSystem` as the existing
   import boundary. No new transport, server service or dependency is required.
2. Retain `addNotification`/`removeNotification` and numeric IDs. Host callers
   can additionally update/clear notices and select warning, persistence,
   progress (0-1), title, duration or an explicit replacement key. Old module
   `useSDK().addNotification(message, type, {html})` calls remain unchanged;
   this host-only extension does not change SDK version contracts.
3. Display at most three notices with twenty waiting. Start expiry at display,
   not enqueue. Pause for hover, keyboard focus and hidden tabs. When full,
   discard the oldest waiting notice, never an active notice. Expose waiting
   count and dismiss-all. This is transient feedback, not durable history.
4. Default duration remains five seconds, bounded to 1-60 seconds. Explicit
   permanent notices and incomplete progress do not expire. Completing progress
   starts normal expiry unless explicitly permanent. Update restarts the full
   configured lifetime. Removing an ID is final; later updates are ignored.
5. Retain bottom-right placement above the HUD, as accepted by the user. Use
   compact severity-colored borders/backgrounds, familiar icons, title/body,
   dismiss controls and progress bars. Provide accessible severity text,
   status/alert semantics, keyboard dismissal, and responsive scroll bounds.
6. Plain text is the default. Opt-in rich messages are sanitized on creation
   and update at the host boundary. Titles remain React text. Existing safe
   HTML policy and Core chat redaction are not weakened or bypassed.
7. ChatMessageStore remains the primary document mirror. Chat previews are not
   secondary documents. Like Foundry's ui.chat, ChatContext owns transient
   previews independently from the system notification queue. A shared message
   component renders both the log and previews from authorized DTOs. Dismissal
   never deletes a document; invalidations immediately hide stale previews.
8. Chat is chronological, newest at the bottom, with conditional scrolling and
   new-message indication. Preserve preview preferences and avoid replaying
   history. A shared display stack prevents overlap without merging lifecycles.
9. Suppress duplicate roll success feedback only when an acknowledgement clearly
   identifies a posted ChatMessage. Preserve non-chat feedback and errors.
10. Clear notices/timers on logout, session/world transitions and disconnect.
   Provider callbacks remain stable to avoid repeating the realtime reconnection
   regression found in ADR-0039. The admin tree retains contextual inline errors.

## Consequences

- Existing host/module call sites gain unified presentation without module
  source changes or a new SDK requirement.
- Persistent notices occupy a visible slot until dismissed; the queue indicator
  makes this explicit. Bounded transient feedback may discard old waiting notices
  during floods; chat and operational logs remain authoritative records.
- Rich content still uses the existing sanitizer, while generic ordinary text
  no longer goes through an HTML wrapper. Duplicate login error delivery is fixed.
- Host progress API does not imply arbitrary module progress support. Exposing
  handles/options publicly requires a separately versioned additive SDK change.

## Audit Procedure

The initial audit was reviewed before implementation. The user requested a
Foundry chat/notification comparison and approved this expanded scope. Read-only
evidence: Foundry v14 notifications.mjs, sidebar/tabs/chat.mjs, ChatMessage hooks,
and the official [ChatMessages](https://foundryvtt.com/api/classes/foundry.documents.collections.ChatMessages.html)
and [ChatLog](https://foundryvtt.com/api/v14/classes/foundry.applications.sidebar.tabs.ChatLog.html)
documentation. These establish world-level chat documents, transient chat cards,
and a separate application notification queue. No upstream UI code is imported.

Trace: primary store -> authorized service DTO -> realtime hint/API refresh ->
ChatContext -> log/preview -> SDK feedback callers. The completed audit is
temp/audit-reports/completed/unified-notifications-2026-09-18.md. Test with deterministic
clocks, existing security tests and an isolated browser fixture, never another
Core process against the hosted Foundry configuration.

## Verification and Closeout

- [x] Deterministic notification lifecycle and sanitization tests.
- [x] Existing unit/SDK/security/chat regressions, TypeScript and lint.
- [x] Local desktop/mobile visual and interaction checks, no Foundry connection.
- [x] User live visual acceptance.

No notification history center, OS notifications, admin redesign, or roll-card
contract changes are included in this decision.

## Verification Evidence

September 18, 2026: client and full unit suites passed (including SDK and chat
security regressions); TypeScript, repository lint and diff whitespace checks
passed. Isolated real-component browser checks passed at 1440x900, 390x844 and
320x568, with no external requests. Covered queue admission, focus/hover expiry,
progress, independent chat/system dismissal, rich/multi-roll rendering,
redaction, current-authorized-read replacement, chronology, reader scroll
preservation, deletion without a false new-message marker, and world/disconnect/
logout cleanup including a late response. Screenshots and the development-only
fixture are in temp/notification-preview/. No browser dependency was added to
the application, no hosted Foundry connection was made, and no module repository
was changed. The user accepted the visual result ("looks good"); implementation closeout is complete.

This is not a port of Foundry's arbitrary chat-card JavaScript or its complete
chat feature set. Existing supported inline controls remain host/API actions;
controls without an available handler are disabled.
