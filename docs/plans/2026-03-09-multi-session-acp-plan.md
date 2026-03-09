# Multi-Session ACP Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Each UI session maps to its own ACP session, with shutdown summaries for context restoration across app restarts.

**Architecture:** Replace single `acpSessionId` with a map. Route `session/update` events by sessionId. On `before-quit`, summarize active sessions. On resume, prepend summary to first message.

**Tech Stack:** Electron IPC, ACP JSON-RPC over stdin/stdout, localStorage for persistence.

**Design doc:** `docs/plans/2026-03-09-multi-session-acp-design.md`

**No test runner is configured.** Manual testing via `npm run dev` + CDP (`test/control.js`).

---

### Task 1: Replace single acpSessionId with session map in main.js

**Files:**
- Modify: `main.js:14-25` (global state)
- Modify: `main.js:382-391` (ensureACPSession)

**Step 1: Replace globals**

Replace lines 18-25:

```js
let acpProcess = null;
let acpMessageId = 1;
let acpSessionId = null;
let acpPendingResolves = {};
let acpPermissionRequestIds = {};
let acpCancelled = false;
let acpReadyPromise = null;
let acpHasSession = false;
```

With:

```js
let acpProcess = null;
let acpMessageId = 1;
let acpSessions = {};           // uiSessionId -> acpSessionId
let acpActiveUISession = null;  // which UI session receives stream events
let acpPendingResolves = {};
let acpPermissionRequestIds = {};
let acpCancelled = false;
let acpReadyPromise = null;
```

**Step 2: Replace ensureACPSession**

Replace the `ensureACPSession` function (lines 382-391):

```js
// Create ACP session for a UI session (fast)
async function createACPSession(uiSessionId, workingDir) {
  const sessionResult = await sendACPRequest('session/new', {
    cwd: workingDir || os.tmpdir(),
    mcpServers: []
  });
  acpSessions[uiSessionId] = sessionResult.sessionId;
  return sessionResult.sessionId;
}
```

**Step 3: Update all references to old globals**

Find every reference to `acpSessionId` and `acpHasSession` in main.js and update:

- `spawnACPProcess` close/error handlers (lines 336-366): reset `acpSessions = {}` and `acpActiveUISession = null` instead of `acpSessionId = null` and `acpHasSession = false`
- `gemini:killACP` handler (line 609-614): same replacement
- `gemini:cancel` handler (line 582): no change needed (kills process, not session-specific)

**Step 4: Verify no references to old globals remain**

Search for `acpSessionId` and `acpHasSession` — should be zero hits.

**Step 5: Commit**

```bash
git add main.js
git commit -m "refactor: replace single acpSessionId with multi-session map"
```

---

### Task 2: Update sendMessage to use session map

**Files:**
- Modify: `main.js:407-451` (gemini:sendMessage ACP path)

**Step 1: Update the ACP message path**

Replace the ACP section of `gemini:sendMessage` (lines 409-450):

```js
if (options.useACP) {
  try {
    if (acpReadyPromise) {
      await acpReadyPromise;
    }
    if (!acpProcess) {
      await spawnACPProcess(options);
    }

    const uiSessionId = options.uiSessionId;
    if (!uiSessionId) {
      return { output: '', error: 'No uiSessionId provided', code: 1 };
    }

    // Create ACP session if this UI session doesn't have one yet
    if (!acpSessions[uiSessionId]) {
      await createACPSession(uiSessionId, workingDir);
    }

    const acpSessionId = acpSessions[uiSessionId];
    acpActiveUISession = uiSessionId;

    const promptContent = [];
    if (options.imageAttachments && options.imageAttachments.length > 0) {
      promptContent.push({ type: 'text', text: message });
      for (const img of options.imageAttachments) {
        promptContent.push({
          type: 'image',
          data: img.data,
          mimeType: img.mediaType
        });
      }
    } else {
      promptContent.push({ type: 'text', text: message });
    }

    sendACPRequest('session/prompt', {
      sessionId: acpSessionId,
      prompt: promptContent
    }).then(() => {
      mainWindow.webContents.send('gemini:stream', { type: 'result', stats: {} });
      mainWindow.webContents.send('gemini:stream', { type: 'done', code: 0, error: '' });
    }).catch((err) => {
      mainWindow.webContents.send('gemini:stream', { type: 'error', content: err.message });
      mainWindow.webContents.send('gemini:stream', { type: 'done', code: 1, error: err.message });
    });

    return { output: '', error: '', code: 0 };
  } catch (err) {
    return { output: '', error: err.message, code: 1 };
  }
}
```

**Step 2: Commit**

```bash
git add main.js
git commit -m "feat: sendMessage creates/uses per-session ACP sessions"
```

---

### Task 3: Route session/update events by sessionId

**Files:**
- Modify: `main.js:226-299` (handleACPMessage)

**Step 1: Add reverse lookup helper**

Add above `handleACPMessage`:

```js
// Reverse lookup: acpSessionId -> uiSessionId
function findUISessionByACP(acpId) {
  for (const [uiId, aId] of Object.entries(acpSessions)) {
    if (aId === acpId) return uiId;
  }
  return null;
}
```

**Step 2: Add session routing to handleACPMessage**

At the top of the `session/update` handler (line 243), add a guard that only forwards events for the active UI session:

```js
if (msg.method === 'session/update' && msg.params) {
  const update = msg.params.update;
  if (!update) return;

  // Only forward events for the active UI session
  const eventAcpId = msg.params.sessionId;
  const eventUISession = findUISessionByACP(eventAcpId);
  if (eventUISession !== acpActiveUISession) return;

  switch (update.sessionUpdate) {
    // ... existing cases unchanged
  }
  return;
}
```

**Step 3: Same for permission requests**

Add session routing to the permission handler (line 285). Permission requests for non-active sessions should be queued:

```js
if ((msg.method === 'client/requestPermission' || msg.method === 'session/request_permission') && msg.params) {
  const { toolCall, options } = msg.params;
  if (toolCall) {
    // Only show permission UI for active session
    const eventAcpId = msg.params.sessionId;
    const eventUISession = findUISessionByACP(eventAcpId);
    if (eventUISession !== acpActiveUISession) return; // TODO: queue for later

    acpPermissionRequestIds[toolCall.toolCallId] = msg.id;
    mainWindow.webContents.send('gemini:stream', {
      type: 'permission_request',
      tool_id: toolCall.toolCallId,
      tool_name: toolCall.title || toolCall.kind || 'tool',
      parameters: toolCall.content,
      options: options
    });
  }
  return;
}
```

**Step 4: Commit**

```bash
git add main.js
git commit -m "feat: route ACP events to active UI session only"
```

---

### Task 4: Add setActiveSession IPC + update preload

**Files:**
- Modify: `main.js` (add new IPC handler after gemini:resetSession)
- Modify: `preload.js:60-64` (add new API, remove resetSession)

**Step 1: Add IPC handler in main.js**

Replace the `gemini:resetSession` handler (lines 568-579) with:

```js
// Set which UI session receives stream events
ipcMain.handle('gemini:setActiveSession', (_, uiSessionId) => {
  acpActiveUISession = uiSessionId;
  return true;
});
```

**Step 2: Update preload.js**

In the ACP mode section (lines 60-64), replace `resetSession` with `setActiveSession`:

```js
// ACP mode
preloadACP: (options) => ipcRenderer.invoke('gemini:preloadACP', options),
setActiveSession: (uiSessionId) => ipcRenderer.invoke('gemini:setActiveSession', uiSessionId),
killACP: () => ipcRenderer.invoke('gemini:killACP'),
respondPermission: (toolId, outcome) => ipcRenderer.invoke('gemini:respondPermission', { toolId, outcome }),
```

**Step 3: Commit**

```bash
git add main.js preload.js
git commit -m "feat: add setActiveSession IPC, remove resetSession"
```

---

### Task 5: Update preloadACP to only spawn process (no session)

**Files:**
- Modify: `main.js:393-404` (gemini:preloadACP handler)

**Step 1: Simplify preload handler**

Sessions are now created lazily per-UI-session. Preload only spawns the process and runs `initialize`:

```js
ipcMain.handle('gemini:preloadACP', async (_, options) => {
  if (acpProcess || acpReadyPromise) return;
  acpReadyPromise = spawnACPProcess(options).then(() => {
    acpReadyPromise = null;
    if (mainWindow) mainWindow.webContents.send('gemini:ready');
  }).catch(() => {
    acpReadyPromise = null;
  });
});
```

**Step 2: Commit**

```bash
git add main.js
git commit -m "refactor: preloadACP only spawns process, no session pre-creation"
```

---

### Task 6: Update renderer sendMessage to pass uiSessionId and handle summary re-injection

**Files:**
- Modify: `src/app.js` — `sendMessage()` function (~line 867)

**Step 1: Pass uiSessionId in options**

In `sendMessage()`, where the options object is built (~line 900-909), add `uiSessionId`:

```js
const options = {
  apiKey: state.settings.apiKey || undefined,
  model: state.settings.model || undefined,
  approvalMode: state.settings.approvalMode || 'yolo',
  sandbox: state.settings.sandbox,
  subagents: state.settings.subagents,
  useACP: true,
  imageAttachments: imageAttachments.length > 0 ? imageAttachments : undefined,
  uiSessionId: state.activeSessionId
};
```

Remove the `resume: state.messageCount > 0` line — ACP sessions handle continuity natively.

**Step 2: Prepend summary for resumed sessions**

In `sendMessage()`, where `fullMessage` is built (~line 833-845), add summary re-injection:

```js
let fullMessage = message;
if (state.messageCount === 0) {
  let prefix = '';

  // Re-inject summary from previous app run
  const session = state.sessions.find(s => s.id === state.activeSessionId);
  if (session && session.summary) {
    prefix += `[Previous conversation summary]:\n${session.summary}\n\n[New message]:\n`;
  } else if (session && !session.summary && session.messages.length > 0) {
    // Crash recovery: no summary, use last 10 messages as context
    const recent = session.messages.slice(-10);
    const context = recent.map(m => `${m.role}: ${m.content}`).join('\n\n');
    prefix += `[Previous conversation context]:\n${context}\n\n[New message]:\n`;
  }

  if (isCowork && state.folderInstructions) {
    prefix += `[Project Instructions from GEMINI.md]:\n${state.folderInstructions}\n\n`;
  }
  if (state.settings.instructions) {
    prefix += `[User Instructions]:\n${state.settings.instructions}\n\n`;
  }
  if (prefix) fullMessage = prefix + message;
}
```

**Step 3: Commit**

```bash
git add src/app.js
git commit -m "feat: pass uiSessionId, re-inject summary on session resume"
```

---

### Task 7: Update switchToSession and createNewSession in renderer

**Files:**
- Modify: `src/app.js` — `switchToSession()` (~line 574), `createNewSession()` (~line 527), `switchMode()` (~line 153)

**Step 1: Update switchToSession**

```js
function switchToSession(sessionId) {
  const session = state.sessions.find(s => s.id === sessionId);
  if (!session) return;

  state.activeSessionId = sessionId;
  state.messageCount = session.messages.filter(m => m.role === 'user').length;
  geminiAPI.setActiveSession(sessionId);
  renderSessions();
  showTaskScreen();
  renderMessages(session);
  saveState();
}
```

**Step 2: Update createNewSession**

Remove the `resetSession` call. Session is created lazily on first message:

```js
function createNewSession() {
  const session = {
    id: Date.now().toString(),
    title: state.mode === 'chat' ? 'New Chat' : 'New Task',
    mode: state.mode,
    messages: [],
    isResume: false,
    archived: false,
    summary: null
  };
  state.sessions.unshift(session);
  state.activeSessionId = session.id;
  state.messageCount = 0;
  geminiAPI.setActiveSession(session.id);
  renderSessions();
  clearMessages();
  showTaskScreen();
  elements.messageInput.focus();
  saveState();
}
```

**Step 3: Update switchMode**

In `switchMode()` (~line 153), replace `geminiAPI.resetSession(...)` with `geminiAPI.setActiveSession(null)`:

```js
function switchMode(mode, isInit) {
  state.mode = mode;
  if (!isInit) {
    state.activeSessionId = null;
    state.messageCount = 0;
    geminiAPI.setActiveSession(null);
  }
  // ... rest unchanged
}
```

**Step 4: Commit**

```bash
git add src/app.js
git commit -m "feat: session switching uses setActiveSession, lazy ACP creation"
```

---

### Task 8: Implement shutdown summary generation

**Files:**
- Modify: `main.js:91-103` (app quit handlers)
- Modify: `main.js` (add summarize helper)
- Modify: `preload.js` (add onShutdownSummaries listener)
- Modify: `src/app.js` (listen for summaries, persist to localStorage)

**Step 1: Add summarize function in main.js**

Add after `createACPSession`:

```js
// Ask an ACP session to summarize itself. Returns summary text or null on timeout.
async function summarizeACPSession(acpSessionId, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    let summary = '';

    // Temporarily intercept session/update for this session
    const originalHandler = handleACPMessage;
    const interceptor = (msg) => {
      if (msg.method === 'session/update' && msg.params) {
        const update = msg.params.update;
        if (msg.params.sessionId === acpSessionId && update) {
          if (update.sessionUpdate === 'agent_message_chunk' && update.content && update.content.text) {
            summary += update.content.text;
          }
          return; // Consumed
        }
      }
      originalHandler(msg);
    };
    handleACPMessage = interceptor;

    sendACPRequest('session/prompt', {
      sessionId: acpSessionId,
      prompt: [{ type: 'text', text: 'Summarize our conversation so far in 2-3 concise paragraphs. Include: what was discussed, any decisions made, current state of any tasks, and any pending items. This summary will be used to restore context in a future session.' }]
    }).then(() => {
      clearTimeout(timer);
      handleACPMessage = originalHandler;
      resolve(summary || null);
    }).catch(() => {
      clearTimeout(timer);
      handleACPMessage = originalHandler;
      resolve(null);
    });
  });
}
```

Note: `handleACPMessage` must be declared with `let` instead of `function` for this to work. Change line 227 from `function handleACPMessage(msg) {` to assign a `let` variable, or use a wrapper. Simplest: add a `let acpMessageHandler = null;` global and have the stdout parser call `acpMessageHandler(msg)` instead of `handleACPMessage(msg)`.

**Step 2: Update app quit to generate summaries**

Replace the `before-quit` and `window-all-closed` handlers (lines 91-103):

```js
app.on('before-quit', async (e) => {
  if (app.isQuitting) return; // Already processing
  app.isQuitting = true;

  // Check if there are active sessions to summarize
  const activeEntries = Object.entries(acpSessions);
  if (acpProcess && activeEntries.length > 0) {
    e.preventDefault(); // Hold quit until summaries are done

    const summaries = {};
    for (const [uiId, acpId] of activeEntries) {
      const summary = await summarizeACPSession(acpId, 10000);
      if (summary) summaries[uiId] = summary;
    }

    // Send summaries to renderer for localStorage persistence
    if (mainWindow && Object.keys(summaries).length > 0) {
      mainWindow.webContents.send('gemini:shutdown-summaries', summaries);
      // Give renderer a moment to persist
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Now kill and quit
    if (acpProcess) acpProcess.kill();
    if (activeProcess) activeProcess.kill();
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (acpProcess) acpProcess.kill();
  if (activeProcess) activeProcess.kill();
  app.quit();
});
```

**Step 3: Add preload listener**

In preload.js, add after `onReady`:

```js
onShutdownSummaries: (callback) => {
  ipcRenderer.on('gemini:shutdown-summaries', (_, summaries) => callback(summaries));
},
```

**Step 4: Add renderer listener**

In `src/app.js`, in the `init()` function (after the onReady setup), add:

```js
geminiAPI.onShutdownSummaries((summaries) => {
  for (const [sessionId, summary] of Object.entries(summaries)) {
    const session = state.sessions.find(s => s.id === sessionId);
    if (session) {
      session.summary = summary;
    }
  }
  saveState();
});
```

**Step 5: Commit**

```bash
git add main.js preload.js src/app.js
git commit -m "feat: generate and persist session summaries on app shutdown"
```

---

### Task 9: Update init() preload — no pre-created session

**Files:**
- Modify: `src/app.js` — `init()` function (~line 240-260)

**Step 1: Simplify preload call**

Remove `workingDir` from preload (no session is pre-created anymore):

```js
if (version) {
  setupText.textContent = 'Warming up Gemini CLI...';
  setupIcon.className = 'setup-icon loading';
  geminiAPI.onReady(() => {
    state.cliReady = true;
    setupIcon.className = 'setup-icon success';
    setupText.textContent = version === 'installed' ? 'Gemini CLI ready' : `Gemini CLI v${version} ready`;
    if (state.mode === 'chat') {
      document.getElementById('setup-check').style.display = 'none';
    }
  });
  geminiAPI.preloadACP({
    apiKey: state.settings.apiKey || undefined,
    model: state.settings.model || undefined,
    sandbox: state.settings.sandbox,
    subagents: state.settings.subagents
  });
}
```

**Step 2: Clear transient acpSessionId from restored sessions on startup**

In `init()`, after restoring state from localStorage (~line 39-43), clear any stale acpSessionId values:

```js
if (parsed.sessions) {
  state.sessions = parsed.sessions;
  // Clear transient ACP session IDs from previous app run
  state.sessions.forEach(s => { s.acpSessionId = null; });
}
```

**Step 3: If restoring an active session, set it as active**

After state restoration, if there's an activeSessionId, tell main:

```js
if (state.activeSessionId) {
  geminiAPI.setActiveSession(state.activeSessionId);
}
```

**Step 4: Commit**

```bash
git add src/app.js
git commit -m "refactor: init() no longer pre-creates ACP session, clears stale session IDs"
```

---

### Task 10: Clean up dead code and manual test

**Files:**
- Modify: `main.js` — remove `gemini:resetSession` handler if still present
- Verify: no remaining references to `acpSessionId` (single), `acpHasSession`, `resetSession`

**Step 1: Search and remove dead references**

- Remove `gemini:resetSession` IPC handler from main.js (if not already replaced in Task 4)
- Search app.js for any remaining `resetSession` calls
- Search main.js for `acpSessionId` (single variable) and `acpHasSession`

**Step 2: Manual test via npm run dev**

```bash
taskkill //F //IM electron.exe 2>/dev/null
npm run dev
```

Test checklist:
- [ ] App starts, shows "Warming up Gemini CLI..."
- [ ] Send a message in Chat mode — should create ACP session and get response
- [ ] Create a new session, send a message — should be a separate context
- [ ] Switch back to first session, send a follow-up — Gemini should remember first conversation
- [ ] Close app cleanly — check localStorage for summaries on sessions
- [ ] Reopen app, go to old session, send message — summary should be prepended

**Step 3: Commit**

```bash
git add main.js preload.js src/app.js
git commit -m "chore: remove dead session code, verify multi-session ACP"
```
