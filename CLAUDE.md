# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start          # Run the app
npm run dev        # Run with DevTools + CDP on port 9222
npm run build      # Build Windows installer (NSIS + portable)
npm run dist       # Build without publishing
```

No test runner or linter is configured.

## Architecture

Electron app (v34) wrapping the Gemini CLI (`@google/gemini-cli`). Three-process model:

**Main process** (`main.js`) — Window management, IPC handlers, spawns `gemini` CLI as a child process with `-o stream-json` for structured streaming output. Manages a single `activeProcess` reference. Auth settings stored at `~/.gemini/settings.json`.

**Preload bridge** (`preload.js`) — `contextBridge.exposeInMainWorld('geminiAPI', {...})` exposes IPC methods + markdown parsing (marked + DOMPurify) to the renderer. All renderer↔main communication goes through this bridge.

**Renderer** (`src/app.js`, `src/index.html`, `src/styles.css`) — Vanilla JS wrapped in an IIFE (required: `window.geminiAPI` conflicts with top-level `const geminiAPI`). State persisted to localStorage. No framework.

## Streaming Data Flow

1. `sendMessage()` in renderer calls `geminiAPI.sendMessage({message, workingDir, options})`
2. Main spawns `gemini -p "<message>" -o stream-json --allowed-mcp-server-names none --approval-mode yolo`
3. stdout is line-buffered and parsed as newline-delimited JSON
4. Each parsed event is sent via `mainWindow.webContents.send('gemini:stream', event)`
5. Renderer `handleStreamEvent()` processes event types: `init`, `message`, `tool_use`, `tool_result`, `result`, `text`, `done`, `error`

## Key Patterns

- **Windows CLI quoting**: Gemini CLI is a `.cmd` file requiring `shell: true` in `spawn()`. Message is escaped with `\"` and wrapped in double quotes. Newlines are replaced with spaces (cmd.exe breaks on literal newlines in quoted strings).
- **File attachment**: Uses `@path` syntax for Gemini CLI's at-command processor. Backslashes converted to forward slashes. Includes fallback read instruction since `@` respects `.gitignore`. Binary images (PNG/JPG) cannot be visually analyzed — CLI limitation (no multimodal support in non-interactive mode).
- **Version check**: `gemini --version` hangs on Windows. Use `where gemini` + read `package.json` from the npm global install path instead.
- **Session resume**: `--resume latest` for follow-up messages in the same session. Tracked via `state.messageCount`.
- **MCP server skip**: `--allowed-mcp-server-names none` saves ~15s startup time.
- **Folder instructions**: Reads `GEMINI.md` from the working directory and prepends to the first message.
- **Theme**: `data-theme` attribute on `<html>`, CSS variables switch between light/dark.
- **CDP debugging**: Enabled in dev mode via `app.commandLine.appendSwitch('remote-debugging-port', '9222')` (not CLI flag — Electron 30+ rejects it as a CLI arg).

## File Roles

| File | Lines | Purpose |
|------|-------|---------|
| `main.js` | ~350 | Electron main process, all IPC handlers |
| `preload.js` | ~45 | Context bridge API |
| `src/app.js` | ~1080 | All renderer logic, state, event handling |
| `src/index.html` | ~280 | UI structure |
| `src/styles.css` | ~1500 | All styling, dark/light theme vars |
| `.mcp.json` | MCP config for Playwright CDP connection |
| `test/control.js` | Playwright CDP script for automated UI testing |

## Testing over CDP

The Playwright MCP server (`mcp__plugin_playwright_*`) **cannot** control the Electron app — it launches its own browser. Use `test/control.js` instead.

### Setup

```bash
taskkill //F //IM electron.exe 2>/dev/null   # Kill existing instances (frees port 9222)
npm run dev                                   # Start with CDP on port 9222
```

### Using test/control.js

Connects to the running Electron app via `chromium.connectOverCDP('http://localhost:9222')`.

```bash
node test/control.js screenshot test/shot.png    # Take screenshot
node test/control.js eval "<js expression>"       # Run JS in renderer context
node test/control.js click "<css selector>"       # Click an element
node test/control.js type "<selector>" "<text>"   # Type into an input
node test/control.js snapshot                     # Accessibility tree (JSON)
```

### Common test patterns

```bash
# Read app state
node test/control.js eval "JSON.stringify(JSON.parse(localStorage.getItem('geminui-state')).settings)"

# Set state and reload
node test/control.js eval "const s = JSON.parse(localStorage.getItem('geminui-state')); s.workingDir = 'C:/path'; localStorage.setItem('geminui-state', JSON.stringify(s)); 'ok'"
node test/control.js eval "location.reload()"

# Call IPC methods directly (bypasses UI)
node test/control.js eval "geminiAPI.sendMessage({message: 'hello', workingDir: 'C:/path', options: {useACP: true}}).then(r => {window._r = r}); 'sent'"

# Capture stream events
node test/control.js eval "window._events = []; geminiAPI.onStream(e => window._events.push(e)); 'listening'"
sleep 15
node test/control.js eval "JSON.stringify(window._events)"

# Check CDP targets (without Playwright)
curl -s http://localhost:9222/json
```

### Tips

- **Async operations**: Use `sleep` between sending a command and checking results. ACP initialization takes ~10-15s (loading extensions/MCP servers). Follow-up messages are fast (~2-5s).
- **Window variables**: Store results on `window._varName` in eval, then retrieve in a separate eval call.
- **Port conflicts**: Always kill electron processes before restarting. Use `netstat -ano | grep 9222` to verify port is free.
- **Screenshot for visual checks**: `Read` tool can display PNGs inline — useful for verifying UI state.
