# Competitive Analysis: AI Desktop Apps (March 2026)

Research from inspecting installed apps (ASAR extraction) and web research.

## Claude Desktop (Anthropic)

**Framework:** Electron 40 + React 18 + Vite + Tailwind CSS

**Key architecture:** Web wrapper. Loads `https://claude.ai` in the main window. The Electron shell provides native features only (title bar, MCP, tray, shortcuts, screen capture, SSH).

**Notable dependencies:**
- `@anthropic-ai/sdk` + `@anthropic-ai/claude-agent-sdk` (API + agent)
- `@modelcontextprotocol/sdk` 1.26.0 (MCP hosting)
- `@marshallofsound/ipc` (type-safe IPC)
- `rxjs` (reactive), `zod` (validation), `winston` (logging)
- `electron-store` (settings), `electron-forge` (packaging)
- `@sentry/electron` (error tracking)
- `playwright-core` (computer use)
- `ssh2` (remote connections)
- `ws` (WebSocket)
- `@ant/claude-native` - Rust native addon via NAPI-RS

**Interesting features from source inspection:**
- Quick Window (spotlight-like overlay, transparent, always-on-top)
- MCP servers run in Electron utility processes (not child processes)
- Sidebar modes: `chat`, `code`, `task`, `epitaxy`
- Settings validated with Zod schemas at runtime
- IPC channels namespaced with UUIDs
- Computer use enabled by default
- Cowork service as separate native binary (`cowork-svc.exe`)
- Chrome extension pairing for browser integration
- Scheduled tasks feature (flag-gated)

**Deep source code findings (from ASAR extraction + analysis):**

Architecture: Dual session system
- Cloud sessions: handled by the claude.ai web view (standard web conversations)
- Local sessions: managed by main process for agent mode. Each session tracks:
  `sessionId`, `cwd`, `model`, `permissionMode`, `worktreePath`, `sshConfig`,
  `prNumber`, `prUrl`, `scheduledTaskId`, `mountedProjects`, `spaceId`, `sessionType`

Window architecture: Multi-view using WebContentsView (Electron 40)
- MainWindow = OS container (local HTML for title bar)
- MainView = WebContentsView loading claude.ai
- FindInPageView = overlay WebContentsView for Ctrl+F
- LaunchPreview views = sandboxed WebContentsView for dev server previews
- QuickEntry = separate floating window (320x54)

IPC framework (`eipc`): All channels follow pattern:
`$eipc_message$_{uuid}_$_{namespace}_$_{interface}_$_{method}`
Namespaces: claude.internal.ui, claude.web, claude.settings, claude.hybrid

Chrome Extension MCP (built-in browser automation):
- Tools: javascript_tool, read_page, find, form_input, computer, navigate,
  gif_creator, upload_image, tabs_context_mcp, read_console_messages,
  read_network_requests, shortcuts_list, shortcuts_execute
- Connects to Chrome extension via WebSocket + OAuth

PTY terminal: startPty/stopPty/writePty/resizePty — interactive shell within sessions

Git worktrees: Each agent session gets its own worktree, cleaned up on end

Spaces: Workspace organization with folders, projects, custom instructions per space

OAuth 2.0 with PKCE: Multiple client IDs for different contexts
- Desktop inference: clientId 89355bc3, scope user:inference
- Cowork OAuth: separate clientId a473d7bb
- Token cache persisted in electron-store

Feature flags (code names): plushRaccoon, quietPenguin, louderPenguin,
sparkleHedgehog, chillingSloth, yukonSilver

Theme colors: dark #262624, light #FAF9F5

**ASAR location:** `C:\Program Files\WindowsApps\Claude_1.1.5749.0_x64__pzs8sxrjxfjjc\app\resources\app.asar`

---

## ChatGPT Desktop (OpenAI)

**Windows:** Electron (~260 MB). **macOS:** Fully native (Swift/AppKit, NOT Electron).

**Architecture:** Web wrapper. Loads ChatGPT web app (Next.js 13 + React + Tailwind).

**Streaming:** Server-Sent Events (SSE) via `/backend-api/conversation`.

**"Work with Apps":** Uses OS accessibility APIs (macOS Accessibility API, Windows UI Automation). Reads text only (up to 200 lines). Built on Multi acquisition technology.

**Auth:** Auth0 with JWT tokens.

---

## OpenAI Codex

**CLI:** Open-source (Apache-2.0) at github.com/openai/codex. Rewritten in Rust.

**Desktop:** Electron. Bundles a Rust App Server binary as child process.

**App Server Protocol (very similar to our stream-json approach):**
- JSON-RPC 2.0 as JSONL over stdio
- Item lifecycle: `started → delta → completed`
- Item types: userMessage, agentMessage, plan, reasoning, commandExecution, fileChange, mcpToolCall, webSearch
- Turn = group of items from one agent action
- Thread = durable session (resume, fork, rollback)
- Approval flow: server sends request, client responds accept/decline/cancel

**Sandbox policies:** readOnly, workspaceWrite, externalSandbox, dangerFullAccess

---

## Open-Source Apps Worth Studying

| App | Stars | Repo | Key Learnings |
|-----|-------|------|--------------|
| Cherry Studio | ~40k | github.com/CherryHQ/cherry-studio | Provider middleware pipeline, Redux state, MCP support, closest analog to GeminUI |
| AnythingLLM | ~55k | github.com/Mintplex-Labs/anything-llm | Embedded Express server, full MCP (stdio/SSE/HTTP), agent framework |
| Chatbox | ~39k | github.com/chatboxai/chatbox | Multi-provider streaming, local-first storage, per-session model config |
| Jan | ~26k | github.com/janhq/jan | Extension system, MCP host, migrating Electron→Tauri |
| Dive | ~6k | github.com/OpenAgentPlatform/Dive | MCP-first design, granular tool control, Jotai atoms |
| Vercel Streamdown | — | github.com/vercel/streamdown | Streaming markdown renderer handling incomplete blocks |
| LibreChat | ~25k | github.com/danny-avila/LibreChat | MCPManager registry, SSE session management, comprehensive architecture docs |

---

## Feature Gap Analysis for GeminUI

### Already strong:
- CLI wrapping via stream-json (validated by Codex using same pattern)
- Tray support, theme switching, session resume
- File attachment via @path syntax

### High-priority opportunities:
1. **Quick Window / Spotlight mode** — Global shortcut → floating compact chat overlay
2. **MCP server hosting** — Lazy-load after first response instead of `--allowed-mcp-server-names none`
3. **Tool use UI** — Collapsible panels with status indicators (pending/success/failure)
4. **Streaming markdown robustness** — Handle unterminated code blocks mid-stream (Streamdown patterns)
5. **Accessibility API integration** — Read text from other windows (Windows UI Automation)

### Medium-priority:
6. State management upgrade (Redux/Jotai instead of localStorage)
7. Type-safe IPC as channel count grows
8. Approval flow for dangerous operations
9. Find-in-page for conversation search

### Lower-priority:
10. Native Rust addon for system features (NAPI-RS)
11. Browser extension pairing
12. SSH/remote support
13. Computer use via Playwright
14. Scheduled tasks / cron features

---

## Actionable UI Patterns from Claude Desktop

### Quick Window Implementation (Lit + RxJS)
- Transparent BrowserWindow (320x54 initial), always-on-top, frameless
- Auto-resize textarea: height adjusts up to `window.innerHeight - 100px`
- Window resize debounced 750ms via RxJS (`requestSkooch(width, height)`)
- Enter submits + clears, Escape dismisses with null
- File drag-and-drop explicitly disabled on textarea
- Gradient bg: `white -> rgba(245,245,250,0.95)`, 16px border-radius, 0.5px border

### Button Microinteractions
- Hover: `scale-y-[1.015] scale-x-[1.005]` + radial gradient after-pseudo for glow
- Active press: `scale-[0.985]` — physical press feel
- 6 variants: primary, secondary, flat, ghost, danger, unstyled
- 8 sizes: default, sm, lg, icon, icon_xs, icon_sm, icon_lg, inline

### CSS Design System (HSL tokens)
- Light/dark toggle via `.darkTheme` class on `:root`
- Semantic tokens: `--bg-000` to `--bg-500`, `--text-000` to `--text-500`
- Brand colors: `--kraft`, `--book-cloth`, `--manilla`, `--clay`
- Dark bg: `#262624`, Light bg: `#FAF9F5`
- Drag regions: `.nc-drag` / `.nc-no-drag` utility classes

### Reconnection Pattern
- Exponential backoff: `min(1000 * 2^(attempt-1), 30000ms)` + 10% jitter
- Check `navigator.onLine` before attempting health probe
- Full-screen error overlay with "Refresh" button on failure

### Find-in-Page
- Separate WebContentsView overlay (not in-page DOM)
- RxJS debounce 250ms, minimum 2 characters to trigger
- Navigation: up/down arrows cycle matches, shows `activeIndex/total`

### IPC Organization (197+ channels)
Modules: LocalSessions, LocalAgentModeSessions, FileSystem, Launch,
CoworkSpaces, CoworkScheduledTasks, CustomPlugins, Resources, ClaudeVM,
ComputerUseTcc, DesktopNotifications, QuickEntry, Toast, Navigation, AutoUpdater
