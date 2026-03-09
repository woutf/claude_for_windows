# Chat API Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the WebView-based Chat mode with direct API calls to Google's Code Assist endpoint, using existing OAuth credentials, with server-side sessions, thinking display, and model switching.

**Architecture:** New `code-assist-client.js` in main process makes HTTPS+SSE calls to `cloudcode-pa.googleapis.com/v1internal`. Renderer gets a new `#chat-view` with its own message list, input bar, and model switcher. Cowork mode (CLI-based) is unchanged.

**Tech Stack:** `google-auth-library` (OAuth token management), Node.js `https` + `readline` (SSE streaming), `marked` + `DOMPurify` (existing, for markdown rendering)

**Design doc:** `docs/plans/2026-03-09-chat-api-design.md`

**Security note:** All HTML rendering uses `geminiAPI.parseMarkdown()` which sanitizes via DOMPurify (preload.js line 102). No raw unsanitized HTML is ever injected.

---

### Task 1: Add google-auth-library dependency

**Files:**
- Modify: `package.json`

**Step 1: Install the dependency**

Run:
```bash
cd C:/Users/wout/Desktop/gemini_app && npm install google-auth-library
```

**Step 2: Verify it installed**

Run:
```bash
node -e "const {OAuth2Client} = require('google-auth-library'); console.log('OK')"
```
Expected: `OK`

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add google-auth-library for Code Assist OAuth"
```

---

### Task 2: Create code-assist-client.js -- OAuth + streaming

**Files:**
- Create: `code-assist-client.js`

This file is the API client for the Code Assist endpoint. It handles OAuth setup, the `loadCodeAssist` handshake, and SSE streaming.

**Step 1: Create the file**

```js
// code-assist-client.js -- Code Assist API client
// Mirrors the Gemini CLI's CodeAssistServer for direct API access.

const { OAuth2Client } = require('google-auth-library');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Readable } = require('stream');
const readline = require('readline');
const crypto = require('crypto');

const CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
const CODE_ASSIST_API_VERSION = 'v1internal';
const OAUTH_CLIENT_ID = process.env.GEMINI_CLIENT_ID || '';
const OAUTH_CLIENT_SECRET = process.env.GEMINI_CLIENT_SECRET || '';
const OAUTH_CREDS_PATH = path.join(os.homedir(), '.gemini', 'oauth_creds.json');
const G1_CREDIT_TYPE = 'GOOGLE_ONE_AI';

class CodeAssistClient {
  constructor() {
    this.oauthClient = null;
    this.projectId = null;
    this.userTier = null;
    this.enableCredits = false;
    this.initialized = false;
    this.activeAbort = null;
  }

  async init() {
    if (this.initialized) return;

    if (!fs.existsSync(OAUTH_CREDS_PATH)) {
      throw new Error('NO_CREDENTIALS');
    }

    const creds = JSON.parse(fs.readFileSync(OAUTH_CREDS_PATH, 'utf-8'));
    this.oauthClient = new OAuth2Client(OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET);
    this.oauthClient.setCredentials({
      access_token: creds.access_token,
      refresh_token: creds.refresh_token,
      expiry_date: creds.expiry_date,
      token_type: creds.token_type,
    });

    const setupResp = await this._post('loadCodeAssist', {
      metadata: {
        ideType: 'IDE_UNSPECIFIED',
        platform: 'PLATFORM_UNSPECIFIED',
        pluginType: 'GEMINI',
      },
    });

    this.projectId = setupResp.cloudaicompanionProject || '';
    if (setupResp.currentTier) {
      this.userTier = setupResp.currentTier.id;
      this.enableCredits = this.userTier === 'standard-tier';
    }

    this.initialized = true;
  }

  async _post(method, body) {
    const url = `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:${method}`;
    const res = await this.oauthClient.request({
      url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.data;
  }

  async *_streamPost(method, body, signal) {
    const url = `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:${method}?alt=sse`;
    const headers = await this.oauthClient.getRequestHeaders();

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`Code Assist API error: ${res.status} ${res.statusText}`);
      err.status = res.status;
      err.body = text;
      throw err;
    }

    const rl = readline.createInterface({
      input: Readable.fromWeb(res.body),
      crlfDelay: Infinity,
    });

    let bufferedLines = [];
    for await (const line of rl) {
      if (line.startsWith('data: ')) {
        bufferedLines.push(line.slice(6).trim());
      } else if (line === '') {
        if (bufferedLines.length === 0) continue;
        try {
          yield JSON.parse(bufferedLines.join('\n'));
        } catch (e) {
          console.error('SSE parse error:', e.message);
        }
        bufferedLines = [];
      }
    }
  }

  async streamMessage(opts) {
    if (!this.initialized) await this.init();

    const abortController = new AbortController();
    this.activeAbort = abortController;

    const requestBody = {
      model: opts.model,
      project: this.projectId,
      user_prompt_id: crypto.randomUUID(),
      request: {
        contents: opts.contents,
        generationConfig: {
          thinkingConfig: { type: 'ENABLED' },
        },
        session_id: opts.sessionId || '',
      },
    };

    if (opts.systemInstruction) {
      requestBody.request.systemInstruction = opts.systemInstruction;
    }

    if (this.enableCredits) {
      requestBody.enabled_credit_types = [G1_CREDIT_TYPE];
    }

    try {
      for await (const chunk of this._streamPost('streamGenerateContent', requestBody, abortController.signal)) {
        if (opts.onChunk) opts.onChunk(chunk);
      }
      if (opts.onDone) opts.onDone();
    } catch (err) {
      if (err.name === 'AbortError') {
        if (opts.onDone) opts.onDone();
      } else {
        if (opts.onError) opts.onError(err);
        else throw err;
      }
    } finally {
      this.activeAbort = null;
    }
  }

  cancel() {
    if (this.activeAbort) {
      this.activeAbort.abort();
      this.activeAbort = null;
    }
  }

  static hasCredentials() {
    return fs.existsSync(OAUTH_CREDS_PATH);
  }
}

module.exports = { CodeAssistClient };
```

**Step 2: Verify it loads**

Run:
```bash
cd C:/Users/wout/Desktop/gemini_app && node -e "const {CodeAssistClient} = require('./code-assist-client'); console.log('has creds:', CodeAssistClient.hasCredentials()); console.log('OK')"
```
Expected: `has creds: true` and `OK`

**Step 3: Commit**

```bash
git add code-assist-client.js
git commit -m "feat: add Code Assist API client with OAuth and SSE streaming"
```

---

### Task 3: Remove WebView code from main.js + preload.js

**Files:**
- Modify: `main.js`
- Modify: `preload.js`
- Delete: `preload-gemini.js`

**Step 1: Remove WebView code from main.js**

1. Remove `WebContentsView` from the require on line 1
2. Remove lines 29-31 (geminiView variable, GEMINI_URL constant)
3. Remove ALL WebView functions: `createGeminiView()`, `isGoogleAuthURL()`, `resizeGeminiView()`, `showGeminiView()`, `hideGeminiView()`, `injectGeminiCustomizations()`, `openGeminiAuthWindow()`
4. Remove ALL WebView IPC handlers (lines ~425-470): `gemini:show-view`, `gemini:hide-view`, `gemini:navigate`, `gemini:reload-view`, `gemini:conversations`, `gemini:scrape-failed`, `gemini:signOut`, `gemini:sync-theme`
5. In `createWindow()`, remove `mainWindow.on('resize', resizeGeminiView)` and `mainWindow.webContents.on('did-finish-load', createGeminiView)`
6. Remove geminiView cleanup in `before-quit`/`window-all-closed` handlers

**Step 2: Remove WebView methods from preload.js**

Remove lines 78-99 (the entire "Gemini Chat embed" section with showGeminiView, hideGeminiView, navigateGemini, reloadGeminiView, signOutGemini, onGeminiConversations, onGeminiScrapeFailed, onGeminiUrlChanged, onGeminiViewCrashed, onGeminiLoadFailed, syncGeminiTheme).

**Step 3: Delete preload-gemini.js**

```bash
rm preload-gemini.js
```

**Step 4: Update build files in package.json**

Add `code-assist-client.js` to the build files array:
```json
"files": [
  "main.js",
  "preload.js",
  "code-assist-client.js",
  "src/**/*",
  "node_modules/**/*"
]
```

**Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove WebContentsView code, delete preload-gemini.js"
```

---

### Task 4: Add session storage + Chat API IPC handlers to main.js

**Files:**
- Modify: `main.js`

**Step 1: Add imports and session storage**

At top of `main.js`, after existing requires:
```js
const { CodeAssistClient } = require('./code-assist-client');
let chatClient = null;
const SESSIONS_DIR = path.join(os.homedir(), '.geminui', 'sessions');
```

Add session storage functions (after `resetACPState()`):

```js
function ensureSessionsDir() {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

function getSessionPath(sessionId) {
  return path.join(SESSIONS_DIR, `${sessionId}.json`);
}

function loadChatSession(sessionId) {
  const p = getSessionPath(sessionId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {
    console.error('Failed to load session:', sessionId, e.message);
    return null;
  }
}

function saveChatSession(session) {
  ensureSessionsDir();
  session.lastUsedAt = Date.now();
  fs.writeFileSync(getSessionPath(session.id), JSON.stringify(session, null, 2));
}

function deleteChatSession(sessionId) {
  const p = getSessionPath(sessionId);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

function listChatSessions() {
  ensureSessionsDir();
  const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
  const sessions = [];
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf-8'));
      sessions.push({
        id: data.id,
        title: data.title,
        model: data.model,
        createdAt: data.createdAt,
        lastUsedAt: data.lastUsedAt,
      });
    } catch (e) { /* skip corrupt files */ }
  }
  return sessions.sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
}
```

**Step 2: Add Chat API IPC handlers**

```js
ipcMain.handle('chat:init', async () => {
  try {
    if (!CodeAssistClient.hasCredentials()) {
      return { error: 'NO_CREDENTIALS' };
    }
    chatClient = new CodeAssistClient();
    await chatClient.init();
    return { ok: true, userTier: chatClient.userTier, enableCredits: chatClient.enableCredits };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('chat:send', async (_, { model, contents, sessionId, systemInstruction }) => {
  if (!chatClient || !chatClient.initialized) {
    return { error: 'NOT_INITIALIZED' };
  }
  chatClient.streamMessage({
    model,
    contents,
    sessionId,
    systemInstruction,
    onChunk: (chunk) => {
      if (mainWindow) mainWindow.webContents.send('chat:stream', chunk);
    },
    onError: (err) => {
      if (mainWindow) mainWindow.webContents.send('chat:stream', { error: true, message: err.message, status: err.status });
    },
    onDone: () => {
      if (mainWindow) mainWindow.webContents.send('chat:stream', { done: true });
    },
  });
  return { ok: true };
});

ipcMain.handle('chat:cancel', () => {
  if (chatClient) chatClient.cancel();
  return { ok: true };
});

ipcMain.handle('chat:sessions:list', () => listChatSessions());
ipcMain.handle('chat:sessions:load', (_, sessionId) => loadChatSession(sessionId));
ipcMain.handle('chat:sessions:save', (_, session) => { saveChatSession(session); return { ok: true }; });
ipcMain.handle('chat:sessions:delete', (_, sessionId) => { deleteChatSession(sessionId); return { ok: true }; });
```

**Step 3: Commit**

```bash
git add main.js
git commit -m "feat: add chat session storage and Chat API IPC handlers"
```

---

### Task 5: Add Chat API methods to preload.js

**Files:**
- Modify: `preload.js`

**Step 1: Add chat bridge methods**

Where the WebView section was removed, add:

```js
  // Chat API (Code Assist)
  chatInit: () => ipcRenderer.invoke('chat:init'),
  chatSend: (payload) => ipcRenderer.invoke('chat:send', payload),
  chatCancel: () => ipcRenderer.invoke('chat:cancel'),
  onChatStream: (callback) => {
    ipcRenderer.on('chat:stream', (_, data) => callback(data));
  },
  chatListSessions: () => ipcRenderer.invoke('chat:sessions:list'),
  chatLoadSession: (id) => ipcRenderer.invoke('chat:sessions:load', id),
  chatSaveSession: (session) => ipcRenderer.invoke('chat:sessions:save', session),
  chatDeleteSession: (id) => ipcRenderer.invoke('chat:sessions:delete', id),
```

**Step 2: Commit**

```bash
git add preload.js
git commit -m "feat: add Chat API bridge methods to preload"
```

---

### Task 6: Add #chat-view HTML and CSS

**Files:**
- Modify: `src/index.html`
- Modify: `src/styles.css`

**Step 1: Add #chat-view to index.html**

After the closing `</main>` tag (line 170) and before the settings modal (line 173), insert:

```html
    <!-- Chat View (API-based, visible in Chat mode) -->
    <div id="chat-view" style="display:none;">
      <div id="chat-messages-area">
        <div id="chat-messages"></div>
      </div>
      <div id="chat-input-area">
        <div class="chat-input-wrapper">
          <div class="chat-model-select">
            <select id="chat-model-select">
              <option value="gemini-3-flash-preview">Flash</option>
              <option value="gemini-3.1-pro-preview">Pro</option>
            </select>
          </div>
          <textarea id="chat-input" placeholder="Type a message..." rows="1"></textarea>
          <button id="chat-send" class="btn-send" disabled>
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M3.5 17L5 10.5 3.5 3 18 10 3.5 17z" fill="currentColor"/><path d="M5 10.5H14" stroke="white" stroke-width="1.5"/></svg>
          </button>
        </div>
        <div class="chat-input-footer">
          <span id="chat-status"></span>
          <span class="input-hint">Enter to send, Shift+Enter for new line</span>
        </div>
      </div>
    </div>
```

**Step 2: Add chat view CSS**

Append to end of `src/styles.css`:

```css
/* ============================================
   Chat View (API-based)
   ============================================ */

#chat-view {
  position: absolute;
  top: var(--titlebar-height);
  left: var(--sidebar-width);
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary);
  z-index: 1;
}

#chat-messages-area {
  flex: 1;
  overflow-y: auto;
  padding: 24px 0;
}

#chat-messages {
  max-width: 800px;
  margin: 0 auto;
  padding: 0 24px;
}

.chat-msg { margin-bottom: 24px; line-height: 1.6; }

.chat-msg-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
}

.chat-msg-header .model-label {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--bg-tertiary);
  color: var(--text-tertiary);
}

.chat-msg.user .chat-msg-header { color: var(--gemini-blue); }

.chat-msg.model .chat-msg-body { color: var(--text-primary); }
.chat-msg.model .chat-msg-body p { margin-bottom: 12px; }
.chat-msg.model .chat-msg-body p:last-child { margin-bottom: 0; }
.chat-msg.model .chat-msg-body code {
  font-family: var(--font-mono);
  font-size: 13px;
  background: var(--bg-code);
  padding: 2px 5px;
  border-radius: 4px;
}
.chat-msg.model .chat-msg-body pre {
  background: var(--bg-code);
  border-radius: var(--radius-sm);
  padding: 12px 16px;
  overflow-x: auto;
  margin: 12px 0;
}
.chat-msg.model .chat-msg-body pre code { background: none; padding: 0; }

.chat-thinking {
  margin-bottom: 12px;
  border-left: 3px solid var(--gemini-purple);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  overflow: hidden;
}

.chat-thinking-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-tertiary);
  background: var(--bg-secondary);
  user-select: none;
}

.chat-thinking-header:hover { background: var(--bg-tertiary); }
.chat-thinking-toggle { font-size: 10px; transition: transform 0.15s; }
.chat-thinking.collapsed .chat-thinking-toggle { transform: rotate(-90deg); }

.chat-thinking-body {
  padding: 8px 12px;
  font-size: 13px;
  color: var(--text-tertiary);
  background: var(--bg-secondary);
  border-top: 1px solid var(--border-light);
  white-space: pre-wrap;
  max-height: 300px;
  overflow-y: auto;
}

.chat-thinking.collapsed .chat-thinking-body { display: none; }
.chat-thinking.streaming .chat-thinking-header { color: var(--gemini-purple); }

#chat-input-area {
  padding: 12px 24px 16px;
  max-width: 848px;
  margin: 0 auto;
  width: 100%;
}

.chat-input-wrapper {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  background: var(--bg-input);
  border: 1.5px solid var(--border-color);
  border-radius: var(--radius-lg);
  padding: 8px 12px;
  transition: border-color 0.15s;
}

.chat-input-wrapper:focus-within { border-color: var(--gemini-blue); }

.chat-model-select select {
  appearance: none;
  background: var(--bg-tertiary);
  border: none;
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  cursor: pointer;
  font-family: var(--font-sans);
}

.chat-model-select select:focus { outline: none; background: var(--bg-secondary); }

#chat-input {
  flex: 1;
  border: none;
  outline: none;
  resize: none;
  font-size: 14px;
  font-family: var(--font-sans);
  line-height: 1.5;
  color: var(--text-primary);
  background: transparent;
  max-height: 200px;
  min-height: 24px;
}

#chat-input::placeholder { color: var(--text-tertiary); }

.chat-input-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 6px;
  padding: 0 4px;
}

#chat-status { font-size: 12px; color: var(--text-tertiary); }

.chat-auth-banner {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 16px;
  margin: 24px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  font-size: 14px;
}

.chat-auth-banner code {
  font-family: var(--font-mono);
  background: var(--bg-code);
  padding: 2px 6px;
  border-radius: 4px;
}

.chat-cursor {
  display: inline-block;
  width: 2px;
  height: 1em;
  background: var(--gemini-blue);
  margin-left: 2px;
  animation: chatBlink 0.8s infinite;
  vertical-align: text-bottom;
}

@keyframes chatBlink {
  0%, 50% { opacity: 1; }
  51%, 100% { opacity: 0; }
}

.chat-error {
  padding: 12px 16px;
  background: rgba(234, 67, 53, 0.1);
  border: 1px solid var(--error);
  border-radius: var(--radius-sm);
  color: var(--error);
  font-size: 13px;
  margin: 12px 0;
}
```

**Step 3: Commit**

```bash
git add src/index.html src/styles.css
git commit -m "feat: add chat view HTML and CSS"
```

---

### Task 7: Remove WebView references from app.js

**Files:**
- Modify: `src/app.js`

**Step 1: Remove WebView state and references**

1. Remove `geminiConversations: []` from state (line 32)

2. In `switchMode()` (line 153), remove:
   - WebView show/hide/theme calls (lines 169-174)
   - The line hiding `#main-content` (line 194): `document.getElementById('main-content').style.display = isChat ? 'none' : '';`

3. In `createNewSession()` (lines 563-567), remove:
   ```js
   if (state.mode === 'chat') {
     geminiAPI.navigateGemini('https://gemini.google.com/app');
     return;
   }
   ```

4. Remove `renderGeminiSessions()` function entirely (lines 726-761)

5. In `renderSessions()` (lines 628-631), remove:
   ```js
   if (state.mode === 'chat') {
     renderGeminiSessions();
     return;
   }
   ```

6. In `init()` (lines 284-312), remove ALL Gemini WebView event listeners (onGeminiConversations, onGeminiScrapeFailed, onGeminiUrlChanged, onGeminiViewCrashed, onGeminiLoadFailed)

7. In `applyTheme()`, remove `geminiAPI.syncGeminiTheme(...)` if present

**Step 2: Commit**

```bash
git add src/app.js
git commit -m "refactor: remove WebView references from renderer"
```

---

### Task 8: Wire Chat mode in app.js -- state, switchMode, sessions

**Files:**
- Modify: `src/app.js`

**Step 1: Add chat state**

In the `state` object, add:
```js
  chatSessions: [],
  chatSessionId: null,
  chatModel: 'gemini-3-flash-preview',
  chatReady: false,
  chatStreaming: false,
```

In the `elements` object, add:
```js
  chatView: $('#chat-view'),
  chatMessages: $('#chat-messages'),
  chatMessagesArea: $('#chat-messages-area'),
  chatInput: $('#chat-input'),
  chatSend: $('#chat-send'),
  chatModelSelect: $('#chat-model-select'),
  chatStatus: $('#chat-status'),
```

**Step 2: Rewrite switchMode()**

The new `switchMode()` shows `#chat-view` in chat mode, `#main-content` in cowork mode:

```js
function switchMode(mode, isInit) {
  state.mode = mode;
  if (!isInit) {
    state.activeSessionId = null;
    state.messageCount = 0;
    geminiAPI.setActiveSession(null);
  }

  elements.modeToggle.querySelectorAll('.mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });

  const isChat = mode === 'chat';

  elements.chatView.style.display = isChat ? 'flex' : 'none';
  document.getElementById('main-content').style.display = isChat ? 'none' : '';

  elements.btnNewTaskLabel.textContent = isChat ? 'New Chat' : 'New Task';
  elements.welcomeTitle.textContent = isChat ? 'How can I help you?' : 'Welcome to GeminUI';
  elements.welcomeSubtitle.textContent = isChat ? '' : 'Your AI desktop assistant powered by Gemini';
  elements.welcomeSubtitle.style.display = isChat ? 'none' : '';
  elements.welcomeActionsCowork.style.display = isChat ? 'none' : '';
  document.getElementById('setup-check').style.display = isChat ? 'none' : '';

  const folderHeader = document.getElementById('current-folder-display');
  if (folderHeader) folderHeader.style.display = isChat ? 'none' : '';

  elements.messageInput.placeholder = 'Describe your task...';

  renderSessions();
  if (!isInit) {
    if (isChat) {
      initChat();
    } else {
      clearMessages();
      showWelcomeScreen();
    }
  }
  saveState();
}
```

**Step 3: Add chat init and session functions**

```js
async function initChat() {
  if (state.chatReady) {
    loadChatSessions();
    return;
  }

  elements.chatStatus.textContent = 'Connecting...';
  const result = await geminiAPI.chatInit();

  if (result.error === 'NO_CREDENTIALS') {
    const banner = document.createElement('div');
    banner.className = 'chat-auth-banner';
    banner.textContent = 'No Google credentials found. Run ';
    const code = document.createElement('code');
    code.textContent = 'gemini auth';
    banner.appendChild(code);
    banner.appendChild(document.createTextNode(' in your terminal to sign in.'));
    elements.chatMessages.textContent = '';
    elements.chatMessages.appendChild(banner);
    elements.chatInput.disabled = true;
    return;
  }
  if (result.error) {
    const errDiv = document.createElement('div');
    errDiv.className = 'chat-error';
    errDiv.textContent = 'Failed to connect: ' + result.error;
    elements.chatMessages.textContent = '';
    elements.chatMessages.appendChild(errDiv);
    return;
  }

  state.chatReady = true;
  elements.chatStatus.textContent = '';
  elements.chatInput.disabled = false;
  loadChatSessions();
}

async function loadChatSessions() {
  state.chatSessions = await geminiAPI.chatListSessions();
  renderChatSessions();
}

function renderChatSessions() {
  elements.sessionsList.textContent = '';

  if (state.chatSessions.length === 0) {
    const empty = createEl('div', 'sessions-empty', 'No conversations yet');
    elements.sessionsList.appendChild(empty);
    return;
  }

  let filtered = state.chatSessions;
  if (state.sessionSearchQuery) {
    filtered = filtered.filter(s =>
      s.title.toLowerCase().includes(state.sessionSearchQuery)
    );
  }

  filtered.forEach(s => {
    const btn = createEl('button', 'session-item');
    if (s.id === state.chatSessionId) btn.classList.add('active');

    const dot = createEl('span', 'session-dot');
    const label = createEl('span', 'session-label', s.title);
    const delBtn = createEl('button', 'session-delete', '\u00D7');
    delBtn.title = 'Delete';
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Delete "' + s.title + '"?')) return;
      await geminiAPI.chatDeleteSession(s.id);
      if (state.chatSessionId === s.id) {
        state.chatSessionId = null;
        elements.chatMessages.textContent = '';
      }
      loadChatSessions();
    });

    btn.appendChild(dot);
    btn.appendChild(label);
    btn.appendChild(delBtn);
    btn.addEventListener('click', () => switchToChatSession(s.id));
    elements.sessionsList.appendChild(btn);
  });
}

async function switchToChatSession(sessionId) {
  const session = await geminiAPI.chatLoadSession(sessionId);
  if (!session) return;

  state.chatSessionId = session.id;
  state.chatModel = session.model || 'gemini-3-flash-preview';
  elements.chatModelSelect.value = state.chatModel;

  elements.chatMessages.textContent = '';
  if (session.messages) {
    session.messages.forEach(msg => appendChatMessage(msg));
  }
  chatScrollToBottom();
  renderChatSessions();
}
```

**Step 4: Update renderSessions() and createNewSession()**

In `renderSessions()`, add chat delegation at the top:
```js
if (state.mode === 'chat') {
  renderChatSessions();
  return;
}
```

In `createNewSession()`, add chat handling at the top:
```js
if (state.mode === 'chat') {
  state.chatSessionId = crypto.randomUUID();
  elements.chatMessages.textContent = '';
  elements.chatInput.focus();
  loadChatSessions();
  return;
}
```

**Step 5: Save/restore chatModel in state**

In `saveState()`, add `chatModel: state.chatModel` to the persisted object.
In `loadState()`, add: `if (parsed.chatModel) state.chatModel = parsed.chatModel;`

**Step 6: Commit**

```bash
git add src/app.js
git commit -m "feat: wire Chat mode init, switchMode, session management"
```

---

### Task 9: Wire Chat mode in app.js -- message sending, streaming, thinking

**Files:**
- Modify: `src/app.js`

**Step 1: Add chat message sending**

```js
async function sendChatMessage() {
  const text = elements.chatInput.value.trim();
  if (!text || state.chatStreaming) return;

  if (!state.chatSessionId) {
    state.chatSessionId = crypto.randomUUID();
  }

  let session = await geminiAPI.chatLoadSession(state.chatSessionId);
  if (!session) {
    session = {
      id: state.chatSessionId,
      title: text.length > 40 ? text.substring(0, 40) + '...' : text,
      model: state.chatModel,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: [],
    };
  }

  const userContent = { role: 'user', parts: [{ text }] };
  session.messages.push(userContent);
  appendChatMessage(userContent);

  elements.chatInput.value = '';
  autoResizeTextarea(elements.chatInput);
  elements.chatSend.disabled = true;

  state.chatStreaming = true;
  elements.chatStatus.textContent = 'Thinking...';

  const modelMsg = { role: 'model', parts: [] };
  appendChatMessage(modelMsg, true);

  let systemInstruction = undefined;
  if (state.settings.instructions) {
    systemInstruction = { role: 'user', parts: [{ text: state.settings.instructions }] };
  }

  await geminiAPI.chatSend({
    model: state.chatModel,
    contents: [userContent],
    sessionId: state.chatSessionId,
    systemInstruction,
  });

  session.model = state.chatModel;
  await geminiAPI.chatSaveSession(session);
  loadChatSessions();
}
```

**Step 2: Add stream handler**

```js
let chatStreamEl = null;
let chatThinkingEl = null;
let chatStreamText = '';
let chatThinkingText = '';
let chatStreamSession = null;

function initChatStream() {
  geminiAPI.onChatStream(async (data) => {
    if (data.done) {
      // Save model message to session
      if (chatStreamSession) {
        const modelMsg = { role: 'model', parts: [] };
        if (chatThinkingText) modelMsg.parts.push({ thought: chatThinkingText });
        if (chatStreamText) modelMsg.parts.push({ text: chatStreamText });
        chatStreamSession.messages.push(modelMsg);
        await geminiAPI.chatSaveSession(chatStreamSession);
      }

      // Collapse thinking
      if (chatThinkingEl) {
        chatThinkingEl.classList.add('collapsed');
        chatThinkingEl.classList.remove('streaming');
        const label = chatThinkingEl.querySelector('.chat-thinking-label');
        if (label) {
          const words = chatThinkingText.split(/\s+/).length;
          label.textContent = 'Thinking (' + words + ' words)';
        }
      }

      // Remove cursor
      if (chatStreamEl) {
        const cursor = chatStreamEl.querySelector('.chat-cursor');
        if (cursor) cursor.remove();
      }

      state.chatStreaming = false;
      elements.chatStatus.textContent = '';
      elements.chatSend.disabled = !elements.chatInput.value.trim();
      chatStreamEl = null;
      chatThinkingEl = null;
      chatStreamText = '';
      chatThinkingText = '';
      chatStreamSession = null;
      return;
    }

    if (data.error) {
      const errDiv = document.createElement('div');
      errDiv.className = 'chat-error';
      errDiv.textContent = data.message || 'Stream error';
      elements.chatMessages.appendChild(errDiv);
      state.chatStreaming = false;
      elements.chatStatus.textContent = '';
      return;
    }

    const resp = data.response;
    if (!resp || !resp.candidates || !resp.candidates[0]) return;

    const parts = resp.candidates[0].content?.parts || [];
    for (const part of parts) {
      if (part.thought) {
        chatThinkingText += part.thought;
        if (!chatThinkingEl && chatStreamEl) {
          chatThinkingEl = createThinkingBlock();
          const body = chatStreamEl.querySelector('.chat-msg-body');
          body.insertBefore(chatThinkingEl, body.firstChild);
        }
        if (chatThinkingEl) {
          chatThinkingEl.querySelector('.chat-thinking-body').textContent = chatThinkingText;
        }
        elements.chatStatus.textContent = 'Thinking...';
      } else if (part.text) {
        chatStreamText += part.text;
        if (chatStreamEl) {
          const body = chatStreamEl.querySelector('.chat-msg-body');
          let textContainer = body.querySelector('.chat-text-content');
          if (!textContainer) {
            textContainer = document.createElement('div');
            textContainer.className = 'chat-text-content';
            body.appendChild(textContainer);
          }
          // Safe: parseMarkdown uses DOMPurify internally (preload.js:102)
          textContainer.innerHTML = geminiAPI.parseMarkdown(chatStreamText);
          if (!textContainer.querySelector('.chat-cursor')) {
            const cursor = document.createElement('span');
            cursor.className = 'chat-cursor';
            textContainer.appendChild(cursor);
          }
        }
        elements.chatStatus.textContent = 'Generating...';
      }
    }

    chatScrollToBottom();

    if (!chatStreamSession && state.chatSessionId) {
      chatStreamSession = await geminiAPI.chatLoadSession(state.chatSessionId);
    }
  });
}
```

**Step 3: Add DOM helper functions**

```js
function appendChatMessage(msg, isStreaming = false) {
  const div = document.createElement('div');
  div.className = 'chat-msg ' + msg.role;

  const header = document.createElement('div');
  header.className = 'chat-msg-header';

  if (msg.role === 'user') {
    header.textContent = 'You';
  } else {
    header.textContent = 'Gemini';
    if (state.chatModel) {
      const label = document.createElement('span');
      label.className = 'model-label';
      label.textContent = state.chatModel.includes('pro') ? 'Pro' : 'Flash';
      header.appendChild(label);
    }
  }

  const body = document.createElement('div');
  body.className = 'chat-msg-body';

  if (msg.role === 'user') {
    body.textContent = msg.parts.map(p => p.text || '').join('');
  } else if (!isStreaming) {
    for (const part of msg.parts) {
      if (part.thought) {
        body.appendChild(createThinkingBlock(part.thought, true));
      } else if (part.text) {
        const textDiv = document.createElement('div');
        textDiv.className = 'chat-text-content';
        // Safe: parseMarkdown uses DOMPurify internally (preload.js:102)
        textDiv.innerHTML = geminiAPI.parseMarkdown(part.text);
        body.appendChild(textDiv);
      }
    }
  }

  div.appendChild(header);
  div.appendChild(body);
  elements.chatMessages.appendChild(div);
  chatScrollToBottom();

  if (isStreaming) chatStreamEl = div;
  return div;
}

function createThinkingBlock(text, collapsed = false) {
  const block = document.createElement('div');
  block.className = 'chat-thinking' + (collapsed ? ' collapsed' : ' streaming');

  const header = document.createElement('div');
  header.className = 'chat-thinking-header';

  const toggle = document.createElement('span');
  toggle.className = 'chat-thinking-toggle';
  toggle.textContent = '\u25BC';

  const label = document.createElement('span');
  label.className = 'chat-thinking-label';
  label.textContent = 'Thinking...';

  header.appendChild(toggle);
  header.appendChild(label);
  header.addEventListener('click', () => block.classList.toggle('collapsed'));

  const body = document.createElement('div');
  body.className = 'chat-thinking-body';
  if (text) body.textContent = text;

  if (collapsed && text) {
    const words = text.split(/\s+/).length;
    label.textContent = 'Thinking (' + words + ' words)';
  }

  block.appendChild(header);
  block.appendChild(body);
  return block;
}

function chatScrollToBottom() {
  elements.chatMessagesArea.scrollTop = elements.chatMessagesArea.scrollHeight;
}
```

**Step 4: Commit**

```bash
git add src/app.js
git commit -m "feat: add chat message sending and SSE stream rendering with thinking"
```

---

### Task 10: Wire Chat mode in app.js -- event bindings and init integration

**Files:**
- Modify: `src/app.js`

**Step 1: Add chat event bindings**

In the `bindEvents()` function, add:

```js
// Chat input
elements.chatInput.addEventListener('input', () => {
  autoResizeTextarea(elements.chatInput);
  elements.chatSend.disabled = !elements.chatInput.value.trim() || state.chatStreaming;
});

elements.chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
});

elements.chatSend.addEventListener('click', sendChatMessage);

elements.chatModelSelect.addEventListener('change', (e) => {
  state.chatModel = e.target.value;
});
```

**Step 2: Update cancel button handler**

In the existing cancel button click handler, add chat cancel support:
```js
if (state.mode === 'chat' && state.chatStreaming) {
  geminiAPI.chatCancel();
  return;
}
```

**Step 3: Call initChatStream() and initChat() in init()**

In the `init()` function, after `loadState()` and before `switchMode()`:
```js
initChatStream();
```

After `switchMode(state.mode, true)` and `renderSessions()`:
```js
if (state.mode === 'chat') {
  initChat();
}
```

**Step 4: Commit**

```bash
git add src/app.js
git commit -m "feat: add chat event bindings, model switching, init integration"
```

---

### Task 11: Integration test

**Files:** None (testing only)

**Step 1: Start the app**

```bash
cd C:/Users/wout/Desktop/gemini_app && npm start
```

**Step 2: Test chat flow**

1. App opens in Chat mode
2. Chat view appears with input bar and model dropdown (Flash/Pro)
3. Status briefly shows "Connecting..." then clears
4. Type "Hello, what model are you?" and press Enter
5. User message appears, thinking block expands, answer streams in
6. Thinking collapses when answer starts, cursor disappears when done
7. Session appears in sidebar

**Step 3: Test session resume**

1. Click "New Chat"
2. Send: "My name is TestUser"
3. Wait for response
4. Click first session in sidebar -- previous messages render
5. Click back to TestUser session
6. Send: "What is my name?" -- server should know (session_id preserves context)

**Step 4: Test model switching**

1. Change dropdown to Pro
2. Send a message -- response shows "Pro" label
3. Switch back to Flash

**Step 5: Test Cowork mode**

1. Switch to Cowork -- chat view hides, main content appears
2. Cowork works as before
3. Switch back to Chat -- chat view reappears

**Step 6: Fix any issues, commit**

```bash
git add -A
git commit -m "feat: complete Chat API integration (Code Assist endpoint)"
```
