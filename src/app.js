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
  attachedFiles: []
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
  modelDropdown: $('#model-dropdown')
};

// ============================================
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

  geminiAPI.onStream(handleStreamEvent);
}

// ============================================
// Folder Management
// ============================================

async function selectFolder() {
  const folder = await geminiAPI.selectFolder();
  if (folder) {
    state.workingDir = folder;
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
    isResume: false
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

  if (state.sessions.length === 0) {
    const empty = createEl('div', 'sessions-empty', 'No sessions yet');
    elements.sessionsList.appendChild(empty);
    return;
  }

  state.sessions.forEach(session => {
    const btn = createEl('button', `session-item${session.id === state.activeSessionId ? ' active' : ''}`);
    btn.dataset.id = session.id;

    const dot = createEl('span', 'session-dot');
    const label = createEl('span', 'session-label', session.title);
    const deleteBtn = createEl('span', 'session-delete', '\u00d7');
    deleteBtn.title = 'Delete session';

    btn.appendChild(dot);
    btn.appendChild(label);
    btn.appendChild(deleteBtn);
    btn.addEventListener('click', (e) => {
      if (e.target.closest('.session-delete')) {
        deleteSession(session.id);
      } else {
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
  indicator.appendChild(createEl('span', null, 'Thinking...'));

  body.appendChild(roleLabel);
  body.appendChild(indicator);
  msgEl.appendChild(avatar);
  msgEl.appendChild(body);

  elements.messagesContainer.appendChild(msgEl);
  scrollToBottom();
}

function removeThinkingIndicator() {
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
  if (state.settings.instructions && state.messageCount === 0) {
    fullMessage = `[System Instructions: ${state.settings.instructions}]\n\n${message}`;
  }

  // Append attached file references to the prompt
  if (state.attachedFiles.length > 0) {
    const fileList = state.attachedFiles.map(f => f).join('\n');
    fullMessage += `\n\n[Attached files - read these files to fulfill the request]:\n${fileList}`;
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

    // stream-json: tool invocation
    case 'tool_use': {
      removeThinkingIndicator();
      if (!streamMessageEl) {
        streamMessageEl = appendMessageToDOM('assistant', '');
      }
      const contentEl = streamMessageEl.querySelector('.message-content');
      const label = event.tool_name || 'tool';
      const activity = createEl('div', 'tool-activity');
      activity.id = 'tool-' + (event.tool_id || '');
      activity.textContent = label + (event.parameters && event.parameters.command ? ': ' + event.parameters.command : '');
      contentEl.appendChild(activity);
      scrollToBottom();
      break;
    }

    // stream-json: tool result
    case 'tool_result': {
      const activityEl = document.getElementById('tool-' + (event.tool_id || ''));
      if (activityEl) {
        activityEl.classList.add(event.status === 'success' ? 'tool-success' : 'tool-error');
        if (event.output) {
          activityEl.textContent += ' — ' + event.output;
        }
      }
      break;
    }

    // stream-json: final result with stats
    case 'result': {
      // Stats are available in event.stats if needed
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

      if (streamBuffer.trim()) {
        const session = state.sessions.find(s => s.id === state.activeSessionId);
        if (session) {
          session.messages.push({ role: 'assistant', content: streamBuffer });
          saveState();
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
