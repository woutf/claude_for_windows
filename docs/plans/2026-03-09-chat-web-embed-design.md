# Design: Chat Tab Web Embed

Replace the CLI-based Chat mode with an embedded gemini.google.com WebContentsView. Cowork mode stays CLI-based.

## Decisions

| Decision | Choice |
|----------|--------|
| Embed approach | WebContentsView (Electron 34, via `contentView.addChildView`) |
| Google's sidebar | Hidden via CSS, conversations scraped via JS |
| Google's top nav | Hidden via CSS |
| Google's input bar | Kept as-is (free file upload, image gen, voice, etc.) |
| Auth | Separate modal BrowserWindow, shared `persist:gemini` partition |
| Theme sync | Push our theme to Gemini via JS attribute injection |
| Fallback on break | Toast + show Google's native sidebar |
| CLI chat code | Removed. Chat = web embed, Cowork = CLI only |
| Sidebar data | Scraped from DOM using `data-test-id` selectors |
| Navigation | Our sidebar click → IPC → `loadURL()` on WebContentsView |

## Architecture

```
+--------------------------------------------------+
| Title Bar (our existing, 38px)                   |
| [Logo] [Chat | Cowork]              [- [] X]     |
+------------+-------------------------------------+
| Our        |                                     |
| Sidebar    |  WebContentsView                    |
| (260px)    |  (gemini.google.com)                |
|            |                                     |
| Scraped    |  Google sidebar: HIDDEN (CSS)       |
| convos     |  Google top nav: HIDDEN (CSS)        |
| from DOM   |  Google input bar: VISIBLE           |
|            |  Google chat area: VISIBLE           |
| [New Chat] |                                     |
+------------+-------------------------------------+
| Cowork mode: WebContentsView hidden,             |
| CLI task screen shown as today                   |
+--------------------------------------------------+
```

Mode switching:
- Chat mode: WebContentsView visible, CLI task screen hidden
- Cowork mode: WebContentsView hidden (not destroyed), CLI task screen visible
- WebContentsView stays alive when hidden to preserve login state and scroll position

## Gemini DOM Structure (Angular, no Shadow DOM on main UI)

Key stable selectors:

| Element | Selector |
|---------|----------|
| Sidebar container | `bard-sidenav-container` |
| Each conversation | `[data-test-id="conversation"]` |
| Conversation title | `.conversation-title` |
| Conv link (has ID) | `a[href*="/app/"]` → regex `/app/([a-zA-Z0-9]+)/` |
| Top nav actions | `.top-bar-actions` |
| Google One Bar | `.boqOnegoogleliteOgbOneGoogleBar`, `.desktop-ogb-buffer` |
| Input area | `rich-textarea`, `.ql-editor` |
| Chat content area | `.conversation-container` |
| Disclaimer footer | `.hallucination-disclaimer` |
| Upsell banner | `.buttons-container.adv-upsell` |
| Sidebar toggle btn | `[data-test-id="menu-toggle-button"]` |
| Model picker | `[data-test-id="bard-mode-menu-button"]` |
| Send button | `[aria-label="Send message"]` |
| New chat button | `button[aria-label*="New chat"]` |

URL patterns:
- New chat: `https://gemini.google.com/app`
- Conversation: `https://gemini.google.com/app/<alphanumeric-id>`
- Multi-account: `https://gemini.google.com/u/<n>/app`

## WebContentsView Lifecycle (main.js)

```js
let geminiView = null;
const SIDEBAR_WIDTH = 260;
const TITLEBAR_HEIGHT = 38;

function createGeminiView() {
  geminiView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-gemini.js'),
      partition: 'persist:gemini',
      contextIsolation: true,
      sandbox: true,
    }
  });
  mainWindow.contentView.addChildView(geminiView);

  geminiView.webContents.setWindowOpenHandler(({ url }) => {
    if (isGoogleAuthURL(url)) {
      openAuthWindow(url);
      return { action: 'deny' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  geminiView.webContents.on('did-finish-load', injectGeminiCustomizations);
  geminiView.webContents.on('did-navigate-in-page', (_, url) => {
    mainWindow.webContents.send('gemini:url-changed', url);
  });
  geminiView.webContents.on('render-process-gone', handleViewCrash);
  geminiView.webContents.on('did-fail-load', handleLoadFailure);

  resizeGeminiView();
}

function resizeGeminiView() {
  if (!geminiView || !mainWindow) return;
  const { width, height } = mainWindow.getContentBounds();
  geminiView.setBounds({
    x: SIDEBAR_WIDTH, y: TITLEBAR_HEIGHT,
    width: width - SIDEBAR_WIDTH,
    height: height - TITLEBAR_HEIGHT,
  });
}

mainWindow.on('resize', resizeGeminiView);
```

## CSS Injection

```css
/* Injected via insertCSS({ cssOrigin: 'user' }) */

.boqOnegoogleliteOgbOneGoogleBar,
.desktop-ogb-buffer { display: none !important; }

bard-sidenav-container { display: none !important; }

.top-bar-actions { display: none !important; }

.hallucination-disclaimer { display: none !important; }

.buttons-container.adv-upsell { display: none !important; }

.conversation-container { max-width: 90% !important; }
.input-area-container:not(.is-zero-state) { max-width: 90% !important; }
mat-sidenav-content { margin-left: 0 !important; }
```

## Conversation Scraping

Preload bridge (`preload-gemini.js`):
```js
contextBridge.exposeInMainWorld('geminuiBridge', {
  sendConversations: (data) => ipcRenderer.send('gemini:conversations', data),
  sendScrapeFailed: () => ipcRenderer.send('gemini:scrape-failed'),
});
```

Scraper (injected via `executeJavaScript`):
- Queries `[data-test-id="conversation"]` elements
- Extracts title from `.conversation-title`, ID from `a[href*="/app/"]`
- Sends array of `{ id, title, url }` via `window.geminuiBridge.sendConversations()`
- MutationObserver on `bard-sidenav-container` re-scrapes on changes (debounced 500ms)
- Initial scrape delayed 2s for Angular to render
- If zero results after 5s, sends `scrape-failed` event

Main process relays to renderer:
```js
ipcMain.on('gemini:conversations', (_, convos) => {
  mainWindow.webContents.send('gemini:conversations', convos);
});
```

Renderer shows conversations in our sidebar. Click → IPC → `geminiView.webContents.loadURL(url)`.

## Authentication

1. WebContentsView loads gemini.google.com
2. `will-navigate` detects redirect to accounts.google.com or consent.google.com
3. `event.preventDefault()` — open modal `BrowserWindow` with same `persist:gemini` partition
4. User logs in inside the auth window
5. Auth window detects redirect back to `gemini.google.com/app` → closes itself
6. WebContentsView reloads with valid cookies

Sign out: settings option that clears `persist:gemini` session cookies.

## Theme Syncing

On `did-finish-load` and on theme toggle, inject JS:
```js
const isDark = ...; // from IPC
if (isDark) {
  html.setAttribute('dark-theme', '');
  html.removeAttribute('light-theme');
  body.classList.add('dark-theme');
  body.classList.remove('light-theme');
} else { /* inverse */ }
```

If Gemini overrides it on re-render, accept the mismatch. Cosmetic only.

## Error Handling

| Scenario | Response |
|----------|----------|
| Scraping fails (DOM changed) | Toast message, show Google's native sidebar |
| Network offline | Detect `did-fail-load`, show banner, reload when back |
| Session expired | `will-navigate` catches auth redirect → auth window |
| WebContentsView crash | `render-process-gone` → error overlay + Reload button |
| URL regex breaks | Sidebar empty, toast, user interacts directly with web view |

## Code Changes

**New files:**
- `preload-gemini.js` (~20 lines) — context bridge for scraper
- `gemini-inject.js` (~80 lines) — scraper + CSS injection logic

**Modified files:**
- `main.js` (~120 lines added) — WebContentsView lifecycle, auth window, IPC, resize
- `app.js` (~60 lines modified) — `switchMode()`, `renderGeminiSessions()`, sidebar handlers
- `preload.js` (~10 lines added) — new IPC methods for mode switch and Gemini navigation

**Removed code:**
- Chat-specific CLI paths in `sendMessage()` (~50 lines)
- Welcome screen chat input elements
- Chat session creation in `createNewSession()`
- `mode: 'chat'` session filtering
