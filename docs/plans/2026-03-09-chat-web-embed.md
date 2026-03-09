# Chat Web Embed Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the CLI-based Chat mode with an embedded gemini.google.com WebContentsView, while keeping Cowork mode CLI-based.

**Architecture:** A WebContentsView loads gemini.google.com with a dedicated `persist:gemini` partition. CSS injection hides Google's sidebar/nav, a preload bridge scrapes conversations into our sidebar, and auth redirects open in a modal window. Mode switching toggles visibility between the WebContentsView and the CLI task screen.

**Tech Stack:** Electron 34 WebContentsView, CSS injection via `insertCSS()`, JS injection via `executeJavaScript()`, IPC bridge via `contextBridge`

**Design doc:** `docs/plans/2026-03-09-chat-web-embed-design.md`

---

### Task 1: Create the Gemini preload bridge

**Files:**
- Create: `preload-gemini.js`

**Step 1: Write the preload file**

```js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('geminuiBridge', {
  sendConversations: (data) => ipcRenderer.send('gemini:conversations', data),
  sendScrapeFailed: () => ipcRenderer.send('gemini:scrape-failed'),
  onScrapeRequest: (callback) => ipcRenderer.on('gemini:scrape-now', () => callback()),
  onThemeChange: (callback) => ipcRenderer.on('gemini:theme', (_, isDark) => callback(isDark)),
});
```

**Step 2: Verify syntax**

Run: `node -c preload-gemini.js`
Expected: no output (syntax OK)

**Step 3: Commit**

```bash
git add preload-gemini.js
git commit -m "feat: add preload bridge for Gemini WebContentsView"
```

---

### Task 2: Add WebContentsView lifecycle to main.js

**Files:**
- Modify: `main.js` (add after line 27, before `function resetACPState()`)

This is the core task — creating, resizing, showing, and hiding the Gemini web view.

**Step 1: Add the require for WebContentsView and shell**

At the top of `main.js` (line 1), add `WebContentsView` to the destructured imports:

```js
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, WebContentsView } = require('electron');
```

**Step 2: Add Gemini view state variables**

After `let isShuttingDown = false;` (line 27), add:

```js
// Gemini WebContentsView (Chat mode)
let geminiView = null;
const GEMINI_URL = 'https://gemini.google.com/app';
```

**Step 3: Add createGeminiView function**

After the `resetACPState()` function (after line 39), add the function that creates the WebContentsView, attaches it to the main window, sets up event handlers, and loads Gemini:

```js
function createGeminiView() {
  if (geminiView) return;

  geminiView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-gemini.js'),
      partition: 'persist:gemini',
      contextIsolation: true,
      sandbox: true,
    }
  });
  mainWindow.contentView.addChildView(geminiView);

  // Intercept new windows (auth redirects, external links)
  geminiView.webContents.setWindowOpenHandler(({ url }) => {
    if (isGoogleAuthURL(url)) {
      openGeminiAuthWindow(url);
      return { action: 'deny' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Inject CSS/JS after page loads
  geminiView.webContents.on('did-finish-load', () => {
    injectGeminiCustomizations();
  });

  // Detect in-page navigation (conversation switches)
  geminiView.webContents.on('did-navigate-in-page', (_, url) => {
    mainWindow.webContents.send('gemini:url-changed', url);
  });

  // Full navigation (detect auth redirects)
  geminiView.webContents.on('will-navigate', (event, url) => {
    if (isGoogleAuthURL(url)) {
      event.preventDefault();
      openGeminiAuthWindow(url);
    }
  });

  // Handle crashes
  geminiView.webContents.on('render-process-gone', (_, details) => {
    console.error('Gemini view crashed:', details.reason);
    mainWindow.webContents.send('gemini:view-crashed', details.reason);
  });

  geminiView.webContents.on('did-fail-load', (_, errorCode, errorDesc) => {
    if (errorCode === -3) return; // Aborted navigations (normal)
    console.error('Gemini load failed:', errorCode, errorDesc);
    mainWindow.webContents.send('gemini:load-failed', { errorCode, errorDesc });
  });

  resizeGeminiView();
  geminiView.webContents.loadURL(GEMINI_URL);
}

function isGoogleAuthURL(url) {
  return url.includes('accounts.google.com') ||
         url.includes('consent.google.com') ||
         url.includes('myaccount.google.com');
}

function resizeGeminiView() {
  if (!geminiView || !mainWindow) return;
  const { width, height } = mainWindow.getContentBounds();
  const sidebarWidth = 260; // matches CSS --sidebar-width
  const titlebarHeight = 40; // matches CSS --titlebar-height
  geminiView.setBounds({
    x: sidebarWidth,
    y: titlebarHeight,
    width: Math.max(0, width - sidebarWidth),
    height: Math.max(0, height - titlebarHeight),
  });
}

function showGeminiView() {
  if (!geminiView) createGeminiView();
  geminiView.setVisible(true);
  resizeGeminiView();
}

function hideGeminiView() {
  if (geminiView) geminiView.setVisible(false);
}
```

**Step 4: Hook resize into the window**

Inside `createWindow()` (after line 71, after the `unmaximize` handler), add:

```js
  mainWindow.on('resize', () => {
    resizeGeminiView();
  });
```

**Step 5: Create the Gemini view after window is ready**

After `mainWindow.loadFile(...)` (line 59), add:

```js
  // Create Gemini view once renderer is ready
  mainWindow.webContents.on('did-finish-load', () => {
    createGeminiView();
  });
```

**Step 6: Add IPC handlers for mode switching**

After the existing window IPC handlers (after line 148), add:

```js
// Gemini Chat mode controls
ipcMain.on('gemini:show-view', () => showGeminiView());
ipcMain.on('gemini:hide-view', () => hideGeminiView());
ipcMain.on('gemini:navigate', (_, url) => {
  if (geminiView) geminiView.webContents.loadURL(url);
});
ipcMain.on('gemini:reload-view', () => {
  if (geminiView) geminiView.webContents.reload();
});
ipcMain.on('gemini:conversations', (_, convos) => {
  mainWindow.webContents.send('gemini:conversations', convos);
});
ipcMain.on('gemini:scrape-failed', () => {
  mainWindow.webContents.send('gemini:scrape-failed');
});
```

**Step 7: Verify app starts**

Run: `npm start`
Expected: App launches. The Gemini WebContentsView loads behind/over the main content area. It may overlap — that's expected at this stage.

**Step 8: Commit**

```bash
git add main.js
git commit -m "feat: add WebContentsView lifecycle for Gemini embed"
```

---

### Task 3: Add CSS injection and conversation scraper

**Files:**
- Modify: `main.js` (add `injectGeminiCustomizations` function)

**Step 1: Add the CSS injection + scraper function**

After the `hideGeminiView()` function added in Task 2, add:

```js
async function injectGeminiCustomizations() {
  if (!geminiView) return;
  const wc = geminiView.webContents;

  // Inject CSS to hide Google's sidebar, nav, and disclaimers
  await wc.insertCSS(`
    .boqOnegoogleliteOgbOneGoogleBar,
    .desktop-ogb-buffer { display: none !important; }
    bard-sidenav-container { display: none !important; }
    .top-bar-actions { display: none !important; }
    .hallucination-disclaimer { display: none !important; }
    .buttons-container.adv-upsell { display: none !important; }
    .conversation-container { max-width: 90% !important; }
    .input-area-container:not(.is-zero-state) { max-width: 90% !important; }
    mat-sidenav-content { margin-left: 0 !important; }
  `, { cssOrigin: 'user' });

  // Inject conversation scraper
  await wc.executeJavaScript(`
    (function() {
      if (window.__geminuiScraperActive) return;
      window.__geminuiScraperActive = true;

      function scrapeConversations() {
        try {
          const items = document.querySelectorAll('[data-test-id="conversation"]');
          const convos = [];
          items.forEach(item => {
            const titleEl = item.querySelector('.conversation-title');
            const linkEl = item.querySelector('a[href*="/app/"]');
            if (titleEl && linkEl) {
              const href = linkEl.getAttribute('href');
              const match = href.match(/\\/app\\/([a-zA-Z0-9]+)/);
              if (match) {
                convos.push({
                  id: match[1],
                  title: titleEl.textContent.trim(),
                  url: 'https://gemini.google.com' + href
                });
              }
            }
          });
          if (convos.length > 0) {
            window.geminuiBridge.sendConversations(convos);
          }
        } catch (e) {
          console.error('GeminUI scraper error:', e);
        }
      }

      // Initial scrape after Angular renders
      setTimeout(scrapeConversations, 2000);

      // Watch for sidebar changes
      const observer = new MutationObserver(() => {
        clearTimeout(window.__geminuiScrapeTimer);
        window.__geminuiScrapeTimer = setTimeout(scrapeConversations, 500);
      });

      function startObserving() {
        const sidebar = document.querySelector('bard-sidenav-container');
        if (sidebar) {
          observer.observe(sidebar, { childList: true, subtree: true });
        } else {
          setTimeout(startObserving, 1000);
        }
      }
      startObserving();

      // Fallback: if no results after 5s, notify failure
      setTimeout(() => {
        const items = document.querySelectorAll('[data-test-id="conversation"]');
        if (items.length === 0) {
          window.geminuiBridge.sendScrapeFailed();
        }
      }, 5000);

      // Re-scrape on demand
      if (window.geminuiBridge.onScrapeRequest) {
        window.geminuiBridge.onScrapeRequest(scrapeConversations);
      }
    })();
  `);
}
```

**Step 2: Verify app starts and CSS hides Google sidebar**

Run: `npm start`
Expected: gemini.google.com loads in the WebContentsView with Google's sidebar, top bar, and disclaimer hidden.

**Step 3: Commit**

```bash
git add main.js
git commit -m "feat: inject CSS and conversation scraper into Gemini view"
```

---

### Task 4: Add auth window flow

**Files:**
- Modify: `main.js` (add `openGeminiAuthWindow` function)

**Step 1: Add the auth window function**

After `injectGeminiCustomizations()` from Task 3, add:

```js
function openGeminiAuthWindow(url) {
  const authWin = new BrowserWindow({
    width: 500,
    height: 700,
    parent: mainWindow,
    modal: true,
    webPreferences: {
      partition: 'persist:gemini',
      contextIsolation: true,
      sandbox: true,
    }
  });

  authWin.loadURL(url);

  // Close auth window when user completes login and is redirected back to Gemini
  authWin.webContents.on('will-navigate', (_, navUrl) => {
    if (navUrl.includes('gemini.google.com/app')) {
      authWin.close();
      // Reload the Gemini view to pick up the new cookies
      if (geminiView) {
        geminiView.webContents.loadURL(GEMINI_URL);
      }
    }
  });

  authWin.webContents.on('did-navigate', (_, navUrl) => {
    if (navUrl.includes('gemini.google.com/app')) {
      authWin.close();
      if (geminiView) {
        geminiView.webContents.loadURL(GEMINI_URL);
      }
    }
  });
}
```

**Step 2: Add sign-out IPC handler**

After the `gemini:scrape-failed` handler from Task 2, add:

```js
ipcMain.handle('gemini:signOut', async () => {
  if (geminiView) {
    await geminiView.webContents.session.clearStorageData({
      storages: ['cookies']
    });
    geminiView.webContents.loadURL(GEMINI_URL);
  }
  return true;
});
```

**Step 3: Verify by testing auth flow**

Run: `npm start`
Expected: If not logged in, clicking on Gemini's login button should open a modal auth window. After login, the auth window closes and the Gemini view reloads with the user's account.

**Step 4: Commit**

```bash
git add main.js
git commit -m "feat: add Google auth window for Gemini embed"
```

---

### Task 5: Add Gemini IPC methods to the preload bridge

**Files:**
- Modify: `preload.js`

**Step 1: Add new IPC methods**

After the `readFileBase64` line (line 76) and before the `parseMarkdown` line (line 79), add:

```js
  // Gemini Chat embed
  showGeminiView: () => ipcRenderer.send('gemini:show-view'),
  hideGeminiView: () => ipcRenderer.send('gemini:hide-view'),
  navigateGemini: (url) => ipcRenderer.send('gemini:navigate', url),
  reloadGeminiView: () => ipcRenderer.send('gemini:reload-view'),
  signOutGemini: () => ipcRenderer.invoke('gemini:signOut'),
  onGeminiConversations: (callback) => {
    ipcRenderer.on('gemini:conversations', (_, data) => callback(data));
  },
  onGeminiScrapeFailed: (callback) => {
    ipcRenderer.on('gemini:scrape-failed', () => callback());
  },
  onGeminiUrlChanged: (callback) => {
    ipcRenderer.on('gemini:url-changed', (_, url) => callback(url));
  },
  onGeminiViewCrashed: (callback) => {
    ipcRenderer.on('gemini:view-crashed', (_, reason) => callback(reason));
  },
  onGeminiLoadFailed: (callback) => {
    ipcRenderer.on('gemini:load-failed', (_, data) => callback(data));
  },
```

**Step 2: Verify syntax**

Run: `node -c preload.js`
Expected: no output (syntax OK)

**Step 3: Commit**

```bash
git add preload.js
git commit -m "feat: add Gemini embed IPC methods to preload bridge"
```

---

### Task 6: Add theme sync to Gemini view

**Files:**
- Modify: `main.js` (add theme IPC handler)

**Step 1: Add theme sync IPC handler**

After the `gemini:signOut` handler from Task 4, add:

```js
ipcMain.on('gemini:sync-theme', (_, isDark) => {
  if (!geminiView) return;
  geminiView.webContents.executeJavaScript(`
    (function() {
      const html = document.documentElement;
      const body = document.body;
      if (${isDark}) {
        html.setAttribute('dark-theme', '');
        html.removeAttribute('light-theme');
        body.classList.add('dark-theme');
        body.classList.remove('light-theme');
      } else {
        html.setAttribute('light-theme', '');
        html.removeAttribute('dark-theme');
        body.classList.add('light-theme');
        body.classList.remove('dark-theme');
      }
    })();
  `);
});
```

**Step 2: Add the preload method**

In `preload.js`, add to the Gemini embed section (after the existing methods from Task 5):

```js
  syncGeminiTheme: (isDark) => ipcRenderer.send('gemini:sync-theme', isDark),
```

**Step 3: Commit**

```bash
git add main.js preload.js
git commit -m "feat: add theme sync between app and Gemini embed"
```

---

### Task 7: Modify switchMode() for web embed

**Files:**
- Modify: `src/app.js` — `switchMode()` function (lines 156-195)

This is the key renderer change: when switching to Chat mode, show the WebContentsView and hide the CLI task screen. When switching to Cowork, do the reverse.

**Step 1: Rewrite switchMode()**

Replace the `switchMode` function (lines 156-195 in `src/app.js`) with:

```js
function switchMode(mode, isInit) {
  state.mode = mode;
  if (!isInit) {
    state.activeSessionId = null;
    state.messageCount = 0;
    geminiAPI.setActiveSession(null);
  }

  // Update toggle buttons
  elements.modeToggle.querySelectorAll('.mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });

  const isChat = mode === 'chat';

  // Show/hide Gemini WebContentsView
  if (isChat) {
    geminiAPI.showGeminiView();
    // Sync current theme
    geminiAPI.syncGeminiTheme(state.theme === 'dark');
  } else {
    geminiAPI.hideGeminiView();
  }

  // Update sidebar button label
  elements.btnNewTaskLabel.textContent = isChat ? 'New Chat' : 'New Task';

  // Update welcome screen for Cowork mode
  elements.welcomeTitle.textContent = isChat ? 'How can I help you?' : 'Welcome to GeminUI';
  elements.welcomeSubtitle.textContent = isChat ? '' : 'Your AI desktop assistant powered by Gemini';
  elements.welcomeSubtitle.style.display = isChat ? 'none' : '';
  elements.welcomeActionsCowork.style.display = isChat ? 'none' : '';
  elements.welcomeChatInput.style.display = 'none'; // No longer needed — web embed handles input
  document.getElementById('setup-check').style.display = isChat ? 'none' : '';

  // Update task header folder display visibility
  const folderHeader = document.getElementById('current-folder-display');
  if (folderHeader) folderHeader.style.display = isChat ? 'none' : '';

  // Update task screen input placeholder
  elements.messageInput.placeholder = 'Describe your task...';

  // In Chat mode, hide the main-content area (the web view takes over)
  // In Cowork mode, show it
  document.getElementById('main-content').style.display = isChat ? 'none' : '';

  renderSessions();
  if (!isInit) {
    if (!isChat) {
      clearMessages();
      showWelcomeScreen();
    }
  }
  saveState();
}
```

**Step 2: Verify mode switching**

Run: `npm start`
Expected: Clicking "Chat" shows the Gemini web embed full-width (sidebar + web view). Clicking "Cowork" hides the web view and shows the normal CLI task screen.

**Step 3: Commit**

```bash
git add src/app.js
git commit -m "feat: wire switchMode to show/hide Gemini WebContentsView"
```

---

### Task 8: Render Gemini conversations in sidebar

**Files:**
- Modify: `src/app.js` — add `renderGeminiSessions()` and wire up listeners

**Step 1: Add state for Gemini conversations**

In the `state` object (after `mode: 'chat'` on line 31), add:

```js
  geminiConversations: [],
```

**Step 2: Add renderGeminiSessions function**

After the existing `renderSessions()` function (after line ~680 in app.js), add:

```js
function renderGeminiSessions() {
  if (state.mode !== 'chat') return;

  elements.sessionsList.textContent = '';

  const convos = state.geminiConversations;
  if (convos.length === 0) {
    const empty = createEl('div', 'sessions-empty', 'No conversations yet');
    elements.sessionsList.appendChild(empty);
    return;
  }

  // Apply search filter
  let filtered = convos;
  if (state.sessionSearchQuery) {
    filtered = filtered.filter(c =>
      c.title.toLowerCase().includes(state.sessionSearchQuery)
    );
  }

  filtered.forEach(convo => {
    const btn = createEl('button', 'session-item');
    btn.dataset.url = convo.url;

    const dot = createEl('span', 'session-dot');
    const label = createEl('span', 'session-label', convo.title);

    btn.appendChild(dot);
    btn.appendChild(label);

    btn.addEventListener('click', () => {
      geminiAPI.navigateGemini(convo.url);
      // Highlight active
      elements.sessionsList.querySelectorAll('.session-item').forEach(el => el.classList.remove('active'));
      btn.classList.add('active');
    });

    elements.sessionsList.appendChild(btn);
  });
}
```

**Step 3: Wire up Gemini conversation listeners in init()**

At the end of the `init()` function (before the closing `}`), add:

```js
  // Gemini conversation scraping
  geminiAPI.onGeminiConversations((convos) => {
    state.geminiConversations = convos;
    if (state.mode === 'chat') renderGeminiSessions();
  });

  geminiAPI.onGeminiScrapeFailed(() => {
    console.warn('Gemini conversation scraping failed — DOM may have changed');
    if (state.mode === 'chat') {
      elements.sessionsList.textContent = '';
      const msg = createEl('div', 'sessions-empty', 'Could not load conversations');
      elements.sessionsList.appendChild(msg);
    }
  });

  geminiAPI.onGeminiUrlChanged((url) => {
    // Highlight the matching conversation in our sidebar
    elements.sessionsList.querySelectorAll('.session-item').forEach(el => {
      el.classList.toggle('active', el.dataset.url === url);
    });
  });

  geminiAPI.onGeminiViewCrashed((reason) => {
    alert('Gemini view crashed: ' + reason + '. Click OK to reload.');
    geminiAPI.reloadGeminiView();
  });

  geminiAPI.onGeminiLoadFailed(({ errorCode, errorDesc }) => {
    alert('Failed to load Gemini: ' + errorDesc + ' (code ' + errorCode + '). Check your internet connection.');
  });
```

**Step 4: Update renderSessions() to branch on mode**

In the existing `renderSessions()` function (line 599), add an early return at the top:

```js
function renderSessions() {
  if (state.mode === 'chat') {
    renderGeminiSessions();
    return;
  }
  // ... rest of existing code unchanged
```

**Step 5: Update createNewSession() for Chat mode**

In `createNewSession()` (line 539), add a guard so that clicking "New Chat" in Chat mode navigates the Gemini view instead of creating a CLI session:

```js
function createNewSession() {
  if (state.mode === 'chat') {
    geminiAPI.navigateGemini('https://gemini.google.com/app');
    return;
  }
  // ... rest of existing code unchanged
```

**Step 6: Verify sidebar shows scraped conversations**

Run: `npm start`
Expected: In Chat mode, the sidebar populates with conversation titles scraped from Gemini. Clicking a conversation navigates the WebContentsView.

**Step 7: Commit**

```bash
git add src/app.js
git commit -m "feat: render Gemini conversations in sidebar, wire up navigation"
```

---

### Task 9: Wire up theme sync in the renderer

**Files:**
- Modify: `src/app.js` — `applyTheme()` function (lines 496-507)

**Step 1: Add theme sync call**

At the end of the `applyTheme()` function, add:

```js
  // Sync theme to Gemini WebContentsView
  geminiAPI.syncGeminiTheme(state.theme === 'dark');
```

**Step 2: Commit**

```bash
git add src/app.js
git commit -m "feat: sync theme toggle to Gemini embed"
```

---

### Task 10: Remove CLI chat code paths

**Files:**
- Modify: `src/app.js` — remove chat-specific CLI code
- Modify: `src/index.html` — remove welcome-chat-input elements

**Step 1: Remove welcome-chat-input from index.html**

Delete the entire `<div id="welcome-chat-input">` block (lines 120-134 in `src/index.html`):

```html
          <div id="welcome-chat-input" class="welcome-chat-input" style="display:none;">
            ...
          </div>
```

**Step 2: Remove welcome chat elements from app.js elements object**

Remove these three lines from the `elements` object (lines 118-120 in `src/app.js`):

```js
  welcomeChatInput: $('#welcome-chat-input'),
  welcomeChatTextarea: $('#welcome-chat-textarea'),
  welcomeChatSend: $('#welcome-chat-send'),
```

**Step 3: Remove welcome chat event bindings**

Remove the welcome chat input/keydown/click bindings from `bindEvents()` (lines 298-310 in `src/app.js`):

```js
  elements.welcomeChatTextarea.addEventListener('input', () => { ... });
  elements.welcomeChatTextarea.addEventListener('keydown', (e) => { ... });
  elements.welcomeChatSend.addEventListener('click', () => { ... });
```

**Step 4: Remove sendFromWelcomeChat function**

Delete the `sendFromWelcomeChat()` function (lines 871-883 in `src/app.js`).

**Step 5: Remove CSS for welcome-chat-input**

Delete these CSS rules from `src/styles.css` (lines 571-611):
- `.welcome-chat-input`
- `.welcome-input-footer`
- `.welcome-input-wrapper`
- `.welcome-input-wrapper:focus-within`
- `#welcome-chat-textarea`

**Step 6: Verify Cowork still works, Chat uses web embed**

Run: `npm start`
Expected: Chat mode shows Gemini web embed. Cowork mode works exactly as before. No broken references.

**Step 7: Commit**

```bash
git add src/app.js src/index.html src/styles.css
git commit -m "refactor: remove CLI chat code, Chat mode uses web embed only"
```

---

### Task 11: Update CSP and handle edge cases

**Files:**
- Modify: `src/index.html` — update Content-Security-Policy if needed
- Modify: `main.js` — ensure cleanup on quit

**Step 1: Check CSP**

The CSP in `index.html` (line 6) only applies to the renderer (`src/index.html`), NOT to the WebContentsView. The WebContentsView loads `gemini.google.com` which has its own CSP. No changes needed.

**Step 2: Clean up Gemini view on quit**

In the `app.on('before-quit')` handler (line 105 in `main.js`), before the ACP cleanup, add:

```js
  // Clean up Gemini view
  if (geminiView) {
    mainWindow.contentView.removeChildView(geminiView);
    geminiView.webContents.close();
    geminiView = null;
  }
```

**Step 3: Add Gemini view cleanup to window-all-closed**

In the `app.on('window-all-closed')` handler (line 132), add before the `app.quit()`:

```js
  if (geminiView) {
    geminiView.webContents.close();
    geminiView = null;
  }
```

**Step 4: Commit**

```bash
git add main.js
git commit -m "fix: clean up Gemini WebContentsView on app quit"
```

---

### Task 12: Manual integration test

**Step 1: Full test of Chat mode**

Run: `npm start`

Test checklist:
- [ ] App starts, Gemini loads in Chat mode
- [ ] Google's sidebar, top bar, and disclaimer are hidden
- [ ] Conversations appear in our sidebar
- [ ] Clicking a conversation navigates the WebContentsView
- [ ] "New Chat" navigates to `gemini.google.com/app`
- [ ] If not logged in, auth window opens
- [ ] After login, Gemini reloads with user's account
- [ ] Theme toggle syncs to Gemini
- [ ] Switching to Cowork hides the web view, shows CLI task screen
- [ ] Switching back to Chat shows the web view (state preserved)
- [ ] Window resize keeps the web view correctly positioned

**Step 2: Full test of Cowork mode**

- [ ] Cowork mode works exactly as before (folder select, send message, streaming)
- [ ] Session list shows CLI sessions only
- [ ] New Task creates a CLI session
- [ ] No broken references or console errors

**Step 3: Test error scenarios**

- [ ] Disconnect internet → Gemini shows error → reconnect → reload works
- [ ] Close and reopen app → Gemini login persists (`persist:gemini` partition)

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | Preload bridge | `preload-gemini.js` (new) |
| 2 | WebContentsView lifecycle | `main.js` |
| 3 | CSS injection + scraper | `main.js` |
| 4 | Auth window | `main.js` |
| 5 | Preload IPC methods | `preload.js` |
| 6 | Theme sync (main) | `main.js`, `preload.js` |
| 7 | switchMode() rewrite | `src/app.js` |
| 8 | Sidebar conversations | `src/app.js` |
| 9 | Theme sync (renderer) | `src/app.js` |
| 10 | Remove CLI chat code | `src/app.js`, `src/index.html`, `src/styles.css` |
| 11 | Cleanup + edge cases | `main.js` |
| 12 | Integration test | Manual |
