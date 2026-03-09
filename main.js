const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const GEMINI_SETTINGS_PATH = path.join(os.homedir(), '.gemini', 'settings.json');

// Enable CDP remote debugging for Playwright/automation (Electron 30+ requires this approach)
if (process.argv.includes('--dev')) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222');
}

let mainWindow;
let tray = null;
let minimizeToTray = false;
let activeProcess = null;
let acpProcess = null;
let acpMessageId = 1;
let acpSessionId = null;
let acpPendingResolves = {};
let acpPermissionRequestIds = {};
let acpCancelled = false;
let acpReadyPromise = null;
let acpHasSession = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    icon: path.join(__dirname, 'build', 'icon.png'),
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  // Open DevTools in dev mode
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('maximize', () => {
    mainWindow.webContents.send('window:maximized', true);
  });
  mainWindow.on('unmaximize', () => {
    mainWindow.webContents.send('window:maximized', false);
  });

  // Intercept close to minimize to tray when enabled
  mainWindow.on('close', (e) => {
    if (minimizeToTray && !app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  if (tray) return;
  const icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('GeminUI');
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show', click: () => { mainWindow.show(); mainWindow.focus(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => { mainWindow.show(); mainWindow.focus(); });
}

function destroyTray() {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

app.whenReady().then(createWindow);

app.on('before-quit', () => {
  app.isQuitting = true;
});

app.on('window-all-closed', () => {
  if (acpProcess) {
    acpProcess.kill();
  }
  if (activeProcess) {
    activeProcess.kill();
  }
  app.quit();
});

// Window controls
ipcMain.handle('window:minimize', () => mainWindow.minimize());
ipcMain.handle('window:maximize', () => {
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
});
ipcMain.handle('window:close', () => mainWindow.close());
ipcMain.handle('window:isMaximized', () => mainWindow.isMaximized());

// Launch on startup
ipcMain.handle('app:setAutoLaunch', (_, enabled) => {
  app.setLoginItemSettings({ openAtLogin: enabled });
  return true;
});
ipcMain.handle('app:getAutoLaunch', () => {
  return app.getLoginItemSettings().openAtLogin;
});

// Minimize to tray
ipcMain.handle('app:setMinimizeToTray', (_, enabled) => {
  minimizeToTray = enabled;
  if (enabled) {
    createTray();
  } else {
    destroyTray();
  }
  return true;
});
ipcMain.handle('app:getMinimizeToTray', () => {
  return minimizeToTray;
});

// Folder selection
ipcMain.handle('dialog:selectFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Working Folder'
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

// File selection
ipcMain.handle('dialog:selectFiles', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    title: 'Attach Files'
  });
  if (result.canceled) return [];
  return result.filePaths;
});

// Open folder in explorer or URL in browser
ipcMain.handle('shell:openFolder', async (_, pathOrUrl) => {
  if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) {
    shell.openExternal(pathOrUrl);
  } else {
    shell.openPath(pathOrUrl);
  }
});

// Read folder-specific instructions (GEMINI.md)
ipcMain.handle('gemini:readFolderInstructions', async (_, workingDir) => {
  try {
    const filePath = path.join(workingDir, 'GEMINI.md');
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8');
    }
  } catch (e) { /* ignore */ }
  return null;
});

// Check if Gemini CLI is installed
ipcMain.handle('gemini:checkInstalled', async () => {
  // gemini --version hangs on Windows, so use 'where' to check existence
  // then read the package.json for the actual version
  return new Promise((resolve) => {
    const proc = spawn('where', ['gemini'], { shell: true });
    let output = '';
    proc.stdout.on('data', (data) => { output += data.toString(); });
    proc.on('close', (code) => {
      if (code !== 0 || !output.trim()) {
        resolve(null);
        return;
      }
      // Try to read version from the globally installed package
      try {
        const npmGlobal = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@anthropic-ai', 'gemini-cli', 'package.json');
        const npmGlobal2 = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'package.json');
        const geminiPkg = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@google', 'gemini-cli', 'package.json');
        for (const pkgPath of [geminiPkg, npmGlobal, npmGlobal2]) {
          if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
            resolve(pkg.version || 'installed');
            return;
          }
        }
      } catch (e) { /* ignore */ }
      resolve('installed');
    });
    proc.on('error', () => resolve(null));
  });
});

// ACP helpers: send JSON-RPC request and wait for response
function sendACPRequest(method, params) {
  return new Promise((resolve, reject) => {
    if (!acpProcess || !acpProcess.stdin.writable) {
      return reject(new Error('ACP process not running'));
    }
    const id = acpMessageId++;
    acpPendingResolves[id] = { resolve, reject };
    acpProcess.stdin.write(JSON.stringify({
      jsonrpc: '2.0', method, id, params
    }) + '\n');
  });
}

// Handle a parsed JSON-RPC message from ACP stdout
function handleACPMessage(msg) {
  // JSON-RPC response to our request (has id, no method)
  if (msg.id !== undefined && !msg.method) {
    const pending = acpPendingResolves[msg.id];
    if (pending) {
      delete acpPendingResolves[msg.id];
      if (msg.error) {
        pending.reject(new Error(msg.error.message || 'ACP error'));
      } else {
        pending.resolve(msg.result);
      }
    }
    return;
  }

  // Notification: session/update
  if (msg.method === 'session/update' && msg.params) {
    const update = msg.params.update;
    if (!update) return;

    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (update.content && update.content.text) {
          mainWindow.webContents.send('gemini:stream', {
            type: 'message', role: 'assistant', content: update.content.text
          });
        }
        break;
      case 'agent_thought_chunk':
        if (update.content && update.content.text) {
          mainWindow.webContents.send('gemini:stream', {
            type: 'message', role: 'assistant', content: update.content.text
          });
        }
        break;
      case 'tool_call':
        mainWindow.webContents.send('gemini:stream', {
          type: 'tool_use',
          tool_id: update.toolCallId,
          tool_name: update.title || update.kind || 'tool',
          parameters: update.content ? { detail: update.content } : {}
        });
        break;
      case 'tool_call_update':
        if (update.status === 'completed' || update.status === 'error') {
          mainWindow.webContents.send('gemini:stream', {
            type: 'tool_result',
            tool_id: update.toolCallId,
            status: update.status === 'completed' ? 'success' : 'error',
            output: update.content ? JSON.stringify(update.content) : ''
          });
        }
        break;
    }
    return;
  }

  // Agent request: permission needed
  if ((msg.method === 'client/requestPermission' || msg.method === 'session/request_permission') && msg.params) {
    const { toolCall, options } = msg.params;
    if (toolCall) {
      acpPermissionRequestIds[toolCall.toolCallId] = msg.id;
      mainWindow.webContents.send('gemini:stream', {
        type: 'permission_request',
        tool_id: toolCall.toolCallId,
        tool_name: toolCall.title || toolCall.kind || 'tool',
        parameters: toolCall.content,
        options: options
      });
    }
    return;
  }
}

// ACP mode: spawn process and run initialize (the slow part)
async function spawnACPProcess(options) {
  const cmdParts = ['gemini', '--experimental-acp'];
  if (options.model) cmdParts.push('-m', options.model);
  if (options.sandbox) cmdParts.push('-s');
  if (!options.subagents) cmdParts.push('--allowed-mcp-server-names', 'none');

  const env = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' };
  if (options.apiKey) env.GEMINI_API_KEY = options.apiKey;
  acpCancelled = false;

  acpProcess = spawn(cmdParts[0], cmdParts.slice(1), {
    shell: true,
    env
  });

  let lineBuffer = '';
  acpProcess.stdout.on('data', (data) => {
    lineBuffer += data.toString();
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        handleACPMessage(msg);
      } catch (e) {
        if (mainWindow) mainWindow.webContents.send('gemini:stream', { type: 'text', content: line });
      }
    }
  });

  let stderrBuffer = '';
  acpProcess.stderr.on('data', (data) => { stderrBuffer += data.toString(); });

  acpProcess.on('close', (code) => {
    const wasCancelled = acpCancelled;
    const hadSession = acpHasSession;
    for (const id of Object.keys(acpPendingResolves)) {
      acpPendingResolves[id].reject(new Error('ACP process exited with code ' + code));
    }
    acpProcess = null;
    acpSessionId = null;
    acpMessageId = 1;
    acpPendingResolves = {};
    acpPermissionRequestIds = {};
    acpCancelled = false;
    acpReadyPromise = null;
    acpHasSession = false;
    // Only notify renderer if there was an active session (not a background preload crash)
    if (!wasCancelled && hadSession && mainWindow) {
      mainWindow.webContents.send('gemini:stream', { type: 'done', code, error: stderrBuffer || 'ACP process exited' });
    }
  });

  acpProcess.on('error', (err) => {
    const hadSession = acpHasSession;
    acpProcess = null;
    acpSessionId = null;
    acpMessageId = 1;
    acpPendingResolves = {};
    acpPermissionRequestIds = {};
    acpReadyPromise = null;
    acpHasSession = false;
    if (hadSession && mainWindow) mainWindow.webContents.send('gemini:stream', { type: 'error', content: err.message });
  });

  // Wait for process to be ready before sending init
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Initialize with correct ACP protocol
  await sendACPRequest('initialize', {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false
    },
    clientInfo: { name: 'geminui', version: '1.0.0' }
  });
}

// Create ACP session (fast, called before first message)
async function ensureACPSession(workingDir) {
  if (acpSessionId) return;
  const sessionResult = await sendACPRequest('session/new', {
    cwd: workingDir || process.cwd(),
    mcpServers: []
  });
  acpSessionId = sessionResult.sessionId;
  acpHasSession = true;
}

// Preload ACP process in background (spawn + init + session)
ipcMain.handle('gemini:preloadACP', async (_, options) => {
  if (acpProcess || acpReadyPromise) return;
  acpReadyPromise = spawnACPProcess(options).then(async () => {
    // Pre-create session so first message is instant
    await ensureACPSession(options.workingDir || process.cwd());
    acpReadyPromise = null;
    if (mainWindow) mainWindow.webContents.send('gemini:ready');
  }).catch(() => {
    acpReadyPromise = null;
  });
});

// Send message to Gemini CLI
ipcMain.handle('gemini:sendMessage', async (event, { message, workingDir, options }) => {
  // ACP mode: bidirectional communication via stdin/stdout
  if (options.useACP) {
    try {
      // Wait for preload if in-flight, or spawn fresh
      if (acpReadyPromise) {
        await acpReadyPromise;
      }
      if (!acpProcess) {
        await spawnACPProcess(options);
      }
      await ensureACPSession(workingDir);

      const promptContent = [];
      if (options.imageAttachments && options.imageAttachments.length > 0) {
        promptContent.push({ type: 'text', text: message });
        for (const img of options.imageAttachments) {
          promptContent.push({
            type: 'image',
            data: img.data,
            mimeType: img.mediaType
          });
        }
      } else {
        promptContent.push({ type: 'text', text: message });
      }

      // Send prompt — don't await; responses stream via session/update notifications
      sendACPRequest('session/prompt', {
        sessionId: acpSessionId,
        prompt: promptContent
      }).then(() => {
        // session/prompt resolves when the turn is complete
        mainWindow.webContents.send('gemini:stream', { type: 'result', stats: {} });
        mainWindow.webContents.send('gemini:stream', { type: 'done', code: 0, error: '' });
      }).catch((err) => {
        mainWindow.webContents.send('gemini:stream', { type: 'error', content: err.message });
        mainWindow.webContents.send('gemini:stream', { type: 'done', code: 1, error: err.message });
      });

      return { output: '', error: '', code: 0 };
    } catch (err) {
      return { output: '', error: err.message, code: 1 };
    }
  }

  // Non-ACP mode: kill any existing process
  if (activeProcess) {
    activeProcess.kill();
    activeProcess = null;
  }

  // Build command string for Windows shell execution
  // (Node.js spawn with shell:true on Windows has quoting issues with .cmd files)
  const cmdParts = ['gemini'];

  // Quote the message to handle special characters
  // Replace newlines with spaces — cmd.exe breaks on literal newlines in quoted strings
  const escapedMessage = message.replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ');
  cmdParts.push('-p', `"${escapedMessage}"`);

  // Use structured JSON output for reliable parsing
  cmdParts.push('-o', 'stream-json');

  // Skip MCP servers to reduce startup time (~15s faster), unless subagents need them
  if (!options.subagents) {
    cmdParts.push('--allowed-mcp-server-names', 'none');
  }

  // Resume previous session for follow-up messages
  if (options.sessionIndex != null) {
    cmdParts.push('--resume', String(options.sessionIndex));
  } else if (options.resume) {
    cmdParts.push('--resume', 'latest');
  }

  // Model selection
  if (options.model) {
    cmdParts.push('-m', options.model);
  }

  // Approval mode
  if (options.approvalMode) {
    cmdParts.push('--approval-mode', options.approvalMode === 'default' ? 'yolo' : options.approvalMode);
  } else {
    cmdParts.push('--approval-mode', 'yolo');
  }

  // Sandbox mode
  if (options.sandbox) {
    cmdParts.push('-s');
  }

  const fullCommand = cmdParts.join(' ');

  // Build environment with API key if provided
  const env = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' };
  if (options.apiKey) {
    env.GEMINI_API_KEY = options.apiKey;
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(fullCommand, [], {
      cwd: workingDir || undefined,
      shell: true,
      env
    });

    activeProcess = proc;
    let fullOutput = '';
    let errorOutput = '';
    let lineBuffer = '';

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      fullOutput += text;

      // Parse newline-delimited JSON (stream-json format)
      lineBuffer += text;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop(); // Keep incomplete last line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          mainWindow.webContents.send('gemini:stream', event);
        } catch (e) {
          // Fallback for non-JSON output
          mainWindow.webContents.send('gemini:stream', { type: 'text', content: line });
        }
      }
    });

    proc.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    proc.on('close', (code) => {
      activeProcess = null;
      // Flush remaining buffer
      if (lineBuffer.trim()) {
        try {
          const event = JSON.parse(lineBuffer);
          mainWindow.webContents.send('gemini:stream', event);
        } catch (e) {
          mainWindow.webContents.send('gemini:stream', { type: 'text', content: lineBuffer });
        }
      }
      mainWindow.webContents.send('gemini:stream', { type: 'done', code, error: errorOutput });
      resolve({ output: fullOutput, error: errorOutput, code });
    });

    proc.on('error', (err) => {
      activeProcess = null;
      mainWindow.webContents.send('gemini:stream', { type: 'error', content: err.message });
      reject(err);
    });
  });
});

// Reset ACP session for new chat (keeps process alive, pre-creates new session)
ipcMain.handle('gemini:resetSession', async (_, workingDir) => {
  acpSessionId = null;
  acpHasSession = false;
  // Pre-create new session immediately so next message is instant
  if (acpProcess) {
    try {
      await ensureACPSession(workingDir || process.cwd());
    } catch (e) { /* session will be created on next message */ }
  }
  return true;
});

// Cancel active Gemini process
ipcMain.handle('gemini:cancel', () => {
  if (acpProcess) {
    acpCancelled = true;
    // Clear pending resolves without rejecting (prevents error cascades)
    acpPendingResolves = {};
    // Send single clean done event
    mainWindow.webContents.send('gemini:stream', { type: 'done', code: 0, error: '' });
    // Kill process tree on Windows
    try { spawn('taskkill', ['/PID', String(acpProcess.pid), '/T', '/F'], { shell: true }); } catch (e) {}
    acpProcess = null;
    acpSessionId = null;
    acpMessageId = 1;
    acpPendingResolves = {};
    acpPermissionRequestIds = {};
    acpReadyPromise = null;
    acpHasSession = false;
    return true;
  }
  if (activeProcess) {
    activeProcess.kill('SIGTERM');
    activeProcess = null;
    return true;
  }
  return false;
});

// Write to stdin of active process
ipcMain.handle('gemini:writeStdin', (_, text) => {
  if (activeProcess && activeProcess.stdin.writable) {
    activeProcess.stdin.write(text);
    return true;
  }
  return false;
});

// Launch Google OAuth login flow via a terminal window
ipcMain.handle('gemini:googleLogin', async () => {
  // Open a terminal window running `gemini` which triggers the OAuth browser flow
  // The user completes login in the browser, then closes the terminal
  const proc = spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', 'echo Gemini Google Login - Complete the login in your browser, then type exit to close this window. && gemini'], {
    shell: false,
    detached: true,
    stdio: 'ignore'
  });
  proc.unref();

  // Switch auth type to oauth-personal
  try {
    let settings = {};
    if (fs.existsSync(GEMINI_SETTINGS_PATH)) {
      settings = JSON.parse(fs.readFileSync(GEMINI_SETTINGS_PATH, 'utf-8'));
    }
    if (!settings.security) settings.security = {};
    if (!settings.security.auth) settings.security.auth = {};
    settings.security.auth.selectedType = 'oauth-personal';
    fs.writeFileSync(GEMINI_SETTINGS_PATH, JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error('Failed to update auth settings:', e);
  }

  return true;
});

// Check current auth status
ipcMain.handle('gemini:getAuthType', async () => {
  try {
    if (fs.existsSync(GEMINI_SETTINGS_PATH)) {
      const settings = JSON.parse(fs.readFileSync(GEMINI_SETTINGS_PATH, 'utf-8'));
      return settings?.security?.auth?.selectedType || 'oauth-personal';
    }
  } catch (e) { /* ignore */ }
  return 'oauth-personal';
});

// Configure Gemini CLI auth settings
ipcMain.handle('gemini:setAuthType', async (_, authType) => {
  try {
    let settings = {};
    if (fs.existsSync(GEMINI_SETTINGS_PATH)) {
      settings = JSON.parse(fs.readFileSync(GEMINI_SETTINGS_PATH, 'utf-8'));
    }
    if (!settings.security) settings.security = {};
    if (!settings.security.auth) settings.security.auth = {};
    settings.security.auth.selectedType = authType;
    fs.writeFileSync(GEMINI_SETTINGS_PATH, JSON.stringify(settings, null, 2));
    return true;
  } catch (e) {
    console.error('Failed to update Gemini settings:', e);
    return false;
  }
});

// List Gemini sessions for a directory
ipcMain.handle('gemini:listSessions', async (_, workingDir) => {
  return new Promise((resolve) => {
    const proc = spawn('gemini', ['--list-sessions'], {
      cwd: workingDir || undefined,
      shell: true,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }
    });
    let output = '';
    proc.stdout.on('data', (data) => { output += data.toString(); });
    proc.stderr.on('data', (data) => { output += data.toString(); });
    proc.on('close', () => resolve(output.trim()));
    proc.on('error', () => resolve(''));
  });
});

// Copy attached files into working directory, return list of { original, dest, filename }
ipcMain.handle('files:copyToWorkDir', async (_, { files, workingDir }) => {
  const attachDir = path.join(workingDir, '.gemini-attachments');
  if (!fs.existsSync(attachDir)) {
    fs.mkdirSync(attachDir, { recursive: true });
  }
  // Override parent .gitignore so the @ processor can read all file types
  const localGitignore = path.join(attachDir, '.gitignore');
  if (!fs.existsSync(localGitignore)) {
    fs.writeFileSync(localGitignore, '# Allow all files for Gemini CLI @ references\n!*\n');
  }
  const results = [];
  for (const filePath of files) {
    const filename = path.basename(filePath);
    const dest = path.join(attachDir, filename);
    try {
      fs.copyFileSync(filePath, dest);
      results.push({ original: filePath, dest, filename });
    } catch (e) {
      console.error('Failed to copy attached file:', e);
    }
  }
  return results;
});

// Clean up copied attachment files
ipcMain.handle('files:cleanAttachments', async (_, workingDir) => {
  const attachDir = path.join(workingDir, '.gemini-attachments');
  try {
    if (fs.existsSync(attachDir)) {
      fs.rmSync(attachDir, { recursive: true, force: true });
    }
  } catch (e) {
    console.error('Failed to clean attachments:', e);
  }
});

// Read file as base64 (for ACP image attachments)
ipcMain.handle('files:readAsBase64', async (_, filePath) => {
  try {
    const ext = path.extname(filePath).toLowerCase();
    const mediaTypes = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp'
    };
    const mediaType = mediaTypes[ext];
    if (!mediaType) return null;
    const data = fs.readFileSync(filePath).toString('base64');
    return { data, mediaType };
  } catch (e) {
    return null;
  }
});

// Get subagents setting from ~/.gemini/settings.json
ipcMain.handle('gemini:getSubagents', async () => {
  try {
    if (fs.existsSync(GEMINI_SETTINGS_PATH)) {
      const settings = JSON.parse(fs.readFileSync(GEMINI_SETTINGS_PATH, 'utf-8'));
      return settings?.experimental?.enableAgents || false;
    }
  } catch (e) { /* ignore */ }
  return false;
});

// Set subagents setting in ~/.gemini/settings.json
ipcMain.handle('gemini:setSubagents', async (_, enabled) => {
  try {
    let settings = {};
    if (fs.existsSync(GEMINI_SETTINGS_PATH)) {
      settings = JSON.parse(fs.readFileSync(GEMINI_SETTINGS_PATH, 'utf-8'));
    }
    if (!settings.experimental) settings.experimental = {};
    settings.experimental.enableAgents = enabled;
    fs.writeFileSync(GEMINI_SETTINGS_PATH, JSON.stringify(settings, null, 2));
    return true;
  } catch (e) {
    console.error('Failed to update subagents setting:', e);
    return false;
  }
});

// ACP permission response — respond to agent's client/requestPermission request
ipcMain.handle('gemini:respondPermission', (_, { toolId, outcome }) => {
  if (!acpProcess || !acpProcess.stdin.writable) return false;

  const requestId = acpPermissionRequestIds[toolId];
  if (requestId === undefined) return false;
  delete acpPermissionRequestIds[toolId];

  let acpOutcome;
  if (outcome === 'denied') {
    acpOutcome = { outcome: 'cancelled' };
  } else {
    const optionId = outcome === 'approved_for_session' ? 'proceed_always' : 'proceed_once';
    acpOutcome = { outcome: 'selected', optionId };
  }

  acpProcess.stdin.write(JSON.stringify({
    jsonrpc: '2.0', id: requestId,
    result: { outcome: acpOutcome }
  }) + '\n');
  return true;
});

// Extension management
let extensionsCache = null;
let extensionsCacheTime = 0;

ipcMain.handle('gemini:fetchExtensions', async () => {
  if (extensionsCache && (Date.now() - extensionsCacheTime) < 300000) {
    return extensionsCache;
  }
  try {
    const response = await fetch('https://geminicli.com/extensions.json');
    extensionsCache = await response.json();
    extensionsCacheTime = Date.now();
    return extensionsCache;
  } catch (e) {
    console.error('Failed to fetch extensions:', e);
    return null;
  }
});

ipcMain.handle('gemini:installExtension', async (_, name) => {
  return new Promise((resolve) => {
    const proc = spawn('gemini', ['extension', 'install', name], {
      shell: true,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }
    });
    let output = '';
    proc.stdout.on('data', (d) => { output += d.toString(); });
    proc.stderr.on('data', (d) => { output += d.toString(); });
    proc.on('close', (code) => resolve({ output, code }));
    proc.on('error', (err) => resolve({ output: err.message, code: 1 }));
  });
});

ipcMain.handle('gemini:uninstallExtension', async (_, name) => {
  return new Promise((resolve) => {
    const proc = spawn('gemini', ['extension', 'uninstall', name], {
      shell: true,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }
    });
    let output = '';
    proc.stdout.on('data', (d) => { output += d.toString(); });
    proc.stderr.on('data', (d) => { output += d.toString(); });
    proc.on('close', (code) => resolve({ output, code }));
    proc.on('error', (err) => resolve({ output: err.message, code: 1 }));
  });
});

ipcMain.handle('gemini:listInstalledExtensions', async () => {
  return new Promise((resolve) => {
    const proc = spawn('gemini', ['extension', 'list'], {
      shell: true,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }
    });
    let output = '';
    proc.stdout.on('data', (d) => { output += d.toString(); });
    proc.stderr.on('data', (d) => { output += d.toString(); });
    proc.on('close', () => resolve(output.trim()));
    proc.on('error', () => resolve(''));
  });
});
