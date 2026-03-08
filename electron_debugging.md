# Electron App Debugging & Automation with Playwright

## Overview

This guide covers how to control, screenshot, and test the Gemini Cowork Electron app using Playwright — either via MCP tools in Claude Code or standalone scripts.

> **Key fact:** The official `@playwright/mcp` does NOT support Electron. PR #1291 was proposed in Dec 2025 but rejected by maintainers. Use one of the approaches below instead.

---

## Approach 1: CDP Connection (Recommended — Works with existing Playwright MCP)

Connect the standard `@playwright/mcp` server to the Electron app via Chrome DevTools Protocol.

### Step 1: Enable remote debugging in main.js

Add this line **before** `app.whenReady()`:

```js
// main.js — add near the top, after require() statements
app.commandLine.appendSwitch('remote-debugging-port', '9222');
```

> **Why not the CLI flag?** Electron 30+ rejects `--remote-debugging-port` as a CLI argument. Using `app.commandLine.appendSwitch()` works on all versions.

### Step 2: Launch the app

```bash
npx electron .
# or dev mode:
npx electron . --dev
```

### Step 3: Verify CDP is working

```bash
curl http://localhost:9222/json/version
# Should return JSON with webSocketDebuggerUrl
curl http://localhost:9222/json
# Should list pages including "Gemini Cowork"
```

### Step 4: Configure Playwright MCP with `--cdp-endpoint`

**Option A — Claude Code CLI:**
```bash
claude mcp add --transport stdio playwright-cdp -- cmd /c npx @playwright/mcp@latest --cdp-endpoint http://localhost:9222
```

**Option B — Project `.mcp.json`:**
```json
{
  "mcpServers": {
    "playwright-cdp": {
      "command": "cmd",
      "args": ["/c", "npx", "@playwright/mcp@latest", "--cdp-endpoint", "http://localhost:9222"]
    }
  }
}
```

### Step 5: Use MCP tools

All standard Playwright MCP tools now operate on the Electron app:
- `browser_snapshot` — accessibility tree of the app
- `browser_take_screenshot` — screenshot the app window
- `browser_click` — click elements by ref
- `browser_fill_form` — fill inputs
- `browser_type` — type text
- `browser_evaluate` — run JS in the renderer process

### Limitations
- No main-process access (can't call `app.getVersion()`, `BrowserWindow` methods, etc.)
- App must be running before the MCP server connects
- Only interacts with renderer pages (which is sufficient for UI testing)

---

## Approach 2: Community MCP — `@robertn702/playwright-mcp-electron`

A community fork of the official Playwright MCP with native Electron support.

### Setup

**Claude Code CLI (Windows):**
```bash
claude mcp add --transport stdio playwright-electron -- cmd /c npx @robertn702/playwright-mcp-electron@latest
```

**Or `.mcp.json`:**
```json
{
  "mcpServers": {
    "playwright-electron": {
      "command": "cmd",
      "args": ["/c", "npx", "@robertn702/playwright-mcp-electron@latest"]
    }
  }
}
```

### Additional Electron-specific tools

| Tool | Description |
|------|-------------|
| `electron_evaluate` | Execute JS in the **main** Electron process |
| `electron_windows` | List all open BrowserWindows |
| `electron_first_window` | Get the first application window |
| `electron_browser_window` | Access BrowserWindow object |

Plus all standard Playwright MCP tools (browser_click, browser_snapshot, etc.).

### Limitations
- v0.1.0 — very early stage, single published version
- Independently maintained (may lag behind official MCP releases)
- Requires `playwright@1.54.0`

---

## Approach 3: Community MCP — `electron-test-mcp`

A lighter alternative supporting both CDP connection and direct Electron launch.

### Setup

```bash
claude mcp add --transport stdio electron-test -- cmd /c npx electron-test-mcp
```

### Usage modes

**CDP mode** (connect to running app):
1. Launch app with debugging: ensure `app.commandLine.appendSwitch('remote-debugging-port', '9222')` is in main.js
2. Use the `connect` tool: `connect({ port: 9222 })`

**Launch mode** (MCP starts the app):
- Use the `launch` tool with your app's entry point
- Enables `evaluateMain` for main-process JS execution

### Tools

| Category | Tools |
|----------|-------|
| Connection | `connect`, `disconnect`, `launch`, `close` |
| Interaction | `click`, `fill`, `type`, `hover`, `press`, `drag`, `selectOption` |
| Inspection | `screenshot`, `snapshot`, `getText`, `getAttribute`, `isVisible`, `count` |
| Advanced | `wait`, `evaluate` (renderer), `evaluateMain` (main process, launch mode only) |

### Limitations
- `evaluateMain` only works in launch mode, not CDP mode
- Smaller community, fewer features than the robertn702 fork

---

## Approach 4: Standalone Playwright Script (No MCP)

For automated testing or CI without Claude Code.

### Script: `test/screenshot.js`

```js
const { chromium } = require('playwright');

(async () => {
  // Assumes app is running with remote-debugging-port=9222
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const context = browser.contexts()[0];
  const pages = context.pages();

  const appPage = pages.find(p => p.url().includes('index.html'));
  if (!appPage) {
    console.error('App page not found. Pages:', pages.map(p => p.url()));
    process.exit(1);
  }

  console.log('Title:', await appPage.title());

  // Screenshot
  await appPage.screenshot({ path: 'screenshot.png', fullPage: true });
  console.log('Screenshot saved to screenshot.png');

  // Interact
  // await appPage.click('#btn-select-folder');
  // await appPage.fill('#message-input', 'Hello');
  // await appPage.click('#btn-send');

  await browser.close();
})();
```

### Script: `test/launch-and-test.js`

```js
const { _electron: electron } = require('playwright');

(async () => {
  // Playwright launches Electron directly
  const app = await electron.launch({
    args: ['.'],
    cwd: 'C:/Users/wout/Desktop/gemini_app'
  });

  const window = await app.firstWindow();
  console.log('Title:', await window.title());

  // Main process access
  const version = await app.evaluate(async ({ app }) => app.getVersion());
  console.log('App version:', version);

  // Screenshot
  await window.screenshot({ path: 'screenshot.png' });

  // Interact with the UI
  // await window.click('#btn-select-folder');

  await app.close();
})();
```

> **Note:** `_electron.launch()` requires Playwright 1.51+ for Electron 30+ compatibility (fix merged Jan 2026).

---

## Quick Reference

| Approach | Main-process access | Requires app running first | Setup complexity |
|----------|--------------------|-----------------------------|-----------------|
| CDP + official MCP | No | Yes | Low |
| robertn702 fork | Yes | No (launches app) | Low |
| electron-test-mcp | Launch mode only | CDP: yes, Launch: no | Low |
| Standalone script | connectOverCDP: no, _electron.launch: yes | Depends on method | Medium |

## Recommended for Claude Code

**For quick UI inspection:** Approach 1 (CDP + official `@playwright/mcp` with `--cdp-endpoint`)
- Minimal setup, uses the official maintained package
- Just add the CDP switch to main.js and reconfigure MCP

**For full Electron testing:** Approach 2 (`@robertn702/playwright-mcp-electron`)
- Main-process access, dedicated Electron tools
- Trade-off: community-maintained, early stage

---

## Troubleshooting

### CDP endpoint not responding
```bash
# Check if Electron is listening
curl http://localhost:9222/json/version

# If empty, verify the switch is in main.js BEFORE app.whenReady()
# Also check no other process is using port 9222:
netstat -ano | findstr :9222
```

### "require is not defined" in browser_run_code
The MCP `browser_run_code` runs in the browser context (no Node.js `require`). Use `browser_evaluate` for renderer-side JS, or `electron_evaluate` (robertn702 fork) for main-process JS.

### Windows: MCP server fails to start
Always use `cmd /c` wrapper on native Windows:
```json
{ "command": "cmd", "args": ["/c", "npx", "@playwright/mcp@latest", ...] }
```

### Electron 30+ rejects --remote-debugging-port CLI flag
Don't pass it as a CLI argument. Use `app.commandLine.appendSwitch()` in main.js instead.

### Page not found after connecting
The DevTools page may appear first. Filter pages by URL:
```js
const appPage = pages.find(p => p.url().includes('index.html'));
```

### Playwright version compatibility
- Electron 34 requires Playwright 1.51+ for `_electron.launch()`
- CDP connection works with any Playwright version
- The robertn702 fork bundles Playwright 1.54.0
