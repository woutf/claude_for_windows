# Claude Cowork vs Gemini Cowork — Feature Comparison

## Feature Matrix

| Feature | Claude Cowork | Gemini Cowork | Status |
|---|---|---|---|
| **Core** | | | |
| Desktop app (Electron/native) | Yes | Yes | Done |
| Custom title bar + window controls | Yes | Yes | Done |
| Folder-based workspace | Yes | Yes | Done |
| Send prompts, get streaming responses | Yes | Yes | Done |
| Markdown rendering | Yes | Yes | Done |
| Code block rendering | Yes | Yes | Done |
| Tool usage display (file reads, commands) | Yes | Yes | Done |
| Cancel/stop running task | Yes | Yes | Done |
| **Sessions** | | | |
| Session list in sidebar | Yes | Yes | Done |
| Create/delete sessions | Yes | Yes | Done |
| Session rename | Yes | Yes (double-click) | Done |
| Session filtering (Active/Archived) | Yes | Yes | Done |
| Multi-turn conversation (resume) | Yes | Yes | Done |
| **Input** | | | |
| Text input with auto-resize | Yes | Yes | Done |
| Model selector | Yes | Yes | Done |
| File attachment | Yes | Yes | Done |
| Keyboard shortcuts (Enter, Shift+Enter) | Yes | Yes | Done |
| Suggestion chips on welcome screen | Yes | Yes | Done |
| **Settings** | | | |
| API key / auth config | Yes | Yes | Done |
| Model selection | Yes | Yes | Done |
| Approval mode (auto/ask/yolo) | Yes | Yes | Done |
| Sandbox mode | Yes | Yes | Done |
| Global instructions | Yes | Yes | Done |
| Folder-specific instructions (GEMINI.md) | Yes | Yes | Done |
| **Missing Features** | | | |
| Dark mode / light mode toggle | Yes | Yes | Done |
| Scheduled/recurring tasks | Yes | No | **Missing** |
| Progress indicators per step | Yes (detailed) | Yes (expandable tool details) | Done |
| Parallel sub-agent execution | Yes | No | N/A (Gemini CLI limitation) |
| Permission prompts for destructive actions | Yes (inline) | No (uses approval mode) | N/A (CLI limitation) |
| Server preview panel | Yes | No | N/A (Claude Code-specific) |
| Plugin/extension browser | Yes | No | N/A (CLI limitation) |
| Session context usage display | Yes | Yes (token stats on result) | Done |
| Thinking time indicator (timer) | Yes | Yes | Done |
| Expandable thinking/reasoning section | Yes | Yes (tool use details) | Done |
| Drag & drop file attachment | Yes | Yes | Done |
| Search across sessions | Yes | Yes | Done |
| Notification when background task completes | Yes | Yes | Done |

## Priority Improvements (biggest UX wins)

1. ~~**Thinking timer** — show elapsed time while waiting for response~~ ✅
2. ~~**Drag & drop files** — onto the input area~~ ✅
3. ~~**Dark/light theme toggle**~~ ✅
4. ~~**Session rename** — double-click to edit~~ ✅
5. ~~**Folder-specific instructions** — per-project GEMINI.md~~ ✅
6. ~~**Progress detail** — show what tool is running with expandable output~~ ✅
7. ~~**Context/token usage** — show from the `result` event stats~~ ✅

## Remaining Gaps (not feasible via Gemini CLI)
- Scheduled/recurring tasks (would need a task scheduler daemon)
- Inline permission prompts (Gemini CLI uses approval modes, not inline prompts)
- Plugin/extension browser (no Gemini CLI equivalent)
- Server preview panel (Claude Code-specific feature)

## Sources

- [Introducing Cowork | Claude](https://claude.com/blog/cowork-research-preview)
- [Get started with Cowork | Claude Help Center](https://support.claude.com/en/articles/13345190-get-started-with-cowork)
- [Use Claude Code Desktop](https://code.claude.com/docs/en/desktop)
- [Navigating the Claude desktop app](https://claude.com/resources/tutorials/navigating-the-claude-desktop-app)
- [Schedule recurring tasks in Cowork](https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-cowork)
- [Use Cowork safely](https://support.claude.com/en/articles/13364135-use-cowork-safely)
