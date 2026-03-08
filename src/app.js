// ============================================
// Gemini Cowork - Renderer
// ============================================

;(function() {
const geminiAPI = window.geminiAPI;

// State
const state = {
  workingDir: null,
  sessions: [],
  activeSessionId: null,
  isStreaming: false,
  settings: {
    apiKey: '',
    model: '',
    approvalMode: 'auto_edit',
    sandbox: false,
    instructions: ''
  },
  geminiVersion: null,
  messageCount: 0,
  attachedFiles: [],
  folderInstructions: null,
  sessionFilter: 'all',
  sessionSearchQuery: '',
  theme: localStorage.getItem('gemini-cowork-theme') || 'dark'
};

// Load saved state
function loadState() {
  try {
    const saved = localStorage.getItem('gemini-cowork-state');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed.settings) Object.assign(state.settings, parsed.settings);
      if (parsed.workingDir) state.workingDir = parsed.workingDir;
      if (parsed.sessions) state.sessions = parsed.sessions;
    }
  } catch (e) {
    console.error('Failed to load state:', e);
  }
}

function saveState() {
  try {
    localStorage.setItem('gemini-cowork-state', JSON.stringify({
      settings: state.settings,
      workingDir: state.workingDir,
      sessions: state.sessions.map(s => ({
        ...s,
        messages: s.messages.slice(-50)
      }))
    }));
  } catch (e) {
    console.error('Failed to save state:', e);
  }
}

// Elements
const $ = (sel) => document.querySelector(sel);

const elements = {
  welcomeScreen: $('#welcome-screen'),
  taskScreen: $('#task-screen'),
  setupGemini: $('#setup-gemini'),
  btnSelectFolder: $('#btn-select-folder'),
  btnNewTask: $('#btn-new-task'),
  btnSettings: $('#btn-settings'),
  btnCloseSettings: $('#btn-close-settings'),
  settingsModal: $('#settings-modal'),
  sessionsList: $('#sessions-list'),
  messagesArea: $('#messages-area'),
  messagesContainer: $('#messages-container'),
  messageInput: $('#message-input'),
  btnSend: $('#btn-send'),
  btnCancelTask: $('#btn-cancel-task'),
  btnChangeFolder: $('#btn-change-folder'),
  folderPathText: $('#folder-path-text'),
  modelBadge: $('#model-badge'),
  btnMinimize: $('#btn-minimize'),
  btnMaximize: $('#btn-maximize'),
  btnClose: $('#btn-close'),
  settingApiKey: $('#setting-apikey'),
  settingModel: $('#setting-model'),
  settingApproval: $('#setting-approval'),
  settingSandbox: $('#setting-sandbox'),
  settingInstructions: $('#setting-instructions'),
  btnGoogleLogin: $('#btn-google-login'),
  authDot: $('#auth-dot'),
  authStatusText: $('#auth-status-text'),
  btnAttach: $('#btn-attach'),
  attachedFiles: $('#attached-files'),
  btnModelSelect: $('#btn-model-select'),
  modelSelectLabel: $('#model-select-label'),
  modelDropdown: $('#model-dropdown'),
  btnTheme: $('#btn-theme'),
  themeLabel: $('#theme-label'),
  themeIconLight: $('#theme-icon-light'),
  themeIconDark: $('#theme-icon-dark'),
  sessionSearch: $('#session-search')
};

// ============================================
// Thinking timer
let thinkingStartTime = null;
let thinkingInterval = null;

// Safe DOM helpers
// ============================================

function createEl(tag, className, textContent) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (textContent) el.textContent = textContent;
  return el;
}

function setMarkdownContent(el, markdownText) {
  // parseMarkdown already runs through DOMPurify
  const sanitized = geminiAPI.parseMarkdown(markdownText);
  el.innerHTML = sanitized;
}

// ============================================
// Initialization
// ============================================

async function init() {
  loadState();
  applyTheme();
  bindEvents();
  applySettings();
  renderSessions();

  const version = await geminiAPI.checkInstalled();
  const setupIcon = elements.setupGemini.querySelector('.setup-icon');
  const setupText = elements.setupGemini.querySelector('span');

  if (version) {
    state.geminiVersion = version;
    setupIcon.className = 'setup-icon success';
    setupText.textContent = version === 'installed' ? 'Gemini CLI found' : `Gemini CLI v${version} found`;
  } else {
    setupIcon.className = 'setup-icon error';
    setupText.textContent = 'Gemini CLI not found. Install: npm i -g @google/gemini-cli';
  }

  checkAuthStatus();

  if (state.workingDir) {
    updateFolderDisplay();
  }

  if (state.activeSessionId) {
    const session = state.sessions.find(s => s.id === state.activeSessionId);
    if (session) {
      showTaskScreen();
      renderMessages(session);
    }
  }
}

// ============================================
// Event Binding
// ============================================

function bindEvents() {
  elements.btnMinimize.addEventListener('click', () => geminiAPI.minimize());
  elements.btnMaximize.addEventListener('click', () => geminiAPI.maximize());
  elements.btnClose.addEventListener('click', () => geminiAPI.close());

  geminiAPI.onMaximized((isMax) => {
    elements.btnMaximize.title = isMax ? 'Restore' : 'Maximize';
  });

  elements.btnSelectFolder.addEventListener('click', selectFolder);
  elements.btnChangeFolder.addEventListener('click', selectFolder);
  elements.btnNewTask.addEventListener('click', createNewSession);

  elements.btnSettings.addEventListener('click', () => {
    elements.settingsModal.classList.add('active');
  });
  elements.btnCloseSettings.addEventListener('click', () => {
    elements.settingsModal.classList.remove('active');
    saveSettings();
  });
  elements.settingsModal.addEventListener('click', (e) => {
    if (e.target === elements.settingsModal) {
      elements.settingsModal.classList.remove('active');
      saveSettings();
    }
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (elements.settingsModal.classList.contains('active')) {
        elements.settingsModal.classList.remove('active');
        saveSettings();
      }
    }
    // Ctrl+N for new task
    if (e.ctrlKey && e.key === 'n') {
      e.preventDefault();
      createNewSession();
    }
  });

  elements.messageInput.addEventListener('input', () => {
    autoResizeTextarea(elements.messageInput);
    elements.btnSend.disabled = !elements.messageInput.value.trim() || state.isStreaming;
  });

  elements.messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (elements.messageInput.value.trim() && !state.isStreaming) {
        sendMessage();
      }
    }
  });

  elements.btnSend.addEventListener('click', () => {
    if (elements.messageInput.value.trim() && !state.isStreaming) {
      sendMessage();
    }
  });

  elements.btnCancelTask.addEventListener('click', async () => {
    await geminiAPI.cancel();
    finishStreaming();
  });

  document.querySelectorAll('.suggestion-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const prompt = chip.dataset.prompt;
      if (state.workingDir) {
        elements.messageInput.value = prompt;
        showTaskScreen();
        if (!state.activeSessionId) createNewSession();
        sendMessage();
      } else {
        selectFolder().then(() => {
          if (state.workingDir) {
            elements.messageInput.value = prompt;
            showTaskScreen();
            if (!state.activeSessionId) createNewSession();
            sendMessage();
          }
        });
      }
    });
  });

  // Handle link-text clicks to open URLs externally
  document.addEventListener('click', (e) => {
    const linkEl = e.target.closest('.link-text[data-url]');
    if (linkEl) {
      e.preventDefault();
      geminiAPI.openFolder(linkEl.dataset.url);
    }
  });

  // Google OAuth login
  elements.btnGoogleLogin.addEventListener('click', async () => {
    elements.btnGoogleLogin.disabled = true;
    elements.btnGoogleLogin.textContent = 'Opening login...';
    try {
      await geminiAPI.googleLogin();
      updateAuthStatus('oauth-personal');
    } catch (e) {
      console.error('Google login failed:', e);
    }
    elements.btnGoogleLogin.disabled = false;
    elements.btnGoogleLogin.textContent = 'Login with Google';
    // Re-add the SVG icon
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.innerHTML = '<path d="M15.68 8.18c0-.57-.05-1.12-.15-1.64H8v3.1h4.3a3.68 3.68 0 01-1.6 2.41v2h2.59c1.51-1.4 2.39-3.45 2.39-5.87z" fill="#4285F4"/><path d="M8 16c2.16 0 3.97-.72 5.29-1.94l-2.59-2a5.02 5.02 0 01-7.48-2.63H.63v2.06A8 8 0 008 16z" fill="#34A853"/><path d="M3.22 9.43a4.8 4.8 0 010-2.86V4.5H.63a8 8 0 000 7l2.59-2.06z" fill="#FBBC05"/><path d="M8 3.16c1.22 0 2.31.42 3.17 1.24l2.37-2.37A7.96 7.96 0 008 0 8 8 0 00.63 4.51l2.59 2.06A4.77 4.77 0 018 3.16z" fill="#EA4335"/>';
    elements.btnGoogleLogin.prepend(svg);
  });

  // File attach
  elements.btnAttach.addEventListener('click', async () => {
    const files = await geminiAPI.selectFiles();
    if (files && files.length) {
      state.attachedFiles.push(...files);
      renderAttachedFiles();
    }
  });

  // Model selector dropdown
  elements.btnModelSelect.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = elements.modelDropdown.style.display !== 'none';
    elements.modelDropdown.style.display = isOpen ? 'none' : 'block';
    if (!isOpen) updateModelDropdownActive();
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.input-footer-left')) {
      elements.modelDropdown.style.display = 'none';
    }
  });

  elements.modelDropdown.addEventListener('click', (e) => {
    const opt = e.target.closest('.model-option');
    if (!opt) return;
    const model = opt.dataset.model;
    state.settings.model = model;
    elements.settingModel.value = model;
    updateModelSelectLabel();
    updateModelBadge();
    elements.modelDropdown.style.display = 'none';
    saveState();
  });

  // Theme toggle
  elements.btnTheme.addEventListener('click', () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('gemini-cowork-theme', state.theme);
    applyTheme();
  });

  // Session search
  elements.sessionSearch.addEventListener('input', (e) => {
    state.sessionSearchQuery = e.target.value.toLowerCase();
    renderSessions();
  });

  // Session filters
  document.querySelectorAll('.session-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.session-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.sessionFilter = btn.dataset.filter;
      renderSessions();
    });
  });

  // Drag & drop files
  const inputWrapper = document.querySelector('.input-wrapper');
  inputWrapper.addEventListener('dragover', (e) => {
    e.preventDefault();
    inputWrapper.classList.add('drag-over');
  });
  inputWrapper.addEventListener('dragleave', () => {
    inputWrapper.classList.remove('drag-over');
  });
  inputWrapper.addEventListener('drop', (e) => {
    e.preventDefault();
    inputWrapper.classList.remove('drag-over');
    const files = Array.from(e.dataTransfer.files);
    files.forEach(f => {
      if (f.path) state.attachedFiles.push(f.path);
    });
    if (files.length) renderAttachedFiles();
  });

  geminiAPI.onStream(handleStreamEvent);
}

// ============================================
// Theme
// ============================================

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  if (state.theme === 'dark') {
    elements.themeIconLight.style.display = '';
    elements.themeIconDark.style.display = 'none';
    elements.themeLabel.textContent = 'Light Mode';
  } else {
    elements.themeIconLight.style.display = 'none';
    elements.themeIconDark.style.display = '';
    elements.themeLabel.textContent = 'Dark Mode';
  }
}

// ============================================
// Folder Management
// ============================================

async function selectFolder() {
  const folder = await geminiAPI.selectFolder();
  if (folder) {
    state.workingDir = folder;
    state.folderInstructions = await geminiAPI.readFolderInstructions(folder);
    updateFolderDisplay();
    saveState();

    if (!state.activeSessionId) {
      showTaskScreen();
      createNewSession();
    }
  }
}

function updateFolderDisplay() {
  if (state.workingDir) {
    elements.folderPathText.textContent = state.workingDir;
    elements.folderPathText.title = state.workingDir;
  }
}

// ============================================
// Session Management
// ============================================

function createNewSession() {
  const session = {
    id: Date.now().toString(),
    title: 'New Task',
    messages: [],
    isResume: false,
    archived: false
  };
  state.sessions.unshift(session);
  state.activeSessionId = session.id;
  state.messageCount = 0;
  renderSessions();
  clearMessages();
  showTaskScreen();
  elements.messageInput.focus();
  saveState();
}

function deleteSession(sessionId) {
  state.sessions = state.sessions.filter(s => s.id !== sessionId);
  if (state.activeSessionId === sessionId) {
    state.activeSessionId = state.sessions.length > 0 ? state.sessions[0].id : null;
    if (state.activeSessionId) {
      const session = state.sessions.find(s => s.id === state.activeSessionId);
      renderMessages(session);
    } else {
      clearMessages();
      showWelcomeScreen();
    }
  }
  renderSessions();
  saveState();
}

function showWelcomeScreen() {
  elements.taskScreen.classList.remove('active');
  elements.welcomeScreen.classList.add('active');
}

function switchToSession(sessionId) {
  const session = state.sessions.find(s => s.id === sessionId);
  if (!session) return;

  state.activeSessionId = sessionId;
  state.messageCount = session.messages.filter(m => m.role === 'user').length;
  renderSessions();
  showTaskScreen();
  renderMessages(session);
  saveState();
}

function renderSessions() {
  elements.sessionsList.textContent = '';

  let filtered = state.sessions;

  // Filter by active/archived
  if (state.sessionFilter === 'active') {
    filtered = filtered.filter(s => !s.archived);
  } else if (state.sessionFilter === 'archived') {
    filtered = filtered.filter(s => s.archived);
  }

  // Search filter
  if (state.sessionSearchQuery) {
    filtered = filtered.filter(s =>
      s.title.toLowerCase().includes(state.sessionSearchQuery) ||
      s.messages.some(m => m.content && m.content.toLowerCase().includes(state.sessionSearchQuery))
    );
  }

  if (filtered.length === 0) {
    const empty = createEl('div', 'sessions-empty', state.sessions.length === 0 ? 'No sessions yet' : 'No matching sessions');
    elements.sessionsList.appendChild(empty);
    return;
  }

  filtered.forEach(session => {
    const btn = createEl('button', `session-item${session.id === state.activeSessionId ? ' active' : ''}`);
    btn.dataset.id = session.id;

    const dot = createEl('span', 'session-dot');
    const label = createEl('span', 'session-label', session.title);

    const archiveBtn = createEl('span', 'session-archive', session.archived ? '\u21A9' : '\u2193');
    archiveBtn.title = session.archived ? 'Unarchive' : 'Archive';
    const deleteBtn = createEl('span', 'session-delete', '\u00d7');
    deleteBtn.title = 'Delete session';

    btn.appendChild(dot);
    btn.appendChild(label);
    btn.appendChild(archiveBtn);
    btn.appendChild(deleteBtn);

    // Double-click to rename
    label.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const input = createEl('input', 'session-rename-input');
      input.type = 'text';
      input.value = session.title;
      label.textContent = '';
      label.appendChild(input);
      input.focus();
      input.select();
      const finish = () => {
        const newTitle = input.value.trim() || session.title;
        session.title = newTitle;
        label.textContent = newTitle;
        saveState();
      };
      input.addEventListener('blur', finish);
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') input.blur();
        if (ev.key === 'Escape') { input.value = session.title; input.blur(); }
      });
    });

    btn.addEventListener('click', (e) => {
      if (e.target.closest('.session-delete')) {
        deleteSession(session.id);
      } else if (e.target.closest('.session-archive')) {
        session.archived = !session.archived;
        renderSessions();
        saveState();
      } else if (!e.target.closest('.session-rename-input')) {
        switchToSession(session.id);
      }
    });

    elements.sessionsList.appendChild(btn);
  });
}

// ============================================
// Screen Navigation
// ============================================

function showTaskScreen() {
  elements.welcomeScreen.classList.remove('active');
  elements.taskScreen.classList.add('active');
  updateFolderDisplay();
  updateModelBadge();
}

function updateModelBadge() {
  const model = state.settings.model || 'Default';
  elements.modelBadge.textContent = model === 'Default' ? 'Gemini' : model;
}

// ============================================
// Message Handling
// ============================================

function clearMessages() {
  elements.messagesContainer.textContent = '';
}

function renderMessages(session) {
  clearMessages();
  session.messages.forEach(msg => {
    appendMessageToDOM(msg.role, msg.content, false);
  });
  scrollToBottom();
}

function buildAvatarSVG() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 28 28');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M14 0C14 7.732 7.732 14 0 14c7.732 0 14 6.268 14 14 0-7.732 6.268-14 14-14C20.268 14 14 7.732 14 0z');
  path.setAttribute('fill', 'white');
  svg.appendChild(path);
  return svg;
}

function appendMessageToDOM(role, content, animate = true) {
  const msgEl = createEl('div', `message ${role}`);

  // Avatar
  const avatar = createEl('div', 'message-avatar');
  if (role === 'user') {
    avatar.appendChild(createEl('span', null, 'Y'));
  } else {
    avatar.appendChild(buildAvatarSVG());
  }

  // Body
  const body = createEl('div', 'message-body');
  const roleLabel = createEl('div', 'message-role', role === 'user' ? 'You' : 'Gemini');
  const contentEl = createEl('div', 'message-content');

  if (role === 'assistant') {
    setMarkdownContent(contentEl, content);
  } else {
    contentEl.textContent = content;
  }

  body.appendChild(roleLabel);
  body.appendChild(contentEl);

  msgEl.appendChild(avatar);
  msgEl.appendChild(body);

  if (!animate) {
    msgEl.style.animation = 'none';
  }

  elements.messagesContainer.appendChild(msgEl);
  return msgEl;
}

function addThinkingIndicator() {
  const msgEl = createEl('div', 'message assistant');
  msgEl.id = 'thinking-indicator';

  const avatar = createEl('div', 'message-avatar');
  avatar.appendChild(buildAvatarSVG());

  const body = createEl('div', 'message-body');
  const roleLabel = createEl('div', 'message-role', 'Gemini');
  const indicator = createEl('div', 'thinking-indicator');
  const dots = createEl('div', 'thinking-dots');
  for (let i = 0; i < 3; i++) dots.appendChild(createEl('span'));
  indicator.appendChild(dots);
  const timerSpan = createEl('span', 'thinking-timer', 'Thinking... 0s');
  timerSpan.id = 'thinking-timer';
  indicator.appendChild(timerSpan);

  body.appendChild(roleLabel);
  body.appendChild(indicator);
  msgEl.appendChild(avatar);
  msgEl.appendChild(body);

  elements.messagesContainer.appendChild(msgEl);
  scrollToBottom();

  thinkingStartTime = Date.now();
  thinkingInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - thinkingStartTime) / 1000);
    const timer = document.getElementById('thinking-timer');
    if (timer) timer.textContent = 'Thinking... ' + elapsed + 's';
  }, 1000);
}

function removeThinkingIndicator() {
  if (thinkingInterval) { clearInterval(thinkingInterval); thinkingInterval = null; }
  thinkingStartTime = null;
  const el = document.getElementById('thinking-indicator');
  if (el) el.remove();
}

// ============================================
// Streaming
// ============================================

let streamBuffer = '';
let streamMessageEl = null;

async function sendMessage() {
  const message = elements.messageInput.value.trim();
  if (!message || state.isStreaming) return;

  if (!state.activeSessionId) createNewSession();

  const session = state.sessions.find(s => s.id === state.activeSessionId);
  if (!session) return;

  if (!state.workingDir) {
    await selectFolder();
    if (!state.workingDir) return;
  }

  let fullMessage = message;
  if (state.messageCount === 0) {
    let prefix = '';
    if (state.folderInstructions) {
      prefix += `[Project Instructions from GEMINI.md]:\n${state.folderInstructions}\n\n`;
    }
    if (state.settings.instructions) {
      prefix += `[System Instructions: ${state.settings.instructions}]\n\n`;
    }
    if (prefix) fullMessage = prefix + message;
  }

  // Copy attached files into working directory and reference by relative path
  let copiedFiles = [];
  if (state.attachedFiles.length > 0) {
    copiedFiles = await geminiAPI.copyToWorkDir(state.attachedFiles, state.workingDir);
    if (copiedFiles.length > 0) {
      const refs = copiedFiles.map(f => {
        const rel = '.gemini-attachments/' + f.filename;
        return rel.includes(' ') ? `@"${rel}"` : `@${rel}`;
      }).join(' ');
      fullMessage += ' ' + refs;
    }
  }

  const displayMessage = state.attachedFiles.length > 0
    ? message + '\n\n' + state.attachedFiles.map(f => '\uD83D\uDCCE ' + f.split(/[/\\]/).pop()).join(', ')
    : message;

  session.messages.push({ role: 'user', content: displayMessage });
  appendMessageToDOM('user', displayMessage);

  // Clear attached files after sending
  state.attachedFiles = [];
  renderAttachedFiles();

  if (session.messages.filter(m => m.role === 'user').length === 1) {
    session.title = message.length > 40 ? message.substring(0, 40) + '...' : message;
    renderSessions();
  }

  elements.messageInput.value = '';
  autoResizeTextarea(elements.messageInput);
  elements.btnSend.disabled = true;

  startStreaming();
  addThinkingIndicator();

  const options = {
    apiKey: state.settings.apiKey || undefined,
    model: state.settings.model || undefined,
    approvalMode: state.settings.approvalMode || 'auto_edit',
    sandbox: state.settings.sandbox,
    resume: state.messageCount > 0
  };

  state.messageCount++;

  try {
    await geminiAPI.sendMessage({
      message: fullMessage,
      workingDir: state.workingDir,
      options
    });
  } catch (err) {
    removeThinkingIndicator();
    finishStreaming();
    appendStatusMessage('Error: ' + err.message, 'error');
  }

  saveState();
}

function startStreaming() {
  state.isStreaming = true;
  streamBuffer = '';
  streamMessageEl = null;
  elements.btnCancelTask.style.display = 'flex';
  elements.btnSend.disabled = true;
}

function finishStreaming() {
  state.isStreaming = false;
  elements.btnCancelTask.style.display = 'none';
  elements.btnSend.disabled = !elements.messageInput.value.trim();

  if (streamMessageEl) {
    const cursor = streamMessageEl.querySelector('.streaming-cursor');
    if (cursor) cursor.remove();
  }

  streamMessageEl = null;
}

function handleStreamEvent(event) {
  switch (event.type) {
    // stream-json: session initialization
    case 'init': {
      if (event.model) {
        elements.modelBadge.textContent = event.model;
      }
      break;
    }

    // stream-json: assistant or user message chunk
    case 'message': {
      if (event.role !== 'assistant') break;
      removeThinkingIndicator();

      const text = event.content || '';
      if (!text && !streamBuffer) break;

      streamBuffer += text;

      if (!streamMessageEl) {
        streamMessageEl = appendMessageToDOM('assistant', '');
      }

      const contentEl = streamMessageEl.querySelector('.message-content');
      const sanitizedHtml = geminiAPI.parseMarkdown(streamBuffer);
      contentEl.innerHTML = sanitizedHtml;

      const cursor = createEl('span', 'streaming-cursor');
      contentEl.appendChild(cursor);

      scrollToBottom();
      break;
    }

    // stream-json: tool invocation (expandable)
    case 'tool_use': {
      removeThinkingIndicator();
      if (!streamMessageEl) {
        streamMessageEl = appendMessageToDOM('assistant', '');
      }
      const contentEl = streamMessageEl.querySelector('.message-content');
      const toolName = event.tool_name || 'tool';
      const wrapper = createEl('div', 'tool-detail');
      wrapper.id = 'tool-' + (event.tool_id || '');
      const header = createEl('div', 'tool-detail-header');
      const arrow = createEl('span', 'tool-detail-arrow', '\u25B6');
      const labelText = toolName + (event.parameters && event.parameters.command ? ': ' + event.parameters.command : event.parameters && event.parameters.file_path ? ': ' + event.parameters.file_path : '');
      const labelSpan = createEl('span', null, labelText);
      header.appendChild(arrow);
      header.appendChild(labelSpan);
      wrapper.appendChild(header);
      const body = createEl('div', 'tool-detail-body');
      if (event.parameters) {
        const params = createEl('pre', 'tool-detail-params', JSON.stringify(event.parameters, null, 2));
        body.appendChild(params);
      }
      wrapper.appendChild(body);
      header.addEventListener('click', () => wrapper.classList.toggle('expanded'));
      contentEl.appendChild(wrapper);
      scrollToBottom();
      break;
    }

    // stream-json: tool result
    case 'tool_result': {
      const toolEl = document.getElementById('tool-' + (event.tool_id || ''));
      if (toolEl) {
        toolEl.classList.add(event.status === 'success' ? 'tool-success' : 'tool-error');
        if (event.output) {
          const body = toolEl.querySelector('.tool-detail-body');
          if (body) {
            const output = createEl('div', null, event.output);
            output.style.marginTop = '4px';
            output.style.color = 'var(--text-secondary)';
            body.appendChild(output);
          }
        }
      }
      break;
    }

    // stream-json: final result with stats
    case 'result': {
      if (event.stats && streamMessageEl) {
        const s = event.stats;
        const fmt = (n) => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
        const parts = [];
        if (s.input_tokens) parts.push('\u2191' + fmt(s.input_tokens));
        if (s.output_tokens) parts.push('\u2193' + fmt(s.output_tokens));
        if (s.cached) parts.push('\u26A1' + fmt(s.cached) + ' cached');
        if (s.duration_ms) parts.push((s.duration_ms / 1000).toFixed(1) + 's');
        if (s.tool_calls) parts.push(s.tool_calls + ' tool' + (s.tool_calls > 1 ? 's' : ''));
        const statsEl = createEl('div', 'message-stats', parts.join(' \u00B7 '));
        streamMessageEl.parentNode.insertBefore(statsEl, streamMessageEl.nextSibling);
      }
      break;
    }

    // Fallback: raw text (non-JSON output)
    case 'text': {
      removeThinkingIndicator();
      let text = stripAnsi(event.content);
      if (!text.trim() && !streamBuffer) break;
      streamBuffer += text;

      if (!streamMessageEl) {
        streamMessageEl = appendMessageToDOM('assistant', '');
      }
      const contentEl = streamMessageEl.querySelector('.message-content');
      const sanitizedHtml = geminiAPI.parseMarkdown(streamBuffer);
      contentEl.innerHTML = sanitizedHtml;
      const cursor = createEl('span', 'streaming-cursor');
      contentEl.appendChild(cursor);
      scrollToBottom();
      break;
    }

    // Process exit
    case 'done': {
      removeThinkingIndicator();
      finishStreaming();
      // Clean up copied attachment files
      if (state.workingDir) {
        geminiAPI.cleanAttachments(state.workingDir).catch(() => {});
      }

      if (streamBuffer.trim()) {
        const session = state.sessions.find(s => s.id === state.activeSessionId);
        if (session) {
          session.messages.push({ role: 'assistant', content: streamBuffer });
          saveState();
        }
        // Desktop notification when window isn't focused
        if (!document.hasFocus()) {
          try {
            new Notification('Gemini Cowork', {
              body: 'Task completed',
              silent: false
            });
          } catch (e) { /* notifications may not be supported */ }
        }
      } else if (event.code !== 0) {
        const errText = event.error || '';
        if (errText.includes('IneligibleTier') || errText.includes('not eligible')) {
          appendStatusMessage(
            'Authentication error: Your Google account is not eligible for free tier. ' +
            'Please set a Gemini API key in Settings. Get one free at aistudio.google.com/apikey',
            'error'
          );
        } else if (errText.includes('GEMINI_API_KEY') || errText.includes('API key')) {
          appendStatusMessage('Invalid API key. Check your API key in Settings.', 'error');
        } else if (errText.includes('not found') || errText.includes('ENOENT')) {
          appendStatusMessage('Gemini CLI not found. Install it: npm i -g @google/gemini-cli', 'error');
        } else {
          appendStatusMessage('Gemini process failed (exit code ' + event.code + '). Check Settings or try again.', 'error');
        }
      }
      break;
    }

    case 'error': {
      removeThinkingIndicator();
      finishStreaming();
      appendStatusMessage('Error: ' + event.content, 'error');
      break;
    }
  }
}

function appendStatusMessage(text, type = 'info') {
  const el = createEl('div', `status-message ${type}`, text);
  elements.messagesContainer.appendChild(el);
  scrollToBottom();
}

// ============================================
// Auth Status
// ============================================

async function checkAuthStatus() {
  try {
    const authType = await geminiAPI.getAuthType();
    updateAuthStatus(authType);
  } catch (e) {
    updateAuthStatus(null);
  }
}

function updateAuthStatus(authType) {
  if (state.settings.apiKey) {
    elements.authDot.className = 'auth-dot connected';
    elements.authStatusText.textContent = 'Using API Key';
  } else if (authType === 'oauth-personal') {
    elements.authDot.className = 'auth-dot connected';
    elements.authStatusText.textContent = 'Google Account (OAuth)';
  } else {
    elements.authDot.className = 'auth-dot disconnected';
    elements.authStatusText.textContent = 'Not configured';
  }
}

// ============================================
// Settings
// ============================================

function applySettings() {
  elements.settingApiKey.value = state.settings.apiKey;
  elements.settingModel.value = state.settings.model;
  elements.settingApproval.value = state.settings.approvalMode;
  elements.settingSandbox.checked = state.settings.sandbox;
  elements.settingInstructions.value = state.settings.instructions;
  updateModelSelectLabel();
}

// ============================================
// Attached Files
// ============================================

function renderAttachedFiles() {
  elements.attachedFiles.textContent = '';
  if (state.attachedFiles.length === 0) {
    elements.attachedFiles.style.display = 'none';
    return;
  }
  elements.attachedFiles.style.display = 'flex';
  state.attachedFiles.forEach((filePath, idx) => {
    const chip = createEl('div', 'attached-file');
    const icon = createEl('span', null, '\uD83D\uDCCE');
    const name = createEl('span', 'attached-file-name', filePath.split(/[/\\]/).pop());
    name.title = filePath;
    const removeBtn = createEl('button', 'attached-file-remove', '\u00d7');
    removeBtn.addEventListener('click', () => {
      state.attachedFiles.splice(idx, 1);
      renderAttachedFiles();
    });
    chip.appendChild(icon);
    chip.appendChild(name);
    chip.appendChild(removeBtn);
    elements.attachedFiles.appendChild(chip);
  });
}

// ============================================
// Model Selector
// ============================================

function updateModelSelectLabel() {
  const model = state.settings.model;
  if (!model) {
    elements.modelSelectLabel.textContent = 'Auto';
  } else {
    // Shorten the label
    const labels = {
      'gemini-3.1-pro-preview': '3.1 Pro',
      'gemini-3.0-flash': '3 Flash',
      'gemini-3.1-flash-lite': '3.1 Flash Lite',
      'gemini-2.5-pro': '2.5 Pro',
      'gemini-2.5-flash': '2.5 Flash',
      'gemini-2.0-flash': '2.0 Flash'
    };
    elements.modelSelectLabel.textContent = labels[model] || model;
  }
}

function updateModelDropdownActive() {
  elements.modelDropdown.querySelectorAll('.model-option').forEach(opt => {
    opt.classList.toggle('active', opt.dataset.model === (state.settings.model || ''));
  });
}

async function saveSettings() {
  const oldApiKey = state.settings.apiKey;
  state.settings.apiKey = elements.settingApiKey.value.trim();
  state.settings.model = elements.settingModel.value;
  state.settings.approvalMode = elements.settingApproval.value;
  state.settings.sandbox = elements.settingSandbox.checked;
  state.settings.instructions = elements.settingInstructions.value;
  updateModelBadge();
  saveState();

  // Switch Gemini CLI auth type based on API key
  if (state.settings.apiKey && !oldApiKey) {
    await geminiAPI.setAuthType('gemini-api-key');
  } else if (!state.settings.apiKey && oldApiKey) {
    await geminiAPI.setAuthType('oauth-personal');
  }

  checkAuthStatus();
}

// ============================================
// Utilities
// ============================================

function scrollToBottom() {
  requestAnimationFrame(() => {
    elements.messagesArea.scrollTop = elements.messagesArea.scrollHeight;
  });
}

function autoResizeTextarea(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
}

function stripAnsi(text) {
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
             .replace(/\r/g, '');
}

// ============================================
// Start
// ============================================

init();
})();
