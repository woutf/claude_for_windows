# Multi-Session ACP with Shutdown Summaries

## Problem

Currently, a single ACP session is shared across all UI sessions. Switching sessions in the sidebar doesn't reset or switch the Gemini context -- messages go to the same backend session. This means Gemini carries context from unrelated conversations.

## Solution

Keep multiple ACP sessions alive on one process. Each UI session maps to its own ACP session. On app shutdown, summarize each session and store the summary. On app reopen, re-inject the summary when the user resumes an old session.

## Architecture

### One ACP process, many sessions

Replace the single `acpSessionId` global with a map:

```
acpSessions = {
  "ui-session-1": "acp-abc123",
  "ui-session-2": "acp-def456",
}
```

The renderer's `activeSessionId` determines which ACP session receives `session/prompt` calls. `session/update` notifications are routed by matching `msg.params.sessionId` against the map.

### Session Lifecycle

| Event | What happens |
|-------|-------------|
| App launch | Spawn ACP process + `initialize`. No sessions created yet. |
| User sends first message | `session/new` -> store mapping. Send prompt. |
| User switches session (has ACP session) | Update `activeSessionId` in renderer. Tell main which session is active for event routing. No ACP calls. |
| User switches to old session (no ACP session) | On next message: `session/new`, prepend stored summary, store mapping. |
| App closing (clean) | For each live ACP session: prompt "Summarize this conversation", collect response, store in localStorage. Kill process. |
| App crash (no clean shutdown) | No summary. Fall back to last 10 messages as raw context on resume. |

### Data Model

UI session object gains two fields:

```js
{
  id: "...",
  title: "...",
  messages: [...],
  summary: null,        // Set on clean app shutdown
  acpSessionId: null,   // Transient -- cleared on app restart
}
```

### Main Process Changes (main.js)

- `acpSessionId` (single) -> `acpSessions = {}` (map: uiSessionId -> acpSessionId)
- `activeUISessionId` -- which UI session events route to
- New IPC `gemini:setActiveSession(uiSessionId)` -- renderer tells main which session is active
- New IPC `gemini:createSession(uiSessionId, workingDir)` -- creates ACP session, stores mapping
- `handleACPMessage`: look up `msg.params.sessionId` in the reverse map to find the UI session, only forward events if it matches `activeUISessionId`
- `app.on('before-quit')`: iterate all live sessions, send summary prompt to each, wait for responses (10s timeout per session), send summaries to renderer for localStorage storage

### Renderer Changes (app.js)

- `switchToSession()`: call `gemini:setActiveSession` to update main's routing
- `sendMessage()`: if session has no live `acpSessionId`, call `gemini:createSession`. If session has a `summary` (from previous app run), prepend it to the first message as context.
- `createNewSession()`: no longer calls `resetSession()`. ACP session created lazily on first message.
- Listen for `gemini:shutdown-summaries` to persist summaries before quit.

### Permission Routing

Permission requests include a `sessionId`. Route to active session's UI. If a permission arrives for a non-active session, queue it and show a badge/indicator on that session in the sidebar.

### Edge Cases

- **Background streaming**: If session A is streaming and user switches to B, events keep accumulating on A's buffer. Switching back renders the full state.
- **Shutdown timeout**: If summarization takes >10s per session, abort and store no summary. Fall back to raw messages on resume.
- **Crash recovery**: No summary stored. Prepend last 10 user+assistant messages as raw context.
- **Max sessions**: No hard limit. ACP memory grows with session count. Could prune old sessions if needed later.

### Summary Prompt

On shutdown, send to each active ACP session:

```
Summarize our conversation so far in 2-3 concise paragraphs. Include: what was discussed, any decisions made, current state of any tasks, and any pending items. This summary will be used to restore context in a future session.
```

### Context Restoration Prompt

When resuming an old session with a stored summary, prepend to the user's first message:

```
[Previous conversation summary]:
{summary}

[New message]:
{user's actual message}
```
