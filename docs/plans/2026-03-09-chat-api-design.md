# Design: Chat Mode via Code Assist API

Replace the CLI-based and WebView-based Chat mode with direct API calls to Google's Code Assist endpoint. Cowork mode stays CLI-based.

## Decisions

| Decision | Choice |
|----------|--------|
| API endpoint | `cloudcode-pa.googleapis.com/v1internal` (same as Gemini CLI) |
| Auth | Reuse CLI's OAuth from `~/.gemini/oauth_creds.json`, `google-auth-library` for token refresh |
| Streaming | SSE via `?alt=sse` query param, readline-based parsing |
| Sessions | Server-side via `session_id` + local JSON files for history display |
| Thinking | `thinkingConfig: { type: "ENABLED" }`, collapsible UI blocks |
| Models | Flash (`gemini-3-flash-preview`) + Pro (`gemini-3.1-pro-preview`), sticky per session |
| Chat UI | Our own message list + input bar, markdown rendered via marked + DOMPurify |
| Message storage | JSON file per session in `~/.geminui/sessions/<id>.json` |
| Settings storage | localStorage (unchanged) |
| WebView code | Removed entirely |

## Architecture

```
+-----------------------------------------------------+
| Renderer (src/app.js)                                |
|                                                      |
|  Chat Mode:                  Cowork Mode:            |
|  +------------------+        +------------------+    |
|  | Message list      |        | CLI task view    |    |
|  | Thinking blocks   |        | (unchanged)      |    |
|  | Model switcher    |        |                  |    |
|  | Chat input bar    |        |                  |    |
|  +------------------+        +------------------+    |
|           | IPC                        | IPC         |
+-----------|----------------------------|--------------+
| Main process (main.js)                               |
|           |                            |             |
|  +--------------------+    +---------------------+   |
|  | code-assist-client  |    | CLI spawn (existing) |   |
|  | google-auth-library |    | gemini -o stream-json|   |
|  | Direct HTTPS + SSE  |    |                     |   |
|  +--------+-----------+    +---------------------+   |
|           |                                          |
|  cloudcode-pa.googleapis.com/v1internal              |
|  (Code Assist API, uses Google One subscription)     |
+-----------------------------------------------------+
```

## Authentication

1. Read `~/.gemini/oauth_creds.json` on app start
2. Create `OAuth2Client` with CLI's client credentials:
   - Client ID: `$GEMINI_CLIENT_ID` (from `.env`)
   - Client Secret: `$GEMINI_CLIENT_SECRET` (from `.env`)
3. Token refresh handled automatically by `google-auth-library`
4. Call `loadCodeAssist` to get `projectId` and `userTier`
5. Pass `enabled_credit_types: ["GOOGLE_ONE_AI"]` when user is on paid tier
6. If no credentials found: show banner "Run `gemini auth` in your terminal"

## API Client (code-assist-client.js)

~200 lines. Mirrors CLI's `CodeAssistServer`.

### Request format

```js
POST https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse
{
  model: "gemini-3-flash-preview",
  project: "<from loadCodeAssist>",
  user_prompt_id: "<uuid>",
  request: {
    contents: [{ role: "user", parts: [{ text: "Hello" }] }],
    systemInstruction: { role: "user", parts: [{ text: "..." }] },
    generationConfig: {
      thinkingConfig: { type: "ENABLED" }
    },
    session_id: ""
  },
  enabled_credit_types: ["GOOGLE_ONE_AI"]
}
```

### Response chunks (SSE)

```js
{
  response: {
    candidates: [{
      content: {
        parts: [
          { thought: "Let me think..." },
          { text: "Here's my answer" }
        ]
      }
    }],
    usageMetadata: { thoughtsTokenCount: 150, candidatesTokenCount: 200 }
  },
  consumedCredits: [{ creditType: "GOOGLE_ONE_AI", creditAmount: "1" }],
  remainingCredits: [{ creditType: "GOOGLE_ONE_AI", creditAmount: "999" }]
}
```

### SSE parsing

Readline over HTTP response stream. Buffer `data:` lines, yield parsed JSON on blank lines. Same pattern as CLI.

### Streaming flow

Main process receives SSE chunks -> normalizes into event objects -> sends via `mainWindow.webContents.send('chat:stream', event)` -> renderer appends incrementally.

## Sessions

### Server-side

- `session_id: ""` for new conversations -> server creates session
- Same `session_id` on follow-up messages -> server has full context
- Model switch: change `model` field, keep `session_id` -> server preserves context

### Local storage

JSON file per session in `~/.geminui/sessions/<id>.json`:

```js
{
  id: "uuid",
  title: "How do I...",
  model: "gemini-3-flash-preview",
  createdAt: 1741500000000,
  lastUsedAt: 1741500060000,
  messages: [
    { role: "user", parts: [{ text: "How do I..." }] },
    { role: "model", parts: [{ thought: "Let me..." }, { text: "Here's how..." }], thinkingTokens: 150 },
    { role: "user", parts: [{ text: "Follow up" }] },
    { role: "model", parts: [{ text: "Sure..." }] }
  ]
}
```

- Messages appended as streaming completes
- Clicking a past session renders full history from local file
- Oldest sessions pruned if disk usage exceeds threshold

## Thinking Display

- While streaming: expanded block with "Thinking..." header, dimmed text, left border accent
- When answer starts: collapse automatically, show toggle "Thinking (N tokens)"
- On revisit: collapsed with toggle, full text stored locally for re-expansion
- `thinkingConfig: { type: "ENABLED" }` in all requests (default on 2.5+ models)

## Model Switching

| Label | Model ID |
|-------|----------|
| Flash | `gemini-3-flash-preview` |
| Pro | `gemini-3.1-pro-preview` |

- Dropdown in input bar area, sticky per session
- Stored in session JSON, applied on next message
- Model label shown per-message so you see which model answered

## UI Layout

```
+--------------------------------------------------+
| Title Bar (38px)                                  |
| [Logo] [Chat | Cowork]              [- [] X]     |
+------------+-------------------------------------+
| Sidebar    |  #chat-view                         |
| (260px)    |                                      |
|            |  Message bubbles:                    |
| Session    |   [User] How do I...                |
| list from  |   [Flash] > Thinking (150 tokens)   |
| local JSON |          Here's how to...           |
| files      |   [User] Follow up                  |
|            |   [Pro]  Sure, here's...            |
| [New Chat] |                                      |
|            |  +----------------------------------+|
|            |  | [Flash v]  Type a message...  [>]||
|            |  +----------------------------------+|
+------------+-------------------------------------+
```

- `#chat-view`: new container, visible in chat mode, hidden in cowork mode
- Messages: scrollable, model label per response, collapsible thinking blocks
- Input: textarea + send button + model dropdown. Enter sends, Shift+Enter newline.
- Sidebar: populated from local session files. Search filtering.
- Markdown: reuse existing marked + DOMPurify pipeline

## Error Handling

| Scenario | Response |
|----------|----------|
| No `~/.gemini/oauth_creds.json` | Banner: "Run `gemini auth` in your terminal" |
| Token refresh fails | Toast: "Session expired. Run `gemini auth`." Disable input. |
| `loadCodeAssist` fails | Toast: "Can't connect." Retry button. |
| Stream error mid-response | Append error to current response. Keep partial text. |
| Rate limited (429) | Toast: "Rate limit hit." Auto-retry after delay. |
| Model unavailable | Toast + fall back to Flash. |
| Session file corrupt | Skip, remove from list. |
| Storage full | Prune oldest sessions. Toast. |

## Code Changes

**New files:**
- `code-assist-client.js` (~200 lines) — HTTP client, SSE parser, OAuth setup

**Modified files:**
- `main.js` — Remove WebContentsView code, add Code Assist IPC handlers (chat:send, chat:stop, chat:sessions)
- `preload.js` — Replace Gemini WebView IPC methods with chat API methods
- `src/app.js` — Add #chat-view rendering, message display, thinking blocks, model switcher, session management from JSON files
- `src/index.html` — Add #chat-view container, chat input bar, model dropdown
- `src/styles.css` — Chat message styles, thinking blocks, model labels
- `package.json` — Add `google-auth-library` dependency

**Removed files:**
- `preload-gemini.js` — WebView bridge no longer needed

**Removed code:**
- All WebContentsView lifecycle code in main.js (geminiView, auth window, CSS/JS injection, DOM scraping, resize handlers)
- All gemini:* IPC handlers for the WebView approach
- Gemini conversation scraping logic
