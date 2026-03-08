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

- **Windows CLI quoting**: Gemini CLI is a `.cmd` file requiring `shell: true` in `spawn()`. Message is escaped with `\"` and wrapped in double quotes.
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
